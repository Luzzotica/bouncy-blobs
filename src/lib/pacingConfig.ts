// Live-tunable lockstep pacing configuration. Mirrors the netSim singleton
// pattern: a mutable record + subscribe API so the debug overlay can edit
// values without reloading the page (URL params still seed initial values).
//
// Host reads `inputDelayTicks` each preTickHook to decide how far ahead to
// schedule input. Guest reads `bufferTarget` each RAF to decide how many
// logic steps to allow. Both are safe to mutate mid-round — changes apply
// from the next tick.

export interface PacingConfig {
  /** Guest forward-tags input messages with `world.tick + 1 + inputDelayTicks`.
   * Host buffers and applies the input at that exact tick. The N-tick gap
   * absorbs typical network jitter so the host doesn't drop the input as
   * "late" — without rollback (our current default), any input arriving
   * after the host already ran the claimed tick is silently dropped, which
   * stalls the guest's lockstep gate. N=2 ≈ 33ms input lag in exchange
   * for ~0% stalls under normal jitter. Live-tunable via debug overlay
   * and `?inputDelay=N`. */
  inputDelayTicks: number;
  /** Guest: steady-state target for `latestHostTick - world.tick`.
   * Guest allows a 2nd step per RAF when `depth >= bufferTarget + 2`.
   * Higher = more tolerance for jitter at the cost of input latency. */
  bufferTarget: number;
  /** Host: how many ticks between periodic full-state keyframes. Default 0
   * = DISABLED. The deterministic Rust engine running the host-stamped
   * input stream keeps every peer bit-identical, so periodic full-state
   * resyncs are unnecessary — and the resync visibly glitched the guest
   * when it landed. Keyframes fire ONLY on bootstrap/join/leave
   * (forceKeyframeRef). Set `?keyframe=N` to re-introduce a safety cadence
   * (N ticks) if a determinism bug ever needs masking while debugging. */
  keyframeIntervalTicks: number;
  /** Guest: when true, the guest's own player input is applied LOCALLY
   * the moment a key event fires (client-side prediction) and the
   * lockstep gate skips the local player when applying host's
   * authoritative echo. When false, guest's own input flows through
   * the full round-trip: keyboard → WebRTC → host → broadcast → guest
   * lockstep gate → apply. Sims match perfectly (no local prediction
   * to drift), at the cost of ~80ms perceived input lag on the
   * guest's own player. Useful for A/B testing whether residual
   * desync is from prediction. */
  clientPrediction: boolean;
  /** Either side: when true, the game loop's logic gate returns false
   * unconditionally — physics stops advancing while the renderer keeps
   * drawing. Used by the "compare hashes" diagnostic to freeze both
   * sides at known tick numbers so we can compare per-tick state
   * hashes without the sim drifting under us. Host's overlay toggle
   * also broadcasts the new value to all guests so both sides pause
   * together. */
  paused: boolean;
  /** Guest: how many consecutive frames the lockstep gate may stay starved
   * before the guest enters predict-and-rewind mode (Phase 4). Below this
   * threshold the guest just stalls (cheaper, no rollback cost). Above it,
   * the guest speculatively advances using each remote player's last-known
   * input; when authoritative inputs arrive, it rewinds to the last
   * confirmed tick and replays. Default 3 ticks (~50ms) — the K=120
   * redundancy window means this should rarely trigger. */
  stallPredictThreshold: number;
  /** Either side: when true, host applies late guest inputs via a
   * rollback (rc.onAuthoritativeInputs) and guest reconciles incoming
   * authoritative inputs against its predictions the same way. When
   * false, both sides just stall on missing inputs and rely on the
   * deterministic engine + bootstrap keyframe for sync.
   *
   * Default is FALSE. The shipping model is pure host-authoritative
   * lockstep with NO prediction and NO rollback: the guest sends its raw
   * key state to the host (untagged); the host applies it at its OWN
   * current tick and broadcasts it back stamped with that tick; guests
   * apply the host's stamped inputs in strict lockstep (~2× ping after the
   * keypress). Because the host assigns the tick on arrival, an input is
   * never "in the past" — the host never needs to roll back, and guests
   * never speculate, so there is nothing to reconcile. Rollback remains an
   * opt-in experiment (`?rollback=1`) for client-side prediction; its
   * machinery (RollbackController) is still exercised by
   * lockstepLatency.test.ts. The Rust+wasm engine's determinism
   * (rollbackExactness.test.ts) is what lets strict lockstep stay
   * bit-identical across peers. */
  enableRollback: boolean;
}

const config: PacingConfig = {
  // 3-frame input delay (spec): each peer tags its own input 3 ticks ahead so
  // it arrives before the tick it applies at, under typical jitter.
  inputDelayTicks: 3,
  // Ride the razor's edge — keep ~1-2 buffered inputs to play out. The host
  // pacing controller nudges clients toward this depth.
  bufferTarget: 2,
  // 0 = NO periodic keyframes. The sim is deterministic (Rust integer
  // engine) and runs off the host-stamped input stream, so a periodic
  // full-state resync is unnecessary — and it visibly glitched the guest
  // when it landed. Keyframes now fire ONLY on bootstrap/join/leave
  // (forceKeyframeRef). Re-enable a safety cadence with `?keyframe=N`.
  keyframeIntervalTicks: 0,
  stallPredictThreshold: 3,
  // ON by default — the guest applies its OWN input locally the instant a key
  // fires (writeLocalIntent) and the rollback reconcile skips the local player
  // so its prediction is never rubber-banded to the host's delayed echo. This
  // is what makes the guest's own actions feel instant. `?prediction=off`
  // (which also disables usePrediction) reverts to pure lockstep.
  clientPrediction: true,
  paused: false,
  // ON by default — symmetric Overwatch-style rollback. The deterministic
  // Rust+wasm engine makes restore→replay bit-identical, so both the guest
  // (reconciling predicted vs authoritative inputs) and the host (reconciling
  // late guest inputs) can roll back cleanly. `?rollback=0` falls back to the
  // old pure-lockstep path for A/B diagnostics. See field doc above.
  enableRollback: true,
};

const listeners = new Set<(c: PacingConfig) => void>();

export function getPacingConfig(): PacingConfig {
  return { ...config };
}

export function setPacingConfig(patch: Partial<PacingConfig>): void {
  Object.assign(config, patch);
  for (const l of listeners) l(getPacingConfig());
}

export function subscribePacing(fn: (c: PacingConfig) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Seeds from `?inputDelay=N&buffer=N&keyframe=N&stallPredict=N`. Missing
 *  params keep defaults. Call once on mount; runtime mutation goes
 *  through the setters and the overlay. */
export function initPacingFromUrl(search: string = window.location.search): void {
  const sp = new URLSearchParams(search);
  const patch: Partial<PacingConfig> = {};
  const intParam = (name: string, min: number, max: number): number | undefined => {
    const raw = sp.get(name);
    if (raw === null) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };
  const id = intParam('inputDelay', 0, 30); if (id !== undefined) patch.inputDelayTicks = id;
  const bt = intParam('buffer', 0, 30); if (bt !== undefined) patch.bufferTarget = bt;
  const kf = intParam('keyframe', 0, 3600); if (kf !== undefined) patch.keyframeIntervalTicks = kf;
  const sp_ = intParam('stallPredict', 1, 30); if (sp_ !== undefined) patch.stallPredictThreshold = sp_;
  const cp = sp.get('clientPrediction');
  if (cp !== null) patch.clientPrediction = cp === '1' || cp === 'on' || cp === 'true';
  const rb = sp.get('rollback');
  if (rb !== null) patch.enableRollback = rb === '1' || rb === 'on' || rb === 'true';
  if (Object.keys(patch).length > 0) setPacingConfig(patch);
}

/** How many ticks of inputs each broadcast carries (spec: "send last 16
 *  frames of input, compressed"). At 60Hz broadcast each specific tick appears
 *  in 16 consecutive packets, so even ~25%/packet loss leaves ~12 redundant
 *  copies — enough to cover the ≤7-frame rollback window before a gap would
 *  force a stall. Smaller than the old K=60 so the per-peer single-slot stream
 *  stays tiny at 8 players. Compact v2 format ≈ 4 bytes per player-tick. */
export const REDUNDANCY_TICKS = 16;
