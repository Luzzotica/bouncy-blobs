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

export function playerColor(index: number): string {
  const hue = (index * 0.19) % 1.0;
  return hsvToRgb(hue, 0.52, 0.98);
}

export function playerColorAlpha(index: number, alpha: number): string {
  const hue = (index * 0.19) % 1.0;
  const h = hue, s = 0.52, v = 0.98;
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
