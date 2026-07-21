/**
 * Kids Mode ABC rule
 * ------------------
 * When the kid's blob **expands** (rising edge of expand input on the
 * player — puff button / space / pad expand), play the next letter of the
 * alphabet via bundled voice clips.
 *
 * Sequence: A → B → C → … → Z → A (cycles forever).
 *
 * Debounced so held expand does not spam letters.
 * Callers must only invoke onExpand on a true rising edge (not while held).
 *
 * See GOAL.md §3 and inbox P0 kids-voice (Sterling: expand, not land).
 */

import { playKidsLetter } from './kidsVoice';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Don't spam letters if expand edges arrive back-to-back (bounce + pad). */
export const MIN_MS_BETWEEN_LETTERS = 280;

export class KidsAbcProgress {
  private index = 0;
  private lastSpokeAt = 0;

  /**
   * Advance and play the next letter on an expand rising edge.
   * Returns the letter, or null if debounced.
   */
  onExpand(nowMs: number = performance.now()): string | null {
    if (nowMs - this.lastSpokeAt < MIN_MS_BETWEEN_LETTERS) return null;
    const letter = LETTERS[this.index % LETTERS.length];
    this.index = (this.index + 1) % LETTERS.length;
    this.lastSpokeAt = nowMs;
    playKidsLetter(letter);
    return letter;
  }

  reset(): void {
    this.index = 0;
    this.lastSpokeAt = 0;
  }

  /** Current next letter (for HUD/debug); does not advance. */
  peek(): string {
    return LETTERS[this.index % LETTERS.length];
  }

  spokenCount(): number {
    return this.index;
  }
}
