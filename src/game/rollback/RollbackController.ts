// Client-side prediction with rollback (GGPO-style).
//
// The deterministic Rust+wasm engine makes this cheap and correct:
// every restore → replay produces bit-identical state, so the player
// never sees prediction diverge from authoritative outcome.
//
// Flow per tick on a prediction-enabled client:
//   1. beforeTick(): assemble the input set for `world.tick + 1`.
//      - Local player: read keyboard NOW (no waiting on host echo).
//      - Remote players: reuse each player's LAST KNOWN authoritative
//        input. If they were pressing right last we saw, assume they
//        still are.
//   2. World steps with those inputs (caller does world.step + manager
//      updates inside the game loop's onLogic).
//   3. afterTick(): snapshot engine + game state into the ring buffer,
//      keyed by the tick we just completed.
//
// When the host's authoritative inputs arrive for tick T:
//   4. onAuthoritativeInputs(): compare to what we predicted at T.
//      - If equal → no rollback, just stash for the lastKnownInput map.
//      - If different → restore snapshot at T-1, splice the corrected
//        input set into the input history, fast-forward from T..current
//        re-applying each tick's now-best-known input set, re-snapshotting
//        each step.
//
// Memory: ~6 KB engine + ~2 KB game state per tick × 30 ticks = ~240 KB
// ring buffer. Cheap.

import type { SoftBodyEngine } from '../../physics/SoftBodyEngine';
import type { BouncyBlobsGame, GameStateSnapshot } from '../bouncyBlobsGame';

export interface PlayerInput {
  moveX: number;
  moveY: number;
  expanding: boolean;
}

export type InputSet = Record<string, PlayerInput>;

interface TickRecord {
  tick: number;
  /** Engine snapshot captured BEFORE this tick's step ran. Restoring
   *  this puts the engine back to the state at the START of `tick`. */
  engineBuf: Uint8Array;
  /** Game-state snapshot also captured BEFORE this tick. */
  gameState: GameStateSnapshot;
  /** The input set that was USED for this tick (may have been a
   *  prediction). Stored so a rollback can re-run with corrected
   *  inputs if/when they arrive. */
  inputs: InputSet;
}

export interface RollbackConfig {
  /** Maximum number of past ticks we keep around for rollback. */
  maxRollbackTicks?: number;
  /** Snapshot every N ticks instead of every tick. With N=4 at 60Hz,
   *  we snapshot at ~15Hz (every 67ms) and replay up to 3 ticks on
   *  rollback. The snapshot work (engine serialize + game-state
   *  dumpState fan-out) was the dominant per-frame cost — snapshotting
   *  every tick made GC pause every ~16ms and dropped framerate to 30.
   *  Input history is still recorded per tick so replay reapplies the
   *  right inputs at the right ticks. */
  snapshotInterval?: number;
  /** Local player id (whose input is read each tick from keyboard). */
  localPlayerId: string;
  /** Read local keyboard input NOW. Called once per tick. */
  readLocalInput: () => PlayerInput;
  /** Apply a full input set to the game (typically: write
   *  ManagedPlayer.moveX/Y/expanding for each id). */
  applyInputs: (inputs: InputSet) => void;
  /** Run one logic tick (world.step + manager updates). Called during
   *  rewind/replay. */
  stepOne: () => void;
}

const DEFAULT_MAX_ROLLBACK = 30; // ~500ms at 60Hz
// Bumped from 4 → 10 after M5 user report. Snapshots dominate per-tick
// CPU because of the wasm→JS Uint8Array copy + game-state object-tree
// allocation across 8 managers. At 60Hz × 10-tick interval = 6 snapshots
// per second; rollback worst-case replay is 9 ticks (~150ms of sim work,
// <10ms wall-clock). Tradeoff acceptable: a misprediction at tick T is
// corrected by restoring tick floor(T/10)*10 and replaying. Some extra
// ticks of replay are cheap because the engine is fast.
const DEFAULT_SNAPSHOT_INTERVAL = 10;

export class RollbackController {
  private readonly maxTicks: number;
  private readonly snapshotInterval: number;
  private readonly localPlayerId: string;
  private readonly readLocalInput: () => PlayerInput;
  private readonly applyInputs: (inputs: InputSet) => void;
  private readonly stepOne: () => void;

  /** Snapshots taken at coarse intervals (every snapshotInterval ticks). */
  private ring: TickRecord[] = [];
  /** Per-tick predicted inputs — kept at fine granularity so replay
   *  reapplies the right inputs at each replayed tick. Allocations
   *  here are tiny (~50 bytes per tick) so even 30 ticks is fine. */
  private inputHistory: Map<number, InputSet> = new Map();
  /** Authoritative inputs received from host, keyed by tick. Authoritative
   *  inputs may arrive late (after the local sim already predicted that
   *  tick) or early (faster than the local sim is running). */
  private authInputs: Map<number, InputSet> = new Map();
  /** Per-player most recently seen authoritative input. Used to predict
   *  what they're doing right now when no fresher input is known. */
  private lastKnownInput: Map<string, PlayerInput> = new Map();
  /** True when the local engine is currently being rolled back / replayed
   *  so callers (notably the trigger-listener fan-out) can suppress
   *  side effects that should only fire on the LIVE timeline. */
  private rewinding = false;

  /** Stats for the debug bridge. */
  rollbacksApplied = 0;
  lastRollbackDepth = 0;
  /** Stale-ring resets (e.g. when a player joins and the engine's blob
   *  count changes, invalidating every prior snapshot). Surfaces in the
   *  debug overlay so we can see this happening. */
  ringInvalidations = 0;
  /** Number of times we attempted a rollback but engine.restoreState
   *  returned false — typically a blob-count mismatch from a player
   *  join. We bail out instead of corrupting state. */
  failedRestores = 0;
  /** Rolling 60-sample averages of per-tick cost (milliseconds). The
   *  snapshot bucket only sees N-th tick samples; the cheap bucket
   *  sees every other tick. Helpful for confirming whether the
   *  per-tick rollback bookkeeping or the snapshot work is the
   *  dominant cost. */
  private snapshotTimes: number[] = [];
  private cheapTickTimes: number[] = [];
  private reconcileTimes: number[] = [];

  /** Particle count of the last snapshot we took. If the engine's count
   *  changes (new player joins → new blob), every snapshot in the ring
   *  is stale (different particle count → restore_state fails). */
  private lastParticleCount = -1;

  constructor(opts: RollbackConfig) {
    this.maxTicks = opts.maxRollbackTicks ?? DEFAULT_MAX_ROLLBACK;
    this.snapshotInterval = Math.max(1, opts.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL);
    this.localPlayerId = opts.localPlayerId;
    this.readLocalInput = opts.readLocalInput;
    this.applyInputs = opts.applyInputs;
    this.stepOne = opts.stepOne;
  }

  isRewinding(): boolean { return this.rewinding; }

  /** Predict the input set for the upcoming tick. Returns the input
   *  set that the caller should APPLY before stepping. */
  predictInputs(): InputSet {
    const out: InputSet = {};
    // Remote players: reuse their last-known authoritative input (or
    // default to zero if we've never seen them).
    for (const [pid, inp] of this.lastKnownInput) {
      out[pid] = { ...inp };
    }
    // Local player: live keyboard wins.
    out[this.localPlayerId] = this.readLocalInput();
    return out;
  }

  /** Snapshot the engine + game state AFTER applying inputs but BEFORE
   *  stepping. Restoring this record puts the engine back at the
   *  state-at-start-of-tick-T with the correct inputs already applied.
   *
   *  Call this once per logic tick, in the game loop, AFTER you've
   *  applied the input set and BEFORE world.step(). */
  recordTick(tick: number, inputs: InputSet, engine: SoftBodyEngine, game: BouncyBlobsGame): void {
    if (this.rewinding) return; // don't double-snapshot during replay

    const tStart = performance.now();

    // Per-tick input history is always recorded — tiny allocation, used
    // by replay to reapply the right inputs at each replayed tick.
    this.inputHistory.set(tick, cloneInputs(inputs));
    // Drop input history older than the rollback window.
    const oldestKeep = tick - this.maxTicks;
    if (oldestKeep > 0) {
      for (const t of this.inputHistory.keys()) {
        if (t < oldestKeep) this.inputHistory.delete(t);
      }
    }

    // Snapshot every Nth tick — the heavy cost (engine serialize + game
    // state dump) is what was driving 60→30 fps when done per-tick.
    if (tick % this.snapshotInterval !== 0) {
      pushBounded(this.cheapTickTimes, performance.now() - tStart);
      return;
    }

    // Cheap engine-layout-change check using the new particleCount()
    // accessor (no allocation, unlike the previous `.pos.length` which
    // materialized a fresh Vec2[] each tick on the wasm wrapper).
    const particles = engine.particleCount();
    if (this.lastParticleCount >= 0 && particles !== this.lastParticleCount) {
      this.ring.length = 0;
      this.ringInvalidations += 1;
    }
    this.lastParticleCount = particles;

    this.ring.push({
      tick,
      engineBuf: engine.serializeState(),
      gameState: game.snapshotGameState(),
      inputs: cloneInputs(inputs),
    });
    while (this.ring.length > this.maxTicks) {
      this.ring.shift();
    }
    pushBounded(this.snapshotTimes, performance.now() - tStart);
  }

  /** Average ms of recent recordTick calls, split by snapshot vs no-snapshot.
   *  Used by the debug bridge to pinpoint whether the per-tick overhead is
   *  the snapshot work or something elsewhere in the loop. */
  getTimingStats(): {
    avgSnapshotMs: number;
    avgCheapTickMs: number;
    avgReconcileMs: number;
    snapshotSamples: number;
    cheapSamples: number;
  } {
    return {
      avgSnapshotMs: avg(this.snapshotTimes),
      avgCheapTickMs: avg(this.cheapTickTimes),
      avgReconcileMs: avg(this.reconcileTimes),
      snapshotSamples: this.snapshotTimes.length,
      cheapSamples: this.cheapTickTimes.length,
    };
  }

  /** External hook — call after the keyframe-restore path or
   *  `game.onPlayerJoin` to drop stale snapshots. The recordTick auto-
   *  detection covers most cases, but explicit invalidation is safer
   *  for events that mutate engine layout mid-frame. */
  invalidateRing(reason: string = 'external'): void {
    if (this.ring.length === 0) return;
    this.ring.length = 0;
    this.ringInvalidations += 1;
    // Debug log; keeps the netplay-overlay informative without spamming.
    if (typeof console !== 'undefined') {
      console.info(`[rollback] ring invalidated (${reason})`);
    }
  }

  /** Host's authoritative inputs for one or more past ticks arrived.
   *  If the prediction at that tick differs from the authoritative
   *  inputs, restore + replay. Returns the number of ticks rewound
   *  (0 if no rollback was needed). */
  onAuthoritativeInputs(
    inputsByTick: Map<number, InputSet>,
    engine: SoftBodyEngine,
    game: BouncyBlobsGame,
  ): number {
    const tStart = performance.now();
    const result = this.reconcileImpl(inputsByTick, engine, game);
    pushBounded(this.reconcileTimes, performance.now() - tStart);
    return result;
  }

  private reconcileImpl(
    inputsByTick: Map<number, InputSet>,
    engine: SoftBodyEngine,
    game: BouncyBlobsGame,
  ): number {
    // Update lastKnownInput from the freshest authoritative we got.
    let freshestTick = -1;
    for (const [tick, inputs] of inputsByTick) {
      this.authInputs.set(tick, inputs);
      if (tick > freshestTick) freshestTick = tick;
    }
    if (freshestTick >= 0) {
      const fresh = inputsByTick.get(freshestTick)!;
      for (const [pid, inp] of Object.entries(fresh)) {
        this.lastKnownInput.set(pid, { ...inp });
      }
    }

    // Find the EARLIEST tick where prediction (in inputHistory) differs
    // from authoritative. With coarse snapshots, the per-tick input
    // history is the source of truth for "what we predicted".
    let earliestMismatch = -1;
    for (const [tick, auth] of inputsByTick) {
      const predicted = this.inputHistory.get(tick);
      if (!predicted) continue; // we don't have history for this tick — skip
      if (!inputsEqual(predicted, auth)) {
        if (earliestMismatch < 0 || tick < earliestMismatch) earliestMismatch = tick;
      }
    }
    if (earliestMismatch < 0) return 0;

    // Find the LATEST snapshot at or before earliestMismatch (snapshots
    // are coarse — at every snapshotInterval ticks).
    let startIdx = -1;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].tick <= earliestMismatch) { startIdx = i; break; }
    }
    if (startIdx < 0) {
      // No snapshot available before the mismatch — too old or none
      // taken yet. Drop the ring; next snapshot will re-establish a
      // baseline.
      this.invalidateRing('no snapshot at or before mismatch tick');
      return 0;
    }
    const startRec = this.ring[startIdx];
    const currentTick = engine.tick;
    this.lastRollbackDepth = currentTick - startRec.tick;

    // restoreState returns false if the snapshot's layout doesn't match
    // the live engine (most commonly: a player joined after the snapshot
    // was taken). Bail out cleanly instead of replaying from a state
    // that wasn't actually restored — that would corrupt the sim.
    if (!engine.restoreState(startRec.engineBuf)) {
      this.failedRestores += 1;
      this.invalidateRing('restore returned false (likely blob count mismatch)');
      return 0;
    }
    game.restoreGameState(startRec.gameState);
    // Drop snapshots after startIdx (we'll re-snapshot during replay
    // at the natural snapshotInterval boundaries).
    this.ring.length = startIdx + 1;

    this.rewinding = true;
    try {
      // Replay each tick from startRec.tick up to (but not including)
      // currentTick. For each tick t:
      //   - inputs = authoritative if known else inputHistory[t]
      //   - apply, step
      //   - update inputHistory[t] with the input we actually used
      //     (so a SUBSEQUENT rollback sees the corrected version)
      //   - re-snapshot every snapshotInterval ticks
      for (let t = startRec.tick; t < currentTick; t++) {
        // For each replayed tick t:
        //   - if we have authoritative inputs for t, use them (ground truth)
        //   - otherwise: PREDICT remote players from lastKnownInput (the
        //     freshest authoritative we've seen for them), and use our
        //     own historical input for the local player (we know what
        //     we pressed at tick t even if no auth ever arrived).
        const auth = this.authInputs.get(t);
        let inputs: InputSet;
        if (auth) {
          inputs = auth;
        } else {
          inputs = this.predictInputsForTick(t);
          const hist = this.inputHistory.get(t);
          if (hist && hist[this.localPlayerId]) {
            inputs[this.localPlayerId] = hist[this.localPlayerId];
          }
        }
        this.applyInputs(inputs);
        this.inputHistory.set(t, cloneInputs(inputs));
        if (t > startRec.tick && t % this.snapshotInterval === 0) {
          this.ring.push({
            tick: t,
            engineBuf: engine.serializeState(),
            gameState: game.snapshotGameState(),
            inputs: cloneInputs(inputs),
          });
        }
        this.stepOne();
      }
    } finally {
      this.rewinding = false;
    }

    while (this.ring.length > this.maxTicks) this.ring.shift();
    this.rollbacksApplied += 1;
    return this.lastRollbackDepth;
  }

  /** Same prediction logic as `predictInputs()` but without reading
   *  the live keyboard — used during replay where local input must
   *  also come from history. */
  private predictInputsForTick(_tick: number): InputSet {
    const out: InputSet = {};
    for (const [pid, inp] of this.lastKnownInput) {
      out[pid] = { ...inp };
    }
    return out;
  }

  /** Prune the auth-input map to ticks within the rollback window. */
  pruneOlderThan(oldestKeepTick: number): void {
    for (const t of [...this.authInputs.keys()]) {
      if (t < oldestKeepTick) this.authInputs.delete(t);
    }
  }
}

const TIMING_WINDOW = 60;
function pushBounded(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > TIMING_WINDOW) arr.shift();
}
function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

function cloneInputs(src: InputSet): InputSet {
  const out: InputSet = {};
  for (const [pid, inp] of Object.entries(src)) {
    out[pid] = { moveX: inp.moveX, moveY: inp.moveY, expanding: inp.expanding };
  }
  return out;
}

function inputsEqual(a: InputSet, b: InputSet): boolean {
  // Compare canonical key set. Keys in only one side count as a mismatch
  // (a player joined/left this tick — needs rewind).
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k]; const bv = b[k];
    if (!bv) return false;
    if (av.moveX !== bv.moveX || av.moveY !== bv.moveY || av.expanding !== bv.expanding) return false;
  }
  return true;
}
