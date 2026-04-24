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
