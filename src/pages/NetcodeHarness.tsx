// ─────────────────────────────────────────────────────────────────────────────
// Netcode harness — N real BouncyBlobsGame + BbNetSession instances on one
// screen, wired through an in-memory LocalBus with per-client simulated
// latency/jitter, each AI-driven. Runs the REAL renderer (so the DisplaySmoother
// eases rollback/state-sync corrections — no teleporting) and the REAL netcode,
// so this validates the actual shipping path, not a model.
//
// Topology mirrors production: instance 0 is the HOST (relays + streams confirmed
// state + paces clients); 1..N-1 are clients with climbing latency.
//
// Controls: pause, then STEP FORWARD / BACK one tick to scrub through divergence;
// slow-mo; per-tile hash spreadsheet + divergence export.
//
// NOTE: these are N wasm sims in ONE JS thread — at higher N they contend for CPU
// (clients can fall behind the host). That's harness cost, not netcode: the
// in-process convergence test (netcodeConvergence.test.ts) proves the netcode is
// exact with zero CPU/render in the loop.
//
// Route: /netcode-harness
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import GameCanvas from '../components/GameCanvas';
import { BouncyBlobsGame } from '../game/bouncyBlobsGame';
import { KingOfTheHillMode } from '../game/gameModes/kingOfTheHillMode';
import { kothLevel } from '../levels/kothLevel';
import { AIController } from '../game/aiController';
import { InputManager } from '../managers/InputManager';
import type { GameContext } from '../game/GameInterface';
import type { Player } from '../types/database';
import type { PersonalityName } from '../game/aiPersonalities';
import { BbNetSession } from '../game/net/bbNetSession';
import { LocalBus, type LinkCfg } from '../lib/netcode/localBus';
import { MAGIC_STATE_SYNC, MAGIC_HASH_BEACON } from '../lib/netcode/stateSyncCodec';
import { setPacingConfig } from '../lib/pacingConfig';
import { setSimSpeed } from '../lib/frameStep';

const N = 4;
const HOST_ID = 'i0';
const SEED = 0x1234abcd;
const PLAYER_IDS = Array.from({ length: N }, (_, i) => `p${i}`);
const COLORS = ['#ff5d5d', '#5dd6ff', '#ffd75d', '#7dff8a', '#c98aff', '#ff9d5d', '#5d8aff', '#ff5dc9'];
const PERSONALITIES: PersonalityName[] = ['hill_camper', 'goal_seeker', 'chaser', 'bouncer', 'wanderer', 'fleer', 'march_left', 'march_right'];
const LATENCIES = [0, 60, 120, 180, 80, 120, 160, 220];
const DEBUG_RING = 240; // ticks of step-back history kept per instance

type EngineSnap = { engine: Uint8Array; gameState: ReturnType<BouncyBlobsGame['snapshotGameState']> };
interface Instance {
  game: BouncyBlobsGame;
  session: BbNetSession;
  debug: Map<number, EngineSnap>;
  liveTick: number;
}

function makeContext(): GameContext {
  return {
    connection: null, sessionId: 'harness', players: [], gameState: {},
    playerStates: new Map(), inputManager: new InputManager(),
    api: { updateControllerLayout: () => {} },
  } as unknown as GameContext;
}

function makePlayer(idx: number): Player {
  return {
    player_id: PLAYER_IDS[idx], session_id: '', name: `P${idx}`, slot: idx, status: 'connected',
    controller_config: null, joined_at: new Date(0).toISOString(), color: COLORS[idx], faceId: 'default',
  } as unknown as Player;
}

type NetCfg = { latMult: number; jitterMult: number; lossPct: number };
function linkCfg(idx: number, n: NetCfg): LinkCfg {
  const latencyMs = LATENCIES[idx] * n.latMult;
  return { latencyMs, jitterMs: Math.round(latencyMs * n.jitterMult), dropPct: n.lossPct };
}

const btn: React.CSSProperties = {
  background: '#1a2030', color: '#cde', border: '1px solid #345', borderRadius: 4,
  padding: '3px 9px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
};

export default function NetcodeHarness() {
  const busRef = useRef<LocalBus | null>(null);
  const instancesRef = useRef<Map<string, Instance>>(new Map());
  const initedRef = useRef<Set<string>>(new Set());
  const teardownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hashRingsRef = useRef<Map<string, Map<number, string>>>(new Map());
  const rafRef = useRef<number>(0);
  const scrubRef = useRef<number>(0); // ticks behind live we're currently viewing
  // Cumulative host-upload byte counters (with client fan-out) + last-poll marks.
  const bwRef = useRef({ state: 0, input: 0, relay: 0, pacing: 0, syncCount: 0, syncBytes: 0, packets: 0, lastTick: 0, lastTotal: 0, lastState: 0, lastPackets: 0 });
  // Worker mode: each sim on its own thread (true parallelism for full-speed
  // validation), rendering the FULL game to a transferred OffscreenCanvas.
  const workersRef = useRef<(Worker | null)[]>([]);
  const workerStatRef = useRef<Array<{ tick: number; rollbacks: number; restores: number; pacingBias: number }>>(
    new Array(N).fill(null).map(() => ({ tick: 0, rollbacks: 0, restores: 0, pacingBias: 0 })),
  );
  const transferredRef = useRef<Set<number>>(new Set());
  const [mode, setMode] = useState<'main' | 'workers'>('main');
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [workerErr, setWorkerErr] = useState<(string | null)[]>(new Array(N).fill(null));

  const [paused, setPaused] = useState(false);
  const [slow, setSlow] = useState(false);
  const [camMode, setCamMode] = useState<'follow-local' | 'fit-all'>('follow-local');
  const [physPoints, setPhysPoints] = useState(false);
  const [scrub, setScrub] = useState(0);
  // Recording the per-tick engine state (for step-back) costs a serializeState per
  // tick per sim. Toggle OFF for a max-speed validation run; ON to scrub.
  const [record, setRecord] = useState(true);
  const recordRef = useRef(record);
  recordRef.current = record;
  // Live network conditions — applied to every bus link. latMult scales the base
  // per-client latency; jitterMult is the ± wobble as a fraction of that latency;
  // lossPct is per-packet drop on the (unreliable) input channel.
  const [net, setNet] = useState<NetCfg>({ latMult: 1, jitterMult: 0.3, lossPct: 2 });
  const netRef = useRef(net);
  netRef.current = net;
  const [stats, setStats] = useState<Array<{ tick: number; rollbacks: number; restores: number; pacingBias: number }>>(
    () => new Array(N).fill(null).map(() => ({ tick: 0, rollbacks: 0, restores: 0, pacingBias: 0 })),
  );
  const [table, setTable] = useState<Array<{ tick: number; cells: string[]; agree: boolean }> | null>(null);
  // Host upload, projected to live 60 Hz (counters are per-tick so the figure is
  // the same whether you run at 1× or ¼×). KB/s + the all-important per-sync size.
  const [bw, setBw] = useState({ totalKBs: 0, stateKBs: 0, ioKBs: 0, avgSyncB: 0, pktPerSec: 0, wireKBs: 0 });

  // ── Per-instance setup (mirrors production wiring exactly) ───────────────────
  const initOne = useCallback((idx: number, ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const instId = `i${idx}`;
    // Re-bind on a StrictMode remount (new canvas element) instead of leaving the
    // game drawing into a detached canvas (= blank tile).
    const existing = instancesRef.current.get(instId);
    if (existing) { existing.game.setCanvas(ctx.canvas as HTMLCanvasElement, ctx, w, h); return; }
    // GameCanvas (child) onInit can fire BEFORE this component's (parent) effect,
    // so create the bus lazily here — whichever runs first wins.
    if (!busRef.current) busRef.current = new LocalBus(HOST_ID);
    const bus = busRef.current;
    initedRef.current.add(instId);
    const isHost = instId === HOST_ID;
    const localPlayerId = PLAYER_IDS[idx];

    const game = new BouncyBlobsGame();
    game.setRngSeed(SEED);
    game.setGameMode(new KingOfTheHillMode(kothLevel));
    const context = makeContext();
    game.initialize(context);
    for (let p = 0; p < N; p++) game.onPlayerJoin(context, makePlayer(p));

    const pm = game.getPlayerManager()!;
    const controller = new AIController(PERSONALITIES[idx]);
    controller.setGoalProvider((self) => {
      const mode = game.getModeManager()?.getMode();
      const ms = game.getModeManager()?.getState();
      if (!mode || !ms || !mode.getGoalForBlob) return null;
      return mode.getGoalForBlob(self, ms);
    });
    pm.attachAIController(localPlayerId, controller);
    game.setLocalPlayerIds([localPlayerId]);
    game.setCameraMode(camMode);
    game.setCanvas(ctx.canvas as HTMLCanvasElement, ctx, w, h);

    const slotOf = (pid: string) => { const s = PLAYER_IDS.indexOf(pid); return s < 0 ? undefined : s; };
    const idOfSlot = (s: number) => PLAYER_IDS[s];

    const ring = new Map<number, string>();
    hashRingsRef.current.set(instId, ring);
    const onHash = (tick: number, hash: string) => {
      ring.set(tick, hash);
      if (ring.size > 4000) { const f = ring.keys().next().value; if (f !== undefined) ring.delete(f); }
    };

    const session = new BbNetSession({
      game, isHost,
      localHumanIds: () => [],
      botIds: () => [localPlayerId],
      readHumanInput: () => ({ moveX: 0, moveY: 0, expanding: false }),
      slotOf, idOfSlot,
      sendBytes: (bytes) => {
        // Host broadcasts ONE aggregate input packet to all N-1 clients (host upload);
        // a guest sends one copy upstream to the host (not host upload).
        if (isHost) { bwRef.current.input += bytes.byteLength * (N - 1); bwRef.current.packets += N - 1; return bus.broadcast(instId, 'input', bytes); }
        return bus.send(instId, HOST_ID, 'input', bytes);
      },
      sendState: isHost
        ? (bytes) => {
            bwRef.current.state += bytes.byteLength * (N - 1); bwRef.current.packets += N - 1;
            // Only full keyframes (0x04) count toward avg-sync-size; beacons (0x05) are tiny.
            if (new Uint8Array(bytes)[0] === MAGIC_STATE_SYNC) { bwRef.current.syncCount += 1; bwRef.current.syncBytes += bytes.byteLength; }
            return bus.broadcast(HOST_ID, 'state', bytes);
          }
        : undefined,
      sendStateTo: isHost
        ? (peerId, bytes) => { bwRef.current.state += bytes.byteLength; bwRef.current.packets += 1; bwRef.current.syncCount += 1; bwRef.current.syncBytes += bytes.byteLength; return bus.send(HOST_ID, peerId, 'state', bytes); }
        : undefined,
      requestState: !isHost ? () => bus.send(instId, HOST_ID, 'state', JSON.stringify({ type: 'need_state' })) : undefined,
      peerIdOf: isHost ? (pid) => { const k = PLAYER_IDS.indexOf(pid); return k > 0 ? `i${k}` : undefined; } : undefined,
      sendPacing: isHost ? (peerId, bias) => { const s = JSON.stringify({ type: 'pacing', bias }); bwRef.current.pacing += s.length; bwRef.current.packets += 1; return bus.send(HOST_ID, peerId, 'state', s); } : undefined,
      onHash,
    });
    session.install();
    if (!isHost) game.setClockAdjust(() => session.clockAdjust());

    bus.register(instId, (fromId, channel, data) => {
      if (channel === 'input') {
        session.handleIncoming(data as ArrayBuffer, fromId);
      } else if (channel === 'state') {
        if (typeof data !== 'string') {
          const magic = new Uint8Array(data)[0];
          if (magic === MAGIC_STATE_SYNC) session.handleStateSync(data);
          else if (magic === MAGIC_HASH_BEACON) session.handleHashBeacon(data);
        } else {
          try {
            const ev = JSON.parse(data);
            if (ev?.type === 'pacing') session.setPacingBias(Number(ev.bias) || 0);
            else if (ev?.type === 'need_state') session.handleStateRequest(fromId); // host: a guest wants a keyframe
          } catch { /* ignore */ }
        }
      }
    }, linkCfg(idx, netRef.current));

    game.start();
    game.startRound();
    instancesRef.current.set(instId, { game, session, debug: new Map(), liveTick: 0 });
  }, [camMode]);

  // ── Worker-mode per-instance setup: transfer the canvas, spawn the worker ────
  const initWorker = useCallback((idx: number, canvasEl: HTMLCanvasElement) => {
    if (transferredRef.current.has(idx)) return; // a canvas can only transfer once
    transferredRef.current.add(idx);
    const instId = `i${idx}`;
    if (!busRef.current) busRef.current = new LocalBus(HOST_ID);
    const bus = busRef.current;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(rect.width * dpr));
    canvasEl.height = Math.max(1, Math.round(rect.height * dpr));
    const offscreen = canvasEl.transferControlToOffscreen();

    const wk = new Worker(new URL('./netcode/simWorker.ts', import.meta.url), { type: 'module' });
    workersRef.current[idx] = wk;

    bus.register(instId, (from, channel, data) => { wk.postMessage({ type: 'bus-in', from, channel, data }); }, linkCfg(idx, netRef.current));

    wk.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'bus-out') {
        // Count HOST upload at the hub (with fan-out) so the meter works in worker mode.
        if (m.from === HOST_ID) {
          const len = m.data instanceof ArrayBuffer ? m.data.byteLength : String(m.data).length;
          const b = bwRef.current;
          if (m.op === 'broadcast') {
            b.packets += N - 1;
            if (m.channel === 'state') { b.state += len * (N - 1); if (m.data instanceof ArrayBuffer && new Uint8Array(m.data)[0] === MAGIC_STATE_SYNC) { b.syncCount++; b.syncBytes += len; } }
            else b.input += len * (N - 1);
          } else {
            b.packets += 1;
            if (typeof m.data === 'string') b.pacing += len;
            else { b.state += len; b.syncCount++; b.syncBytes += len; }
          }
        }
        if (m.op === 'broadcast') bus.broadcast(m.from, m.channel, m.data, m.exclude);
        else bus.send(m.from, m.to, m.channel, m.data);
      } else if (m.type === 'stat') {
        workerStatRef.current[idx] = { tick: m.tick, rollbacks: m.rollbacks, restores: m.restores, pacingBias: m.pacingBias };
        const ring = hashRingsRef.current.get(instId);
        if (ring && m.hash) { ring.set(m.tick, m.hash); if (ring.size > 4000) { const f = ring.keys().next().value; if (f !== undefined) ring.delete(f); } }
      } else if (m.type === 'worker-error') {
        console.error(`[harness] worker i${idx} ERROR:`, m.msg);
        setWorkerErr((prev) => { const next = [...prev]; next[idx] = String(m.msg).split('\n')[0].slice(0, 120); return next; });
      }
    };
    wk.onerror = (ev) => { console.error(`[harness] worker i${idx} onerror:`, ev.message); setWorkerErr((prev) => { const next = [...prev]; next[idx] = ev.message || 'worker error'; return next; }); };

    wk.postMessage({
      type: 'init', idx, isHost: idx === 0, hostId: HOST_ID, seed: SEED, n: N,
      playerIds: PLAYER_IDS, personalities: PERSONALITIES, colors: COLORS,
      canvas: offscreen, w: rect.width, h: rect.height, dpr,
    }, [offscreen]);
  }, []);

  const broadcastWorkerControl = useCallback((msg: Record<string, unknown>) => {
    for (const w of workersRef.current) w?.postMessage({ type: 'control', ...msg });
  }, []);

  // ── Lifecycle (deferred teardown for React StrictMode) + capture/stats loop ──
  useEffect(() => {
    if (teardownRef.current) { clearTimeout(teardownRef.current); teardownRef.current = null; }
    if (!busRef.current) busRef.current = new LocalBus(HOST_ID);
    for (let i = 0; i < N; i++) if (!hashRingsRef.current.has(`i${i}`)) hashRingsRef.current.set(`i${i}`, new Map());
    const workers = mode === 'workers';

    // Per-tick step-back history (MAIN mode only — workers own their state).
    const capture = () => {
      if (!workers && recordRef.current) {
        for (const inst of instancesRef.current.values()) {
          const wl = inst.game.getWorld();
          if (wl && wl.tick > inst.liveTick) {
            inst.debug.set(wl.tick, { engine: wl.serializeState(), gameState: inst.game.snapshotGameState() });
            inst.liveTick = wl.tick;
            while (inst.debug.size > DEBUG_RING) { const f = inst.debug.keys().next().value; if (f === undefined) break; inst.debug.delete(f); }
          }
        }
      } else if (!workers) {
        for (const inst of instancesRef.current.values()) { const wl = inst.game.getWorld(); if (wl) inst.liveTick = wl.tick; }
      }
      rafRef.current = requestAnimationFrame(capture);
    };
    rafRef.current = requestAnimationFrame(capture);

    const statTimer = setInterval(() => {
      setStats(Array.from({ length: N }, (_, i) => {
        if (workers) return { ...workerStatRef.current[i] };
        const inst = instancesRef.current.get(`i${i}`);
        const s = inst?.session.stats();
        return { tick: inst?.game.getWorld()?.tick ?? 0, rollbacks: s?.rollbacks ?? 0, restores: s?.stateSyncRestores ?? 0, pacingBias: s?.pacingBias ?? 0 };
      }));

      // Host bandwidth, normalized per host-tick × 60 → live 60 Hz projection.
      const b = bwRef.current;
      const hostTick = workers ? workerStatRef.current[0].tick : (instancesRef.current.get(HOST_ID)?.game.getWorld()?.tick ?? 0);
      const dTick = hostTick - b.lastTick;
      if (dTick > 0) {
        const total = b.state + b.input + b.relay + b.pacing;
        const perTick = (total - b.lastTotal) / dTick;
        const statePerTick = (b.state - b.lastState) / dTick;
        const pktPerSec = ((b.packets - b.lastPackets) / dTick) * 60;
        const PKT_OVERHEAD = 60; // ~UDP+DTLS+SCTP bytes per datagram on a real link
        setBw({
          totalKBs: (perTick * 60) / 1024,
          stateKBs: (statePerTick * 60) / 1024,
          ioKBs: ((perTick - statePerTick) * 60) / 1024,
          avgSyncB: b.syncCount > 0 ? Math.round(b.syncBytes / b.syncCount) : 0,
          pktPerSec,
          wireKBs: (perTick * 60 + pktPerSec * PKT_OVERHEAD) / 1024,
        });
        b.lastTick = hostTick; b.lastTotal = total; b.lastState = b.state; b.lastPackets = b.packets;
      }
    }, 500);

    return () => {
      cancelAnimationFrame(rafRef.current);
      clearInterval(statTimer);
      teardownRef.current = setTimeout(() => {
        for (const inst of instancesRef.current.values()) { inst.session.dispose(); inst.game.stop(); }
        instancesRef.current.clear();
        initedRef.current.clear();
        for (const w of workersRef.current) w?.terminate();
        workersRef.current = [];
        transferredRef.current.clear();
        for (const ring of hashRingsRef.current.values()) ring.clear();
        busRef.current?.dispose();
        busRef.current = null;
      }, 150);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // React to camera-mode changes (main: instances directly; workers: control msg).
  useEffect(() => {
    if (modeRef.current === 'workers') broadcastWorkerControl({ camMode });
    else for (const inst of instancesRef.current.values()) inst.game.setCameraMode(camMode);
  }, [camMode, broadcastWorkerControl]);

  // Toggle the raw-physics-points overlay.
  useEffect(() => {
    if (modeRef.current === 'workers') broadcastWorkerControl({ physPoints });
    else for (const inst of instancesRef.current.values()) inst.game.setShowPhysicsPoints(physPoints);
  }, [physPoints, broadcastWorkerControl]);

  // Apply live network-condition changes (latency / jitter / loss) to every link.
  useEffect(() => {
    const bus = busRef.current;
    if (!bus) return;
    for (let i = 0; i < N; i++) bus.setLinkCfg(`i${i}`, linkCfg(i, net));
  }, [net]);

  // ── Step-back scrub: restore every instance to (liveTick - offset) ───────────
  const restoreScrub = useCallback(() => {
    const off = scrubRef.current;
    for (const inst of instancesRef.current.values()) {
      const t = inst.liveTick - off;
      const e = inst.debug.get(t);
      if (e) { inst.game.getWorld()?.restoreState(e.engine); inst.game.restoreGameState(e.gameState); }
    }
  }, []);

  const setPausedAll = (p: boolean) => {
    if (mode === 'workers') broadcastWorkerControl({ paused: p });
    else setPacingConfig({ paused: p }); // main: all sims share the global config
    setPaused(p);
  };
  const togglePause = () => {
    if (paused && mode === 'main' && scrubRef.current > 0) { scrubRef.current = 0; setScrub(0); restoreScrub(); }
    setPausedAll(!paused);
  };
  const toggleSlow = () => { const s = !slow; setSlow(s); if (mode === 'workers') broadcastWorkerControl({ simSpeed: s ? 0.25 : 1 }); else setSimSpeed(s ? 0.25 : 1); };
  const stepBack = () => {
    if (!paused || mode === 'workers') return; // step-back is main-mode only
    let maxBack = Infinity;
    for (const inst of instancesRef.current.values()) maxBack = Math.min(maxBack, inst.debug.size - 1);
    scrubRef.current = Math.min(scrubRef.current + 1, Math.max(0, maxBack));
    setScrub(scrubRef.current);
    restoreScrub();
  };
  const stepForward = () => {
    if (!paused) return;
    if (mode === 'workers') { broadcastWorkerControl({ step: 1 }); return; }
    if (scrubRef.current > 0) {
      scrubRef.current -= 1; setScrub(scrubRef.current); restoreScrub();
    } else {
      for (const inst of instancesRef.current.values()) inst.session.forceStepOnce();
    }
  };

  // ── Hash spreadsheet + divergence export ─────────────────────────────────────
  const openTable = useCallback(() => {
    const rings = hashRingsRef.current;
    let maxTick = 0;
    for (const ring of rings.values()) for (const t of ring.keys()) if (t > maxTick) maxTick = t;
    const rows: Array<{ tick: number; cells: string[]; agree: boolean }> = [];
    for (let t = Math.max(0, maxTick - 179); t <= maxTick; t++) {
      const cells: string[] = []; const present: string[] = [];
      for (let i = 0; i < N; i++) { const h = rings.get(`i${i}`)?.get(t); cells.push(h ? h.slice(0, 12) : '—'); if (h) present.push(h); }
      rows.push({ tick: t, cells, agree: present.length >= 2 ? present.every((x) => x === present[0]) : true });
    }
    setTable(rows);
  }, []);

  const exportDivergence = useCallback(() => {
    const rings = hashRingsRef.current;
    let maxTick = 0;
    for (const ring of rings.values()) for (const t of ring.keys()) if (t > maxTick) maxTick = t;
    let firstDivergence: { tick: number; hashes: Record<string, string> } | null = null;
    for (let t = 1; t <= maxTick && !firstDivergence; t++) {
      const present: string[] = []; const hashes: Record<string, string> = {};
      for (let i = 0; i < N; i++) { const h = rings.get(`i${i}`)?.get(t); if (h) { present.push(h); hashes[`i${i}`] = h; } }
      if (present.length >= 2 && !present.every((x) => x === present[0])) firstDivergence = { tick: t, hashes };
    }
    const out = {
      instances: Array.from({ length: N }, (_, i) => ({ id: `i${i}`, role: i === 0 ? 'host' : 'client', latencyMs: LATENCIES[i], currentTick: instancesRef.current.get(`i${i}`)?.game.getWorld()?.tick ?? 0 })),
      firstDivergence,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'netcode-divergence.json'; a.click();
    navigator.clipboard?.writeText(JSON.stringify(out, null, 2)).catch(() => {});
  }, []);

  const cols = Math.min(N, 2);
  const rows = Math.ceil(N / cols);
  return (
    <div style={{ background: '#070a12', height: '100vh', color: '#cde', fontFamily: 'ui-monospace, monospace', padding: 8, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', flexShrink: 0 }}>
        <strong style={{ color: '#8cf' }}>Netcode harness · {N} sims</strong>
        <button
          onClick={() => { setPaused(false); setSlow(false); setScrub(0); scrubRef.current = 0; setWorkerErr(new Array(N).fill(null)); setMode((mm) => (mm === 'main' ? 'workers' : 'main')); }}
          style={{ ...btn, borderColor: mode === 'workers' ? '#5d9' : '#345', fontWeight: 700 }}
          title="Main thread = full visuals but N sims contend for one core. Workers = each sim on its own core (true full speed) — full visuals via OffscreenCanvas."
        >{mode === 'workers' ? '⚡ workers' : '🧵 main thread'}</button>
        <button onClick={togglePause} style={btn}>{paused ? '▶ resume' : '⏸ pause'}</button>
        <button onClick={stepBack} style={btn} disabled={!paused}>⏮ step back</button>
        <button onClick={stepForward} style={btn} disabled={!paused}>step fwd ⏭</button>
        {paused && <span style={{ fontSize: 11, color: scrub > 0 ? '#fa3' : '#678' }}>{scrub > 0 ? `scrubbed −${scrub} ticks` : 'live edge'}</span>}
        <button onClick={toggleSlow} style={{ ...btn, borderColor: slow ? '#7af' : '#345' }}>{slow ? '🐢 ¼×' : '1× speed'}</button>
        <button onClick={() => setRecord((r) => !r)} style={{ ...btn, borderColor: record ? '#a55' : '#345' }} title="Per-tick state recording for step-back. Off = max speed.">{record ? '⏺ rec' : '○ rec off'}</button>
        <button onClick={() => setCamMode((c) => (c === 'follow-local' ? 'fit-all' : 'follow-local'))} style={btn}>
          {camMode === 'follow-local' ? '🎯 follow' : '🗺 fit-all'}
        </button>
        <button onClick={() => setPhysPoints((p) => !p)} style={{ ...btn, borderColor: physPoints ? '#f2557d' : '#345' }} title="Overlay raw physics hull nodes (red dots) to see how far the smoothed visuals lag the sim.">{physPoints ? '🔴 physics' : '○ physics'}</button>
        <button onClick={openTable} style={{ ...btn, marginLeft: 8, borderColor: '#58a' }}>📊 hash table</button>
        <button onClick={exportDivergence} style={{ ...btn, borderColor: '#a85' }}>⬇ export divergence</button>
        <span title="Host upload projected to live 60 Hz (with client fan-out). Counters are per-tick, so this is the live figure even at ¼× speed."
          style={{ marginLeft: 'auto', fontSize: 11, color: '#9cf', whiteSpace: 'nowrap' }}>
          ↑ host <strong style={{ color: bw.totalKBs > 100 ? '#fa3' : '#7d7' }}>{bw.totalKBs.toFixed(1)} KB/s</strong>
          <span style={{ color: '#789' }}> payload · ~{bw.wireKBs.toFixed(1)} wire · {Math.round(bw.pktPerSec)} pkt/s · state {bw.stateKBs.toFixed(1)} · io {bw.ioKBs.toFixed(2)} · sync {bw.avgSyncB} B×{N - 1}</span>
        </span>
      </div>

      {/* Live network conditions — drag while it runs to stress jitter/loss/latency. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8, flexShrink: 0, fontSize: 11, color: '#9ab', flexWrap: 'wrap' }}>
        <span style={{ color: '#678' }}>network ·</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          latency <input type="range" min={0} max={4} step={0.25} value={net.latMult} onChange={(e) => setNet((n) => ({ ...n, latMult: +e.target.value }))} style={{ width: 80 }} />
          <span style={{ width: 30, color: '#cde' }}>{net.latMult.toFixed(2)}×</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          jitter <input type="range" min={0} max={1} step={0.05} value={net.jitterMult} onChange={(e) => setNet((n) => ({ ...n, jitterMult: +e.target.value }))} style={{ width: 80 }} />
          <span style={{ width: 34, color: '#cde' }}>±{Math.round(net.jitterMult * 100)}%</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          loss <input type="range" min={0} max={30} step={1} value={net.lossPct} onChange={(e) => setNet((n) => ({ ...n, lossPct: +e.target.value }))} style={{ width: 80 }} />
          <span style={{ width: 26, color: net.lossPct > 10 ? '#fa3' : '#cde' }}>{net.lossPct}%</span>
        </label>
        <span style={{ color: '#567' }}>base lat 0/60/120/180ms · loss hits the input channel (state is reliable)</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap: 8 }}>
        {Array.from({ length: N }, (_, i) => {
          const delta = stats[i].tick - stats[0].tick;
          const bias = stats[i].pacingBias;
          const clock = bias > 0 ? '⏩ faster' : bias < 0 ? '⏪ slower' : '▶ normal';
          return (
            <div key={i} style={{ border: `1px solid ${i === 0 ? '#fd5' : '#234'}`, borderRadius: 6, overflow: 'hidden', background: '#0b0f1a', position: 'relative', minHeight: 0, minWidth: 0 }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1, fontSize: 11, padding: '3px 6px', background: 'rgba(7,10,18,0.78)', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: COLORS[i] }} />
                {i === 0 ? '★ HOST' : `client ${i}`} · {LATENCIES[i]}ms · t{stats[i].tick}
                {i !== 0 && (
                  <>
                    <span style={{ color: delta > 0 ? '#6d6' : delta < 0 ? '#f77' : '#aa6' }}>{delta >= 0 ? `+${delta} ahead` : `${delta} behind`}</span>
                    <span style={{ color: bias > 0 ? '#fa3' : bias < 0 ? '#7af' : '#789' }}>{clock}</span>
                    <span style={{ color: stats[i].restores > 3 ? '#f77' : '#678' }}>rb{stats[i].rollbacks}·sync{stats[i].restores}</span>
                  </>
                )}
                {workerErr[i] && <span style={{ color: '#fff', background: '#a11', padding: '1px 4px', borderRadius: 3, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} title={workerErr[i]!}>⚠ {workerErr[i]}</span>}
              </div>
              {mode === 'workers' ? (
                // Plain canvas: its control is transferred to the worker, which
                // renders the FULL game on its own thread.
                <canvas
                  key="wk"
                  ref={(el) => { if (el && mode === 'workers') { try { initWorker(i, el); } catch (e) { console.error(`[harness] worker i${i} failed`, e); } } }}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />
              ) : (
                <GameCanvas
                  key="mt"
                  onInit={(ctx, w, h) => { try { initOne(i, ctx, w, h); } catch (e) { console.error(`[harness] init i${i} failed`, e); } }}
                  onResize={(w, h) => instancesRef.current.get(`i${i}`)?.game.setCanvasSize(w, h)}
                  style={{ width: '100%', height: '100%', display: 'block' }}
                />
              )}
            </div>
          );
        })}
      </div>

      {table && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setTable(null)}>
          <div style={{ background: '#0e1320', border: '1px solid #345', borderRadius: 6, padding: 10, maxHeight: '88vh', width: 560, display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong style={{ color: '#8cf', fontSize: 13 }}>Per-tick state hash — last {table.length} ticks</strong>
              <div>
                <button onClick={openTable} style={{ ...btn, marginRight: 6 }}>refresh</button>
                <button onClick={() => setTable(null)} style={btn}>close</button>
              </div>
            </div>
            <div style={{ fontSize: 10, color: '#789', marginBottom: 6 }}>green = all instances agree · red = a divergence · cells are stateHash[:12]</div>
            <div style={{ overflow: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 10, fontVariantNumeric: 'tabular-nums', width: '100%' }}>
                <thead>
                  <tr style={{ position: 'sticky', top: 0, background: '#0e1320' }}>
                    <th style={{ textAlign: 'right', padding: '2px 6px', color: '#789' }}>tick</th>
                    {Array.from({ length: N }, (_, i) => (
                      <th key={i} style={{ textAlign: 'left', padding: '2px 6px', color: i === 0 ? '#fd5' : '#9cf' }}>{i === 0 ? 'host' : `c${i}·${LATENCIES[i]}ms`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.map((row) => {
                    const first = row.cells.find((x) => x !== '—');
                    return (
                      <tr key={row.tick} style={{ background: row.agree ? 'transparent' : 'rgba(120,20,20,0.35)' }}>
                        <td style={{ textAlign: 'right', padding: '1px 6px', color: '#789' }}>{row.tick}</td>
                        {row.cells.map((c, i) => (
                          <td key={i} style={{ padding: '1px 6px', fontFamily: 'monospace', color: c === '—' ? '#555' : row.agree || c === first ? '#7d7' : '#f77' }}>{c}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
