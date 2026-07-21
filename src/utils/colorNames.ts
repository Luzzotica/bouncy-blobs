/**
 * Map blob hex colors → short spoken names for Kids Mode.
 * Nearest-neighbour match so custom / slightly-off hexes still get a word.
 */

import { COLOR_PALETTE } from '../constants/customization';

/** Canonical spoken names aligned with COLOR_PALETTE order. */
export const PALETTE_COLOR_NAMES: readonly string[] = [
  'Red',
  'Orange',
  'Yellow',
  'Green',
  'Teal',
  'Blue',
  'Purple',
  'Pink',
  'White',
  'Red',
  'Blue',
  'Purple',
] as const;

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function dist2(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/** Return a kid-friendly spoken color name for a CSS hex. */
export function colorName(hex: string): string {
  const c = parseHex(hex);
  if (!c) return 'Color';

  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < COLOR_PALETTE.length; i++) {
    const p = parseHex(COLOR_PALETTE[i]);
    if (!p) continue;
    const d = dist2(c, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return PALETTE_COLOR_NAMES[best] ?? 'Color';
}

/** Distinct palette color for NPC index i (cycles). */
export function paletteColorAt(i: number): string {
  return COLOR_PALETTE[i % COLOR_PALETTE.length];
}
