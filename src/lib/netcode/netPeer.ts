// ─────────────────────────────────────────────────────────────────────────────
// NetPeer — the symmetric, deterministic, tick-tagged rollback core.
//
// This is the heart of the netcode and the fix for "instant desync even for a
// lone blob". The OLD host model stamped each input at the tick it ARRIVED, so
// a guest predicting its own input applied it at a different tick than the host
// did — same input, different tick, divergent trajectory immediately. There is
// no prediction model that converges against stamp-at-arrival.
//
// THE MODEL (GGPO / rollback with input delay):
//   - Every peer is authoritative for ONLY its own input.
//   - At local tick P-inputDelay a peer reads its input and tags it with the
//     ABSOLUTE apply-tick P; it sends {playerId, applyTick, input}. EVERYONE
//     (including the author) applies that input at tick P. Same input, same
//     tick, everywhere → bit-identical sims (the Rust engine is deterministic).
//   - For ticks where a remote player's input hasn't arrived yet, predict it
//     from their last-known input and step anyway (no stall). When the real
//     input arrives for a tick already simulated, if it differs from the
//     prediction, restore the snapshot at/before that tick and replay forward.
//   - inputDelay (default 3) trades a few frames of local latency for zero
//     local rollback: your own input is scheduled, never mispredicted, so your
//     own blob never rubber-bands.
//
// Topology-agnostic: NetPeer just produces an outbox of its own tagged inputs
// and ingests tagged inputs from anywhere. A star host relays; a mesh
// broadcasts; the test harness wires them through a lossy in-memory channel.
//
// Decoupled from React + the engine specifics via SimDriver, so the real
// BouncyBlobsGame and the headless convergence test drive the SAME core.
// ─────────────────────────────────────────────────────────────────────────────

import type { SoftBodyEngine } from '../../physics/SoftBodyEngine';
import type { InputSet, PlayerInput } from '../../game/rollback/RollbackController';

/** Opaque TS-side game-state snapshot. NetPeer only stores and restores it, so
 *  it stays generic — the real adapter passes BouncyBlobsGame's GameSnapshot;
 *  the test passes its own blob-state blob. */
type GameSnapshot = unknown;

export type { InputSet, PlayerInput } from '../../game/rollback/RollbackController';

/** One player's input tagged with the absolute tick it applies at. This is the
 *  ONLY thing that travels on the input wire. */
export interface TaggedInput {
  playerId: string;
  applyTick: number;
  input: PlayerInput;
}

/** Everything NetPeer needs from "the simulation" — satisfied by the real
 *  BouncyBlobsGame (via a thin adapter) and by the test harness. */
export interface SimDriver {
  /** The deterministic engine — for tick / serializeState / restoreState /
   *  stateHash. */
  readonly engine: SoftBodyEngine;
  /** Stable-ordered ids of every player in the sim. */
  playerIds(): string[];
  /** Write an input set onto the sim's players. No stepping. */
  applyInputs(set: InputSet): void;
  /** Advance the sim exactly one fixed tick (inputs already applied). */
  stepOne(): void;
  /** Snapshot/restore the TS-side game state alongside the engine, so a
   *  rollback restores integrator fields (expand scale, manager timers, …)
   *  the engine snapshot doesn't cover. */
  snapshotGameState(): GameSnapshot;
  restoreGameState(snap: GameSnapshot): void;
}

export interface NetPeerOpts {
  /** Player ids this peer is authoritative for — its own input source(s). The
   *  host owns its keyboard player AND every bot; a guest owns its one player.
   *  These are scheduled + broadcast; all other players are predicted. */
  localIds: string[];
  sim: SimDriver;
  /** Ticks between reading an input and applying it. Spec default 3. */
  inputDelay?: number;
  /** Max ticks we keep snapshots for (bounds rollback depth). */
  maxRollback?: number;
  /** Snapshot every N ticks (input history is always per-tick). Coarser =
   *  cheaper per tick, slightly more replay work on rollback. */
  snapshotInterval?: number;
}

const NEUTRAL: PlayerInput = { moveX: 0, moveY: 0, expanding: false };
const DEFAULT_INPUT_DELAY = 3;
const DEFAULT_MAX_ROLLBACK = 12;
const DEFAULT_SNAPSHOT_INTERVAL = 1;

interface RingRec {
  /** The tick this snapshot lets us re-produce: state captured at the START of
   *  `tick` (engine.tick === tick-1 at capture), before the step that makes it. */
  tick: number;
  engineBuf: Uint8Array;
  gameState: GameSnapshot;
  /** state_hash of the captured state (engine.tick === tick-1) — i.e. the hash of
   *  tick-1. Lets the host stream a confirmed snapshot's hash without re-deriving. */
  hash: string;
}

export class NetPeer {
  localIds: Set<string>;
  private readonly sim: SimDriver;
  private readonly inputDelay: number;
  private readonly maxRollback: number;
  private readonly snapshotInterval: number;

  /** auth[tick] = map of playerId → that player's authoritative input at tick
   *  (our own scheduled inputs + everything we've received). */
  private readonly auth = new Map<number, Map<string, PlayerInput>>();
  /** Per-player most recent authoritative input — predicts unconfirmed ticks. */
  private readonly lastKnown = new Map<string, PlayerInput>();
  /** Highest apply-tick we have authoritative input for, per player. */
  private readonly confirmedThrough = new Map<string, number>();
  /** What input set we actually APPLIED at each simulated tick (prediction or
   *  real). Compared against best-known to find rollback points. */
  private readonly inputHistory = new Map<number, InputSet>();
  /** Coarse snapshot ring (every snapshotInterval ticks). */
  private ring: RingRec[] = [];
  /** Our own tagged inputs awaiting send. */
  private outbox: TaggedInput[] = [];

  rollbacksApplied = 0;
  lastRollbackDepth = 0;
  failedRestores = 0;
  ringInvalidations = 0;

  constructor(opts: NetPeerOpts) {
    this.localIds = new Set(opts.localIds);
    this.sim = opts.sim;
    this.inputDelay = opts.inputDelay ?? DEFAULT_INPUT_DELAY;
    this.maxRollback = opts.maxRollback ?? DEFAULT_MAX_ROLLBACK;
    this.snapshotInterval = Math.max(1, opts.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL);
  }

  /** Update which players this peer is authoritative for (roster change:
   *  a bot or player joined/left). Inputs already scheduled stay valid. */
  setLocalIds(ids: string[]): void { this.localIds = new Set(ids); }

  /** Hard reset of all rollback bookkeeping — call after a keyframe restore
   *  (late-join bootstrap or divergence resync) that re-bases the engine to a
   *  new tick, so stale snapshots/inputs from before the restore are dropped. */
  reset(): void {
    this.auth.clear();
    this.lastKnown.clear();
    this.confirmedThrough.clear();
    this.inputHistory.clear();
    this.ring = [];
    this.outbox = [];
  }

  /** Apply an authoritative state snapshot (from the host's state-stream) at
   *  `syncTick`, then REPLAY our already-committed input history forward to wherever
   *  we currently are — so the correction lands without rewinding the visible tick
   *  AND without re-deciding/re-broadcasting local inputs we already committed.
   *
   *  This REPLACED an earlier rebaseTo() that cleared inputHistory, so the caller
   *  re-advanced from `syncTick` and re-read FRESH local input for ticks it had
   *  already sent — those changed inputs got rebroadcast and corrupted the
   *  authoritative timeline for everyone (the host included). Here we keep the
   *  committed inputs (they live in `auth`) and replay them, exactly like reconcileFrom
   *  does for a late input.
   *
   *  `restoreFn` must restore the engine + game state to the host's snapshot for
   *  `syncTick` (engine.tick === syncTick afterward). */
  applyAuthoritativeState(syncTick: number, restoreFn: () => void): void {
    const savedTick = this.sim.engine.tick;
    restoreFn(); // engine now holds the host's authoritative state at syncTick

    // Reset the snapshot ring to the authoritative state at syncTick; drop our own
    // (possibly diverged) history at/before it — we won't roll back past an
    // authoritative point. Ring convention: a snapshot labeled `tick: T` holds the
    // engine state at `T-1` (captured before stepping to T). The engine is at
    // syncTick now, so this anchor is labeled syncTick+1 — restoring it lands the
    // engine at syncTick and replays from syncTick+1, matching advance()/reconcile.
    this.ring = [this.snapRec(syncTick + 1)];
    for (const t of this.auth.keys()) if (t < syncTick) this.auth.delete(t);
    for (const t of this.inputHistory.keys()) if (t <= syncTick) this.inputHistory.delete(t);
    for (const pid of this.confirmedThrough.keys()) {
      const c = this.confirmedThrough.get(pid) ?? -1;
      if (c < syncTick) this.confirmedThrough.set(pid, syncTick);
    }

    // Host at/ahead of us (late-join bootstrap): nothing committed past syncTick to
    // replay — we simply continue forward from the authoritative state.
    if (syncTick >= savedTick) return;

    // Ongoing correction: replay our COMMITTED inputs (in `auth`) from syncTick+1 back
    // up to savedTick, re-snapshotting, so we end where we were with corrected state.
    for (let t = syncTick + 1; t <= savedTick; t++) {
      const set = this.buildSet(t);
      this.sim.applyInputs(set);
      this.inputHistory.set(t, cloneSet(set));
      this.updateLastKnownFromAuth(t);
      if (t % this.snapshotInterval === 0) {
        this.ring.push(this.snapRec(t));
      }
      this.sim.stepOne();
    }
  }

  // ── Outbound ────────────────────────────────────────────────────────────
  /** Take the queued tagged inputs to send on the wire (clears the queue). */
  drainOutbox(): TaggedInput[] {
    const o = this.outbox;
    this.outbox = [];
    return o;
  }

  // ── Inbound ─────────────────────────────────────────────────────────────
  /** Ingest a tagged input (remote, or relayed). Our own echoes are ignored.
   *  If it lands on a tick we've already simulated and changes the input set,
   *  triggers restore+replay. */
  receive(t: TaggedInput): void {
    if (this.localIds.has(t.playerId)) return; // we already have our own, exact
    const existing = this.auth.get(t.applyTick)?.get(t.playerId);
    if (existing && inputsEqualOne(existing, t.input)) return; // duplicate
    this.setAuth(t.applyTick, t.playerId, t.input);
    const prev = this.confirmedThrough.get(t.playerId) ?? -1;
    if (t.applyTick > prev) this.confirmedThrough.set(t.playerId, t.applyTick);
    // NOTE: do NOT update lastKnown here. lastKnown is the prediction basis —
    // "what the remote was last doing" — and must track the latest input we've
    // actually APPLIED (≤ engine.tick), updated in advance()/reconcile. Setting
    // it from an input that arrives EARLY (applyTick > engine.tick, common when
    // inputDelay > latency) predicts the intermediate ticks with a FUTURE value
    // — a temporally-wrong prediction that desyncs under large input delay.
    if (t.applyTick <= this.sim.engine.tick) this.reconcileFrom(t.applyTick);
  }

  // ── Advance one tick ──────────────────────────────────────────────────────
  /** Returns the highest tick every peer is confirmed through (min over remote
   *  players of the latest apply-tick we have). Drives the speculation cap and
   *  the host pacing controller. */
  /** The newest CONFIRMED snapshot to broadcast as authoritative state. A peer
   *  (host included) PREDICTS remote inputs, so its CURRENT engine state is
   *  speculative — only ticks ≤ confirmedTick() have every input. Streaming the
   *  current (predicted) state would freeze guests onto a guess they can't undo.
   *  This returns the latest ring snapshot whose RESTORED tick (snapshot.tick-1,
   *  per the ring convention) is ≤ confirmedTick, so the receiver rebases onto
   *  canonical state and replays its own committed inputs forward. */
  confirmedStreamSnapshot(): { tick: number; engineBuf: Uint8Array; gameState: GameSnapshot; hash: string } | null {
    const ct = this.confirmedTick();
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const r = this.ring[i];
      if (r.tick - 1 <= ct) return { tick: r.tick - 1, engineBuf: r.engineBuf, gameState: r.gameState, hash: r.hash };
    }
    return null;
  }

  /** Every AUTHORITATIVE input (ours + every remote's we've received — never a
   *  prediction) for the last `window` ticks, as a flat tagged list. The host
   *  broadcasts this as ONE aggregated packet so each guest learns every other
   *  player's input in a single message (replaces per-owner relays). */
  recentAuthInputs(window: number): TaggedInput[] {
    // Latest `window` ticks PER PLAYER (not globally) — guests' inputs lag the
    // host's own by their latency, so a global window anchored at our newest tick
    // would drop a high-latency guest's recent inputs and starve the other guests.
    const byPlayer = new Map<string, { tick: number; input: PlayerInput }[]>();
    for (const [t, m] of this.auth) {
      for (const [pid, input] of m) {
        let list = byPlayer.get(pid);
        if (!list) { list = []; byPlayer.set(pid, list); }
        list.push({ tick: t, input });
      }
    }
    const out: TaggedInput[] = [];
    for (const [pid, list] of byPlayer) {
      list.sort((a, b) => a.tick - b.tick);
      for (const e of list.slice(-window)) out.push({ playerId: pid, applyTick: e.tick, input: { ...e.input } });
    }
    return out;
  }

  confirmedTick(): number {
    let min = Infinity;
    for (const pid of this.sim.playerIds()) {
      if (this.localIds.has(pid)) continue;
      const c = this.confirmedThrough.get(pid);
      // A remote we've NEVER heard from must NOT drag the confirmed tick to 0 —
      // that would trip the speculation cap and freeze us at tick ~maxRollback
      // forever (until every single remote has sent at least one input). We just
      // predict the silent ones; only remotes we've actually heard from bound how
      // far we may speculate.
      if (c === undefined) continue;
      min = Math.min(min, c);
    }
    return min === Infinity ? this.sim.engine.tick : min;
  }

  /** True if stepping the next tick would speculate more than maxRollback past
   *  the slowest confirmed remote — the caller should hold this frame. Always
   *  allows progress while no remote is known yet (startup / single-peer). */
  wouldExceedCap(): boolean {
    const remotes = this.sim.playerIds().filter((p) => !this.localIds.has(p));
    if (remotes.length === 0) return false;
    const anyConfirmed = remotes.some((p) => (this.confirmedThrough.get(p) ?? -1) >= 0);
    if (!anyConfirmed) return false; // nothing to wait on yet
    return this.sim.engine.tick + 1 > this.confirmedTick() + this.maxRollback;
  }

  /** Advance exactly one local tick. Schedules each local player's input for
   *  inputDelay ticks ahead, builds + applies the input set for the tick being
   *  produced, snapshots, and steps. `localInputs` maps each owned player id to
   *  its input THIS frame (host: keyboard player + every bot; guest: its one
   *  player). Returns false (and does nothing) if the speculation cap is hit. */
  advance(localInputs: Record<string, PlayerInput>): boolean {
    if (this.wouldExceedCap()) return false;
    const engine = this.sim.engine;
    const P = engine.tick + 1;          // the tick this step produces
    const at = P + this.inputDelay;     // local inputs apply inputDelay ahead

    // Schedule each local player's input (authoritative for us) + queue to send.
    // (No lastKnown update for local: local players are never predicted — their
    // input at tick P comes from auth[P] or NEUTRAL, never lastKnown.)
    for (const [pid, input] of Object.entries(localInputs)) {
      if (!this.localIds.has(pid)) continue; // only schedule ids we own
      this.setAuth(at, pid, input);
      this.confirmedThrough.set(pid, at);
      this.outbox.push({ playerId: pid, applyTick: at, input });
    }

    const set = this.buildSet(P);
    this.sim.applyInputs(set);
    this.inputHistory.set(P, cloneSet(set));
    // lastKnown follows the latest APPLIED real input (for predicting P+1).
    this.updateLastKnownFromAuth(P);
    this.maybeSnapshot(P);
    this.sim.stepOne();

    this.prune(P);
    return true;
  }

  // ── Internals ─────────────────────────────────────────────────────────────
  private setAuth(tick: number, pid: string, input: PlayerInput): void {
    let m = this.auth.get(tick);
    if (!m) { m = new Map(); this.auth.set(tick, m); }
    m.set(pid, input);
  }

  /** After applying tick `tick`, advance each remote's prediction basis to the
   *  REAL input we applied there (if known). Keeps lastKnown = "latest applied
   *  past input", so predicting the next tick carries forward the right value. */
  private updateLastKnownFromAuth(tick: number): void {
    const a = this.auth.get(tick);
    if (!a) return;
    for (const [pid, inp] of a) {
      if (!this.localIds.has(pid)) this.lastKnown.set(pid, inp);
    }
  }

  /** Best-known input set for `tick`: authoritative where we have it; NEUTRAL
   *  for the local player when absent (we know our own schedule exactly, so
   *  absence means startup, not "unknown"); last-known prediction for remotes. */
  private buildSet(tick: number): InputSet {
    const out: InputSet = {};
    const a = this.auth.get(tick);
    for (const pid of this.sim.playerIds()) {
      const known = a?.get(pid);
      if (known) out[pid] = { ...known };
      else if (this.localIds.has(pid)) out[pid] = { ...NEUTRAL };
      else out[pid] = { ...(this.lastKnown.get(pid) ?? NEUTRAL) };
    }
    return out;
  }

  /** Capture a ring record for `tick` (engine must be at tick-1). */
  private snapRec(tick: number): RingRec {
    return {
      tick,
      engineBuf: this.sim.engine.serializeState(),
      gameState: this.sim.snapshotGameState(),
      hash: this.sim.engine.stateHash(),
    };
  }

  private maybeSnapshot(tick: number): void {
    if (tick % this.snapshotInterval !== 0) return;
    this.ring.push(this.snapRec(tick));
  }

  private prune(currentTick: number): void {
    const oldest = currentTick - this.maxRollback;
    while (this.ring.length > 0 && this.ring[0].tick < oldest) this.ring.shift();
    for (const t of this.inputHistory.keys()) if (t < oldest) this.inputHistory.delete(t);
    for (const t of this.auth.keys()) if (t < oldest) this.auth.delete(t);
  }

  /** A late/corrected input landed at `fromTick` (≤ current). Find the earliest
   *  tick whose applied input no longer matches best-known, restore the latest
   *  snapshot at/before it, and replay forward re-applying best-known inputs. */
  private reconcileFrom(fromTick: number): void {
    const engine = this.sim.engine;
    const currentTick = engine.tick;

    // Earliest mismatch in [fromTick, currentTick].
    let mismatch = -1;
    for (let t = fromTick; t <= currentTick; t++) {
      const applied = this.inputHistory.get(t);
      if (!applied) continue;
      if (!setsEqual(applied, this.buildSet(t))) { mismatch = t; break; }
    }
    if (mismatch < 0) return;

    // Latest snapshot at or before the mismatch.
    let startIdx = -1;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].tick <= mismatch) { startIdx = i; break; }
    }
    if (startIdx < 0) { this.invalidate(); return; }

    const start = this.ring[startIdx];
    if (!engine.restoreState(start.engineBuf)) {
      this.failedRestores += 1;
      this.invalidate();
      return;
    }
    this.sim.restoreGameState(start.gameState);
    // Drop snapshots strictly after the restore point — we re-take them as we
    // replay through the snapshot-interval boundaries.
    this.ring.length = startIdx + 1;

    this.lastRollbackDepth = currentTick - (start.tick - 1);
    // Replay: snapshot `start` was captured at the START of tick start.tick, so
    // after restore engine.tick === start.tick - 1. Re-produce start.tick … currentTick.
    for (let t = start.tick; t <= currentTick; t++) {
      const set = this.buildSet(t);
      this.sim.applyInputs(set);
      this.inputHistory.set(t, cloneSet(set));
      this.updateLastKnownFromAuth(t); // keep prediction basis correct during replay
      if (t > start.tick && t % this.snapshotInterval === 0) {
        this.ring.push(this.snapRec(t));
      }
      this.sim.stepOne();
    }
    this.rollbacksApplied += 1;
  }

  private invalidate(): void {
    this.ring.length = 0;
    this.ringInvalidations += 1;
  }

  /** How many ticks AHEAD of our current tick we have authoritative input for
   *  `pid` (the host's input buffer depth for that player). Negative means we've
   *  already passed the latest input we have → we've been predicting/rolling that
   *  player back (the "teleport" symptom) → that peer should speed up. Returns a
   *  large value if we've never heard from them (don't pace on no data). */
  bufferDepth(pid: string): number {
    const c = this.confirmedThrough.get(pid);
    if (c === undefined) return Number.POSITIVE_INFINITY;
    return c - this.sim.engine.tick;
  }

  // ── Introspection (debug overlay / tests) ─────────────────────────────────
  hash(): string { return this.sim.engine.stateHash(); }
  tick(): number { return this.sim.engine.tick; }
}

// ── pure helpers ────────────────────────────────────────────────────────────
function inputsEqualOne(a: PlayerInput, b: PlayerInput): boolean {
  return a.moveX === b.moveX && a.moveY === b.moveY && a.expanding === b.expanding;
}
function setsEqual(a: InputSet, b: InputSet): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const av = a[k], bv = b[k];
    if (!bv || !inputsEqualOne(av, bv)) return false;
  }
  return true;
}
function cloneSet(s: InputSet): InputSet {
  const out: InputSet = {};
  for (const [k, v] of Object.entries(s)) out[k] = { moveX: v.moveX, moveY: v.moveY, expanding: v.expanding };
  return out;
}
