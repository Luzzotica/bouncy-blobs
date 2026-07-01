function hsvToRgb(h: number, s: number, v: number): string {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r: number, g: number, b: number;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// 16 hand-picked hues for maximum visual distinction
const PLAYER_HUES = [
  0.0,    // red
  0.58,   // cyan
  0.12,   // orange
  0.75,   // purple
  0.33,   // green
  0.92,   // magenta
  0.17,   // gold
  0.45,   // teal
  0.05,   // red-orange
  0.66,   // blue
  0.25,   // lime
  0.83,   // pink
  0.40,   // emerald
  0.54,   // sky blue
  0.08,   // amber
  0.70,   // indigo
];

export function playerColor(index: number): string {
  const hue = PLAYER_HUES[index % PLAYER_HUES.length];
  return hsvToRgb(hue, 0.55, 0.98);
}

export function playerColorAlpha(index: number, alpha: number): string {
  const hue = PLAYER_HUES[index % PLAYER_HUES.length];
  const h = hue, s = 0.55, v = 0.98;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r: number, g: number, b: number;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

export function npcColor(hue: number): string {
  return hsvToRgb(hue, 0.52, 0.98);
}

export const NPC_HUES = [0.08, 0.25, 0.42, 0.55, 0.75];
export const PLATFORM_COLOR = '#2a3a4a';
export const PLATFORM_BORDER = '#4a5a6a';
export const BACKGROUND_COLOR = '#1a1a2e';

// ── Theme ───────────────────────────────────────────────────────────────
// A whole-game visual theme switch. `cave` reskins the world to pure-black
// platforms on a deep-blue procedurally-decorated cavern; `classic` is the
// original candy look. Defaults to `cave` on this branch — append
// `?theme=classic` to the URL to compare against the original.
export type Theme = 'classic' | 'cave';

function readTheme(): Theme {
  try {
    const t = new URLSearchParams(window.location.search).get('theme');
    if (t === 'classic' || t === 'cave') return t;
  } catch {
    // non-browser (tests/SSR) — fall through to default
  }
  return 'cave';
}

export const THEME: Theme = readTheme();
export const isCave = THEME === 'cave';

// Cave palette ------------------------------------------------------------
/** Pure-black flat fill for every solid platform/surface in the cave theme. */
export const CAVE_PLATFORM_FILL = '#000000';

/** Deep-blue cavern backdrop gradient (top → middle → bottom), screen space. */
export const CAVE_BG_TOP = '#050a1c';
export const CAVE_BG_MID = '#0d1c3a';
export const CAVE_BG_BOTTOM = '#04060f';

/** Stalactite/stalagmite silhouette fills, back (recedes, lighter) → front
 * (near-black so black platforms still read on top). One entry per depth
 * layer; index 0 is the farthest. Stack: deep spikes, two column layers,
 * then two nearer spike layers. */
export const CAVE_ROCK_LAYERS = ['#2a4f82', '#1d3e6e', '#142a4e', '#0c1c38', '#05101f'];

/** Soft lighter pool behind the deepest rock — suggests cavern depth. */
export const CAVE_BACKWALL = 'rgba(40, 86, 150, 0.16)';

/** Faint cool drip/sheen highlight on cave rock forms. */
export const CAVE_ROCK_SHEEN = 'rgba(120, 180, 230, 0.10)';

/** Red accent for spike tips (the one warm warning cue, with lava). */
export const CAVE_SPIKE_TIP = '#ff3b4e';

// Toned-down gameplay overlays for the cave mood (cooler, lower intensity).
// Each is an {r,g,b} the renderers fold into their existing alpha ramps.
export const CAVE_GOAL_RGB = { r: 90, g: 210, b: 200 };   // dim teal (was neon green)
export const CAVE_HILL_RGB = { r: 210, g: 180, b: 120 };  // pale amber (was gold)
export const CAVE_GRAVITY_POINT_RGB = { r: 120, g: 110, b: 200 };   // muted indigo (was purple)
export const CAVE_GRAVITY_DIR_RGB = { r: 150, g: 140, b: 120 };     // cool taupe (was orange)
