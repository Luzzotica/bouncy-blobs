import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./kidsVoice', () => ({
  playKidsLetter: vi.fn(),
}));

import { KidsAbcProgress, MIN_MS_BETWEEN_LETTERS } from './kidsAbc';
import { playKidsLetter } from './kidsVoice';

describe('KidsAbcProgress', () => {
  beforeEach(() => {
    vi.mocked(playKidsLetter).mockClear();
  });

  it('plays A then B then C on successive expand edges', () => {
    const abc = new KidsAbcProgress();
    expect(abc.onExpand(1000)).toBe('A');
    expect(abc.onExpand(2000)).toBe('B');
    expect(abc.onExpand(3000)).toBe('C');
    expect(playKidsLetter).toHaveBeenCalledTimes(3);
    expect(playKidsLetter).toHaveBeenNthCalledWith(1, 'A');
    expect(playKidsLetter).toHaveBeenNthCalledWith(2, 'B');
  });

  it('debounces rapid expand edges', () => {
    const abc = new KidsAbcProgress();
    expect(abc.onExpand(1000)).toBe('A');
    expect(abc.onExpand(1000 + MIN_MS_BETWEEN_LETTERS - 50)).toBeNull();
    expect(abc.onExpand(1000 + MIN_MS_BETWEEN_LETTERS + 10)).toBe('B');
  });

  it('wraps Z → A', () => {
    const abc = new KidsAbcProgress();
    for (let i = 0; i < 26; i++) {
      abc.onExpand(1000 + i * 500);
    }
    expect(abc.peek()).toBe('A');
    expect(abc.onExpand(1000 + 26 * 500)).toBe('A');
  });

  it('reset restarts at A', () => {
    const abc = new KidsAbcProgress();
    abc.onExpand(1000);
    abc.onExpand(2000);
    abc.reset();
    expect(abc.peek()).toBe('A');
    expect(abc.onExpand(3000)).toBe('A');
  });
});
