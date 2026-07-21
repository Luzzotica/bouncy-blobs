import { describe, it, expect } from 'vitest';
import { colorName, paletteColorAt, PALETTE_COLOR_NAMES } from './colorNames';
import { COLOR_PALETTE } from '../constants/customization';

describe('colorName', () => {
  it('names every palette entry', () => {
    for (let i = 0; i < COLOR_PALETTE.length; i++) {
      expect(colorName(COLOR_PALETTE[i])).toBe(PALETTE_COLOR_NAMES[i]);
    }
  });

  it('matches case-insensitively / without hash', () => {
    expect(colorName('#E06070')).toBe('Red');
    expect(colorName('e06070')).toBe('Red');
  });

  it('nearest-neighbour for off-palette hex', () => {
    // Near teal #4ac8c8
    expect(colorName('#4bc9c9')).toBe('Teal');
  });

  it('falls back for garbage input', () => {
    expect(colorName('not-a-color')).toBe('Color');
  });
});

describe('paletteColorAt', () => {
  it('cycles the palette', () => {
    expect(paletteColorAt(0)).toBe(COLOR_PALETTE[0]);
    expect(paletteColorAt(COLOR_PALETTE.length)).toBe(COLOR_PALETTE[0]);
  });
});
