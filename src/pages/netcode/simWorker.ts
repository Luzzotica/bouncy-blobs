// ─────────────────────────────────────────────────────────────────────────────
// Netcode harness SIM WORKER — runs ONE full BouncyBlobsGame + BbNetSession on its
// own thread, rendering the FULL game (candy skins, faces, per-node smoothing) to
// a transferred OffscreenCanvas. So worker mode is full visuals AND true
// parallelism — N softbody sims on N cores instead of contending on one.
//
// Bus routing + latency sim live on the MAIN thread (a LocalBus hub): the worker
// forwards outgoing packets as `bus-out` and receives delivered ones as `bus-in`.
// ─────────────────────────────────────────────────────────────────────────────
/// <reference lib="webworker" />
import { loadWasm } from '../../physics/softBodyWorldRust';
import { BouncyBlobsGame } from '../../game/bouncyBlobsGame';
import { KingOfTheHillMode } from '../../game/gameModes/kingOfTheHillMode';
import { kothLevel } from '../../levels/kothLevel';
import { AIController } from '../../game/aiController';
import { InputManager } from '../../managers/InputManager';
import { BbNetSession } from '../../game/net/bbNetSession';
import { MAGIC_STATE_SYNC, MAGIC_HASH_BEACON } from '../../lib/netcode/stateSyncCodec';
import { setPacingConfig } from '../../lib/pacingConfig';
import { setSimSpeed, requestSteps } from '../../lib/frameStep';
import type { GameContext } from '../../game/GameInterface';
import type { Player } from '../../types/database';
import type { PersonalityName } from '../../game/aiPersonalities';

// Workers have no requestAnimationFrame — polyfill with setTimeout (workers are
// NOT background-throttled, so this paces fine at ~60 Hz and runs full-speed).
const FRAME_MS = 1000 / 60;
(self as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame =
  (cb) => setTimeout(() => cb(performance.now()), FRAME_MS) as unknown as number;
(self as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
  (id) => clearTimeout(id);

// Surface ANY uncaught worker error (incl. render throws from the setTimeout loop)
// to the main thread → console, so a freeze is diagnosable instead of silent.
self.onerror = (msg, src, line, col, err) => {
  try { (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ type: 'worker-error', msg: String((err && (err as Error).stack) || msg), line, col }); } catch { /* ignore */ }
  return false;
};
(self as unknown as { onunhandledrejection: (e: PromiseRejectionEvent) => void }).onunhandledrejection = (e) => {
  try { (self as unknown as { postMessage: (m: unknown) => void }).postMessage({ type: 'worker-error', msg: 'unhandledrejection: ' + String((e.reason && e.reason.stack) || e.reason) }); } catch { /* ignore */ }
};

interface InitMsg {
  type: 'init';
  idx: number; isHost: boolean; hostId: string; seed: number; n: number;
  playerIds: string[]; personalities: PersonalityName[]; colors: string[];
  canvas: OffscreenCanvas; w: number; h: number; dpr: number;
}

let game: BouncyBlobsGame | null = null;
let session: BbNetSession | null = null;
let cfg: InitMsg | null = null;
let busIn: ((from: string, channel: string, data: ArrayBuffer | string) => void) | null = null;
let lastHash = '';

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer);
}
function toAB(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  return b instanceof Uint8Array ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b.slice(0);
}
function makeContext(): GameContext {
  return { connection: null, sessionId: 'harness', players: [], gameState: {}, playerStates: new Map(), inputManager: new InputManager(), api: { updateControllerLayout: () => {} } } as unknown as GameContext;
}
function makePlayer(idx: number, m: InitMsg): Player {
  return { player_id: m.playerIds[idx], session_id: '', name: `P${idx}`, slot: idx, status: 'connected', controller_config: null, joined_at: new Date(0).toISOString(), color: m.colors[idx], faceId: 'default' } as unknown as Player;
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') void init(m as InitMsg).catch((err) => post({ type: 'worker-error', msg: 'init: ' + String((err && err.stack) || err) }));
  else if (m.type === 'bus-in') busIn?.(m.from, m.channel, m.data);
  else if (m.type === 'control') {
    if (m.paused !== undefined) setPacingConfig({ paused: !!m.paused });
    if (m.simSpeed !== undefined) setSimSpeed(m.simSpeed);
    if (m.step) requestSteps(m.step);
    if (m.camMode && game) game.setCameraMode(m.camMode);
    if (m.physPoints !== undefined && game) game.setShowPhysicsPoints(!!m.physPoints);
  }
};

async function init(m: InitMsg): Promise<void> {
  cfg = m;
  await loadWasm();
  const instId = `i${m.idx}`;
  const isHost = m.isHost;
  const localPlayerId = m.playerIds[m.idx];

  const g = new BouncyBlobsGame();
  game = g;
  g.setRngSeed(m.seed);
  g.setGameMode(new KingOfTheHillMode(kothLevel));
  const context = makeContext();
  g.initialize(context);
  for (let p = 0; p < m.n; p++) g.onPlayerJoin(context, makePlayer(p, m));

  const pm = g.getPlayerManager()!;
  const controller = new AIController(m.personalities[m.idx]);
  controller.setGoalProvider((selfP) => {
    const mode = g.getModeManager()?.getMode();
    const ms = g.getModeManager()?.getState();
    if (!mode || !ms || !mode.getGoalForBlob) return null;
    return mode.getGoalForBlob(selfP, ms);
  });
  pm.attachAIController(localPlayerId, controller);
  g.setLocalPlayerIds([localPlayerId]);
  g.setCameraMode('follow-local');
  // FULL render to the transferred OffscreenCanvas (shows on the main-thread canvas).
  // Backing store is dpr-scaled; scale the ctx so the game draws in CSS/logical units.
  const ctx = m.canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  ctx.scale(m.dpr, m.dpr);
  g.setCanvas(m.canvas as unknown as HTMLCanvasElement, ctx, m.w, m.h);

  const slotOf = (pid: string) => { const s = m.playerIds.indexOf(pid); return s < 0 ? undefined : s; };
  const idOfSlot = (s: number) => m.playerIds[s];

  const s = new BbNetSession({
    game: g, isHost,
    localHumanIds: () => [],
    botIds: () => [localPlayerId],
    readHumanInput: () => ({ moveX: 0, moveY: 0, expanding: false }),
    slotOf, idOfSlot,
    sendBytes: (bytes) => post(
      isHost
        ? { type: 'bus-out', op: 'broadcast', from: instId, channel: 'input', data: toAB(bytes) }
        : { type: 'bus-out', op: 'send', from: instId, to: m.hostId, channel: 'input', data: toAB(bytes) },
    ),
    sendState: isHost ? (bytes) => post({ type: 'bus-out', op: 'broadcast', from: m.hostId, channel: 'state', data: toAB(bytes) }) : undefined,
    sendStateTo: isHost ? (peerId, bytes) => post({ type: 'bus-out', op: 'send', from: m.hostId, to: peerId, channel: 'state', data: toAB(bytes) }) : undefined,
    requestState: !isHost ? () => post({ type: 'bus-out', op: 'send', from: instId, to: m.hostId, channel: 'state', data: JSON.stringify({ type: 'need_state' }) }) : undefined,
    peerIdOf: isHost ? (pid) => { const k = m.playerIds.indexOf(pid); return k > 0 ? `i${k}` : undefined; } : undefined,
    sendPacing: isHost ? (peerId, bias) => post({ type: 'bus-out', op: 'send', from: m.hostId, to: peerId, channel: 'state', data: JSON.stringify({ type: 'pacing', bias }) }) : undefined,
    onHash: (_tick, hash) => { lastHash = hash; },
  });
  session = s;
  s.install();
  if (!isHost) g.setClockAdjust(() => s.clockAdjust());

  busIn = (from, channel, data) => {
    if (channel === 'input') {
      s.handleIncoming(data as ArrayBuffer, from);
    } else if (channel === 'state') {
      if (typeof data !== 'string') {
        const magic = new Uint8Array(data)[0];
        if (magic === MAGIC_STATE_SYNC) s.handleStateSync(data);
        else if (magic === MAGIC_HASH_BEACON) s.handleHashBeacon(data);
      } else {
        try {
          const ev = JSON.parse(data);
          if (ev?.type === 'pacing') s.setPacingBias(Number(ev.bias) || 0);
          else if (ev?.type === 'need_state') s.handleStateRequest(from);
        } catch { /* ignore */ }
      }
    }
  };

  g.start();
  g.startRound();
  post({ type: 'ready', idx: m.idx });

  // Post stats + the current per-tick hash to the main thread (~20 Hz) for the
  // tiles, hash table, and divergence export.
  setInterval(() => {
    if (!game || !session) return;
    const st = session.stats();
    post({ type: 'stat', idx: m.idx, tick: game.getWorld()?.tick ?? 0, hash: lastHash, rollbacks: st?.rollbacks ?? 0, restores: st?.stateSyncRestores ?? 0, pacingBias: st?.pacingBias ?? 0 });
  }, 50);
}
