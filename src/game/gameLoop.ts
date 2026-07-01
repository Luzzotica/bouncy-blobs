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

// ---------------------------------------------------------------------------
// Frame-timing profiler.
//
// Each RAF appends a {frameMs, logicMs, renderMs, logicSteps, ts} entry to a
// ring buffer (capped at PROFILE_RING_SIZE). `__bbDebug.getFrameProfile()`
// returns the buffer for inspection. Used to pinpoint per-frame cost when
// framerate drops without an obvious culprit.
// ---------------------------------------------------------------------------

import { getSimSpeed } from '../lib/frameStep';

const PROFILE_RING_SIZE = 600; // ~10s @ 60Hz

export interface FrameSample {
  ts: number;       // performance.now() at RAF entry
  frameMs: number;  // wall-clock since last RAF
  logicMs: number;  // sum of onLogic invocations this RAF
  renderMs: number; // onRender duration
  logicSteps: number; // count of onLogic calls this RAF (0 if gated or accumulator-empty)
  /** True if `onLogic` was called and it returned `false` (lockstep gate
   * refused because authoritative inputs hadn't arrived yet). Distinguishes
   * "real jitter stall" from "accumulator hadn't reached FIXED_DT yet" —
   * the latter is normal on high-refresh-rate displays and is NOT a jitter
   * signal. */
  gated: boolean;
  /** Optional per-phase timings populated by callers via
   *  `recordPhaseTime`. Keyed by phase name (e.g. 'worldStep',
   *  'managers', 'camera'). Captures sum across all logic steps in the
   *  RAF. Use to identify which sub-phase dominates a slow tick. */
  phases?: Record<string, number>;
}

/** Accumulator shared between phase-time recorders and the GameLoop's
 *  RAF tick. Cleared at the start of every RAF; folded into the next
 *  FrameSample at the end. Avoids passing a "current frame" handle into
 *  every consumer. */
const phaseAccum: Record<string, number> = {};
export function recordPhaseTime(phase: string, ms: number): void {
  phaseAccum[phase] = (phaseAccum[phase] ?? 0) + ms;
}
function takePhaseAccum(): Record<string, number> | undefined {
  const keys = Object.keys(phaseAccum);
  if (keys.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = phaseAccum[k];
    delete phaseAccum[k];
  }
  return out;
}

const frameProfileRing: FrameSample[] = [];

/** Module-level accessor — wired into the debug bridge so the playwright
 *  diagnostic harness can pull samples without coupling to a specific
 *  GameLoop instance. */
export function getFrameProfile(): FrameSample[] {
  return frameProfileRing.slice();
}

export function resetFrameProfile(): void {
  frameProfileRing.length = 0;
}

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
  /** Optional dynamic cap on logic steps per RAF. Defaults to MAX_STEPS_PER_FRAME.
   * Guests in lockstep set this to 1 in steady state (and 2 when the input
   * buffer is over-deep) so a stalled RAF doesn't trigger a multi-step
   * burst that visibly fast-forwards the sim. */
  getMaxSteps?: () => number;
  /** Optional per-RAF clock adjustment in SECONDS, added to the accumulator
   * each frame (clamped to ±FIXED_DT). This is the netcode time-sync knob: a
   * guest running behind the host returns a small positive value to advance its
   * sim slightly faster (catch up); too far ahead returns negative to slow down.
   * Keeps the guest's tick clock aligned with the host so its tick-tagged inputs
   * arrive just-in-time and the host never has to roll them back. */
  getClockAdjust?: () => number;
}

export class GameLoop {
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private renderErrored = false;
  private readonly onLogic: (dt: number) => boolean | void;
  private readonly onRender?: (alpha: number) => void;
  private readonly getMaxSteps?: () => number;
  private readonly getClockAdjust?: () => number;

  constructor(callbacks: GameLoopCallbacks | ((dt: number) => void)) {
    if (typeof callbacks === 'function') {
      // Legacy single-callback signature — treat the whole thing as logic.
      this.onLogic = callbacks;
    } else {
      this.onLogic = callbacks.onLogic;
      this.onRender = callbacks.onRender;
      this.getMaxSteps = callbacks.getMaxSteps;
      this.getClockAdjust = callbacks.getClockAdjust;
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
    const frameMs = (now - this.lastTime);
    this.lastTime = now;
    // Slow-motion debug knob: scale real elapsed time so the sim runs slower
    // (synced across host + clients via the sim_speed event).
    this.accumulator += real * getSimSpeed();
    // Netcode time-sync nudge: speed up / slow down the sim slightly to keep the
    // guest's tick clock aligned with the host (clamped to ±one tick/frame so it
    // can never burst or freeze).
    if (this.getClockAdjust) {
      const adj = this.getClockAdjust();
      if (adj) this.accumulator += Math.max(-FIXED_DT, Math.min(FIXED_DT, adj));
    }

    const logicStart = performance.now();
    let steps = 0;
    let gated = false;
    const maxSteps = Math.max(1, Math.min(MAX_STEPS_PER_FRAME, this.getMaxSteps?.() ?? MAX_STEPS_PER_FRAME));
    while (this.accumulator >= FIXED_DT && steps < maxSteps) {
      const ran = this.onLogic(FIXED_DT);
      if (ran === false) {
        gated = true;
        break;
      }
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    // Drop excess accumulator when we hit the soft cap mid-RAF. Without this,
    // the next RAF would still see a "full" accumulator and try to drain
    // again — defeating the cap and producing exactly the burst-pause cycle
    // we use it to prevent.
    if (!gated && steps === maxSteps && this.accumulator >= FIXED_DT) {
      this.accumulator = 0;
    }
    const logicMs = performance.now() - logicStart;

    const renderStart = performance.now();
    // A render error must NOT kill the loop — otherwise one bad frame freezes the
    // whole sim (it never reaches the requestAnimationFrame below). Log once.
    try {
      this.onRender?.(this.accumulator / FIXED_DT);
    } catch (err) {
      if (!this.renderErrored) { this.renderErrored = true; console.error('[GameLoop] onRender threw (loop continues):', err); }
    }
    const renderMs = performance.now() - renderStart;

    frameProfileRing.push({ ts: now, frameMs, logicMs, renderMs, logicSteps: steps, gated, phases: takePhaseAccum() });
    if (frameProfileRing.length > PROFILE_RING_SIZE) frameProfileRing.shift();

    this.rafId = requestAnimationFrame(this.tick);
  };
}
