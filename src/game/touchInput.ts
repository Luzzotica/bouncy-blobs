import { shapeJoystickInput } from '../lib/joystickInput';

/**
 * On-screen touch input for standalone (local) play. Mirrors the read API of
 * `KeyboardInput` (getMoveX/getMoveY/isExpanding) so gameplay loops can merge
 * the two sources without caring where input came from. The values are fed by
 * the <TouchControls> component via setVector()/setExpanding().
 *
 * Shaping goes through the same `shapeJoystickInput` used by the phone
 * controller (Controller.tsx) so a blob moves identically whether it's driven
 * by a remote phone or the local on-screen pad.
 */
export class TouchInput {
  private x = 0;
  private y = 0;
  private expanding = false;

  /** dx/dy are the touch offset from the pad center, normalized to [-1, 1]. */
  setVector(dx: number, dy: number): void {
    const shaped = shapeJoystickInput(dx, dy);
    this.x = shaped.x;
    this.y = shaped.y;
  }

  release(): void {
    this.x = 0;
    this.y = 0;
  }

  setExpanding(pressed: boolean): void {
    this.expanding = pressed;
  }

  // --- KeyboardInput-compatible read API (slot arg ignored; touch = slot 1) ---
  getMoveX(_slot: 1 | 2 = 1): number { return this.x; }
  getMoveY(_slot: 1 | 2 = 1): number { return this.y; }
  isExpanding(_slot: 1 | 2 = 1): boolean { return this.expanding; }
}

/**
 * Whether to show the on-screen pad: a coarse pointer (touch) OR a narrow
 * viewport. Mirrors tankii's `shouldUsePad()` heuristic. Evaluated once at
 * mount; callers that need reactivity should re-check on resize.
 */
export function shouldUsePad(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const touch = 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const narrow = window.innerWidth <= 820;
  return coarse || touch || narrow;
}
