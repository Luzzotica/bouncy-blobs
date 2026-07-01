// ─────────────────────────────────────────────────────────────────────────────
// Netcode convergence tests — the gold-standard guard against desync.
//
// Runs N NetPeers (the real symmetric rollback core) over an in-memory channel
// with configurable latency / jitter / packet loss, driving each with a scripted
// input stream, then asserts every peer's engine state is BIT-IDENTICAL to a
// "reference" sim that applied the exact authoritative input timeline with no
// prediction. If prediction + rollback is correct, the networked peers converge
// to the reference at every tick regardless of how inputs were delayed/dropped.
//
// This is what catches "instant desync even for a lone blob": with the OLD
// stamp-at-arrival model the peers would NOT match the reference; with
// tick-tagged input they must.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import initWasm, { SoftBodyWorldHandle } from '../../physics/wasm/softbody_wasm';
import { SoftBodyWorldRust } from '../../physics/softBodyWorldRust';
import { PlayerManager } from '../../game/playerManager';
import { loadLevel } from '../../levels/levelLoader';
import { defaultLevel } from '../../levels/defaultLevel';
import { classicLevel } from '../../levels/classicLevel';
import { chainedLevel } from '../../levels/chainedLevel';
import { kothLevel } from '../../levels/kothLevel';
import { quantizeAxis } from '../inputProtocol';
import { TriggerManager } from '../../game/triggerManager';
import { ActionManager } from '../../game/actionManager';
import { PlatformMover } from '../../game/platformMover';
import { SpringPadManager } from '../../game/springPadManager';
import { PowerupManager } from '../../game/powerups/powerupManager';
import { SpikeManager } from '../../game/spikeManager';
import { DynamicItemManager } from '../../game/dynamicItemManager';
import { NetPeer, type SimDriver, type InputSet, type PlayerInput, type TaggedInput } from './netPeer';
import { encodeTaggedInputs, decodeTaggedInputs } from './taggedInputCodec';
import type { LevelData } from '../../levels/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_DT = 1 / 60;
const SEED = 8888;

beforeAll(async () => {
  const wasmPath = resolve(__dirname, '../../physics/wasm/softbody_wasm_bg.wasm');
  const bytes = readFileSync(wasmPath);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await initWasm({ module_or_path: ab as ArrayBuffer });
  if (typeof SoftBodyWorldHandle !== 'function') throw new Error('wasm init failed');
});

// ── Test SimDriver: bare engine + PlayerManager, blob-state snapshot ─────────
function makeSim(level: LevelData, playerIds: string[], seed = SEED, onHash?: (tick: number, hash: string) => void): SimDriver {
  const world = new SoftBodyWorldRust({ rngSeed: seed });
  const { playerSpawnPoints } = loadLevel(world, level);
  const players = new PlayerManager(playerSpawnPoints);
  for (const id of playerIds) players.addPlayer(id, id, world);
  return {
    engine: world,
    playerIds: () => players.getAllPlayers().map((p) => p.playerId),
    applyInputs: (set: InputSet) => {
      for (const [pid, inp] of Object.entries(set)) {
        const mp = players.getPlayer(pid);
        if (!mp) continue;
        mp.moveX = inp.moveX; mp.moveY = inp.moveY; mp.expanding = inp.expanding;
      }
    },
    stepOne: () => { players.updateAll(FIXED_DT, world); world.step(FIXED_DT); onHash?.(world.tick, world.stateHash()); },
    snapshotGameState: () => players.getAllPlayers().map((p) => ({ id: p.blob.blobId, s: p.blob.dumpState() })),
    restoreGameState: (snap) => {
      const arr = snap as Array<{ id: number; s: ReturnType<PlayerManager['getAllPlayers']>[number]['blob']['dumpState'] extends () => infer R ? R : never }>;
      for (const p of players.getAllPlayers()) {
        const rec = arr.find((a) => a.id === p.blob.blobId);
        if (rec) p.blob.restoreState(rec.s as Parameters<typeof p.blob.restoreState>[0]);
      }
    },
  };
}

// ── Managed SimDriver: the FULL gameplay-manager stack (moving platforms,
//    springs, powerups, triggers, actions, spikes, dynamic items), wired exactly
//    like bouncyBlobsGame.onInit but headless (no canvas/effects). snapshotGameState
//    mirrors production: blob state + the TS-side manager state (platformMover
//    offset, spring/powerup/dynamic-item state) the engine snapshot doesn't cover.
//    This is what validates rollback resolution for TS-driven features. ───────────
function makeManagedSim(level: LevelData, playerIds: string[], seed = SEED): SimDriver {
  const world = new SoftBodyWorldRust({ rngSeed: seed });
  const loaded = loadLevel(world, level);
  const players = new PlayerManager(loaded.playerSpawnPoints);
  for (const id of playerIds) players.addPlayer(id, id, world);
  const npcBlobs = loaded.npcBlobs;

  let powerup: PowerupManager | null = null;
  if (level.powerupSpawns?.length) { powerup = new PowerupManager(); powerup.initialize(world, level.powerupSpawns); }
  let springPad: SpringPadManager | null = null;
  if (level.springPads?.length) { springPad = new SpringPadManager(); springPad.initialize(world, level.springPads); }
  const spike = new SpikeManager();
  spike.initialize(world, players, level.spikes ?? [], npcBlobs);
  if (level.deathZones?.length) spike.setDeathZones(level.deathZones);
  let dynamic: DynamicItemManager | null = null;
  const dItems = (level as unknown as { dynamicItems?: Array<{ id: string; type: string; x: number; y: number; width: number; height: number; rotation: number }> }).dynamicItems ?? [];
  if (dItems.length) {
    dynamic = new DynamicItemManager();
    dynamic.initialize(world, players);
    for (const it of dItems) dynamic.addItem(it.id, it.type as Parameters<DynamicItemManager['addItem']>[1], it.x, it.y, it.width, it.height, it.rotation);
  }
  const platformMover = new PlatformMover();
  platformMover.initialize(level.platforms, loaded.platformSurfaces, world);
  const npcIds = new Set(npcBlobs.map((b) => b.blobId));
  const trigger = new TriggerManager();
  trigger.initialize(world, level.triggers ?? [], loaded.triggerShapeIdxToId,
    (bid) => npcIds.has(bid), (bid) => players.getPlayerByBlobId(bid) !== undefined);
  const action = new ActionManager();
  action.initialize(world, level.actions ?? [], loaded.pointShapeParticles,
    loaded.softPlatformStaticParticles, platformMover, trigger, spike);

  const allBlobs = () => [...players.getAllPlayers().map((p) => p.blob), ...npcBlobs];

  return {
    engine: world,
    playerIds: () => players.getAllPlayers().map((p) => p.playerId),
    applyInputs: (set: InputSet) => {
      for (const [pid, inp] of Object.entries(set)) {
        const mp = players.getPlayer(pid);
        if (mp) { mp.moveX = inp.moveX; mp.moveY = inp.moveY; mp.expanding = inp.expanding; }
      }
    },
    stepOne: () => {
      players.updateAll(FIXED_DT, world);
      world.step(FIXED_DT);
      powerup?.update(FIXED_DT, players);
      springPad?.update(FIXED_DT);
      spike.update(FIXED_DT);
      dynamic?.update(FIXED_DT);
      trigger.update(FIXED_DT);
      action.update(FIXED_DT);
    },
    snapshotGameState: () => ({
      blobs: allBlobs().map((b) => ({ id: b.blobId, s: b.dumpState() })),
      springPad: springPad?.dumpState?.(),
      powerup: powerup?.dumpState?.(),
      dynamic: dynamic?.dumpState?.(),
      platformMover: platformMover.dumpState(),
    }),
    restoreGameState: (snap) => {
      const o = snap as {
        blobs: Array<{ id: number; s: unknown }>;
        springPad?: unknown; powerup?: unknown; dynamic?: unknown; platformMover?: unknown;
      };
      for (const b of allBlobs()) {
        const rec = o.blobs.find((a) => a.id === b.blobId);
        if (rec) b.restoreState(rec.s as Parameters<typeof b.restoreState>[0]);
      }
      if (o.springPad) springPad?.restoreState?.(o.springPad as Parameters<NonNullable<typeof springPad>['restoreState']>[0]);
      if (o.powerup) powerup?.restoreState?.(o.powerup as Parameters<NonNullable<typeof powerup>['restoreState']>[0]);
      if (o.dynamic) dynamic?.restoreState?.(o.dynamic as Parameters<NonNullable<typeof dynamic>['restoreState']>[0]);
      if (o.platformMover) platformMover.restoreState(o.platformMover as Parameters<typeof platformMover.restoreState>[0]);
    },
  };
}

function loadShowcaseLevel(): LevelData {
  const p = resolve(__dirname, '../../../public/levels/showcase.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as LevelData;
}

// ── Seeded PRNG (mulberry32) so latency/jitter/loss are deterministic ────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── In-memory channel with latency / jitter / loss + redundant resend ────────
interface ChannelOpts { latency: number; jitter: number; loss: number; redundancy: number }
class Loopback {
  private q: Array<{ to: string; t: TaggedInput; at: number }> = [];
  constructor(private rng: () => number, private opts: ChannelOpts) {}
  /** Broadcast `t` from `from` to every other peer, each with independent
   *  latency/jitter/loss. `t` is one of the last `redundancy` inputs being
   *  resent, so loss is recovered by later frames. */
  broadcast(from: string, t: TaggedInput, frame: number, peers: string[]): void {
    for (const to of peers) {
      if (to === from) continue;
      if (this.rng() < this.opts.loss) continue; // dropped
      const jit = Math.floor(this.rng() * (this.opts.jitter + 1));
      this.q.push({ to, t, at: frame + this.opts.latency + jit });
    }
  }
  deliverDue(frame: number, recv: (to: string, t: TaggedInput) => void): void {
    const keep: typeof this.q = [];
    for (const m of this.q) {
      if (m.at <= frame) recv(m.to, m.t);
      else keep.push(m);
    }
    this.q = keep;
  }
  flush(recv: (to: string, t: TaggedInput) => void): void {
    for (const m of this.q) recv(m.to, m.t);
    this.q = [];
  }
}

// ── Scripted input (chaos: rapid sign flips + expand toggles) ────────────────
function scriptInput(pid: string, frame: number): PlayerInput {
  const salt = pid.charCodeAt(pid.length - 1);
  const mx = (((frame * 7 + salt) % 11) < 5) ? 1 : -1;
  const my = (((frame * 5 + salt) % 9) < 4) ? 1 : -1;
  const expanding = ((frame + salt) % 4) === 0;
  return { moveX: quantizeAxis(mx), moveY: quantizeAxis(my), expanding };
}

const NEUTRAL: PlayerInput = { moveX: 0, moveY: 0, expanding: false };

/** Build the ground-truth input set for the tick the reference produces.
 *  A peer reading input at frame G produces tick G+1 and schedules its input
 *  at applyTick (G+1)+delay, so the input applied at tick K was read at frame
 *  K-delay-1. */
function canonicalSet(playerIds: string[], tick: number, delay: number): InputSet {
  const out: InputSet = {};
  for (const pid of playerIds) {
    const readFrame = tick - delay - 1;
    out[pid] = readFrame >= 0 ? scriptInput(pid, readFrame) : { ...NEUTRAL };
  }
  return out;
}

interface RunResult { peerHashes: string[]; refHash: string; totalRollbacks: number; stalls: number }

function runScenario(opts: {
  playerIds: string[]; frames: number; delay: number; channel: ChannelOpts; chSeed: number; level?: LevelData; simFactory?: (level: LevelData, ids: string[]) => SimDriver;
}): RunResult {
  const { playerIds, frames, delay, channel, chSeed } = opts;
  const level = opts.level ?? defaultLevel;
  const factory = opts.simFactory ?? makeSim;

  // Networked peers (star/mesh-agnostic: we broadcast every input to all).
  const peers = playerIds.map((id) => {
    const sim = factory(level, playerIds);
    return { id, sim, peer: new NetPeer({ localIds: [id], sim, inputDelay: delay, snapshotInterval: 2, maxRollback: 16 }) };
  });
  const ch = new Loopback(mulberry32(chSeed), channel);
  const recentByPeer = new Map<string, TaggedInput[]>();

  const recv = (to: string, t: TaggedInput) => {
    peers.find((p) => p.id === to)?.peer.receive(t);
  };

  let stalls = 0;
  for (let G = 0; G < frames; G++) {
    for (const pe of peers) {
      const advanced = pe.peer.advance({ [pe.id]: scriptInput(pe.id, G) });
      if (!advanced) stalls++;
      // Accumulate this peer's outgoing inputs; resend the last `redundancy`.
      const recent = recentByPeer.get(pe.id) ?? [];
      for (const t of pe.peer.drainOutbox()) recent.push(t);
      while (recent.length > channel.redundancy) recent.shift();
      recentByPeer.set(pe.id, recent);
      for (const t of recent) ch.broadcast(pe.id, t, G, playerIds);
    }
    ch.deliverDue(G, recv);
  }
  // Deliver everything still in flight + one more reconcile pass.
  ch.flush(recv);

  // Reference: apply the exact authoritative timeline, no prediction.
  const refSim = factory(level, playerIds);
  for (let K = 1; K <= frames; K++) {
    refSim.applyInputs(canonicalSet(playerIds, K, delay));
    refSim.stepOne();
  }

  return {
    peerHashes: peers.map((p) => p.peer.hash()),
    refHash: refSim.engine.stateHash(),
    totalRollbacks: peers.reduce((s, p) => s + p.peer.rollbacksApplied, 0),
    stalls,
  };
}

// ── Full-pipe star harness: routes inputs through the REAL wire codec +
//    host-star relay (the exact data path BbNetSession uses). Point-to-point
//    channel with from/to so the host can relay a guest's bytes to the others. ─
class LoopbackPP {
  private q: Array<{ from: string; to: string; bytes: ArrayBuffer; at: number }> = [];
  frame = 0;
  private reliable = false;
  constructor(private rng: () => number, private opts: ChannelOpts) {}
  send(from: string, to: string, bytes: ArrayBuffer): void {
    if (!this.reliable && this.rng() < this.opts.loss) return;
    const jit = this.reliable ? 0 : Math.floor(this.rng() * (this.opts.jitter + 1));
    this.q.push({ from, to, bytes, at: this.reliable ? this.frame : this.frame + this.opts.latency + jit });
  }
  deliverDue(frame: number, cb: (to: string, from: string, bytes: ArrayBuffer) => void): void {
    const keep: typeof this.q = [];
    for (const m of this.q) { if (m.at <= frame) cb(m.to, m.from, m.bytes); else keep.push(m); }
    this.q = keep;
  }
  /** Reliably drain everything still in flight, including relays produced while
   *  draining (relayed bytes are re-queued reliably and delivered next iteration). */
  flushAll(cb: (to: string, from: string, bytes: ArrayBuffer) => void): void {
    this.reliable = true;
    let guard = 0;
    while (this.q.length > 0 && guard++ < 200000) {
      const m = this.q.shift()!;
      cb(m.to, m.from, m.bytes);
    }
    this.reliable = false;
  }
}

function runStarScenario(opts: {
  playerIds: string[]; frames: number; delay: number; channel: ChannelOpts; chSeed: number; level?: LevelData; simFactory?: (level: LevelData, ids: string[]) => SimDriver;
}): RunResult {
  const { playerIds, frames, delay, channel, chSeed } = opts;
  const level = opts.level ?? defaultLevel;
  const factory = opts.simFactory ?? makeSim;
  const hostId = playerIds[0];
  const slotOf = (id: string) => { const i = playerIds.indexOf(id); return i < 0 ? undefined : i; };
  const idOfSlot = (s: number) => playerIds[s];

  const peers = playerIds.map((id) => {
    const sim = factory(level, playerIds);
    return {
      id, isHost: id === hostId, sim, recent: [] as TaggedInput[],
      peer: new NetPeer({ localIds: [id], sim, inputDelay: delay, snapshotInterval: 2, maxRollback: 16 }),
    };
  });
  const byId = (id: string) => peers.find((p) => p.id === id)!;
  const guests = peers.filter((p) => !p.isHost);
  const ch = new LoopbackPP(mulberry32(chSeed), channel);

  // Deliver decoded bytes into a peer; the host re-broadcasts (relays) the raw
  // bytes to every OTHER guest — exactly BbNetSession.handleIncoming.
  const deliver = (toId: string, fromId: string, bytes: ArrayBuffer) => {
    const pe = byId(toId);
    const items = decodeTaggedInputs(bytes, idOfSlot);
    if (items) for (const t of items) pe.peer.receive(t);
    if (pe.isHost) {
      for (const g of guests) if (g.id !== fromId) ch.send(hostId, g.id, bytes);
    }
  };

  let stalls = 0;
  for (let G = 0; G < frames; G++) {
    ch.frame = G;
    for (const pe of peers) {
      if (!pe.peer.advance({ [pe.id]: scriptInput(pe.id, G) })) stalls++;
      for (const t of pe.peer.drainOutbox()) pe.recent.push(t);
      while (pe.recent.length > channel.redundancy) pe.recent.shift();
      const bytes = encodeTaggedInputs(pe.recent, slotOf);
      if (pe.isHost) { for (const g of guests) ch.send(hostId, g.id, bytes); }
      else { ch.send(pe.id, hostId, bytes); }
    }
    ch.deliverDue(G, deliver);
  }
  ch.flushAll(deliver);

  const refSim = factory(level, playerIds);
  for (let K = 1; K <= frames; K++) { refSim.applyInputs(canonicalSet(playerIds, K, delay)); refSim.stepOne(); }

  return {
    peerHashes: peers.map((p) => p.peer.hash()),
    refHash: refSim.engine.stateHash(),
    totalRollbacks: peers.reduce((s, p) => s + p.peer.rollbacksApplied, 0),
    stalls,
  };
}

// ── Clock-drift / pacing harness: the teleport bug is a TRANSIENT (deep host
//    rollback of a guest's input), not a final-state divergence — so the plain
//    convergence tests (final-hash only) miss it. This measures the host's
//    rollback DEPTH under one-way latency and shows the pacing controller
//    (host tells the guest to speed up) drives it to ~0. ───────────────────────
function runDriftScenario(opts: { withPacing: boolean; latency: number; frames: number }): { steadyMaxHostDepth: number } {
  const ids = ['host', 'guest'];
  const host = new NetPeer({ localIds: ['host'], sim: makeSim(defaultLevel, ids), inputDelay: 3, snapshotInterval: 2, maxRollback: 30 });
  const guest = new NetPeer({ localIds: ['guest'], sim: makeSim(defaultLevel, ids), inputDelay: 3, snapshotInterval: 2, maxRollback: 30 });
  const q: Array<{ to: 'host' | 'guest'; t: TaggedInput; at: number }> = [];
  let guestRate = 1.0, guestAccum = 0, hostAccum = 0, hostProduced = 0, guestProduced = 0;
  let steadyMaxHostDepth = 0;

  for (let G = 0; G < opts.frames; G++) {
    hostAccum += 1.0;
    while (hostAccum >= 1) {
      host.advance({ host: scriptInput('host', hostProduced++) });
      for (const t of host.drainOutbox()) q.push({ to: 'guest', t, at: G + opts.latency });
      hostAccum -= 1;
    }
    guestAccum += guestRate;
    while (guestAccum >= 1) {
      guest.advance({ guest: scriptInput('guest', guestProduced++) });
      for (const t of guest.drainOutbox()) q.push({ to: 'host', t, at: G + opts.latency });
      guestAccum -= 1;
    }
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].at > G) continue;
      const m = q[i]; q.splice(i, 1);
      const peer = m.to === 'host' ? host : guest;
      const before = peer.rollbacksApplied;
      peer.receive(m.t);
      // Track the host's rollback depth in the second half (after pacing settles).
      if (m.to === 'host' && peer.rollbacksApplied > before && G > opts.frames / 2) {
        steadyMaxHostDepth = Math.max(steadyMaxHostDepth, host.lastRollbackDepth);
      }
    }
    if (opts.withPacing) {
      const depth = host.bufferDepth('guest');
      if (Number.isFinite(depth)) {
        const bias = depth < 1 ? 1 : depth > 4 ? -1 : 0;
        guestRate = Math.max(0.9, Math.min(1.1, 1 + bias * 0.05));
      }
    }
  }
  return { steadyMaxHostDepth };
}

describe('netcode clock-sync / pacing (the teleport-bug class)', () => {
  it('WITHOUT pacing: latency > inputDelay → host rolls back guest input every tick (teleport)', () => {
    const r = runDriftScenario({ withPacing: false, latency: 6, frames: 300 });
    // The host is constantly applying the guest's input in the past — this is
    // exactly the "host teleports my blob" symptom. Depth stays ≥ ~2.
    expect(r.steadyMaxHostDepth).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('WITH pacing: the guest speeds up so its inputs arrive just-in-time → host rollback ~0', () => {
    const r = runDriftScenario({ withPacing: true, latency: 6, frames: 300 });
    // Pacing drives the guest ahead until the host always has its input buffered.
    expect(r.steadyMaxHostDepth).toBeLessThanOrEqual(1);
  }, 30000);
});

// ── Full harness reproduction: star + asymmetric latency + relay + STATE-SYNC
//    (host serializes every N ticks; guests rebase on hash mismatch). This is
//    the path BbNetSession uses live but that the other tests never exercised.
//    Captures each peer's per-tick hash ring and reports the earliest divergence
//    — the same thing the browser harness's "export divergence" does. ───────────
function runHarnessSim(opts: { latencies: number[]; frames: number; delay: number; chSeed: number; stateSyncEvery: number; loss: number }):
  { rings: Map<string, Map<number, string>>; firstDivergence: { tick: number; hashes: Record<string, string> } | null; refMismatch: { id: string; tick: number; hash: string; refHash: string | undefined } | null } {
  const ids = opts.latencies.map((_, i) => `p${i}`);
  const HOST = 'p0';
  const rng = mulberry32(opts.chSeed);
  const peers = ids.map((id) => {
    const ring = new Map<number, string>();
    const sim = makeSim(defaultLevel, ids, SEED, (tick, hash) => ring.set(tick, hash));
    return { id, sim, ring, recent: [] as TaggedInput[], advanceCount: 0,
      peer: new NetPeer({ localIds: [id], sim, inputDelay: opts.delay, snapshotInterval: 2, maxRollback: 30 }) };
  });
  const byId = (id: string) => peers.find((p) => p.id === id)!;
  const guests = peers.filter((p) => p.id !== HOST);
  const slotOf = (pid: string) => { const s = ids.indexOf(pid); return s < 0 ? undefined : s; };
  const idOfSlot = (s: number) => ids[s];
  const latOf = (id: string) => opts.latencies[ids.indexOf(id)];

  type Sync = { tick: number; hash: string; engineBuf: Uint8Array; gameState: unknown };
  type Msg = { to: string; from: string; at: number; kind: 'input'; bytes: ArrayBuffer } | { to: string; from: string; at: number; kind: 'state'; sync: Sync };
  const q: Msg[] = [];
  let G = 0;
  const linkLat = (from: string, to: string) => (from === HOST ? latOf(to) : latOf(from));
  const sendInput = (from: string, to: string, bytes: ArrayBuffer) => {
    if (opts.loss > 0 && rng() < opts.loss) return; // unreliable channel
    q.push({ to, from, at: G + linkLat(from, to), kind: 'input', bytes });
  };
  const sendState = (from: string, to: string, sync: Sync) => {
    q.push({ to, from, at: G + linkLat(from, to), kind: 'state', sync }); // reliable
  };

  const deliver = (m: Msg) => {
    const pe = byId(m.to);
    if (m.kind === 'input') {
      const items = decodeTaggedInputs(m.bytes, idOfSlot);
      if (items) for (const t of items) pe.peer.receive(t);
      // No per-owner relay: the host re-broadcasts an AGGREGATE of every player's
      // authoritative inputs each frame (see the host send below), matching
      // BbNetSession's aggregate-relay.
    } else {
      // Guest state-sync handling — mirrors BbNetSession.handleStateSync.
      const guestTick = pe.sim.engine.tick;
      let restore = false;
      if (guestTick < m.sync.tick - 60) restore = true;
      else { const local = pe.ring.get(m.sync.tick); if (local !== undefined && local !== m.sync.hash) restore = true; }
      if (restore) {
        pe.peer.applyAuthoritativeState(m.sync.tick, () => {
          pe.sim.engine.restoreState(m.sync.engineBuf);
          pe.sim.restoreGameState(m.sync.gameState as Parameters<typeof pe.sim.restoreGameState>[0]);
        });
        pe.ring.set(m.sync.tick, m.sync.hash);
      }
    }
  };

  for (G = 0; G < opts.frames; G++) {
    for (const pe of peers) {
      pe.peer.advance({ [pe.id]: scriptInput(pe.id, pe.advanceCount++) });
      for (const t of pe.peer.drainOutbox()) pe.recent.push(t);
      while (pe.recent.length > 16) pe.recent.shift();
      if (pe.id === HOST) {
        // Aggregate relay: ONE packet with every player's recent authoritative input.
        const agg = encodeTaggedInputs(pe.peer.recentAuthInputs(16), slotOf);
        for (const g of guests) sendInput(HOST, g.id, agg);
      } else {
        sendInput(pe.id, HOST, encodeTaggedInputs(pe.recent, slotOf));
      }
    }
    const host = byId(HOST);
    const ht = host.sim.engine.tick;
    if (ht % opts.stateSyncEvery === 0) {
      // Stream the host's CONFIRMED state (a past tick where all inputs are known),
      // NOT its current predicted state — so guests rebase onto canonical state.
      const snap = host.peer.confirmedStreamSnapshot();
      if (snap) {
        const sync: Sync = { tick: snap.tick, hash: snap.hash, engineBuf: snap.engineBuf, gameState: snap.gameState };
        for (const g of guests) sendState(HOST, g.id, sync);
      }
    }
    const keep: Msg[] = [];
    for (const m of q) { if (m.at <= G) deliver(m); else keep.push(m); }
    q.length = 0; q.push(...keep);
  }

  // earliest overlapping tick where two peers that both have it disagree (RING —
  // includes stale entries for ticks a rebase restored over without re-running)
  const rings = new Map(peers.map((p) => [p.id, p.ring] as const));
  const present = new Map<number, string[]>();
  for (const [id, ring] of rings) for (const t of ring.keys()) { const a = present.get(t) ?? []; a.push(id); present.set(t, a); }
  let firstDivergence: { tick: number; hashes: Record<string, string> } | null = null;
  for (const t of [...present.keys()].sort((a, b) => a - b)) {
    const idsAt = present.get(t)!;
    if (idsAt.length < 2) continue;
    const hs = idsAt.map((id) => rings.get(id)!.get(t)!);
    if (!hs.every((h) => h === hs[0])) { firstDivergence = { tick: t, hashes: Object.fromEntries(idsAt.map((id) => [id, rings.get(id)!.get(t)!])) }; break; }
  }

  // DEFINITIVE check: build a no-network reference (exact canonical inputs) and
  // compare each peer's CURRENT engine state to the reference AT its current
  // tick. This ignores stale ring history — it asks "is the live sim correct?".
  // SETTLE: the live host NEVER stops broadcasting its aggregate, so late guest
  // inputs reach the other guests on a later host frame. Mirror that: drain over
  // enough rounds to cover the max latency, re-broadcasting the host aggregate
  // each round (peers don't advance — no new ticks — they just receive + settle).
  const maxLat = Math.max(...opts.latencies);
  const host = byId(HOST);
  for (let d = 0; d <= maxLat + 6; d++) {
    G = opts.frames + d;
    const agg = encodeTaggedInputs(host.peer.recentAuthInputs(16), slotOf);
    for (const g of guests) sendInput(HOST, g.id, agg);
    const keep: Msg[] = [];
    for (const m of q) { if (m.at <= G) deliver(m); else keep.push(m); }
    q.length = 0; q.push(...keep);
  }
  G = 1e9; // flush anything still queued
  q.sort((a, b) => a.at - b.at);
  for (const m of q) deliver(m);
  q.length = 0;

  const ref = makeSim(defaultLevel, ids);
  const refByTick = new Map<number, string>();
  let maxTick = 0;
  for (const p of peers) maxTick = Math.max(maxTick, p.sim.engine.tick);
  for (let K = 1; K <= maxTick; K++) { ref.applyInputs(canonicalSet(ids, K, opts.delay)); ref.stepOne(); refByTick.set(K, ref.engine.stateHash()); }

  // Definitive: each peer's LIVE engine state must equal the reference at the
  // peer's current tick (every input for ticks ≤ now has been delivered).
  const live = peers.map((p) => ({ id: p.id, tick: p.sim.engine.tick, hash: p.sim.engine.stateHash(), refHash: refByTick.get(p.sim.engine.tick) }));
  if (process.env.HARNESS_DEBUG) {
    const hostHash = live.find((p) => p.id === 'p0')!.hash;
    console.log('[harness-repro] live vs ref:', JSON.stringify(live.map((p) => ({ id: p.id, tick: p.tick, okRef: p.hash === p.refHash, okHost: p.hash === hostHash })), null, 0));
  }
  const refMismatch = live.find((p) => p.hash !== p.refHash) ?? null;

  return { rings, firstDivergence, refMismatch };
}

describe('netcode harness reproduction (relay + asymmetric latency + state-sync)', () => {
  it('host + 3 guests at 60/120/180ms-equivalent latency → live state matches reference', () => {
    // latencies in TICKS (60ms≈4, 120ms≈7, 180ms≈11 at 60Hz).
    const r = runHarnessSim({ latencies: [0, 4, 7, 11], frames: 240, delay: 3, chSeed: 3, stateSyncEvery: 6, loss: 0.02 });
    console.log('[harness-repro] ring firstDivergence:', r.firstDivergence ? `tick ${r.firstDivergence.tick}` : 'none');
    console.log("[harness-repro] refMismatch:", r.refMismatch ? JSON.stringify(r.refMismatch) : "none (CONVERGED)");
    expect(r.refMismatch).toBeNull();
  }, 60000);

  it('ISOLATION: same scenario but state-sync OFF (rollback only)', () => {
    const r = runHarnessSim({ latencies: [0, 4, 7, 11], frames: 240, delay: 3, chSeed: 3, stateSyncEvery: 1_000_000, loss: 0.02 });
    console.log("[no-sync] refMismatch:", r.refMismatch ? JSON.stringify(r.refMismatch) : "none (CONVERGED)");
    expect(r.refMismatch).toBeNull();
  }, 60000);

  it('ISOLATION: state-sync OFF + NO loss (pure asymmetric-latency rollback)', () => {
    const r = runHarnessSim({ latencies: [0, 4, 7, 11], frames: 240, delay: 3, chSeed: 3, stateSyncEvery: 1_000_000, loss: 0 });
    console.log("[no-sync-no-loss] refMismatch:", r.refMismatch ? JSON.stringify(r.refMismatch) : "none (CONVERGED)");
    expect(r.refMismatch).toBeNull();
  }, 60000);
});

describe('netcode convergence (symmetric tick-tagged rollback)', () => {
  it('2 peers, no loss, low latency → every peer matches the reference', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 180, delay: 3,
      channel: { latency: 2, jitter: 1, loss: 0, redundancy: 1 }, chSeed: 1,
    });
    expect(r.stalls).toBe(0);
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 30000);

  it('2 peers, high jitter, 30% loss WITH redundancy → still converges', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 180, delay: 3,
      channel: { latency: 3, jitter: 3, loss: 0.3, redundancy: 16 }, chSeed: 7,
    });
    expect(r.totalRollbacks).toBeGreaterThan(0); // mispredictions happened…
    for (const h of r.peerHashes) expect(h).toBe(r.refHash); // …and were corrected
  }, 30000);

  it('tagged-input codec round-trips through the wire format', () => {
    const ids = ['p1', 'p2', 'p3'];
    const slotOf = (id: string) => ids.indexOf(id);
    const idOfSlot = (s: number) => ids[s];
    const items: TaggedInput[] = [
      { playerId: 'p1', applyTick: 1234, input: { moveX: quantizeAxis(1), moveY: quantizeAxis(-1), expanding: true } },
      { playerId: 'p2', applyTick: 1235, input: { moveX: quantizeAxis(0), moveY: quantizeAxis(1), expanding: false } },
      { playerId: 'p3', applyTick: 99999, input: { moveX: quantizeAxis(-1), moveY: quantizeAxis(0), expanding: true } },
    ];
    const decoded = decodeTaggedInputs(encodeTaggedInputs(items, slotOf), idOfSlot)!;
    expect(decoded).toHaveLength(3);
    for (let i = 0; i < items.length; i++) {
      expect(decoded[i].playerId).toBe(items[i].playerId);
      expect(decoded[i].applyTick).toBe(items[i].applyTick);
      expect(decoded[i].input).toEqual(items[i].input); // values are pre-quantized → exact
    }
  });

  it('4 peers, moderate latency + 15% loss WITH redundancy → all converge', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2', 'p3', 'p4'], frames: 150, delay: 3,
      channel: { latency: 2, jitter: 2, loss: 0.15, redundancy: 16 }, chSeed: 42,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    // All four agree with each other too.
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 30000);
});

describe('netcode edge cases — real feature levels', () => {
  // Spikes / death-zones / kill-plane / respawn run inside the Rust engine and
  // are captured by serializeState, so they're exercised under rollback with the
  // bare engine+PlayerManager sim. These levels also carry NPCs (and chains, for
  // chainedLevel) — all engine-side state that must survive predict→rollback.
  const featureLevels: Array<{ name: string; level: LevelData }> = [
    { name: 'classicLevel (spikes + NPCs)', level: classicLevel },
    { name: 'chainedLevel (spikes + chains + NPCs)', level: chainedLevel },
    { name: 'kothLevel (hill zones + spikes + NPCs)', level: kothLevel },
  ];

  for (const { name, level } of featureLevels) {
    it(`${name}: 2 peers, clean → hash-exact to reference`, () => {
      const r = runScenario({
        playerIds: ['p1', 'p2'], frames: 180, delay: 3, level,
        channel: { latency: 2, jitter: 1, loss: 0, redundancy: 1 }, chSeed: 5,
      });
      for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    }, 30000);

    it(`${name}: 3 peers, 25% loss + redundancy → rollbacks resolve to reference`, () => {
      const r = runScenario({
        playerIds: ['p1', 'p2', 'p3'], frames: 160, delay: 3, level,
        channel: { latency: 3, jitter: 3, loss: 0.25, redundancy: 16 }, chSeed: 17,
      });
      for (const h of r.peerHashes) expect(h).toBe(r.refHash);
      expect(new Set(r.peerHashes).size).toBe(1);
    }, 30000);
  }

  it('full-pipe star on kothLevel, host + 2 guests, 20% loss → hash-exact', () => {
    const r = runStarScenario({
      playerIds: ['host', 'g1', 'g2'], frames: 150, delay: 3, level: kothLevel,
      channel: { latency: 3, jitter: 2, loss: 0.2, redundancy: 16 }, chSeed: 23,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 30000);
});

describe('netcode edge cases — showcase level (every feature + moving platforms)', () => {
  // The showcase level carries moving platforms, springs, powerups, triggers,
  // actions, spikes, dynamic items, point shapes, NPCs. makeManagedSim runs the
  // full TS manager stack and snapshots their state (platformMover offset,
  // spring/powerup/dynamic-item) — so a rollback that didn't restore a manager's
  // JS state would surface here as a hash mismatch.
  const showcase = loadShowcaseLevel();

  it('2 peers, clean → hash-exact with all managers active', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 180, delay: 3, level: showcase, simFactory: makeManagedSim,
      channel: { latency: 2, jitter: 1, loss: 0, redundancy: 1 }, chSeed: 31,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 45000);

  it('3 peers, 25% loss + redundancy → rollbacks resolve with moving platforms + springs', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2', 'p3'], frames: 160, delay: 3, level: showcase, simFactory: makeManagedSim,
      channel: { latency: 3, jitter: 3, loss: 0.25, redundancy: 16 }, chSeed: 37,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 45000);

  it('full-pipe star (real codec + relay), host + 2 guests, 20% loss → hash-exact', () => {
    const r = runStarScenario({
      playerIds: ['host', 'g1', 'g2'], frames: 150, delay: 3, level: showcase, simFactory: makeManagedSim,
      channel: { latency: 3, jitter: 2, loss: 0.2, redundancy: 16 }, chSeed: 41,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 45000);
});

describe('netcode stress — scale + extreme conditions', () => {
  it('8 players (target max), 15% loss + redundancy → all converge', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const r = runScenario({
      playerIds: ids, frames: 120, delay: 3,
      channel: { latency: 2, jitter: 2, loss: 0.15, redundancy: 16 }, chSeed: 51,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 60000);

  it('extreme 45% loss with deep redundancy → still recovers to reference', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 160, delay: 3,
      channel: { latency: 4, jitter: 4, loss: 0.45, redundancy: 24 }, chSeed: 61,
    });
    expect(r.totalRollbacks).toBeGreaterThan(0);
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 45000);

  it('input delay = 1 (tight) → converges', () => {
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 150, delay: 1,
      channel: { latency: 2, jitter: 2, loss: 0.2, redundancy: 16 }, chSeed: 71,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 45000);

  it('input delay = 6 (forgiving), within the rollback window → converges', () => {
    // Keep max one-way delay (latency+jitter) comfortably under maxRollback (16)
    // so this exercises the delay parameter, not the window-exceeded path (which
    // is the keyframe safety-net's job — see the window-exceeded test below).
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 150, delay: 6,
      channel: { latency: 3, jitter: 2, loss: 0.15, redundancy: 16 }, chSeed: 73,
    });
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 45000);

  it('window-exceeded (delay 6 + 8-frame latency) → bounded, no crash (may not fully converge)', () => {
    // When a late input lands beyond maxRollback the snapshot is already pruned,
    // so NetPeer invalidates its ring rather than corrupting state. Convergence
    // here is NOT guaranteed (that's what Phase 4's state-stream/keyframe resync
    // is for) — we only assert it stays bounded and produces a valid hash.
    const r = runScenario({
      playerIds: ['p1', 'p2'], frames: 150, delay: 6,
      channel: { latency: 5, jitter: 3, loss: 0.2, redundancy: 16 }, chSeed: 73,
    });
    for (const h of r.peerHashes) expect(h).toMatch(/^0x[0-9a-f]+$/);
  }, 45000);
});

describe('netcode full-pipe (real codec + host-star relay)', () => {
  // These route every input through encodeTaggedInputs/decodeTaggedInputs and
  // the host relay — the exact bytes + topology BbNetSession uses live — so a
  // bug in the codec, slot mapping, or relay shows up as a hash mismatch.
  it('host + 1 guest, no loss → both hash-exact to reference', () => {
    const r = runStarScenario({
      playerIds: ['host', 'g1'], frames: 180, delay: 3,
      channel: { latency: 2, jitter: 1, loss: 0, redundancy: 16 }, chSeed: 3,
    });
    expect(r.stalls).toBe(0);
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
  }, 30000);

  it('host + 2 guests, 20% loss + redundancy → relay converges all to reference', () => {
    const r = runStarScenario({
      playerIds: ['host', 'g1', 'g2'], frames: 160, delay: 3,
      channel: { latency: 3, jitter: 2, loss: 0.2, redundancy: 16 }, chSeed: 11,
    });
    expect(r.totalRollbacks).toBeGreaterThan(0);
    for (const h of r.peerHashes) expect(h).toBe(r.refHash);
    expect(new Set(r.peerHashes).size).toBe(1);
  }, 30000);
});
