// BbNetSession — wires the proven NetPeer rollback core into the live
// BouncyBlobsGame loop and the WebRTC transport. Host and guest use the SAME
// session; they differ only in which players they own (host: keyboard + bots;
// guest: its one player) and that the host relays guests' inputs to each other.
//
// This is the integration of the symmetric tick-tagged model validated by
// netcodeConvergence.test.ts. Gated behind ?netpeer=1 while it's stabilised, so
// the existing path stays the default until live 2-3-tab testing signs it off.
//
// SCOPE (first cut): assumes all peers are present when the match starts (so
// every peer begins at tick 0 with the same level + RNG seed → identical
// initial state, no bootstrap keyframe needed). Late mid-match joins still need
// the keyframe path and are out of scope here.

import type { BouncyBlobsGame } from '../bouncyBlobsGame';
import { NetPeer, type PlayerInput, type TaggedInput, type SimDriver } from '../../lib/netcode/netPeer';
import { makeBouncyBlobsSimDriver } from './simDriver';
import { recordReplayInput, isRecording } from '../../replay/replayRecorder';
import { encodeTaggedInputs, decodeTaggedInputs } from '../../lib/netcode/taggedInputCodec';
import { encodeStateSync, decodeStateSync, encodeHashBeacon, decodeHashBeacon } from '../../lib/netcode/stateSyncCodec';
import { quantizeAxis } from '../../lib/inputProtocol';
import { getPacingConfig, REDUNDANCY_TICKS } from '../../lib/pacingConfig';
import { DisplaySmoother } from '../rollback/displaySmoothing';

/** Late-join / way-behind threshold: if the guest is more than this many ticks
 *  behind a state-sync, treat it as a bootstrap (restore unconditionally) rather
 *  than a per-tick divergence check. Must exceed normal network lag + the
 *  rollback window so routine lag never triggers a full restore. */
const BOOTSTRAP_GAP = 60;

export interface BbNetSessionOpts {
  game: BouncyBlobsGame;
  isHost: boolean;
  /** ids of the human players controlled on THIS client. */
  localHumanIds: () => string[];
  /** host: ids of every bot (also locally authoritative); guest: []. */
  botIds: () => string[];
  /** read a human player's raw (unquantized) input for this frame. */
  readHumanInput: (playerId: string) => PlayerInput;
  /** wire slot ↔ playerId resolution (from lobby_state). */
  slotOf: (playerId: string) => number | undefined;
  idOfSlot: (slot: number) => string | undefined;
  /** send my tagged-input packet: guest→host, host→all guests. */
  sendBytes: (bytes: ArrayBuffer) => void;
  /** host only: relay a received guest packet to all OTHER guests. */
  relayBytes?: (bytes: Uint8Array, fromPeerId: string) => void;
  /** host only: BROADCAST a packet to all guests on the reliable 'state' channel.
   *  Used for the per-tick hash beacon AND the periodic full keyframe. */
  sendState?: (bytes: ArrayBuffer) => void;
  /** host only: send a full-state packet to ONE guest (unicast) — the on-demand
   *  response to a guest's keyframe request after a beacon hash mismatch. Without
   *  it, the host falls back to broadcasting keyframes (still correct, more data). */
  sendStateTo?: (peerId: string, bytes: ArrayBuffer) => void;
  /** guest only: ask the host for a full keyframe (sent after a beacon mismatch
   *  the rollback didn't resolve). Without it, the guest waits for the periodic
   *  keyframe broadcast instead. */
  requestState?: () => void;
  /** host: ticks between full keyframe broadcasts (late-join + safety net).
   *  Default 180 ≈ 3 s — corrections normally ride the on-demand path. */
  keyframeEveryTicks?: number;
  /** host: resolve a player id → the WebRTC peer id that owns it, so per-guest
   *  pacing signals can be addressed. */
  peerIdOf?: (playerId: string) => string | undefined;
  /** host: send a pacing signal (speed up / steady / slow down) to one guest. */
  sendPacing?: (peerId: string, bias: -1 | 0 | 1) => void;
  /** Optional per-instance per-tick hash sink (multi-instance harness divergence
   *  capture — the global hash ring can't separate concurrent sims). */
  onHash?: (tick: number, hash: string) => void;
}

/** Target host-side input buffer depth per guest: the host wants ~2 of each
 *  guest's inputs buffered ahead of its current tick. Below TARGET_LOW it's
 *  starving (guest behind → speed up); above TARGET_HIGH the guest is too far
 *  ahead (excess input latency → slow down). The gap is hysteresis. */
const TARGET_LOW = 1;
const TARGET_HIGH = 4;
/** Per-RAF clock nudge as a fraction of a tick while a bias is active. Kept low
 *  (5% → 16.0ms↔15.2ms/frame) so the speed change is imperceptible to players;
 *  10% was a visible hitch. Trade-off: converging to the right buffer depth takes
 *  a bit longer (a couple seconds), which is fine — it's a one-time settle. */
const CLOCK_NUDGE_FRAC = 0.05;
const FIXED_DT = 1 / 60;

function qInput(v: PlayerInput): PlayerInput {
  return { moveX: quantizeAxis(v.moveX), moveY: quantizeAxis(v.moveY), expanding: v.expanding };
}

export class BbNetSession {
  readonly peer: NetPeer;
  private readonly sim: SimDriver;
  /** Eases rollback / state-sync position corrections over ~5 render frames so
   *  the blob never visibly snaps/teleports. Fed pre/post each correction. */
  private readonly smoother = new DisplaySmoother();
  /** Sliding window of our own recently-sent tagged inputs, resent every frame
   *  for loss recovery (the spec's "last 16 frames of input, compressed"). */
  private recentOut: TaggedInput[] = [];
  /** Guest: latest pacing bias from the host (-1 slow down, +1 speed up). */
  private pacingBias = 0;
  /** Host: last bias sent per peer, so we only send on change. */
  private lastPacingByPeer = new Map<string, number>();
  /** Guest: count of state-sync restores (bootstrap + divergence snaps). A
   *  climbing count during steady play means rollback isn't fully resolving
   *  divergence — the state stream is masking a deeper bug worth chasing. */
  stateSyncRestores = 0;
  /** Our OWN per-tick hash ring (from the sim's onHash) — used to compare against
   *  the host's hash beacons. NOT the global hashHistory singleton, which several
   *  harness sims would clobber. Capped. */
  private localHash = new Map<number, string>();
  /** Guest: last tick we asked the host for a keyframe, to throttle requests. */
  private lastKeyframeReq = -1000;

  /** Live netcode health for the debug overlay. */
  stats(): { tick: number; rollbacks: number; lastDepth: number; failedRestores: number; pacingBias: number; stateSyncRestores: number } {
    return {
      tick: this.peer.tick(),
      rollbacks: this.peer.rollbacksApplied,
      lastDepth: this.peer.lastRollbackDepth,
      failedRestores: this.peer.failedRestores,
      pacingBias: this.pacingBias,
      stateSyncRestores: this.stateSyncRestores,
    };
  }

  constructor(private readonly opts: BbNetSessionOpts) {
    this.sim = makeBouncyBlobsSimDriver(opts.game, (tick, hash) => {
      this.localHash.set(tick, hash);
      if (this.localHash.size > 600) { const f = this.localHash.keys().next().value; if (f !== undefined) this.localHash.delete(f); }
      opts.onHash?.(tick, hash);
    });
    const cfg = getPacingConfig();
    this.peer = new NetPeer({
      localIds: [...opts.localHumanIds(), ...opts.botIds()],
      sim: this.sim,
      inputDelay: cfg.inputDelayTicks,
      // Generous window: a guest→guest input is relayed through the host (two
      // hops), so high-latency clients need room to speculate past the slowest
      // confirmed remote without tripping the cap and stalling.
      maxRollback: 30,
      snapshotInterval: 2,
    });
  }

  /** Take over the game loop: physics steps now flow through NetPeer. */
  install(): void {
    const { game } = this.opts;
    game.setPreTickHook(null);    // peer sends its own tagged inputs
    game.setPostTickHook(null);   // no host aggregation/broadcast
    game.setLogicGate((world) => {
      void world;
      if (getPacingConfig().paused) return false;
      return !this.peer.wouldExceedCap();
    });
    game.setStepDriver((dt) => this.step(dt));
    // Route the renderer's per-blob display offset through our smoother so the
    // visual jump of any rollback / state-sync correction eases in (no teleport).
    game.setRenderOffsetSource(this.smoother);
  }

  dispose(): void {
    const { game } = this.opts;
    game.setStepDriver(null);
    game.setLogicGate(null);
  }

  /** Called from incoming-message handlers with a tagged-input packet. */
  handleIncoming(data: ArrayBuffer | Uint8Array, fromPeerId?: string): void {
    const items = decodeTaggedInputs(data, this.opts.idOfSlot);
    if (!items) return;
    // A late input may trigger a rollback inside receive() — snapshot blob
    // positions first, then hand the visual delta to the smoother to ease in.
    const pre = this.smoother.capturePreRollback(this.opts.game);
    for (const t of items) this.peer.receive(t);
    this.smoother.applyPostRollback(this.opts.game, pre);
    // NOTE: no per-owner relay here anymore — the host re-broadcasts ONE aggregate
    // of every player's authoritative inputs each step() (see the AGGREGATE RELAY
    // comment). `fromPeerId` / `relayBytes` are retained but unused.
    void fromPeerId;
  }

  /** Debug: advance this peer's sim exactly one tick, bypassing the loop's pause
   *  gate. Used by the harness to step every game forward one frame while paused. */
  forceStepOnce(): void { this.step(1 / 60); }

  private step(dt: number): boolean {
    const { game, isHost } = this.opts;
    const pm = game.getPlayerManager();
    const world = game.getWorld();
    if (!pm || !world) return false;

    // Roster may have changed (player/bot join/leave) — refresh the owned set.
    // NB: a peer owns its humans AND any bots it's authoritative for. In the real
    // game only the host has bots (guests pass botIds:[]), but a peer can be
    // AI-driven too (e.g. the local netcode harness), so don't gate bots on isHost
    // — that would make an AI client own no player and never send its input.
    const humanIds = this.opts.localHumanIds();
    const botIds = this.opts.botIds();
    this.peer.setLocalIds([...humanIds, ...botIds]);

    // Gather this frame's local inputs (quantized so wire == applied value).
    const inputs: Record<string, PlayerInput> = {};
    for (const pid of humanIds) inputs[pid] = qInput(this.opts.readHumanInput(pid));
    if (botIds.length > 0) {
      pm.tickAIInputs(dt, world); // derive bot decisions into ManagedPlayer
      for (const botId of botIds) {
        const mp = pm.getPlayer(botId);
        if (mp) inputs[botId] = qInput({ moveX: mp.moveX, moveY: mp.moveY, expanding: mp.expanding });
      }
    }

    const advanced = this.peer.advance(inputs);

    // Resend a redundant window of our own recent inputs for loss recovery.
    for (const t of this.peer.drainOutbox()) this.recentOut.push(t);
    const ownerCount = Math.max(1, humanIds.length + botIds.length);
    const window = REDUNDANCY_TICKS * ownerCount;
    while (this.recentOut.length > window) this.recentOut.shift();
    if (isHost) {
      // AGGREGATE RELAY: ONE packet with EVERY player's recent authoritative input
      // (ours + each guest's, never a prediction), broadcast to all guests — each
      // ignores its own slot. Replaces own-broadcast + N per-owner relays, so the
      // host sends 1 input packet/guest/tick instead of ~N (huge packet-overhead win).
      const agg = this.peer.recentAuthInputs(REDUNDANCY_TICKS);
      if (agg.length > 0) this.opts.sendBytes(encodeTaggedInputs(agg, this.opts.slotOf));
      if (isRecording()) {
        for (const t of agg) recordReplayInput({ t: t.applyTick, p: t.playerId, mx: t.input.moveX, my: t.input.moveY, e: t.input.expanding });
      }
    } else if (this.recentOut.length > 0) {
      // Guest: send only our own redundant window upstream to the host.
      this.opts.sendBytes(encodeTaggedInputs(this.recentOut, this.opts.slotOf));
    }

    // Host: broadcast a tiny HASH BEACON every tick + a full keyframe only
    // occasionally. The beacon (13 B) lets each guest verify its prediction; it
    // requests the full snapshot only on a mismatch the rollback didn't fix. This
    // is what keeps bandwidth ~13 B/tick instead of a 6 KB snapshot every frame.
    // We stream the CONFIRMED past state (all inputs known), never the current
    // predicted state (the host predicts remotes too → speculative). Skipped while
    // paused so frame-stepping doesn't auto-correct and hide a divergence.
    if (isHost && this.opts.sendState && !getPacingConfig().paused) {
      const snap = this.peer.confirmedStreamSnapshot();
      if (snap) {
        this.opts.sendState(encodeHashBeacon(snap.tick, snap.hash));
        const keyEvery = this.opts.keyframeEveryTicks ?? 180;
        if (world.tick % keyEvery === 0) {
          this.opts.sendState(encodeStateSync({ tick: snap.tick, hash: snap.hash, engineState: snap.engineBuf, gameState: snap.gameState }));
        }
      }
    }

    // Host pacing: keep each guest's input buffer at the target depth so its
    // tick-tagged inputs arrive just-in-time (no host rollback → no teleport).
    if (isHost && this.opts.sendPacing && this.opts.peerIdOf) {
      this.updatePacing();
    }
    return advanced;
  }

  /** Host: per remote player, measure how deep its input buffer is and tell the
   *  owning guest to speed up (behind), hold, or slow down (too far ahead). */
  private updatePacing(): void {
    const peerMinDepth = new Map<string, number>();
    for (const pid of this.sim.playerIds()) {
      const peerId = this.opts.peerIdOf!(pid);
      if (!peerId) continue; // host-local players + bots aren't paced
      const depth = this.peer.bufferDepth(pid);
      if (!Number.isFinite(depth)) continue;
      const cur = peerMinDepth.get(peerId);
      if (cur === undefined || depth < cur) peerMinDepth.set(peerId, depth);
    }
    for (const [peerId, depth] of peerMinDepth) {
      const bias: -1 | 0 | 1 = depth < TARGET_LOW ? 1 : depth > TARGET_HIGH ? -1 : 0;
      if (this.lastPacingByPeer.get(peerId) !== bias) {
        this.lastPacingByPeer.set(peerId, bias);
        this.opts.sendPacing!(peerId, bias);
      }
    }
  }

  /** Host: per-guest netcode health for the debug overlay — input buffer depth
   *  (negative = host rolling that guest back) + the last pacing bias sent. */
  guestStats(): Array<{ peerId: string; bufferDepth: number; pacingBias: number }> {
    if (!this.opts.isHost || !this.opts.peerIdOf) return [];
    const byPeer = new Map<string, number>();
    for (const pid of this.sim.playerIds()) {
      const peerId = this.opts.peerIdOf(pid);
      if (!peerId) continue;
      const depth = this.peer.bufferDepth(pid);
      if (!Number.isFinite(depth)) continue;
      const cur = byPeer.get(peerId);
      if (cur === undefined || depth < cur) byPeer.set(peerId, depth);
    }
    return [...byPeer].map(([peerId, bufferDepth]) => ({
      peerId, bufferDepth, pacingBias: this.lastPacingByPeer.get(peerId) ?? 0,
    }));
  }

  /** Guest: apply a pacing signal from the host. */
  setPacingBias(bias: number): void {
    this.pacingBias = bias < 0 ? -1 : bias > 0 ? 1 : 0;
  }

  /** Guest: per-RAF clock adjustment (seconds) for the game loop — speeds the
   *  sim up (+) or slows it down (−) toward the host's target buffer depth. */
  clockAdjust(): number {
    return this.pacingBias * FIXED_DT * CLOCK_NUDGE_FRAC;
  }

  /** Call after the page applied an EXTERNAL engine restore (a join/bootstrap
   *  keyframe via the legacy applySnapshot path) so NetPeer re-bases onto the
   *  freshly-restored tick instead of replaying against stale snapshots. */
  notifyResync(): void { this.peer.reset(); }

  /** Is our state for `tick` known to disagree with `hash` (or are we so far
   *  behind we must bootstrap)? Drives both the beacon request + the state gate. */
  private divergedAt(tick: number, hash: string): boolean {
    const w = this.opts.game.getWorld();
    if (!w) return false;
    if (w.tick < tick - BOOTSTRAP_GAP) return true; // far behind → bootstrap
    const local = this.localHash.get(tick);
    return local !== undefined && local !== hash; // a tick we have, and it differs
  }

  /** Guest: a host HASH BEACON arrived (the cheap per-tick fingerprint). If our
   *  prediction for that tick disagrees, ask the host for a full keyframe — the
   *  rollback usually fixes it first, so requests are rare. Throttled. */
  handleHashBeacon(data: ArrayBuffer | Uint8Array): void {
    if (this.opts.isHost || !this.opts.requestState) return;
    const b = decodeHashBeacon(data);
    if (!b || !this.divergedAt(b.tick, b.hash)) return;
    const now = this.opts.game.getWorld()?.tick ?? 0;
    if (now - this.lastKeyframeReq < 20) return; // ≤ ~3 requests/sec while diverged
    this.lastKeyframeReq = now;
    this.opts.requestState();
  }

  /** Host: a guest asked for a full keyframe — unicast our confirmed snapshot to
   *  it (or broadcast if no unicast channel is wired). */
  handleStateRequest(fromPeerId: string): void {
    if (!this.opts.isHost) return;
    const snap = this.peer.confirmedStreamSnapshot();
    if (!snap) return;
    const bytes = encodeStateSync({ tick: snap.tick, hash: snap.hash, engineState: snap.engineBuf, gameState: snap.gameState });
    if (this.opts.sendStateTo) this.opts.sendStateTo(fromPeerId, bytes);
    else this.opts.sendState?.(bytes);
  }

  /** Guest: a host full-state-sync arrived (keyframe or our requested correction).
   *  Restore it when (a) we're a late joiner / way behind, or (b) our own hash for
   *  that tick disagrees. Otherwise we already self-corrected — skip, no hitch. */
  handleStateSync(data: ArrayBuffer | Uint8Array): void {
    if (this.opts.isHost) return;
    const s = decodeStateSync(data);
    if (!s) return;
    const engine = this.opts.game.getWorld();
    if (!engine) return;

    if (!this.divergedAt(s.tick, s.hash)) return;

    // Restore the authoritative state at s.tick, then REPLAY our already-committed
    // input history forward to where we are — so we don't rewind the visible tick
    // AND don't re-read/re-broadcast fresh local input for ticks we already sent
    // (which would corrupt the authoritative timeline for everyone, the host
    // included). s.tick is the host's CONFIRMED tick, so it's truly canonical.
    // Snapshot positions first so the smoother eases the correction (no snap).
    const pre = this.smoother.capturePreRollback(this.opts.game);
    this.peer.applyAuthoritativeState(s.tick, () => {
      engine.restoreState(s.engineState);
      this.opts.game.restoreGameState(s.gameState as Parameters<BouncyBlobsGame['restoreGameState']>[0]);
    });
    this.smoother.applyPostRollback(this.opts.game, pre);
    this.stateSyncRestores += 1;
  }
}
