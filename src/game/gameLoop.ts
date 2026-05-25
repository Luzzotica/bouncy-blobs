// ─────────────────────────────────────────────────────────────────────────────
// GameLoop — fixed-timestep accumulator with RAF render pacing.
//
// Logic runs at a fixed dt (default 1/60 s). Each animation frame:
//   1. accumulate the real elapsed time
//   2. drain it in fixed-dt steps via `onLogic(FIXED_DT)`
//   3. paint once via `onRender(interpolationAlpha)`
//
// Why: simulation determinism depends on every client running the same number
// of logic steps with the same dt for the same sim time. RAF-driven variable
// dt produces different float-integration paths on different machines even
// when the user inputs are identical. Fixed dt removes that source of drift.
//
// `onRender` receives `interpolationAlpha` in [0, 1) — the fraction of a logic
// step remaining in the accumulator. Renderers that interpolate visual state
// between physics steps use it; ones that don't can ignore it.
//
// Back-compat: passing a single function (the old signature) wraps it as
// `onLogic` and runs render-free. Callers that combined logic+render in the
// same callback get the same observable behavior, just with deterministic dt.
// ─────────────────────────────────────────────────────────────────────────────

export const FIXED_DT = 1 / 60;
/** Hard ceiling on logic steps per RAF — avoids the spiral of death if a tab
 * was backgrounded for minutes. Frames past this just get dropped on the floor. */
const MAX_STEPS_PER_FRAME = 5;

export interface GameLoopCallbacks {
  /** Runs N times per RAF (0 ≤ N ≤ MAX_STEPS_PER_FRAME). Always invoked with
   * `FIXED_DT`. Mutates simulation state.
   *
   * Return `false` (or void/undefined) to **skip** this logic step without
   * draining the accumulator — the loop tries again on the next RAF. Use
   * case: a lockstep client pauses its sim until the next tick's
   * authoritative inputs have arrived. Return `true` (or void) when work
   * was done and the accumulator should advance. */
  onLogic: (dt: number) => boolean | void;
  /** Runs once per RAF, after the logic steps. `alpha` is the fraction of
   * a logic step remaining in the accumulator — use to interpolate visuals. */
  onRender?: (alpha: number) => void;
}

export class GameLoop {
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private readonly onLogic: (dt: number) => boolean | void;
  private readonly onRender?: (alpha: number) => void;

  constructor(callbacks: GameLoopCallbacks | ((dt: number) => void)) {
    if (typeof callbacks === 'function') {
      // Legacy single-callback signature — treat the whole thing as logic.
      this.onLogic = callbacks;
    } else {
      this.onLogic = callbacks.onLogic;
      this.onRender = callbacks.onRender;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.tick(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    // Cap the real elapsed at ~250 ms so a backgrounded tab doesn't try to
    // burn the cpu catching up. Anything past that just gets discarded.
    const real = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    this.accumulator += real;

    let steps = 0;
    let gated = false;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      const ran = this.onLogic(FIXED_DT);
      if (ran === false) {
        // Gated — sim doesn't advance this frame. Leave accumulator full
        // so the next RAF tries again. Common case: lockstep client
        // waiting for inputs that haven't arrived yet.
        gated = true;
        break;
      }
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    // Spiral-of-death prevention: only drop overflow when we actually
    // tried and couldn't keep up — never when the gate was blocking.
    if (!gated && steps === MAX_STEPS_PER_FRAME && this.accumulator >= FIXED_DT) {
      this.accumulator = 0;
    }

    this.onRender?.(this.accumulator / FIXED_DT);

    this.rafId = requestAnimationFrame(this.tick);
  };
}
