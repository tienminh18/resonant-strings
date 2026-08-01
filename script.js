
console.clear();

function getPointID(row, col, gridH) {
  return col * gridH + row;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

let audioCtx, masterGain, shelfFilter;

// Each theme is a full timbre profile (pitch set, harmonic partials, envelope,
// strike noise) so switching themes changes the character of the bell, not
// just its pitch.
const CHIME_THEMES = {
  warm: {
    label: 'Ấm áp',
    freqs: [349.23, 392.0, 440.0, 523.25, 587.33, 659.25, 698.46],
    partials: [{ ratio: 1, gain: 0.6 }, { ratio: 2, gain: 0.22 }, { ratio: 2.4, gain: 0.15 }, { ratio: 3.6, gain: 0.08 }],
    duration: 1.3, attack: 0.012, peak: 0.2, droop: 0.99,
    noiseDur: 0.035, noiseGain: 0.06, noiseQ: 4, noiseMul: 2.2,
    shelfHz: 1600, shelfGain: 2
  },
  crystal: {
    label: 'Pha lê',
    freqs: [659.25, 783.99, 880.0, 987.77, 1046.5, 1174.7, 1318.5],
    partials: [{ ratio: 1, gain: 0.45 }, { ratio: 2, gain: 0.3 }, { ratio: 3.01, gain: 0.16 }, { ratio: 4.7, gain: 0.08 }],
    duration: 0.85, attack: 0.004, peak: 0.16, droop: 0.996,
    noiseDur: 0.02, noiseGain: 0.12, noiseQ: 8, noiseMul: 3.4,
    shelfHz: 2800, shelfGain: 6
  },
  deep: {
    label: 'Trầm',
    freqs: [196.0, 220.0, 246.94, 293.66, 329.63, 392.0, 440.0],
    partials: [{ ratio: 1, gain: 0.65 }, { ratio: 2, gain: 0.25 }, { ratio: 3.01, gain: 0.12 }, { ratio: 4.2, gain: 0.06 }],
    duration: 1.7, attack: 0.02, peak: 0.22, droop: 0.985,
    noiseDur: 0.05, noiseGain: 0.045, noiseQ: 2.2, noiseMul: 1.4,
    shelfHz: 900, shelfGain: 0.5
  },
  metal: {
    label: 'Kim loại',
    freqs: [311.13, 369.99, 415.3, 466.16, 554.37, 622.25, 739.99],
    partials: [{ ratio: 1, gain: 0.5 }, { ratio: 1.48, gain: 0.22 }, { ratio: 2.15, gain: 0.2 }, { ratio: 3.3, gain: 0.1 }],
    duration: 1.0, attack: 0.006, peak: 0.18, droop: 0.993,
    noiseDur: 0.03, noiseGain: 0.1, noiseQ: 5.5, noiseMul: 2.6,
    shelfHz: 2000, shelfGain: 4
  },
  wind: {
    label: 'Gió',
    freqs: [523.25, 587.33, 659.25, 783.99, 880.0, 987.77, 1174.7],
    partials: [{ ratio: 1, gain: 0.4 }, { ratio: 2, gain: 0.26 }, { ratio: 3.2, gain: 0.18 }, { ratio: 5.0, gain: 0.09 }],
    duration: 1.5, attack: 0.03, peak: 0.14, droop: 0.994,
    noiseDur: 0.12, noiseGain: 0.15, noiseQ: 1.5, noiseMul: 1.1,
    shelfHz: 2400, shelfGain: 4.5
  }
};

// localStorage does not merely return null when storage is unavailable — it
// throws on access (sandboxed iframes, cookies disabled, Safari private
// browsing historically). At module scope an unguarded read would abort the
// whole script and leave a blank page, so both ends degrade to "this session
// only" instead.
function readStoredTheme() {
  try {
    const id = localStorage.getItem('chimeTheme');
    return id && id in CHIME_THEMES ? id : 'warm';
  } catch {
    return 'warm';
  }
}
function storeTheme(id) {
  try {
    localStorage.setItem('chimeTheme', id);
  } catch {
    // Preference just won't survive a reload; nothing else depends on it.
  }
}

let activeTheme = readStoredTheme();

function ensureAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.3;
  shelfFilter = audioCtx.createBiquadFilter();
  shelfFilter.type = 'highshelf';
  applyThemeFilter();
  masterGain.connect(shelfFilter);
  shelfFilter.connect(audioCtx.destination);
}

function applyThemeFilter() {
  if (!shelfFilter) return;
  const profile = CHIME_THEMES[activeTheme];
  shelfFilter.frequency.value = profile.shelfHz;
  shelfFilter.gain.value = profile.shelfGain;
}

const THEME_ORDER = Object.keys(CHIME_THEMES);

// Per-country roof renders, matched to each theme by sonic/cultural fit
// (e.g. Trung Quốc's long-sustain bronze bells → the "Trầm" deep theme).
// Pre-keyed to real alpha PNGs (see tooling notes) so they composite cleanly
// over any page background without a blend-mode hack.
// `scale` = roof width as a multiple of the cloth width, `ratio` = image
// width/height — both taken from the reference site's actual per-country
// CSS vars (e.g. --roof-w:841px over --area-w:492px for China ≈ 1.71x)
// rather than one fixed size for every roof.
//
// `topPad` = fraction of the image's height that is fully transparent above
// the highest visible pixel. syncRoofNav() lets the roof box hang that far
// past the top of the viewport before it starts shrinking it, so the guard
// spends the empty margin and not the finials. These are measured off the
// actual alpha channel, not estimated — they vary far more than they look:
// Hy Lạp has 7.8% of slack where Trung Quốc has 18.4%, so a single shared
// constant either clipped the Greek roof or needlessly shrank the Chinese one.
// Re-measure if the PNGs are ever re-exported.
const ROOF_IMAGES = {
  warm:    { country: 'Việt Nam',   file: './roof-vietnam.png', scale: 1.30, ratio: 1717 / 916, topPad: .181, bottomPad: .098 },
  crystal: { country: 'Hy Lạp',     file: './roof-greece.png',  scale: 1.20, ratio: 1661 / 947, topPad: .078, bottomPad: .087 },
  deep:    { country: 'Trung Quốc', file: './roof-china.png',   scale: 1.20, ratio: 1662 / 946, topPad: .184, bottomPad: .111 },
  metal:   { country: 'Pháp',       file: './roof-france.png',  scale: 1.30, ratio: 1716 / 916, topPad: .115, bottomPad: .105 },
  wind:    { country: 'Nhật Bản',   file: './roof-japan.png',   scale: 1.30, ratio: 1717 / 916, topPad: .091, bottomPad: .122 }
};

// ─── Per-country background palettes ───
// Keyed to each country's own colour tradition, not to its flag: five flags
// would give five primary-coloured pages and no atmosphere at all. Each is a
// three-stop radial gradient — a near-white core where the light falls, a mid
// tone that carries the identity, and a saturated edge.
//
// Hard constraint on `mid` and `edge`: the cloth's glyphs are rasterised once
// at #2e2420 and hang exactly over that band, so both stops are held to a
// light-to-mid luminance. A true deep Aegean or Sèvres blue looks superb on an
// empty page and makes the text unreadable — every value below is measured
// against the glyph ink and clears 4.5:1.
const COUNTRY_PALETTES = {
  warm:    { core: '#fdf5e3', mid: '#f6c96b', edge: '#e07c2a' }, // sơn mài, ngói nung, lúa chín
  crystal: { core: '#f7fbfb', mid: '#bcdcea', edge: '#5aa8ca' }, // vôi trắng Cyclades, biển Aegean
  deep:    { core: '#fdf2df', mid: '#f0b954', edge: '#d4553a' }, // minh hoàng + chu sa hoàng cung
  metal:   { core: '#f8f5ee', mid: '#c9c3dd', edge: '#8189c9' }, // đá vôi Paris, lam Sèvres, oải hương
  wind:    { core: '#f9f7f1', mid: '#cfd8dc', edge: '#7f9cb0' }  // sinh thành, sương sớm, chàm ai
};

// Every switch routes through this instead of going palette-to-palette direct.
// Interpolating a Việt Nam orange edge straight to an Aegean blue in sRGB drags
// the midpoint through desaturated grey — visible mud, landing exactly in the
// middle of the motion where the eye is.
//
// The hub is deliberately near-achromatic. An earlier, prettier-looking warm
// gold hub (#f3ddbe) did not fix it: the second leg still had to cross the
// complementary axis, and sampling the tween caught it dipping to 13%
// saturation at hue 154° — a pale sage flicker ~200ms into the settle. With an
// almost-neutral hub each leg is a pure chroma ramp instead: colour drains out
// to warm white, then the new hue rises out of it. Nothing ever crosses.
const PALETTE_BLOOM = { core: '#fffefb', mid: '#f7f2ea', edge: '#efe7dc' };

// Split either side of the moment the scene is empty: the page blooms out with
// the departing roof, then settles into the new country as it arrives. BLOOM_MS
// must stay equal to the slide-out delay in renderRoof() and to the 800ms
// transition on .roof/#container in style.css.
const BG_BLOOM_MS = 800;
const BG_SETTLE_MS = 700;
const BG_FADE_MS = 420;   // the no-direction path, which only cross-fades the roof

// iOS Safari tints its own toolbar with <meta name="theme-color">, which sits
// outside the document and can't pick up the body's gradient. Left at a fixed
// value it was a flat #ffa100 that matched none of the five palettes below —
// on Hy Lạp's blue or Pháp's lavender scene the top of the screen still read
// as Việt Nam's orange. Synced to each palette's mid stop (the tone that
// "carries the identity" per the comment above) so Safari's chrome tracks
// whichever country is on screen.
//
// The meta tag itself can't transition — a browser snaps it the instant
// `content` changes, it never eases like the body's custom properties do.
// Writing it at the same moment the tween *starts* made the toolbar jump to
// the destination colour while the on-screen gradient was still mid-ease,
// so the chrome visibly led the slide instead of matching it. Delaying the
// write by `ms` lands it exactly when the CSS transition finishes, so the
// jump — unavoidable either way — happens after the eye has already settled
// on the new scene rather than ahead of it. The pending timer is tracked so
// a second switch fired mid-transition (rapid taps on the nav buttons)
// cancels the stale write instead of letting it land after the newer one.
const themeColorMeta = document.querySelector('meta[name="theme-color"]');
let themeColorTimer = null;

function paintBackground(palette, ms, easing = 'cubic-bezier(.32,0,.22,1)') {
  const s = document.body.style;
  s.transitionProperty = '--bg-core, --bg-mid, --bg-edge';
  s.transitionDuration = ms + 'ms';
  s.transitionTimingFunction = easing;
  s.setProperty('--bg-core', palette.core);
  s.setProperty('--bg-mid', palette.mid);
  s.setProperty('--bg-edge', palette.edge);
  if (themeColorMeta) {
    clearTimeout(themeColorTimer);
    const apply = () => themeColorMeta.setAttribute('content', palette.mid);
    if (ms > 0) themeColorTimer = setTimeout(apply, ms);
    else apply();
  }
}

// Cache-buster for the roof PNGs. Unlike style.css and script.js these are
// requested from JS, so the ?v= in index.html never reached them — an edited
// image would keep serving from cache until a hard refresh. Bump on any change
// to a roof file. (v2: leftover white background cleared out of the gaps under
// the Việt Nam dragons.)
const ROOF_ASSET_V = '?v=2';
const roofSrc = (roof) => roof.file + ROOF_ASSET_V;

// Which roof is actually on screen right now, as opposed to which country is
// selected. The two differ for the whole 800ms of a slide-out, and syncRoofNav()
// must size against this one.
//
// It used to read activeTheme, and setChimeTheme flips that before the animation
// even starts. So anything that re-synced during the slide — the button icons
// finishing their load was enough — resized the roof to the incoming country's
// dimensions while the outgoing image was still displayed. Traced on desktop:
// width went 811 -> 749 at t=23ms, but the picture did not change until t=824ms.
// Eight hundred milliseconds of the Việt Nam roof squeezed into the Hy Lạp roof's
// width, which is the "flicker" — it was never the image, only its box.
let renderedTheme = activeTheme;

let roofEl, roofLabelEl, roofWrapEl;
let leftCountryBtn, rightCountryBtn;

// The reference site's shadow.svg, verbatim: a flat quadrilateral (no blur
// filter at all) shaded by two stacked linear gradients for the opacity
// falloff. `preserveAspectRatio="none"` lets it stretch to whatever box
// .roof-shadow-svg is given in CSS, same as the original.
const ROOF_SHADOW_SVG = `<svg class="roof-shadow-svg" preserveAspectRatio="none" viewBox="0 0 996 468" aria-hidden="true">
  <path d="M0 0H489.5L996 468H519.428L0 0Z" fill="url(#shadowGradA)"/>
  <path d="M0 0H489.5L996 468H519.428L0 0Z" fill="url(#shadowGradB)"/>
  <defs>
    <linearGradient id="shadowGradA" x1="281.14" y1="0" x2="283.4" y2="412.05" gradientUnits="userSpaceOnUse">
      <stop stop-color="#291803" stop-opacity="0.29"/>
      <stop offset="1" stop-color="#241707" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="shadowGradB" x1="281.14" y1="0" x2="285.7" y2="115.15" gradientUnits="userSpaceOnUse">
      <stop stop-color="#4D2E07" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#542F02" stop-opacity="0"/>
    </linearGradient>
  </defs>
</svg>`;

function renderRoof(id, animate = true, direction = 0) {
  if (!roofEl) return;
  const applyContent = () => {
    const roof = ROOF_IMAGES[id];
    // Set before the markup, so any syncRoofNav() triggered by the swap already
    // sizes against the roof that is about to be on screen.
    renderedTheme = id;
    roofEl.innerHTML = roof
      ? `${ROOF_SHADOW_SVG}<img class="roof-real-img" src="${roofSrc(roof)}" alt="${roof.country}">`
      : '';
    if (roofLabelEl) roofLabelEl.textContent = roof ? `${roof.country} · ${CHIME_THEMES[id].label}` : CHIME_THEMES[id].label;
    // The cloth is now a specific historical document, so it gets named rather
    // than left as anonymous decoration.
    const cap = document.querySelector('.eyebrow');
    if (cap) cap.textContent = COUNTRY_TEXTS[id].caption;
  };

  if (!animate) {
    applyContent();
    syncRoofNav();
    paintBackground(COUNTRY_PALETTES[id], 0, 'linear'); // first paint: no tween to run
    return;
  }

  if (direction !== 0) {
    // Two-phase sequential slide: the current roof/cloth glide all the way
    // out first, then — once fully gone — the new ones glide in from the
    // other side. Not a carousel crossfade (nothing overlaps mid-motion).
    // Reference-site convention: "next" (right button) pushes the current
    // scene out to the right and pulls the new one in from the left;
    // "prev" (left button) is the mirror of that.
    const outClass = direction > 0 ? 'slide-out-right' : 'slide-out-left';
    const inClass = direction > 0 ? 'slide-in-left' : 'slide-in-right';
    const slideTargets = [roofEl, container].filter(Boolean);

    // Phase 1: the page blooms toward light as the old scene leaves, so the
    // hue swap happens while the eye has nothing else to hold onto.
    paintBackground(PALETTE_BLOOM, BG_BLOOM_MS, 'cubic-bezier(.33,0,.25,1)');
    slideTargets.forEach(el => el.classList.add(outClass));
    setTimeout(() => {
      applyContent();
      rebuildCloth();   // new passage, new script metrics — see rebuildCloth()
      syncRoofNav();
      // Phase 2: settle out of the bloom into the new country, timed to land
      // as the incoming roof and cloth come to rest.
      paintBackground(COUNTRY_PALETTES[id], BG_SETTLE_MS, 'cubic-bezier(.3,0,.2,1)');
      slideTargets.forEach(el => {
        el.classList.remove(outClass);
        el.classList.add(inClass);
      });
      void roofEl.offsetWidth; // commit the "teleported to the entry side" state...
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          slideTargets.forEach(el => el.classList.remove(inClass)); // ...before easing it back to rest.
        });
      });
    }, BG_BLOOM_MS);
  } else {
    // No slide here, so no empty moment to hide a bloom in — go straight
    // across. The palettes are close enough in lightness that a direct tween
    // over this short a window never reads as muddy.
    roofEl.classList.add('is-fading');
    paintBackground(COUNTRY_PALETTES[id], BG_FADE_MS);
    setTimeout(() => {
      applyContent();
      rebuildCloth();
      syncRoofNav();
      roofEl.classList.remove('is-fading');
    }, 180);
  }
}

// The two side buttons always preview the country before/after the active
// one in THEME_ORDER — clicking jumps straight there, same as the
// reference site's left/right country selectors.
function renderCountryButtons() {
  if (!leftCountryBtn || !rightCountryBtn) return;
  const idx = THEME_ORDER.indexOf(activeTheme);
  const prevId = THEME_ORDER[(idx - 1 + THEME_ORDER.length) % THEME_ORDER.length];
  const nextId = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
  [[leftCountryBtn, prevId], [rightCountryBtn, nextId]].forEach(([btn, id]) => {
    const roof = ROOF_IMAGES[id];
    btn.querySelector('img').src = roofSrc(roof);
    btn.querySelector('img').alt = roof.country;
    btn.querySelector('.country-btn__label').textContent = roof.country;
    btn.setAttribute('aria-label', roof.country);
  });
}

// Each roof is sized off its own scale/ratio (see ROOF_IMAGES above) and
// bottom-anchored to the cloth's pinned top row so it overlaps down onto the
// curtain, same as the reference. The two side country buttons are then
// centered on that roof's vertical midpoint (not the viewport's), matching
// how the reference's selectors sit noticeably above screen-center, roughly
// level with the roof rather than the whole page. All of this depends on
// CONFIG.awidth/aheight and on which country is active, so it's recomputed
// on resize and on every theme switch.
function syncRoofNav() {
  if (!roofWrapEl) return;
  const roof = ROOF_IMAGES[renderedTheme];

  const clothTopY = window.innerHeight - CONFIG.aheight - CONFIG.bottomMargin;

  // Two ceilings, both on the roof itself so the cloth keeps whatever size
  // computeArea() gave it:
  //
  //   horizontal — the clear gap between the two country buttons. On a phone
  //   the roof is already as wide as the screen allows, so ROOF_SIZE simply
  //   stops having an effect rather than pushing the roof over the buttons.
  //
  //   vertical — how much room is left above the cloth. The box may hang past
  //   y=0 by exactly this roof's transparent top margin (roof.topPad, measured
  //   per country) without anything looking cut; beyond that the finials clip.
  //   This guard used to live in computeArea() behind a `vh < 520` test, which
  //   meant a desktop viewport had no protection at all: raising
  //   CLOTH_BOTTOM_MARGIN lifted the cloth, the roof followed it up, and its
  //   top ended up 100px off-screen with the dragon finials sheared off.
  //
  // The 4px is real daylight above the highest visible pixel. Without it the
  // guard lands the ridge at exactly y=0, and sub-pixel rounding alone was
  // enough to shave it (measured -0.05px on an 844x390 viewport).
  //
  // In the compact layout the ceiling is not the top of the screen but the
  // bottom of the country-button row, measured off the live element rather than
  // guessed — --pad-top is a clamp() on viewport height, so the row sits at a
  // different y on every device.
  const ROOF_TOP_MARGIN = compactTopReserve();

  // ─── Where the roof's lower edge lands ───
  // Desktop keeps the original model: the overlap is measured to the image BOX,
  // which is what that composition was tuned against.
  //
  // Compact measures to the roof's VISIBLE lower edge instead, because the two
  // are not the same thing. Every PNG carries a transparent skirt below the
  // eaves (measured: 8.7% of the image height for Hy Lạp up to 12.2% for Nhật
  // Bản), and that skirt scales with the roof. So one fixed box overlap hid
  // wildly different amounts of text: 26px on a 811px desktop roof, but 53px on
  // a 291px phone roof — nearly three lines of a 19.5px leading, which is why
  // the first line was never readable on a phone. Việt Nam felt worst of all
  // because its skirt is the second thinnest, putting its eaves lowest.
  //
  // A negative visible overlap parks the eaves just clear of the first row.
  //
  // Two passes: the roof's height decides where its visible edge falls, and the
  // anchor decides how much height the guard allows — mutually dependent, and
  // one iteration is enough to settle.
  let imageBottomY = clothTopY + ROOF_OVERLAP;
  let roofWidth = 0, roofHeight = 0;
  for (let pass = 0; pass < 2; pass++) {
    const maxByHeight = ((imageBottomY - ROOF_TOP_MARGIN) / (1 - roof.topPad)) * roof.ratio;
    roofWidth = Math.max(0, Math.min(
      CONFIG.awidth * roof.scale * ROOF_SIZE,
      roofBudget(),
      maxByHeight
    ));
    roofHeight = roofWidth / roof.ratio;
    imageBottomY = isCompact()
      ? clothTopY + COMPACT_ROOF_OVERLAP + roof.bottomPad * roofHeight
      : clothTopY + ROOF_OVERLAP;
  }

  roofWrapEl.style.width = roofWidth + 'px';
  roofWrapEl.style.bottom = (window.innerHeight - imageBottomY) + 'px';

  // Side layout only: the buttons are centred on the roof's own midpoint rather
  // than the viewport's, which is what makes them read as flanking it. In the
  // compact layout their position is pure CSS, so the inline value written on a
  // previous resize has to be cleared or it would override the media query.
  if (isCompact()) {
    [leftCountryBtn, rightCountryBtn].forEach(btn => btn && (btn.style.top = ''));
    return;
  }
  // Clamped so a tall roof on a short viewport can't push the buttons up
  // into the fixed topbar. The floor drops on short viewports, where the
  // topbar itself is shorter and 140px would shove the buttons well below
  // the roof they're meant to sit level with.
  const minCenter = window.innerHeight < 520 ? 88 : 140;
  const roofCenterY = Math.max(minCenter, imageBottomY - roofHeight / 2);
  [leftCountryBtn, rightCountryBtn].forEach(btn => {
    if (!btn) return;
    btn.style.top = roofCenterY + 'px';
  });
}

// Side layout only: the bottom copy cannot be pushed below the cloth there —
// the cloth is bottom-anchored and the copy would have nowhere to go — so the
// two are separated horizontally instead. The heading gets whatever width is
// left to the cloth's left edge, the aside whatever is left to its right.
// In the compact layout the screen is far too narrow to sit anything beside the
// cloth, so the variables are cleared and the stylesheet's own widths apply;
// the vertical separation in clothBottomMargin() takes over there.
function syncCopyWidths() {
  const root = document.documentElement.style;
  if (isCompact()) {
    root.removeProperty('--copy-max-w');
    root.removeProperty('--aside-max-w');
    return;
  }
  const pad = sidePad();
  const clothLeft = (window.innerWidth - CONFIG.awidth) / 2;
  const clothRight = clothLeft + CONFIG.awidth;
  root.setProperty('--copy-max-w', Math.max(160, Math.round(clothLeft - pad - TEXT_GAP)) + 'px');
  root.setProperty('--aside-max-w',
    Math.max(140, Math.round(window.innerWidth - clothRight - pad - TEXT_GAP)) + 'px');
}

// How much vertical room the roof must leave clear at the top.
// Side layout: just enough daylight that rounding cannot shave the ridge.
// Compact layout: everything down to the bottom of the button row, plus a gap.
function compactTopReserve() {
  if (!isCompact() || !leftCountryBtn) return 4;
  const b = leftCountryBtn.getBoundingClientRect();
  return b.height ? Math.round(b.bottom + 16) : 4;
}

function setChimeTheme(id, direction = 0) {
  if (!CHIME_THEMES[id] || id === activeTheme) return;
  activeTheme = id;
  storeTheme(id);
  applyThemeFilter();
  renderRoof(id, true, direction);
  renderCountryButtons();
}

function createThemeNav() {
  const roofWrap = document.createElement('div');
  roofWrap.className = 'roof-wrap';
  roofWrapEl = roofWrap;
  roofEl = document.createElement('div');
  roofEl.className = 'roof';
  roofLabelEl = document.createElement('span');
  roofLabelEl.className = 'roof-label';
  roofWrap.appendChild(roofEl);
  document.body.appendChild(roofWrap);

  // The label joins the metadata stack at bottom-left instead of floating near
  // the roof. It used to hang directly under the roof image, which put it
  // squarely inside the cloth — measured overlapping the glyphs by 102x14px on
  // every viewport. Moving it to the top-left corner only traded one collision
  // for another: on a phone the centred button row reaches into that corner,
  // and on a landscape phone the side buttons ride high enough to hit it.
  // There is no corner that is free at every size. The bottom copy, on the
  // other hand, is the one block whose clearance is already guaranteed — by
  // clothBottomMargin() vertically and syncCopyWidths() horizontally — so the
  // label is safe there by construction rather than by luck.
  const heading = document.querySelector('.heading');
  if (heading) heading.insertBefore(roofLabelEl, heading.firstChild);
  else document.body.appendChild(roofLabelEl);

  // Both buttons live inside one wrapper. In the side layout it is
  // `display: contents`, so it vanishes and each button positions itself against
  // the viewport exactly as before. In the compact layout it becomes the flex
  // row that centres the pair — which is the only way to keep them centred when
  // "Pháp" and "Trung Quốc" are 35px apart in width.
  const nav = document.createElement('div');
  nav.className = 'country-nav';
  document.body.appendChild(nav);

  function makeCountryBtn(side, dir) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `country-btn country-btn--${side}`;
    btn.innerHTML = `<span class="country-btn__icon"><img alt=""></span><span class="country-btn__label"></span>`;
    // The row's height is what the compact layout reserves above the roof, and
    // it only settles once the icon decodes — and again on every country swap,
    // since the roof PNGs differ in aspect ratio. One permanent listener per
    // button, so this re-measures on each src change without stacking up.
    btn.querySelector('img').addEventListener('load', () => syncRoofNav());
    btn.addEventListener('click', () => {
      const idx = THEME_ORDER.indexOf(activeTheme);
      setChimeTheme(THEME_ORDER[(idx + dir + THEME_ORDER.length) % THEME_ORDER.length], dir);
    });
    nav.appendChild(btn);
    return btn;
  }
  leftCountryBtn = makeCountryBtn('left', -1);
  rightCountryBtn = makeCountryBtn('right', 1);

  // Buttons first, then the roof. In the compact layout the roof's top ceiling
  // is measured off the live button row, so the row has to have its icon and
  // label in place before syncRoofNav() reads its height — otherwise the box is
  // empty, the reserve silently falls back to 4px, and the roof rides up over
  // the buttons (seen on 1024x768: ceiling 556 computed, 588 actually drawn).
  renderCountryButtons();
  renderRoof(activeTheme, false);
}

function playChime(pitchScale = 1) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const profile = CHIME_THEMES[activeTheme];
  const now = audioCtx.currentTime;
  const freq = profile.freqs[Math.floor(Math.random() * profile.freqs.length)] * pitchScale;
  const duration = profile.duration;

  const voice = audioCtx.createGain();
  voice.gain.setValueAtTime(0.0001, now);
  voice.gain.exponentialRampToValueAtTime(profile.peak, now + profile.attack);
  voice.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  voice.connect(masterGain);

  // Inharmonic partials give a metallic bell/chime timbre instead of a flat tone.
  profile.partials.forEach(({ ratio, gain }) => {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    const f0 = freq * ratio;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f0 * profile.droop), now + duration);
    const partialGain = audioCtx.createGain();
    partialGain.gain.value = gain;
    osc.connect(partialGain);
    partialGain.connect(voice);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  });

  // Short bandpassed noise burst simulates the initial strike transient.
  const noiseDur = profile.noiseDur;
  const buffer = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate * noiseDur)), audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.value = freq * profile.noiseMul;
  noiseFilter.Q.value = profile.noiseQ;
  const noiseGain = audioCtx.createGain();
  noiseGain.gain.setValueAtTime(profile.noiseGain, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + noiseDur);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(voice);
  noise.start(now);
  noise.stop(now + noiseDur + 0.01);
}

// ─── Per-country founding text ───
// Only Việt Nam and Hy Lạp actually have a declaration of independence. France
// never seceded from anyone, and neither China nor Japan has a document of that
// kind either, so those three carry the founding text of equivalent standing in
// their own tradition rather than an invented "declaration".
//
// `tracking`/`leading` are per-script, not per-country: Han and kana are
// full-width (measured 15px advance against Latin's 8.25px at the same size),
// so a CJK passage laid on the Latin 0.62em grid overlaps itself by 60%. CJK
// also wants more leading — it has no ascenders/descenders to space the lines
// apart optically.
//
// The quotations are reproduced from memory; verify the orthography against a
// primary source before this goes anywhere public — the Greek in particular is
// given in monotonic form, and the Chinese in traditional characters.
const LATIN_TRACKING = 0.62, LATIN_LEADING = 1.30;
const CJK_TRACKING = 1.05, CJK_LEADING = 1.55;

const COUNTRY_TEXTS = {
  warm: {
    caption: 'Tuyên ngôn Độc lập · Hà Nội, 2.9.1945 (trích đoạn)',
    tracking: LATIN_TRACKING, leading: LATIN_LEADING,
    text: `Tất cả mọi người đều sinh ra có quyền bình đẳng. Tạo hóa cho họ những quyền không ai có thể xâm phạm được; trong những quyền ấy, có quyền được sống, quyền tự do và quyền mưu cầu hạnh phúc. Nước Việt Nam có quyền hưởng tự do và độc lập, và sự thật đã thành một nước tự do độc lập.`
  },
  crystal: {
    caption: 'Διακήρυξις της Ανεξαρτησίας · Επίδαυρος, 1822',
    tracking: LATIN_TRACKING, leading: LATIN_LEADING,
    text: `Απόγονοι του σοφού και φιλανθρώπου Έθνους των Ελλήνων, σύγχρονοι των νυν πεφωτισμένων λαών της Ευρώπης, κηρύττομεν σήμερον ενώπιον Θεού και ανθρώπων την πολιτικήν ημών ύπαρξιν και ανεξαρτησίαν.`
  },
  deep: {
    caption: '中華民國臨時大總統宣言書 · 孫文, 1912',
    tracking: CJK_TRACKING, leading: CJK_LEADING,
    text: `國家之本，在於人民。合漢滿蒙回藏諸地為一國，合漢滿蒙回藏諸族為一人，是曰民族之統一。國家之進步，以獲得自由之人民為本。`
  },
  metal: {
    caption: 'Déclaration des Droits de l’Homme et du Citoyen · 1789',
    tracking: LATIN_TRACKING, leading: LATIN_LEADING,
    text: `Les hommes naissent et demeurent libres et égaux en droits. Les distinctions sociales ne peuvent être fondées que sur l’utilité commune. Le but de toute association politique est la conservation des droits naturels et imprescriptibles de l’homme.`
  },
  wind: {
    caption: '日本国憲法 前文 · 1947',
    tracking: CJK_TRACKING, leading: CJK_LEADING,
    text: `日本国民は、恒久の平和を念願し、人間相互の関係を支配する崇高な理想を深く自覚するのであつて、平和を愛する諸国民の公正と信義に信頼して、われらの安全と生存を保持しようと決意した。`
  }
};

function activeText() {
  return COUNTRY_TEXTS[activeTheme] || COUNTRY_TEXTS.warm;
}

// Greedy word wrap into rows of at most `cols` cells.
//
// The grid used to be filled straight from a flat character stream —
// `text[(i + j*gridW) % text.length]` — which guillotined a word at every single
// row boundary: "quyền tự d / o và", "có qu / yền bình đẳng". Every glyph was
// rendered correctly and the result still read as broken text, because a reader
// sees severed words long before they notice intact letterforms.
//
// The `while` fallback handles two cases: a single word longer than the row, and
// the Chinese and Japanese passages, which contain no spaces at all and are
// meant to break anywhere.
function wrapText(text, cols) {
  const lines = [];
  let line = '';
  const flushOverflow = () => {
    while (line.length > cols) {
      lines.push(line.slice(0, cols));
      line = line.slice(cols);
    }
  };
  for (const word of text.split(' ')) {
    if (!word) continue;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= cols) line += ' ' + word;
    else { lines.push(line); line = word; }
    flushOverflow();
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

let fullCode = '';

// The cloth is bottom-anchored (not centered) so it runs down to the
// viewport edge and the roof caps its top row — see drawCode()'s offset,
// the Input mouse-offset (must match or clicks miss the cloth), and
// syncRoofNav()'s clothTopY, which all derive from this same margin.
// Fixed small value by request — the cloth's bottom row is meant to touch
// the screen edge, overlapping the heading text rather than stopping short
// of it.
// Base gap between the cloth's resting bottom row and the foot of the screen.
// In the compact layout this is only a floor — clothBottomMargin() raises it to
// clear the bottom copy, since on a narrow screen the copy is too wide to sit
// beside the cloth and the two have to be separated vertically instead.
const CLOTH_BOTTOM_MARGIN = 160;

// Gravity and the 1.1 stretch factor pull the cloth's last row well past its
// resting height — measured ~15% on a 400px cloth. Positioning off the resting
// height alone left the ink hanging into the copy below it.
//
// Deliberately not raised further. Pushing it to 0.22 to chase a 320px-wide
// screen lifted the cloth enough to starve the roof of headroom, and the roof
// guard answered by shrinking it — 554px to 327px on a landscape tablet, 279 to
// 199 on an iPhone SE — while not actually fixing the 320px case. The cost was
// real and the benefit was nil.
const CLOTH_STRETCH_ALLOW = 0.15;
// Clear air demanded between any two blocks of text.
const TEXT_GAP = 16;

// The cloth is bottom-anchored, so where its last row lands is entirely this
// number. Read live rather than baked in: the copy block's height depends on
// how many lines the heading wraps to, which changes with viewport and with
// the country (the caption line names a different document each time).
function clothBottomMargin() {
  if (!isCompact()) return CLOTH_BOTTOM_MARGIN;
  const copy = document.querySelector('.bottom-copy');
  if (!copy) return CLOTH_BOTTOM_MARGIN;
  const copyTop = copy.getBoundingClientRect().top;
  if (!copyTop) return CLOTH_BOTTOM_MARGIN;
  const vh = window.innerHeight;
  const h = Math.min(CLOTH_H_MAX, vh * (vh < 520 ? 0.42 : CLOTH_H_RATIO));
  return Math.max(
    CLOTH_BOTTOM_MARGIN,
    Math.round(vh - copyTop + h * CLOTH_STRETCH_ALLOW + TEXT_GAP)
  );
}

// How far the roof image presses down over the cloth's pinned top row.
// Hoisted out of syncRoofNav() because computeArea() needs it too, to work
// out how much headroom the roof has left on a short viewport.
const ROOF_OVERLAP = 60;

// Compact only, and measured to the roof's VISIBLE lower edge rather than its
// image box — see the note in syncRoofNav(). Negative, so the eaves stop just
// short of the cloth's first row instead of covering it. Sized off the glyph
// tile: a row's ink reaches roughly 8px above its particle, so -14 leaves a few
// pixels of daylight. Raise toward 0 to press the roof back down onto the text.
const COMPACT_ROOF_OVERLAP = -14;

// Lifting the eaves clear of the first row moves the roof up in absolute terms,
// and on a small phone there is no spare height above it — the roof guard
// answered by shrinking the roof to 107px on an iPhone SE, 61px for the French
// one. So the cloth gives back the same distance instead: it is bottom-anchored,
// so trimming its height slides its top edge down and leaves the roof exactly
// where it was.
//
// Nothing is actually lost. On an iPhone 14 the cloth was 375px with 53px of it
// buried under the roof — 322px of readable text. It is now 317px, all of it
// readable, and the first line is legible for the first time.
//
// Derived from the constants above rather than typed in: the gap being closed is
// the old box overlap minus the new visible one, less the roof's transparent
// skirt (~16px at phone sizes; it is per-country, but resizing the cloth on
// every country switch would be worse than being a few pixels out).
const COMPACT_ROOF_SKIRT = 16;
const COMPACT_CLOTH_TRIM = ROOF_OVERLAP - COMPACT_ROOF_OVERLAP - COMPACT_ROOF_SKIRT;

// ─── Roof size knob ───
// One multiplier over every country's own `scale` in ROOF_IMAGES, so the
// roofs grow together and keep their relative differences (Trung Quốc stays
// the widest). 1 = the sizes taken from the reference site.
//
// Deliberately NOT folded into computeArea(): feeding it into the cloth-fit
// clamp there would shrink the cloth on small screens to buy room for a roof
// that can't grow anyway, so a phone would end up with a smaller cloth and
// the same roof. syncRoofNav() applies it to the roof alone and clamps to
// the real gap between the buttons instead.
const ROOF_SIZE = 1.30;

// ─── Responsive sizing model ───
// Every breakpoint is derived from one approved reference layout — a 600x500
// cloth on a 1440x900 desktop — expressed as viewport ratios, so a phone and
// a tablet reproduce the same composition (cloth ≈42% of viewport width,
// roof ≈56%) instead of each screen size inventing its own numbers. Feeding
// 1440x900 back through computeArea() returns exactly 600x500, so the
// desktop rendering is unchanged.
const CLOTH_W_RATIO = 480 / 1440;
const CLOTH_H_RATIO = 400 / 900;
const CLOTH_W_MAX = 480, CLOTH_W_MIN = 120;
const CLOTH_H_MAX = 400, CLOTH_H_MIN = 180;

// Compact layout gets a wider share. Moving the country buttons to the top
// hands back the two side margins they used to occupy, and on a phone the
// desktop-derived 33% left the cloth looking stranded in the middle of the
// screen. 44% is roughly a third wider, and the roof — sized off the cloth —
// grows with it. Everything above tablet width is untouched.
const CLOTH_W_RATIO_COMPACT = 0.44;

// Widest scale and tallest (= smallest ratio) roof in ROOF_IMAGES. The fit
// maths below uses the worst case rather than the active country's own
// number, so switching country never reflows the cloth. Keep this equal to
// the largest `scale` in ROOF_IMAGES — too high and the cloth is needlessly
// narrowed on phones, too low and the roof can crowd the country buttons.
const MAX_ROOF_SCALE = 1.25;

// Retina backing store, capped at 2: phones report 3, and on a cloth this
// size the third multiple costs fill rate without showing any extra detail.
const DPR = Math.min(2, window.devicePixelRatio || 1);

// Glyph tiles are rasterised well above the size they are drawn at, then scaled
// down. This is not a retina concern — it is about *fractional placement*. The
// cloth positions every glyph at a continuous particle coordinate, never on a
// pixel boundary, so a tile rasterised 1:1 is resampled on every single draw,
// and bilinear resampling of a 15px bold face eats the stems. That is the
// "mất nét" — the glyph atlas itself was always sharp, the blit was not.
//
// Measured on a Vietnamese sample, solid ink vs. a direct-fillText baseline of
// 390 solid / 588 soft:
//     1x   280 solid /  977 soft   ← what this used to do: 28% less solid ink
//     2x   519 /  429
//     3x   556 /  231
//     4x   559 /  232              ← no better than 3x for 78% more memory
// So target 3, and only go past it where a retina backing store needs the
// headroom. At the 4x ceiling a tile is ~25KB, ~1.6MB for the largest glyph set
// (the Japanese passage, 62 distinct characters).
const ATLAS_SCALE = Math.min(4, Math.max(3, DPR * 2));

const GLYPH_INK = '#2e2420';

// Synthetic emboldening: the glyph is filled, then its outline stroked at this
// width, which thickens every stem by half of it on each side.
//
// Oversampling fixed the resampling loss, but it could not fix the physics of
// the size. At 15px this face carries roughly a 2px stem, so even a perfect
// rasterisation is one solid pixel flanked by two partial ones — measured, only
// 45% of the ink came out fully opaque, and that is what still read as thin.
// Darkening the ink was tried first and did nothing (468 solid vs 465): the
// problem was never contrast, it was stroke mass.
//
// Solid ink against the 465 baseline:
//     0.3  →  497   (also raised the soft count; too light to help)
//     0.5  →  620   ← chosen: +33%, counters in q / ộ / ế still open
//     0.7  →  721   (+55%, but ộ and ế start closing up and go blobby)
// Set to 0 to disable and get the plain filled glyph back.
const GLYPH_EMBOLDEN = 0.5;

// These mirror style.css — --pad-x and .country-btn's width with its media
// query overrides. They're duplicated here because the roof width is
// computed in JS and has to know where the buttons actually are.
//
// env(safe-area-inset-*) can't be read from JS directly, so a zero-sized
// probe element carries the values into layout where getComputedStyle can
// see them. Without this the roof overran the buttons on a notched phone in
// landscape, where the inset is ~44px and --pad-x's max() silently grew.
let safeProbe;
function safeInsetX() {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);';
    document.documentElement.appendChild(safeProbe);
  }
  const s = getComputedStyle(safeProbe);
  return Math.max(parseFloat(s.paddingLeft) || 0, parseFloat(s.paddingRight) || 0);
}
function sidePad() {
  return Math.max(Math.min(64, Math.max(20, window.innerWidth * 0.05)), safeInsetX());
}
// ─── Compact layout ───
// At tablet width and below the two country buttons lift out of the side
// margins and become a centred pair at the top of the screen. Must stay in
// step with the matching @media block in style.css.
//
// Gated on height as well as width: a phone held landscape is under 1024px wide
// but has so little vertical room that a button row at the top would sit on the
// roof, so it keeps the side arrangement.
const COMPACT_MAX_W = 1024;
const COMPACT_MIN_H = 600;
function isCompact() {
  return window.innerWidth <= COMPACT_MAX_W && window.innerHeight >= COMPACT_MIN_H;
}

function countryBtnWidth() {
  // Zero in the compact layout — the buttons are above the roof now, not beside
  // it, so they no longer eat into the width available to it.
  if (isCompact()) return 0;
  const vw = window.innerWidth;
  return vw <= 480 ? 44 : vw <= 760 ? 56 : 84;
}
// Clear horizontal span left for the roof once both country buttons and the
// side padding are accounted for. Used by computeArea() to size the cloth and
// by syncRoofNav() as the roof's own hard ceiling.
function roofBudget() {
  return window.innerWidth - 2 * (sidePad() + countryBtnWidth() + 14);
}

function computeArea() {
  const vw = window.innerWidth, vh = window.innerHeight;

  // Landscape phones have so little height that the cloth's usual ~56%
  // share leaves the roof no headroom above it.
  let w = Math.min(CLOTH_W_MAX, vw * (isCompact() ? CLOTH_W_RATIO_COMPACT : CLOTH_W_RATIO));
  let h = Math.min(CLOTH_H_MAX, vh * (vh < 520 ? 0.42 : CLOTH_H_RATIO));
  // Compact: give back exactly what lifting the eaves off the first row costs,
  // so the roof keeps its absolute position and its size. See COMPACT_CLOTH_TRIM.
  if (isCompact()) h -= COMPACT_CLOTH_TRIM;

  // Horizontal fit: the roof renders at clothWidth * scale and has to clear
  // both country buttons. Without this a 768px tablet asked for an 810px
  // roof and ran it off both edges of the screen. ROOF_SIZE is intentionally
  // absent here — see the note on its declaration.
  w = Math.min(w, roofBudget() / MAX_ROOF_SCALE);

  // No vertical clamp here any more. It used to narrow the *cloth* on short
  // viewports so the roof above it would fit, which meant a landscape phone
  // paid for the roof twice over. syncRoofNav() now caps the roof's own
  // height instead, and does it at every viewport size rather than only
  // below 520px.

  return {
    w: Math.max(CLOTH_W_MIN, Math.round(w)),
    h: Math.max(CLOTH_H_MIN, Math.round(h))
  };
}

const CONFIG = {
  awidth: 0,
  aheight: 0,
  gridW: 0,
  gridH: 0,
  gravity: .2,
  damping: .99,
  iterationsPerFrame: 5,
  compressFactor: .02,
  stretchFactor: 1.1,
  mouseSize: 3000,
  mouseStrength: 2,
  contain: false,
  randomSolve: false
};

// ─── Typography ───
// The cloth is a grid of glyphs, which makes the cell aspect ratio literally
// the text's letter-spacing and leading. So the grid is derived from type
// metrics rather than the other way round.
//
// The previous code did the opposite: it picked the grid from raw pixel
// divisors (w/15, h/12) and then set the font from whatever cellHeight fell
// out. That produced near-square cells — measured 15.48 x 12.50 — against an
// 8.25px glyph advance and a 14px accented glyph. Result: 7.24px of dead air
// between every letter while consecutive lines overlapped by 1.5px. Words
// came apart horizontally and Vietnamese diacritics crashed into the row
// below, which is why the text was visible but unreadable.
//
// Monospace advance is ~0.62em and comfortable leading ~1.30em, so cells have
// to be about twice as tall as they are wide.
// Tracking and leading now come from the active country's passage (see
// COUNTRY_TEXTS) because they are script-dependent — CJK needs roughly 1.7x
// the horizontal cell that Latin does.
const GLYPH_SIZE = 15;    // px — the single knob for how large the text reads

// ─── Atlas font ───
// Pinned, not left to the generic `monospace` keyword. That keyword resolves to
// whatever the OS supplies — Courier New on a stock Windows install — and
// Courier New has no coverage of Latin Extended Additional (U+1EA0–U+1EF9),
// which is exactly where Vietnamese keeps ấ ữ ộ ế ầ ợ. The atlas was therefore
// being rasterised from per-character fallbacks that differ machine to machine:
// intact on one screen, shredded on another, with no error anywhere to show it.
// (Measured: the same 'ấ' came out at 59 ink pixels under the generic keyword
// against 82 under a real pinned webfont — different fonts entirely.)
//
// Pinned to the self-hosted face declared in style.css — Source Code Pro, which
// carries both the Vietnamese (U+1EA0–U+1EF9) and Greek subsets these passages
// need. CJK falls through to the system stack, which is unavoidable: no
// monospace webfont covers Han and kana.
const GLYPH_FONT_FAMILY = '"Source Code Pro", ui-monospace, monospace';
const GLYPH_FONT_NAME = 'Source Code Pro';

// Is the webfont actually being used right now, as opposed to merely promised?
// Draws a codepoint that exists only in the Vietnamese block (U+1EA7) with the
// atlas stack and with a family that cannot exist, and compares the ink. While
// the two match, the browser is still serving a fallback.
function webfontInUse() {
  const draw = (family) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const x = cv.getContext('2d');
    x.font = `bold ${GLYPH_SIZE}px ${family}`;
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    x.fillText('ầ', 16, 22);
    const d = x.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 3; i < d.length; i += 4) sum += d[i];
    return sum;
  };
  return draw(GLYPH_FONT_FAMILY) !== draw('"__no_such_family__", monospace');
}

// The atlas is rasterised once per build and never re-rendered, so building it
// before the webfont lands bakes the fallback in for the rest of the session.
//
// This gate verifies the outcome rather than trusting document.fonts.load(),
// because that promise is not the guarantee it looks like: FontFaceSet.load()
// resolves *immediately, with an empty array*, when no registered face matches
// the requested family. If the stylesheet carrying the @font-face rules has not
// been parsed yet when this module runs — or if those rules are invalid, which
// is what an @font-face missing its `src` becomes — there is simply nothing to
// match, the promise resolves at once, and the cloth is built from Courier New.
// That is the exact signature of "broken on first load, fine after two or three
// reloads": on a warm cache the CSS parses first and the race is won by luck.
let fontReady = false;
function whenFontReady(run) {
  if (fontReady) return run();
  const go = () => { fontReady = true; run(); };
  if (!document.fonts || !document.fonts.load) return go();

  const deadline = performance.now() + 4000;
  const attempt = () => {
    Promise.resolve(document.fonts.ready)
      .then(() => Promise.all([
        // Sample strings, not just the family: the face is split per subset and
        // only the ones a sample needs are fetched.
        document.fonts.load(`bold ${GLYPH_SIZE}px "${GLYPH_FONT_NAME}"`, 'Tất cả những quyền ầ'),
        document.fonts.load(`bold ${GLYPH_SIZE}px "${GLYPH_FONT_NAME}"`, 'Απόγονοι σοφού')
      ]))
      .catch(() => {})
      .then(() => {
        // Proceed on success, or once the deadline passes — a missing font must
        // degrade to the system face, never leave the page with no cloth at all.
        if (webfontInUse() || performance.now() > deadline) return go();
        setTimeout(attempt, 100);
      });
  };
  attempt();
}

function applyArea() {
  const { w, h } = computeArea();
  CONFIG.awidth = w;
  CONFIG.aheight = h;
  // Resolved once per build and read from CONFIG everywhere after: drawCode's
  // offset, syncRoofNav's anchor and the pointer maths all have to agree on it
  // exactly, and re-measuring the DOM in each of them would let them drift.
  CONFIG.bottomMargin = clothBottomMargin();
  CONFIG.fontSize = GLYPH_SIZE;
  // Caps keep the particle count bounded on a large viewport; the floors keep
  // a phone from degenerating into a couple of columns.
  const { tracking, leading } = activeText();
  CONFIG.gridW = Math.max(8, Math.min(64, Math.round(w / (GLYPH_SIZE * tracking)) + 1));
  CONFIG.gridH = Math.max(8, Math.min(48, Math.round(h / (GLYPH_SIZE * leading)) + 1));
  CONFIG.cellWidth = CONFIG.awidth / (CONFIG.gridW - 1);
  CONFIG.cellHeight = CONFIG.aheight / (CONFIG.gridH - 1);
  syncCopyWidths();
}
applyArea();

// Full rebuild rather than an in-place patch: constraint lengths, particle
// positions and the pre-rasterised glyph canvases are all baked from
// cellWidth/cellHeight when main() runs. The previous handler only reassigned
// CONFIG, so the cloth stayed at its old size while syncRoofNav() moved the
// roof to the new one — the two visibly came apart, and because the pointer
// maths read live CONFIG while drawCode() read the stale closure values,
// clicks landed nowhere near the glyphs they appeared to be on.
// Also the country-switch path: a new country brings a new passage, and with
// it a different script, tracking and leading — so the grid dimensions, the
// constraint lengths and the glyph atlas all have to be rebuilt, not just
// re-read. Verified not to leak: after five rebuilds there is still exactly one
// document listener of each type and one rAF loop.
function rebuildCloth() {
  whenFontReady(() => {
    applyArea();
    if (rafID) cancelAnimationFrame(rafID);
    if (input) input.unbind(); // else every rebuild stacks another set of document listeners
    main();
  });
}

let resizeTimer;
function handleResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    rebuildCloth();
    syncRoofNav();
  }, 180);
}
window.addEventListener('resize', handleResize);
// iOS fires orientationchange before innerWidth/innerHeight have settled.
window.addEventListener('orientationchange', () => setTimeout(handleResize, 120));

let rafID, input, c;
function main() {
  // No terminal full stop and no repeat separator, by request. Both are safe to
  // drop now: a "  ·  " marker was only ever needed back when the grid was filled
  // from a flat character stream, where the closing stop butted straight into the
  // next opening capital ("độc lập.Tất cả mọi"). Since the wrap became
  // line-based, every repeat already restarts on its own row, so the boundary
  // reads as a paragraph break with nothing added.
  fullCode = activeText().text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');   // '。' is the CJK full stop — both passages end in one
  // gravity/damping are read live off CONFIG inside Particle.update, so they
  // are deliberately not pulled in here.
  const { awidth: width, aheight: height, bottomMargin, gridW, gridH, iterationsPerFrame, compressFactor, stretchFactor, cellWidth, cellHeight, fontSize } = CONFIG;

  const charCanvases = {};
  const chars = [...new Set(fullCode)].filter(ch => ch !== ' ');
  const FONT = `bold ${fontSize}px ${GLYPH_FONT_FAMILY}`;

  // Tile geometry is measured off the actual character set instead of guessed.
  //
  // The old code sized the tile as ceil(fontSize * 1.4) and drew with
  // textBaseline:'middle' at the tile's centre. That puts the alphabetic
  // baseline far too low for a stacked Vietnamese diacritic: 'ẳ' needs 13px of
  // ascent and only had 10.5px of tile above the pen, so its accent was sliced
  // off by the tile ceiling. 21 of the 54 glyphs in this passage were losing
  // their tops that way — which is what made "quyền" read as "quy n" and
  // "những" as "nhưng" on screen.
  //
  // Measuring also makes this correct for scripts nobody has tried yet: Han and
  // kana have different extents again, and they now size their own tile.
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = FONT;
  const GLYPH_PAD = 2;
  let maxAsc = 0, maxDesc = 0, maxSide = 0;
  for (const ch of chars) {
    const m = probe.measureText(ch);
    maxAsc  = Math.max(maxAsc,  m.actualBoundingBoxAscent  || 0);
    maxDesc = Math.max(maxDesc, m.actualBoundingBoxDescent || 0);
    maxSide = Math.max(maxSide, (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0));
  }
  // Tile grows by the emboldening width so the thickened outline is not clipped.
  const glyphPx = Math.ceil(Math.max(maxAsc + maxDesc, maxSide) + GLYPH_PAD * 2 + GLYPH_EMBOLDEN);
  // Baseline placed so the ink block is vertically centred in the tile — that
  // is what lets drawCode() centre the tile on its particle and have the text
  // land where the grid says it should.
  const baselineY = (glyphPx - (maxAsc + maxDesc)) / 2 + maxAsc;

  // Rasterised at ATLAS_SCALE, drawn back at their CSS size — see the note on
  // that constant for why the oversampling is what keeps the strokes solid.
  for (const ch of chars) {
    const off = document.createElement('canvas');
    off.width = off.height = Math.ceil(glyphPx * ATLAS_SCALE);
    const octx = off.getContext('2d');
    octx.scale(ATLAS_SCALE, ATLAS_SCALE);
    octx.font = FONT;
    octx.textAlign = 'center';
    octx.textBaseline = 'alphabetic';
    octx.fillStyle = GLYPH_INK;
    octx.fillText(ch, glyphPx / 2, baselineY);
    if (GLYPH_EMBOLDEN) {
      octx.strokeStyle = GLYPH_INK;
      octx.lineWidth = GLYPH_EMBOLDEN;
      octx.lineJoin = 'round';   // else the joins spike on tight corners
      octx.strokeText(ch, glyphPx / 2, baselineY);
    }
    charCanvases[ch] = off;
  }

  c = document.createElement('canvas');
  container.innerHTML = '';
  container.appendChild(c);
  // Backing store in device pixels, CSS box in layout pixels. Everything
  // else in this file — the simulation, drawCode's offset, the pointer
  // maths — stays in layout pixels; DPR is folded in only at draw time.
  const viewW = window.innerWidth, viewH = window.innerHeight;
  c.width = Math.round(viewW * DPR);
  c.height = Math.round(viewH * DPR);
  c.style.width = viewW + 'px';
  c.style.height = viewH + 'px';
  const ctx = c.getContext('2d');
  // Every glyph is a downscale from an ATLAS_SCALE tile, and it happens ~1400
  // times a frame — ask for the good filter rather than the fast one.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  const particles = [];
  const constraints = [];

  input = new Input({ c, particles });
  
  // Wrapped once here, then cycled down the grid: the passage is almost always
  // shorter than the cloth is tall, so it repeats — with the "  ·  " separator
  // from fullCode falling between repeats.
  const lines = wrapText(fullCode, gridW);

  for(let i=0;i<gridW;i++) {
    for(let j=0;j<gridH;j++) {
      let x = i*cellWidth;
      let y = j*cellHeight;

      const id = getPointID(j, i, gridH);
      const pinned = j === 0;

      // Cells past the end of a short line stay blank, which is what gives the
      // cloth a natural ragged right edge instead of a justified slab.
      const char = lines[j % lines.length][i] || ' ';

      particles.push(new Particle({ x, y, pinned, id, char }));
    }
  }
  
  for(let i=0;i<gridW;i++) {
    for(let j=0;j<gridH;j++) {
      const id = getPointID(j, i, gridH);
      const p = particles[id];

      // Vertical: stiff. These are the "strings" — they hold the drape and
      // give each glyph its rotation (see p.downConstraint in drawCode).
      if(j<gridH-1) {
        const bottomP = particles[getPointID(j+1, i, gridH)];
        const vc = new Constraint({p1: p, p2: bottomP, length: cellHeight, compressFactor, stretchFactor});
        constraints.push(vc);
        p.downConstraint = vc; // Cache the down ref directly on the particle
      }
      // Horizontal: loose spacers, free to compress to 0.6x and stretch to 4x
      // so neighbouring columns can slide past each other as the cloth swings.
      if(i<gridW-1) {
        const rightP = particles[getPointID(j, i+1, gridH)];
        constraints.push(new Constraint({
          p1: p,
          p2: rightP,
          length: cellWidth,
          compressFactor: 0.6,
          stretchFactor: 4
        }));
      }
    }
  }
  
  const half = glyphPx / 2;
  function drawCode() {
    // Layout pixels, not c.width/c.height — those are the device-pixel
    // backing store. viewW/viewH are captured once per main(), and main()
    // re-runs on every resize, so the cloth re-anchors to the new viewport
    // when the rebuild lands rather than on each frame.
    const offset = [viewW/2-width/2, viewH-height-bottomMargin];
    particles.forEach(p => {
      if (p.char && p.char !== " ") {
        const constraint = p.downConstraint;
        let angle = 0;

        const img = charCanvases[p.char];
        if (!img) return;

        let cos = 1, sin = 0;

        if (constraint) {
          const dx = constraint.p2.pos.x - constraint.p1.pos.x;
          const dy = constraint.p2.pos.y - constraint.p1.pos.y;
          angle = Math.atan2(dy, dx) - Math.PI / 2;
          cos = Math.cos(angle);
          sin = Math.sin(angle);
        }

        // ctx.translate(p.pos.x, p.pos.y);
        // if (angle !== 0) ctx.rotate(angle);
        // const cos = Math.cos(angle);
        // const sin = Math.sin(angle);
        ctx.setTransform(cos*DPR, sin*DPR, -sin*DPR, cos*DPR,
                         (p.pos.x+offset[0])*DPR, (p.pos.y+offset[1])*DPR);

        // ctx.fillText(p.char, 0, 0);
        // Explicit dw/dh: the tile is DPR times its layout size, and the
        // transform already carries the DPR scale.
        ctx.drawImage(img, -half, -half, glyphPx, glyphPx);

        // if (angle !== 0) ctx.rotate(-angle);
        // ctx.translate(-p.pos.x, -p.pos.y);
      }
    });
    // ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  
  function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
  
  let lastDelta = 0;
  function runloop(delta) {
    rafID = requestAnimationFrame(runloop);

    ctx.save();
    ctx.clearRect(0,0,c.width,c.height);

    // Clamped frame time, for two separate hazards:
    //
    //   0  — rAF timestamps can repeat when the browser coarsens them for
    //        anti-fingerprinting. Particle.update squares this into dd, so
    //        dd=0 makes gravity/dd Infinity and then Infinity*dd NaN. NaN
    //        spreads through every constraint within one frame and the cloth
    //        never recovers short of a reload.
    //
    //   big — on the first frame after main() (including every resize
    //        rebuild) lastDelta is still 0, so delta is the full page
    //        timestamp. Gravity cancels out of that harmlessly, but a pointer
    //        force applied between frames does not: it is multiplied by dd,
    //        and a dd of ~3.6e9 launches the whole cloth off-screen.
    //
    // 32ms is two frames at 60fps — wide enough never to bite in normal use.
    if (!lastDelta) lastDelta = delta;
    const frame = Math.min(32, Math.max(1, delta - lastDelta));
    particles.forEach(p => p.update(frame));
    lastDelta = delta;
    
    if(CONFIG.randomSolve) shuffleArray(constraints)
    for(let i=0;i<iterationsPerFrame;i++) {
      for(let j=0;j<constraints.length;j++) constraints[j].solve();
    }
    
    if(CONFIG.contain) particles.forEach(p=>p.contain());
    
    drawCode();
    
    ctx.restore();
  }
  rafID = requestAnimationFrame(runloop);
}

class Input {
  constructor({ c, particles }) {
    this.c = c, this.particles = particles;
    this.mousePos = new Vec2();
    // A fingertip is far less precise than a cursor, and on a phone the
    // cloth is only ~150px wide, so 20px made glyphs hard to catch by touch.
    this.grabRadius = window.matchMedia('(pointer: coarse)').matches ? 28 : 20;
    this.lastChimeTime = 0;
    this.chimeCooldown = 90;
    // Scratch vector reused across the per-particle loops below. They run over
    // every particle on every pointer event, and subtractNew()/new Vec2() were
    // allocating one object per particle per event — roughly 170k short-lived
    // Vec2 per second while dragging on a 1.4k-particle grid.
    this.force = new Vec2();
    this.bind()
  }
  pointerdown(e) {
    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // window.inner*, not c.width/c.height: those are the device-pixel
    // backing store now, and e.clientX/Y are layout pixels — mixing them
    // put the grab point off by a factor of DPR on any retina screen.
    this.mousePos.x = e.clientX - (window.innerWidth/2 - CONFIG.awidth/2);
    this.mousePos.y = e.clientY - (window.innerHeight - CONFIG.aheight - CONFIG.bottomMargin);

    const grabRadiusSq = this.grabRadius * this.grabRadius;
    for (const p of this.particles) {
      const dx = this.mousePos.x - p.pos.x, dy = this.mousePos.y - p.pos.y;
      if (dx*dx + dy*dy < grabRadiusSq) {   // squared compare: no sqrt, no allocation
        this.grabbedParticle = p;
        p.originalPinnedState = p.pinned;
        p.pinned = true;
        if (p.char && p.char !== ' ') this.ringChime(p);
        break;
      }
    }
  }
  pointerup(e) {
    if (this.grabbedParticle) {
      this.grabbedParticle.pinned = this.grabbedParticle.originalPinnedState;
      this.grabbedParticle = null;
    }
  }
  pointermove(e) {
    this.mousePos.x = e.clientX - (window.innerWidth/2 - CONFIG.awidth/2);
    this.mousePos.y = e.clientY - (window.innerHeight - CONFIG.aheight - CONFIG.bottomMargin);

    if (this.grabbedParticle) {
      this.grabbedParticle.pos.reset(this.mousePos.x, this.mousePos.y);
      this.grabbedParticle.oldPos.reset(this.mousePos.x, this.mousePos.y);
    }

    let nearestChar = null, nearestLs = this.grabRadius * this.grabRadius;
    for (const p of this.particles) {
      const dx = this.mousePos.x - p.pos.x, dy = this.mousePos.y - p.pos.y;
      const ls = dx*dx + dy*dy;
      if (ls < CONFIG.mouseSize) {
        const a = Math.atan2(dy, dx) - Math.PI;
        const strength = smoothstep(CONFIG.mouseSize, -2000, ls)*CONFIG.mouseStrength/300;
        // applyForce copies the components out, so one scratch vector is safe
        // to reuse for every particle in the loop.
        this.force.reset(Math.cos(a)*strength, Math.sin(a)*strength);
        p.applyForce(this.force);
      }
      if (p.char && p.char !== ' ' && ls < nearestLs) {
        nearestLs = ls;
        nearestChar = p;
      }
    }
    if (nearestChar) this.ringChime(nearestChar);
  }
  ringChime(particle) {
    const now = performance.now();
    if (now - this.lastChimeTime < this.chimeCooldown) return;
    this.lastChimeTime = now;
    // Shorter "tubes" (near the pinned top) ring higher; longer ones (further
    // down) ring lower.
    //
    // Floored, because pos.y is not bounded by aheight: a grabbed glyph is
    // pinned straight onto the pointer. On a short viewport — where aheight
    // sits on its 180px floor while CLOTH_BOTTOM_MARGIN still reserves 150px —
    // y reaches 330 against a 288px safe limit, driving the multiplier to
    // -0.23. Chrome accepts the resulting negative frequency without
    // complaint, so instead of a chime you got an 81Hz drone with no error to
    // point at it. Measured on a 844x390 viewport.
    playChime(Math.max(0.35, 1.6 - particle.pos.y / CONFIG.aheight));
  }
  contextmenu(e) {
    e.preventDefault();
  }
  bind() {
    this.pointerdown=this.pointerdown.bind(this)
    this.pointerup=this.pointerup.bind(this)
    this.pointermove=this.pointermove.bind(this)
    this.contextmenu=this.contextmenu.bind(this)
    document.addEventListener('pointerdown', this.pointerdown)
    document.addEventListener('pointerup', this.pointerup)
    document.addEventListener('pointermove', this.pointermove)
    document.addEventListener('contextmenu', this.contextmenu)
  }
  unbind() {
    document.removeEventListener('pointerdown', this.pointerdown)
    document.removeEventListener('pointerup', this.pointerup)
    document.removeEventListener('pointermove', this.pointermove)
    document.removeEventListener('contextmenu', this.contextmenu)
  }
}

class Vec2 {
  constructor(x=0, y=0) {
    this.reset(x,y)
  }
  zero() {
    this.reset(0,0)
  }
  reset(x=0, y=0) {
    this.x = x;
    this.y = y;
  }
  clone() {
    return new Vec2(this.x, this.y);
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  addNew(v) {
    return this.clone().add(v);
  }
  subtract(v) {
    this.x -= v.x;
    this.y -= v.y;
    return this;
  }
  subtractNew(v) {
    return this.clone().subtract(v);
  }
  multiply(v) {
    this.x *= v.x;
    this.y *= v.y;
    return this;
  }
  multiplyNew(v) {
    return this.clone().multiply(v);
  }
  scale(scalar) {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }
  scaleNew(scalar) {
    return this.clone().scale(scalar);
  }
  
  get array() {
    return [this.x, this.y];
  }
  get lengthSquared() {
    return this.x**2 + this.y**2;
  }
  get length() {
    return Math.hypot(this.x, this.y);
  }
  get angle() {
    return Math.atan2(this.y, this.x);
  }
  
  [Symbol.iterator]() {
    let values = this.array;
    let i = 0;
    return {
      next() {
        if(i < values.length) {
          let value = values[i];
          i++;
          return { value, done: false }
        } else return { done: true }
      }
    }
  }
}

class Particle {
  // Added 'char' to the constructor
  constructor({x, y, pinned, id, char}={}) {
    this.pos = new Vec2(x, y);
    this.oldPos = new Vec2(x, y);
    this.velocity = new Vec2()
    this.acceleration = new Vec2();
    this.pinned = pinned;
    this.id = id;
    this.char = char;
    this.gravityVec = new Vec2();
  }
  contain() {
    if(this.pinned) return;
    const radius = 5;
    
    if (this.pos.x < radius) {
      this.pos.x = radius;
      this.oldPos.x = this.pos.x + Math.abs(this.oldPos.x - this.pos.x) * 0.8;
    } else if (this.pos.x > CONFIG.awidth - radius) {
      this.pos.x = CONFIG.awidth - radius;
      this.oldPos.x = this.pos.x - Math.abs(this.oldPos.x - this.pos.x) * 0.8;
    }
    if (this.pos.y < radius) {
        this.pos.y = radius;
        this.oldPos.y = this.pos.y + Math.abs(this.oldPos.y - this.pos.y) * 0.8;
    } else if (this.pos.y > CONFIG.aheight - radius) {
        this.pos.y = CONFIG.aheight - radius;
        this.oldPos.y = this.pos.y - Math.abs(this.oldPos.y - this.pos.y) * 0.8;
    }
  }
  update(delta) {
    if(this.pinned) {
      this.acceleration.zero();
      return;
    }
    
    this.velocity.reset(
      (this.pos.x - this.oldPos.x) * CONFIG.damping,
      (this.pos.y - this.oldPos.y) * CONFIG.damping
    );
    
    this.oldPos.reset(...this.pos);
    
    const dd = delta**2;
    this.gravityVec.reset(0,CONFIG.gravity/dd)
    
    this.applyForce(this.gravityVec)
    
    this.pos.x += this.velocity.x + this.acceleration.x * dd;
    this.pos.y += this.velocity.y + this.acceleration.y * dd;
    
    this.acceleration.reset();
  }
  applyForce(v) {
    this.acceleration.add(v);
  }
}

class Constraint {
  // Horizontal ("spacer") constraints get their own compress/stretch factors
  // passed in at construction — see the two call sites in main().
  //
  // There used to be a c.addEventListener("update", …) here that recomputed
  // minLength/maxLength from an event's detail. No code in this file ever
  // dispatched an "update" event, so it never ran once — it only created one
  // listener and one closure per constraint (~2,800 of each at the current
  // grid) on first build and again on every resize rebuild. The `isSpacer`
  // flag was read solely inside it, and was never destructured here anyway.
  constructor({p1, p2, length, compressFactor, stretchFactor}) {
    this.p1 = p1;
    this.p2 = p2;
    this.length = length;
    this.minLength = length * compressFactor;
    this.maxLength = length * stretchFactor;
  }
  solve() {
    // Inline the vector math to avoid thrash
    const dx = this.p2.pos.x - this.p1.pos.x;
    const dy = this.p2.pos.y - this.p1.pos.y;
    const distance = Math.hypot(dx, dy);

    if (distance == 0) return;

    let targetLength = this.length;
    if (distance < this.minLength) targetLength = this.minLength;
    else if (distance > this.maxLength) targetLength = this.maxLength;
    else return;

    const difference = targetLength - distance;
    const percent = difference / distance / 2;

    const offsetX = dx * percent;
    const offsetY = dy * percent;

    if (!this.p1.pinned) {
      this.p1.pos.x -= offsetX;
      this.p1.pos.y -= offsetY;
    }
    if (!this.p2.pinned) {
      this.p2.pos.x += offsetX;
      this.p2.pos.y += offsetY;
    }
  }
}

createThemeNav();
// rebuildCloth() rather than a bare main(): it gates on the webfont, so the
// glyph atlas is never rasterised against a fallback face. The old fixed 500ms
// timer was a guess that happened to be long enough on a warm cache and far too
// short on a cold one.
rebuildCloth();