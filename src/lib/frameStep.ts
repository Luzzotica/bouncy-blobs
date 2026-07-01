// Manual frame-stepping for netcode debugging. While the sim is PAUSED
// (pacingConfig.paused), the host can advance the game exactly one (or N) ticks
// on every peer at once: the host broadcasts a step command, each peer queues N
// steps here, and the game loop's pause gate consumes one per logic tick. Lets
// you freeze host + clients, compare per-tick hashes, advance one frame, and
// watch exactly where they diverge.

let pendingSteps = 0;

/** Queue N manual steps (additive). */
export function requestSteps(n = 1): void {
  pendingSteps += Math.max(1, Math.floor(n));
}

/** Consume one queued step. Returns true if a step was available (the game loop
 *  should run this tick despite being paused), false otherwise. */
export function consumeStep(): boolean {
  if (pendingSteps > 0) { pendingSteps -= 1; return true; }
  return false;
}

export function pendingStepCount(): number { return pendingSteps; }
export function clearSteps(): void { pendingSteps = 0; }

// Sim-speed multiplier (slow-motion). 1 = realtime; the game loop scales the
// real elapsed time fed to its accumulator by this, so 0.25 = quarter speed.
// Set on the host and mirrored to clients so everyone slows together (the
// tick-tagged inputs stay in sync — only the wall-clock rate changes).
let simSpeed = 1;
export function getSimSpeed(): number { return simSpeed; }
export function setSimSpeed(s: number): void {
  simSpeed = Number.isFinite(s) ? Math.max(0.05, Math.min(1, s)) : 1;
}
