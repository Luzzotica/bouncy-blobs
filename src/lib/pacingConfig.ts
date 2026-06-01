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
  /** Host: how many ticks between periodic full-state keyframes. 60 = ~1s
   * (default), 0 = disabled. The compact slot-based input format + K=120
   * input redundancy on the unreliable channel mean inputs are nearly
   * never lost, but keyframes are still the recovery path if a desync
   * does occur (cross-browser float drift, integrator skew, etc.). */
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
   * Default is FALSE while the Rust engine migration is in progress:
   * with the engine proven cross-tab deterministic and rollback
   * machinery introducing edge-case ring/timing mismatches (the
   * default cross-tab determinism test flapped between 0 and 30
   * mismatches per run with rollback ON), shipping with rollback OFF
   * gives stable lockstep play. Once the Phase 2-8 manager migrations
   * land and rollback's interaction with the hash ring is fully
   * audited, this can flip back on. */
  enableRollback: boolean;
}

const config: PacingConfig = {
  inputDelayTicks: 2,
  bufferTarget: 3,
  keyframeIntervalTicks: 60,
  stallPredictThreshold: 3,
  // Default to OFF so 2-tab desync diagnostics can verify whether
  // prediction is the cause. Flip to true to re-enable Phase 3
  // local-player prediction.
  clientPrediction: false,
  paused: false,
  enableRollback: false,
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

/** How many ticks of inputs each broadcast carries. K=60 (1 s) covers any
 *  plausible network gap before the guest's predict-on-stall path kicks in,
 *  and at 60Hz broadcast each specific tick appears in 60 consecutive
 *  packets — even 25%/packet loss leaves ~45 redundant copies of each tick
 *  on average. Compact v2 format keeps the packet at ~1.5 KB for 5 players
 *  (2 SCTP fragments at typical WebRTC MTU). */
export const REDUNDANCY_TICKS = 60;
