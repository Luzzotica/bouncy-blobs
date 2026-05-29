import { useEffect, useMemo, useRef, useState } from "react";
import { RollbackController, type InputSet } from "../game/rollback/RollbackController";
import { evaluateLockstepGate } from "./lockstepGate";
import { DisplaySmoother } from "../game/rollback/displaySmoothing";
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { joinAsPeer, RoomService, PeerManager, SteamTransport, getSelfSteamId } from "../lib/party";
import { roomConfig } from "../lib/partyConfig";
import { joinLobby, leaveLobby } from "../lib/steamLobbyApi";
import {
  type InputBatch,
  type ReliableEvent,
  type LobbyStateEvent,
} from "../lib/multiplayerSnapshot";
import {
  decodeSnapshot,
  BINARY_MAGIC,
  MAX_OFFSET,
  ENTITY_KIND_NPC,
  ENTITY_KIND_PLATFORM,
  ENTITY_KIND_POINT_SHAPE,
  type SnapshotFrame,
} from "../lib/wireProtocol";
import { decodeAggregatedInputs, MAGIC_AGGREGATED_INPUTS } from "../lib/inputProtocol";
import { installDebugBridge, setNetDiagAccessor, setRollbackStatsAccessor, setSnapsAccessor } from "../lib/debugBridge";
import GameCanvas from "../components/GameCanvas";
import GuestLobbyPanel from "../components/GuestLobbyPanel";
import { COLOR_PALETTE } from "../constants/customization";
import { BouncyBlobsGame } from "../game/bouncyBlobsGame";
import type { GameContext } from "../game/GameInterface";
import { InputManager } from "../managers/InputManager";
import type { LevelData, LevelType } from "../levels/types";
import type { Player } from "../types/database";
import { ClassicMode } from "../game/gameModes/classicMode";
import { ChainedMode } from "../game/gameModes/chainedMode";
import { PartyMode } from "../game/gameModes/partyMode";
import { KingOfTheHillMode } from "../game/gameModes/kingOfTheHillMode";
import { FreeplayMode } from "../game/gameModes/freeplayMode";
import { getLevelTypes } from "../levels/types";
import type { GameMode } from "../game/gameModes/types";
import { getPendingJoin, clearPendingJoin } from "./LobbyBrowser";

const INPUT_HZ = 30;

type Phase = "connecting" | "connected" | "host_disconnected" | "error";

/**
 * Pure mirror of GameMaster's createModeForLevel — instantiates the same
 * GameMode subclass on the guest so its local sim mirrors the host's mode
 * (KOTH, party, racing). The mode's local timer/scores are best-effort; the
 * host's modeState in snapshots is the source of truth.
 */
function createMirrorMode(level: LevelData, override?: LevelType, freeplay = false): GameMode {
  // While the host is in its pre-round playground arena (freeplay), the guest
  // should run FreeplayMode too — same as the host. Otherwise the guest's
  // local sim runs a competitive mode's countdown / round timer over what's
  // supposed to be a free-for-all idle screen.
  if (freeplay) return new FreeplayMode(level);
  if (level.hillZones && level.hillZones.length > 0) return new KingOfTheHillMode(level);
  const mode = override ?? getLevelTypes(level)[0];
  switch (mode) {
    case "team_racing": return new ChainedMode(level);
    case "party": return new PartyMode(level);
    case "koth": return new KingOfTheHillMode(level);
    case "solo_racing":
    default: return new ClassicMode(level);
  }
}

export default function OnlineGuest() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lobbyCode, setLobbyCode] = useState<string>("");
  const [localPlayerJoined, setLocalPlayerJoined] = useState(false);
  const [hasLevel, setHasLevel] = useState(false);
  /** If `joinAsLocalPlayer` fired before the canvas was ready (no game
   *  context yet → game.onPlayerJoin would silently no-op), we record
   *  the synthesized Player here. `onCanvasInit` drains it once the
   *  game has been initialised so the local blob still gets spawned —
   *  deferred by a render or two instead of waiting up to a full
   *  second for a keyframe to synthesise it. */
  const pendingLocalSpawnRef = useRef<Player | null>(null);
  const [statusLine, setStatusLine] = useState<string>("");
  const [lobbyState, setLobbyState] = useState<LobbyStateEvent | null>(null);
  const [localColor, setLocalColor] = useState<string>(COLOR_PALETTE[1] ?? "#ffd166");
  const [localFaceId, setLocalFaceId] = useState<string>("default");

  const roomRef = useRef<RoomService | null>(null);
  const managerRef = useRef<PeerManager | null>(null);

  // Local sim — full BouncyBlobsGame instance with the same level as the host.
  const gameRef = useRef<BouncyBlobsGame | null>(null);
  const gameContextRef = useRef<GameContext | null>(null);
  const inputManagerRef = useRef<InputManager>(new InputManager());
  const currentLevelRef = useRef<{ levelId: string; levelData: LevelData; levelType: LevelType } | null>(null);
  // Snapshot inputs to apply to non-own players each frame (drives their motion locally).
  const remoteInputRef = useRef<Map<string, { moveX: number; moveY: number; expanding: boolean; expandScale: number }>>(new Map());

  const localPlayerIdRef = useRef<string>("");
  // Name the user typed in the LobbyBrowser prompt. Used as the
  // player_join.name and as the synth fallback before the host's
  // lobby_state roster lands.
  const localNameRef = useRef<string>("Player");
  const [canvasKey, setCanvasKey] = useState(0);

  // Rollback prediction (Phase 7D). Default off — keyboard-driven
  // override via `?prediction=on`. When enabled, the guest applies
  // local input INSTANTLY (no host echo wait) and reconciles against
  // authoritative inputs via the RollbackController.
  const usePrediction = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get('prediction') === 'on';
  }, []);
  /** Live keyboard state — shared between the keyboard interval and the
   *  prediction gate so the gate can read "what's pressed RIGHT NOW". */
  const liveKeysRef = useRef({ w: false, a: false, s: false, d: false, space: false });
  /** RollbackController instance, only built when prediction is on. */
  const rollbackControllerRef = useRef<import('../game/rollback/RollbackController').RollbackController | null>(null);
  /** Display smoother for rollback corrections. Only built when prediction is on. */
  const displaySmootherRef = useRef<DisplaySmoother | null>(null);

  // ─── Bootstrap: join the host's room as a 'screen' peer ────────────────────
  // Two sources for the bootstrap:
  //   1. ?steam_lobby=<id> — Steam invite path. Join the lobby, read the
  //      host's SteamID from lobby data, dial via Steam Networking.
  //   2. getPendingJoin() — classic WebRTC room-code path (LobbyBrowser).
  useEffect(() => {
    const steamLobby = searchParams.get("steam_lobby");
    let cancelled = false;

    const guestCallbacks = {
      onPeerConnected: () => { if (!cancelled) setPhase("connected"); },
      onPeerDisconnected: () => { if (!cancelled) setPhase("host_disconnected"); },
      onMessage: (_peerId: string, _channel: string, data: string | ArrayBuffer) => {
        if (cancelled) return;
        handleHostMessage(data);
      },
      onError: (e: Error) => { if (!cancelled) setError(e.message); },
    };

    if (steamLobby) {
      (async () => {
        try {
          const { hostSteamId } = await joinLobby(steamLobby);
          if (!hostSteamId) throw new Error("Lobby missing host_steam_id");
          // Steam-only manager: no RoomService, no WebRTC signaling.
          const manager = new PeerManager(null, "joiner", guestCallbacks);
          managerRef.current = manager;
          const transport = await SteamTransport.connect(hostSteamId, manager.callbacksFor(hostSteamId));
          manager.attachTransport(transport);
          // Our own SteamID — unique per guest. Avoid keying on the host's
          // SteamID, which would collide if multiple guests joined.
          const selfId = await getSelfSteamId().catch(() => `guest-${Math.random().toString(36).slice(2, 10)}`);
          localPlayerIdRef.current = `steam-${selfId}-keyboard`;
          if (!cancelled) setLobbyCode(`steam:${steamLobby}`);
        } catch (err) {
          if (!cancelled) {
            setError((err as Error).message);
            setPhase("error");
          }
        }
      })();

      return () => {
        cancelled = true;
        // Leave the Steam lobby so we don't keep an orphaned member row that
        // the host's lobby-member listener would still count.
        void leaveLobby().catch(() => {});
        managerRef.current?.dispose();
        managerRef.current = null;
        gameRef.current?.destroy();
        gameRef.current = null;
      };
    }

    // Classic WebRTC room-code path.
    const pending = getPendingJoin();
    if (!pending) {
      navigate("/lobbies");
      return;
    }

    (async () => {
      try {
        const { result, room, manager } = await joinAsPeer(
          roomConfig,
          pending.room_id,
          {
            kind: "screen",
            display_name: pending.display_name,
            password: pending.password || undefined,
          },
          guestCallbacks,
        );
        roomRef.current = room;
        managerRef.current = manager;
        localPlayerIdRef.current = `guest-${result.peer_id}-keyboard`;
        localNameRef.current = pending.display_name || "Player";

        try {
          const detail = await room.getRoom();
          if (!cancelled) setLobbyCode(detail.join_code);
        } catch { /* non-critical */ }

        clearPendingJoin();
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          setPhase("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      void roomRef.current?.leaveRoom().catch(() => {});
      managerRef.current?.dispose();
      managerRef.current = null;
      roomRef.current = null;
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [navigate, searchParams]);

  // ─── Host → guest message routing ──────────────────────────────────────────
  // The state channel multiplexes three message kinds, distinguished by the
  // first byte:
  //   0x00 → binary world-snapshot keyframe (drift-recovery safety net,
  //          arrives ~1 Hz). Hard-set particle positions; do NOT blend.
  //   0x02 → aggregated player inputs from the host (~30 Hz). Apply to the
  //          local sim's blobs so deterministic physics drives remote
  //          players forward in lockstep with the host.
  //   else → JSON reliable event (level_loaded, lobby_state, customization).
  function handleHostMessage(data: string | ArrayBuffer): void {
    if (data instanceof ArrayBuffer) {
      const u8 = new Uint8Array(data);
      if (u8.length === 0) return;
      const magic = u8[0];
      if (magic === BINARY_MAGIC) {
        const frame = decodeSnapshot(data);
        if (frame) applySnapshot(frame);
        return;
      }
      if (magic === MAGIC_AGGREGATED_INPUTS) {
        const agg = decodeAggregatedInputs(data);
        if (agg) applyAggregatedInputs(agg);
        return;
      }
      // Non-magic binary — try to decode as utf-8 JSON (the WebRTC transport
      // can deliver string events as ArrayBuffer in some browsers).
      try {
        const text = new TextDecoder().decode(u8);
        handleReliableEvent(text);
      } catch { /* drop */ }
      return;
    }
    handleReliableEvent(data);
  }

  /** Lockstep input buffer. Aggregated-input messages from the host land
   * here, keyed by the host's tick. The game's logic gate pulls from this
   * buffer one tick at a time, applying the host's exact inputs at the
   * exact matching local tick before each physics step. Pruned as the sim
   * advances past each consumed tick. */
  const inputBufferRef = useRef<Map<number, import("../lib/inputProtocol").AggregatedTick>>(new Map());
  const latestHostTickRef = useRef<number>(-1);

  /** A keyframe that arrived BEFORE the game's world was initialized
   * (race between `level_loaded` triggering React canvas-remount and
   * `onCanvasInit` actually running `game.initialize`). We stash it here
   * and apply once `game.initialize` completes. Without this buffering,
   * the cached keyframe from the host's `onPeerConnected` is silently
   * dropped, the guest's `world.tick` stays at 0, the lockstep gate
   * never finds matching ticks in the input buffer, and the sim freezes. */
  const pendingKeyframeRef = useRef<SnapshotFrame | null>(null);
  /** Same race for the rng_state reliable event. */
  const pendingRngStateRef = useRef<number | null>(null);
  /** Same race for the manager_state reliable event. */
  const pendingManagerStateRef = useRef<unknown>(null);

  /** Per-tick position + input log for each player. When a keyframe arrives,
   * we cross-reference the guest's recorded position at the keyframe's
   * tick AND the inputs the gate applied at that tick. If positions
   * diverge but inputs were correct, it's a state-application bug. If
   * inputs themselves differ from what the keyframe expects, it's an
   * input-timing bug.
   *
   * Map<playerId, Map<tick, {x, y, sx, sy, sp}>>. Pruned to sliding window. */
  type TickLogEntry = { x: number; y: number; sx: number; sy: number; sp: boolean };
  const positionLogRef = useRef<Map<string, Map<number, TickLogEntry>>>(new Map());
  const POSITION_LOG_WINDOW = 600; // ~10 s @ 60 Hz

  function logPlayerPositions(): void {
    const game = gameRef.current;
    const world = game?.getWorld();
    const pm = game?.getPlayerManager();
    if (!world || !pm) return;
    const tick = world.tick;
    for (const p of pm.getAllPlayers()) {
      let m = positionLogRef.current.get(p.playerId);
      if (!m) {
        m = new Map();
        positionLogRef.current.set(p.playerId, m);
      }
      const c = p.blob.getCentroid();
      // Record what the BLOB applied — `blob.getStickX/Y/isExpanding`
      // reflect the values setInput captured for this tick's physics,
      // i.e. the inputs the gate placed into mp.* and updateAll then
      // pushed into the blob. This is what host's broadcast SHOULD have
      // sent for this tick.
      m.set(tick, {
        x: c.x,
        y: c.y,
        sx: p.blob.getStickX(),
        sy: p.blob.getStickY(),
        sp: p.blob.isExpanding(),
      });
      const cutoff = tick - POSITION_LOG_WINDOW;
      for (const t of m.keys()) {
        if (t < cutoff) m.delete(t);
        else break;
      }
    }
  }

  /** Ring buffer of true state-divergence measurements: how far was the
   * guest's recorded position at tick T from the host's keyframe position
   * at the same tick T? This is the diagnostic that matters for
   * determinism. Also captures the inputs the guest applied at the
   * keyframe tick + a few preceding ticks so we can spot input
   * mismatches relative to the host's reported input. */
  const recentSnapsRef = useRef<Array<{
    tick: number;
    playerId: string;
    dist: number;
    dx: number;
    dy: number;
    at: number;
    lag: number;
    cur: number;
    /** Guest's blob.stickX at the keyframe tick (= what guest's physics used). */
    guestSx?: number;
    /** Host's broadcast moveX in the keyframe PlayerRecord (= what host used). */
    hostMx?: number;
    /** Guest's blob.expandPressed at the keyframe tick. */
    guestSp?: boolean;
    /** Host's broadcast expanding in the keyframe PlayerRecord. */
    hostSp?: boolean;
    /** Last 5 ticks of guest's applied inputs (most recent last). */
    recent?: Array<{ tick: number; sx: number; sp: boolean }>;
  }>>([]);
  const SNAP_LOG_SIZE = 200;

  function recordSnap(
    playerId: string,
    keyframeTick: number,
    dist: number,
    dx: number,
    dy: number,
    lag: number,
    cur: number,
    extras?: {
      guestSx?: number;
      hostMx?: number;
      guestSp?: boolean;
      hostSp?: boolean;
      recent?: Array<{ tick: number; sx: number; sp: boolean }>;
    },
  ): void {
    const buf = recentSnapsRef.current;
    buf.push({ tick: keyframeTick, playerId, dist, dx, dy, at: Date.now(), lag, cur, ...extras });
    if (buf.length > SNAP_LOG_SIZE) buf.shift();
  }

  /** Dispatch a `manager_state` payload from the host to each local
   * stateful manager. Adding a new manager: add a getter to
   * BouncyBlobsGame and a case here. */
  function applyManagerState(state: {
    springPads?: unknown;
    blobGroundContacts?: Record<string, number>;
  }): void {
    const game = gameRef.current;
    if (!game || !state) return;
    if (state.springPads) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      game.getSpringPadManager()?.restoreState(state.springPads as any);
    }
    if (state.blobGroundContacts) {
      // Restore per-blob ground-contact counts. Critical for snap-free
      // physics on the first post-keyframe tick — see the wire-format
      // comment in `GameMaster.tsx`'s `manager_state` broadcast for the
      // full reasoning. Without this, the guest's `SlimeBlob.update`
      // reads `grounded = 0` on the very first post-keyframe tick (its
      // local sim's collision pass set this tally during the previous
      // tick, but the keyframe just yanked the blob to a new position
      // that may have a different ground-contact count than the local
      // sim had previously concluded — and the next collision pass
      // doesn't run until AFTER this tick's force application).
      const world = game.getWorld();
      const pm = game.getPlayerManager();
      if (world && pm) {
        for (const [playerId, count] of Object.entries(state.blobGroundContacts)) {
          const p = pm.getPlayer(playerId);
          if (p) world.setBlobGroundContacts(p.blob.blobId, count);
        }
      }
    }
  }

  function applyAggregatedInputs(agg: import("../lib/inputProtocol").AggregatedInputs): void {
    const buf = inputBufferRef.current;
    for (const t of agg.ticks) {
      buf.set(t.tick, t);
      if (t.tick > latestHostTickRef.current) latestHostTickRef.current = t.tick;
    }
    if (buf.size > 600) {
      const sortedKeys = [...buf.keys()].sort((a, b) => a - b);
      for (let i = 0; i < sortedKeys.length - 600; i++) buf.delete(sortedKeys[i]);
    }
    // In prediction mode, also feed authoritative inputs to the
    // RollbackController so it can compare against predictions and
    // restore+replay on mismatch. The engine and game references are
    // pulled from the game instance lazily — they only become
    // available after onCanvasInit runs.
    const rc = rollbackControllerRef.current;
    const game = gameRef.current;
    if (rc && game) {
      const engine = game.getWorld();
      if (engine) {
        const byTick = new Map<number, InputSet>();
        for (const t of agg.ticks) {
          const set: InputSet = {};
          for (const inp of t.inputs) {
            set[inp.playerId] = {
              moveX: inp.moveX,
              moveY: inp.moveY,
              expanding: inp.expanding,
            };
          }
          byTick.set(t.tick, set);
        }
        const smoother = displaySmootherRef.current;
        // Capture pre-rollback positions so we can compute the visual
        // offset for smoothing.
        const pre = smoother?.capturePreRollback(game);
        const rolled = rc.onAuthoritativeInputs(byTick, engine, game);
        if (rolled > 0 && pre && smoother) {
          smoother.applyPostRollback(game, pre);
        }
      }
    }
  }

  function handleReliableEvent(text: string): void {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return; }
    if (parsed?.type === "level_loaded") {
      installLevel(parsed.levelId, parsed.levelData, parsed.levelType, !!parsed.freeplay, parsed.rngSeed);
      return;
    }
    if (parsed?.type === "rng_state") {
      // Host is aligning our PRNG state so subsequent random draws match.
      // If the world isn't ready yet (canvas race), stash and apply later.
      const world = gameRef.current?.getWorld();
      if (world) {
        world.rng.setState(parsed.state);
      } else {
        pendingRngStateRef.current = parsed.state;
      }
      return;
    }
    if (parsed?.type === "manager_state") {
      // Host is replicating stateful managers (spring pads etc.) alongside
      // the 1 Hz keyframe. Without this, manager state diverges silently
      // — host has cooldowns ticking from real interactions while guest's
      // local sim might have a pad in a different state machine slot,
      // producing different impulses on the same input. Stash for replay
      // if the game isn't ready yet (same race as rng_state).
      const game = gameRef.current;
      if (!game) {
        pendingManagerStateRef.current = parsed.state;
        return;
      }
      applyManagerState(parsed.state);
      return;
    }
    if (parsed?.type === "lobby_state") {
      const evt = parsed as LobbyStateEvent;
      setLobbyState(evt);
      // Push the roster's name/color/face into the live sim so existing
      // local blobs pick up any customization changes the host made — the
      // binary snapshot path carries physics only, never cosmetics.
      const game = gameRef.current;
      const ctx = gameContextRef.current;
      const pm = game?.getPlayerManager();
      if (game && ctx && pm) {
        for (const p of evt.players) {
          if (pm.getPlayer(p.id)) {
            game.onPlayerCustomizationUpdate(ctx, p.id, p.color, p.faceId);
          }
        }
      }
      return;
    }
  }

  // ─── Local sim setup on level_loaded ───────────────────────────────────────
  function installLevel(levelId: string, levelData: LevelData, levelType: LevelType, freeplay = false, rngSeed?: number): void {
    // Tear down any previous game.
    gameRef.current?.destroy();
    gameRef.current = null;
    remoteInputRef.current.clear();

    // Reset per-level state. Without this, transitioning from playground
    // → real game leaves stale refs that block the new game's setup:
    //   - localPlayerJoined sticks at true → auto-join effect skips →
    //     local blob never spawns in the new game.
    //   - lastTickRef holds the playground's high tick → applySnapshot
    //     drops every tick-0 keyframe → host/other-guest blobs never
    //     get synthesized either.
    setLocalPlayerJoined(false);
    lastTickRef.current = -1;
    latestHostTickRef.current = -1;
    inputBufferRef.current.clear();
    pendingKeyframeRef.current = null;
    pendingManagerStateRef.current = null;
    pendingRngStateRef.current = null;
    pendingLocalSpawnRef.current = null;

    const game = new BouncyBlobsGame();
    if (typeof rngSeed === 'number') game.setRngSeed(rngSeed);
    const mode = createMirrorMode(levelData, levelType, freeplay);
    game.setGameMode(mode);
    // Inputs should always be accepted on the guest — phase is host-authoritative
    // and we don't gate motion locally.
    game.setAllowCountdownInput(true);

    currentLevelRef.current = { levelId, levelData, levelType };
    gameRef.current = game;
    setHasLevel(true);
    setCanvasKey(k => k + 1); // force GameCanvas remount so onInit fires again
  }

  // GameCanvas onInit — happens after the React canvas is mounted. Wire it
  // to the BouncyBlobsGame using the same pattern GameMaster uses (logical
  // context for game state + setCanvas for the actual draw target).
  function onCanvasInit(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const game = gameRef.current;
    if (!game) return;
    const context: GameContext = {
      connection: null,
      sessionId: "",
      players: [],
      gameState: {},
      playerStates: new Map(),
      inputManager: inputManagerRef.current,
      api: { updateControllerLayout: () => {} },
    };
    gameContextRef.current = context;
    game.initialize(context);
    game.setCanvas(ctx.canvas, ctx, width, height);
    // Guest camera follows only the local player — other blobs simulated
    // here are just visualization of remote players; we don't want them
    // pulling the view around.
    if (localPlayerIdRef.current) {
      game.setLocalPlayerIds([localPlayerIdRef.current]);
    }

    if (usePrediction) {
      // ── Prediction gate ─────────────────────────────────────────────
      // Local input is read NOW. Remote players' inputs are predicted
      // from their last-known authoritative input. RollbackController
      // snapshots before each tick; authoritative inputs arriving for
      // a past tick trigger restore+replay if they differ from what
      // we predicted. Local sim runs at the guest's RAF rate (60 Hz)
      // regardless of network — no lockstep wait.
      const applyInputsToPM = (inputs: InputSet) => {
        const pm = game.getPlayerManager();
        if (!pm) return;
        for (const [pid, inp] of Object.entries(inputs)) {
          const mp = pm.getPlayer(pid);
          if (!mp) continue;
          mp.moveX = inp.moveX;
          mp.moveY = inp.moveY;
          mp.expanding = inp.expanding;
        }
      };
      const rc = new RollbackController({
        localPlayerId: localPlayerIdRef.current,
        readLocalInput: () => {
          const k = liveKeysRef.current;
          return {
            moveX: (k.d ? 1 : 0) + (k.a ? -1 : 0),
            moveY: (k.s ? 1 : 0) + (k.w ? -1 : 0),
            expanding: k.space,
          };
        },
        applyInputs: applyInputsToPM,
        stepOne: () => {
          // Used during replay — emulate one logic tick. The bouncyBlobsGame
          // onLogic does playerManager.updateAll + world.step + manager
          // updates; for replay we want the same effects. Calling world.step
          // directly drives the engine; manager.update equivalents must run
          // so spring pads/actions/etc evolve in sync.
          const st = (game as unknown as { state: { world: SoftBodyEngine; playerManager: import('../game/playerManager').PlayerManager; springPadManager: import('../game/springPadManager').SpringPadManager | null; spikeManager: import('../game/spikeManager').SpikeManager | null; powerupManager: import('../game/powerups/powerupManager').PowerupManager | null; dynamicItemManager: import('../game/dynamicItemManager').DynamicItemManager | null; effects: import('../game/effectsBindings').EffectsBindings; gameTime: number } }).state;
          if (!st) return;
          const dt = 1 / 60;
          st.playerManager.updateAll(dt, st.world);
          st.world.step(dt);
          st.powerupManager?.update(dt, st.playerManager);
          st.springPadManager?.update(dt);
          st.spikeManager?.update(dt);
          st.dynamicItemManager?.update(dt);
          st.effects.update(dt, st.playerManager);
          st.gameTime += dt;
        },
      });
      rollbackControllerRef.current = rc;
      displaySmootherRef.current = new DisplaySmoother();
      game.setLogicGate((world) => {
        // Always advance — predict the input set for the upcoming tick
        // and apply it before bouncyBlobsGame's onLogic calls world.step.
        const inputs = rc.predictInputs();
        applyInputsToPM(inputs);
        rc.recordTick(world.tick, inputs, world, game);
        return true;
      });
    } else {
      // ── Lockstep gate ──────────────────────────────────────────────────
      // The guest's sim advances ONLY when it has authoritative inputs for
      // the next tick from the host. If the buffer hasn't received the next
      // tick yet, return false → GameLoop pauses physics (render still runs).
      // The accumulator stays full so we burst-step when inputs arrive.
      //
      // COUNTDOWN EXCEPTION: during the countdown phase the host's
      // `world.step` doesn't run (modeManager.update returns
      // shouldRunPhysics=false), so the host's `world.tick` is frozen
      // and its postTickHook broadcasts the SAME tick number every RAF.
      // The lockstep gate would then sit waiting for `world.tick + 1`
      // forever and the guest's countdown timer would never decrement.
      // We bypass the gate during countdown so the guest's local
      // `modeManager.update` can tick the timer at its own RAF rate;
      // physics still doesn't actually run (shouldRunPhysics=false on
      // the guest too) so no input is needed. Once the phase transitions
      // to 'playing' the gate resumes normal lockstep behaviour.
      game.setLogicGate((world) => {
        return evaluateLockstepGate({
          worldTick: world.tick,
          phase: game.getPhase(),
          inputBuffer: inputBufferRef.current,
          applyInputs: (tickInputs) => {
            const pm = game.getPlayerManager();
            if (!pm) return;
            for (const inp of tickInputs.inputs) {
              const mp = pm.getPlayer(inp.playerId);
              if (!mp) continue;
              mp.moveX = inp.moveX;
              mp.moveY = inp.moveY;
              mp.expanding = inp.expanding;
            }
          },
        });
      });
    }

    // Log every player's centroid after each successful physics tick.
    // Used by the snap diagnostic to compare the guest's actual position
    // at tick K to the host's keyframe position at tick K, isolating
    // true state divergence from network lag.
    game.setPostTickHook(() => logPlayerPositions());

    game.start();
    installDebugBridge(game);
    setNetDiagAccessor(() => {
      const world = game.getWorld();
      return {
        bufferSize: inputBufferRef.current.size,
        latestHostTick: latestHostTickRef.current,
        gap: latestHostTickRef.current - (world?.tick ?? 0),
      };
    });
    setSnapsAccessor(() => recentSnapsRef.current.slice());
    setRollbackStatsAccessor(() => {
      const rc = rollbackControllerRef.current;
      const sm = displaySmootherRef.current;
      if (!rc) return null;
      sm?.tick();
      const t = rc.getTimingStats();
      return {
        rollbacksApplied: rc.rollbacksApplied,
        lastDepth: rc.lastRollbackDepth,
        smoothingActive: sm?.activeCount() ?? 0,
        ringInvalidations: rc.ringInvalidations,
        failedRestores: rc.failedRestores,
        avgSnapshotMs: t.avgSnapshotMs,
        avgCheapTickMs: t.avgCheapTickMs,
        avgReconcileMs: t.avgReconcileMs,
      };
    });

    // Drain anything that arrived before the world was ready. Order
    // matters: rng_state first (so any tick-aware logic uses the right
    // PRNG state), then the keyframe (which sets world.tick to the
    // host's tick and snaps positions).
    if (pendingRngStateRef.current !== null) {
      game.getWorld()?.rng.setState(pendingRngStateRef.current);
      pendingRngStateRef.current = null;
    }
    if (pendingKeyframeRef.current) {
      const pending = pendingKeyframeRef.current;
      pendingKeyframeRef.current = null;
      applySnapshot(pending);
    }
    if (pendingManagerStateRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      applyManagerState(pendingManagerStateRef.current as any);
      pendingManagerStateRef.current = null;
    }

    // Drain a deferred local-player spawn — joinAsLocalPlayer fired
    // before this canvas mount completed, sent player_join to the host,
    // and queued the local addPlayer here. Now that game.initialize ran
    // and gameContextRef.current is populated, finish the local spawn.
    if (pendingLocalSpawnRef.current) {
      const pending = pendingLocalSpawnRef.current;
      pendingLocalSpawnRef.current = null;
      game.onPlayerJoin(context, pending);
    }

    setTimeout(() => game.startRound(), 100);
  }

  function onCanvasResize(width: number, height: number): void {
    gameRef.current?.setCanvasSize(width, height);
  }

  // ─── Snapshot application (binary frame from wireProtocol) ───────────────
  // Most recent tick we've actually applied — older arrivals are dropped to
  // avoid re-applying stale state out of order. Tick wraps at 65536 (u16 on
  // the wire); we use simple subtraction with a wrap window.
  const lastTickRef = useRef<number>(-1);

  // Client-Side Prediction input history. Each entry records what the local
  // player applied at a given tick. We don't implement full rollback (replay
  // local inputs from the server's tick forward); the spec explicitly allows
  // "snap or interpolate" reconciliation, which is what `blendParticle` does.
  // Keeping the buffer means we *can* upgrade to rollback later without
  // restructuring the rest of the guest.
  const INPUT_HISTORY_SIZE = 120;
  const inputHistoryRef = useRef<Array<{ tick: number; moveX: number; moveY: number; expanding: boolean }>>([]);
  const inputTickRef = useRef<number>(0);

  function recordLocalInput(moveX: number, moveY: number, expanding: boolean): void {
    const tick = inputTickRef.current++;
    const buf = inputHistoryRef.current;
    buf.push({ tick, moveX, moveY, expanding });
    if (buf.length > INPUT_HISTORY_SIZE) buf.shift();
  }

  function applySnapshot(frame: SnapshotFrame): void {
    const game = gameRef.current;
    const ctx = gameContextRef.current;
    const world = game?.getWorld();
    // Race: a keyframe sent right after `level_loaded` arrives while
    // canvas mount + game.initialize() are still in-flight. Stash it and
    // apply once the game is ready (see onCanvasInit).
    if (!game || !ctx || !world) {
      pendingKeyframeRef.current = frame;
      return;
    }
    const pm = game.getPlayerManager();
    if (!pm) return;

    // Drop strictly-older keyframes (the cached keyframe sent on peer
    // connect can race with a fresh 1 Hz one). With u32 ticks we have ~828
    // days before wrap so plain numeric comparison is fine.
    const last = lastTickRef.current;
    if (last >= 0 && frame.tick <= last) return;
    lastTickRef.current = frame.tick;
    // Align the local sim's tick counter to the host's. This keeps anything
    // that reads `world.tick` (AI elapsed-time, replay logging) in sync. The
    // old fear was that doing this would feed the catch-up loop in
    // applyAggregatedInputs — but that loop is now disabled for live
    // messages, so the alignment is safe and necessary.
    world.setTick(frame.tick);

    /** Snap a particle to the host's authoritative position AND velocity.
     * Velocity sync is critical: positions alone aren't enough, because
     * the local sim immediately integrates with the wrong velocity and
     * drifts back out of sync within a few ticks. Keyframes are sent at
     * 1 Hz so any visible "twitch" is bounded — but a deterministic sim
     * fed identical inputs should make this a near-no-op. */
    const snapParticle = (idx: number, sx: number, sy: number, svx: number, svy: number) => {
      if (!world.pos[idx]) return;
      world.setParticlePos(idx, sx, sy);
      world.setParticleVel(idx, svx, svy);
    };

    /** Apply root + offsets for an entity given its particle indices. The
     * first index is the root (center); subsequent indices are hull-node
     * positions reconstructed from root + offset. */
    const applyEntity = (
      indices: number[],
      rootX: number, rootY: number,
      rootVx: number, rootVy: number,
      offsets: { idx: number; ox: number; oy: number; vx: number; vy: number }[],
      _isOwn: boolean,
    ) => {
      if (indices.length > 0) snapParticle(indices[0], rootX, rootY, rootVx, rootVy);
      for (const off of offsets) {
        const targetIdxInIndices = 1 + off.idx;
        if (targetIdxInIndices >= indices.length) continue;
        snapParticle(
          indices[targetIdxInIndices],
          rootX + off.ox, rootY + off.oy,
          off.vx, off.vy,
        );
      }
    };

    const incomingIds = new Set<string>();
    // The lobby_state roster is the authoritative source of cosmetic state
    // (name / color / face) — the binary snapshot is physics-only by design.
    // Look up the roster entry for each player so newly-synthesized blobs
    // get the right colors immediately rather than gray placeholders.
    const rosterById = new Map<string, { name: string; color: string; faceId: string }>();
    for (const p of lobbyState?.players ?? []) {
      rosterById.set(p.id, { name: p.name, color: p.color, faceId: p.faceId });
    }
    for (const rec of frame.players) {
      incomingIds.add(rec.id);
      let mp = pm.getPlayer(rec.id);
      if (!mp) {
        const roster = rosterById.get(rec.id);
        const isOwnLocal = rec.id === localPlayerIdRef.current;
        const synth: Player = {
          player_id: rec.id,
          session_id: "",
          name: roster?.name ?? (isOwnLocal ? localNameRef.current : rec.id),
          slot: 0,
          status: "connected",
          controller_config: null,
          joined_at: new Date().toISOString(),
          color: roster?.color ?? (isOwnLocal ? localColor : "#888"),
          faceId: roster?.faceId ?? (isOwnLocal ? localFaceId : "default"),
        } as Player;
        game.onPlayerJoin(ctx, synth);
        mp = pm.getPlayer(rec.id);
        if (!mp) continue;
      }

      const isOwn = rec.id === localPlayerIdRef.current;
      // Drive remote players' inputs from the host's echo so their local sim
      // moves correctly between snapshots. Own player keeps local input.
      if (!isOwn) {
        mp.moveX = rec.moveX;
        mp.moveY = rec.moveY;
        mp.expanding = rec.expanding;
      }

      // Restore the blob's internal expand-shape integrator on EVERY player.
      // `expandShapeScale` accumulates per-tick toward `expandShapeScaleMax`
      // (or back to 1.0) whenever expand is pressed/released. It's a scalar
      // that feeds back into the physics via `shapeMatchRestScale`, so even
      // a tiny per-tick divergence (e.g. the guest synthesizing a player
      // mid-jump from a keyframe will start their `expandShapeScale` at
      // the default 1.0 while the host's is mid-integration) compounds
      // into visible drift and a snap on the next keyframe. The wire
      // format already carries this value as `rec.expandScale`; we just
      // weren't applying it. This is almost certainly the primary cause
      // of the "snaps with no interaction" the user reported — every
      // press/release of the expand button on either blob diverges the
      // integrator until the next keyframe yanks positions back.
      mp.blob.setExpandStateExternal(rec.expanding, rec.expandScale);

      // Diagnostic: compare host's keyframe position at tick K to the
      // guest's OWN recorded position at the same tick K (the guest logs
      // its centroid per-tick into positionLogRef). This isolates state
      // divergence from network lag — without this, the diagnostic just
      // measures how many ticks behind the guest is, not how wrong its
      // physics has become.
      const myTickLog = positionLogRef.current.get(rec.id);
      const guestEntryAtKfTick = myTickLog?.get(frame.tick);
      if (guestEntryAtKfTick) {
        const dx = rec.rootX - guestEntryAtKfTick.x;
        const dy = rec.rootY - guestEntryAtKfTick.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.1) {
          // Gather recent input history for this player (last 5 ticks
          // before/at the keyframe tick). Lets us see whether the guest
          // applied a different input than the host at the divergent tick.
          const recent: Array<{ tick: number; sx: number; sp: boolean }> = [];
          if (myTickLog) {
            for (let t = frame.tick - 4; t <= frame.tick; t++) {
              const e = myTickLog.get(t);
              if (e) recent.push({ tick: t, sx: e.sx, sp: e.sp });
            }
          }
          recordSnap(rec.id, frame.tick, dist, dx, dy, world.tick - frame.tick, world.tick, {
            guestSx: guestEntryAtKfTick.sx,
            hostMx: rec.moveX,
            guestSp: guestEntryAtKfTick.sp,
            hostSp: rec.expanding,
            recent,
          });
        }
      }

      // Snap every player including our own. With lockstep, own-player
      // input also comes from the host's echo — the host's view of own
      // player IS authoritative. Skipping the snap would let local drift
      // accumulate indefinitely.
      //
      // EXCEPTION — prediction mode: the guest predicts the local
      // player's input INSTANTLY each tick, so the guest's blob is
      // typically a few ticks AHEAD of the host's keyframe. Snapping
      // the local blob back to keyframe positions every ~1s causes
      // visible jitter (predict-forward-then-yank-back oscillation).
      // The rollback controller's reconciliation handles divergence
      // via the per-tick aggregated-input stream — keyframes are a
      // safety net we can skip for own player.
      const skipOwnSnap = usePrediction && isOwn;
      if (!skipOwnSnap) {
        applyEntity(
          [mp.blob.centerIdx, ...mp.blob.hullIndices],
          rec.rootX, rec.rootY,
          rec.rootVx, rec.rootVy,
          rec.offsets,
          isOwn,
        );
      }
    }
    // Newly-added players from this keyframe may have grown the engine's
    // blob count — invalidate the rollback ring so we don't try to
    // restore from snapshots taken before they existed.
    if (usePrediction) {
      rollbackControllerRef.current?.invalidateRing('keyframe applied');
    }

    // Despawn players the host no longer reports.
    for (const p of pm.getAllPlayers()) {
      if (!incomingIds.has(p.playerId)) {
        game.onPlayerDisconnect(ctx, p.playerId);
      }
    }

    // World objects — these now ride the wire as absolute positions per
    // particle (see wireProtocol's WorldRecord), so we apply position-by-
    // position with the same blend logic as players.
    const applyWorld = (
      indices: number[],
      nodes: { x: number; y: number; vx: number; vy: number }[],
    ) => {
      // Snap every particle to the host's authoritative position AND
      // velocity. Without velocity sync, even a perfect position snap
      // diverges within a few ticks because the local sim's integrator
      // keeps using whatever velocity it had. World objects (NPCs,
      // platforms) are driven entirely by physics, so velocity alignment
      // is what actually keeps them in sync between keyframes.
      const n = Math.min(indices.length, nodes.length);
      for (let i = 0; i < n; i++) {
        const idx = indices[i];
        if (!world.pos[idx]) continue;
        world.setParticlePos(idx, nodes[i].x, nodes[i].y);
        world.setParticleVel(idx, nodes[i].vx, nodes[i].vy);
      }
    };

    const npcBlobs = game.getNpcBlobs();
    const platforms = game.getSoftPlatforms();
    const platformsById = new Map(platforms.map((sp) => [sp.id, sp.hullIndices] as const));
    const pointShapeMap = game.getPointShapeParticles();
    for (const wr of frame.world) {
      // Settled entities are emitted as keyframes only; if we receive one with
      // settled=true on a delta tick the host didn't send it (filtered host-
      // side), so this guard mostly catches the first-after-settle keyframe.
      if (wr.settled && !frame.isKeyframe) continue;
      if (wr.kind === ENTITY_KIND_NPC) {
        const m = wr.id.match(/^npc-(\d+)$/);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        const b = npcBlobs[idx];
        if (!b) continue;
        applyWorld([b.centerIdx, ...b.hullIndices], wr.nodes);
      } else if (wr.kind === ENTITY_KIND_PLATFORM) {
        const indices = platformsById.get(wr.id);
        if (!indices) continue;
        applyWorld(indices, wr.nodes);
      } else if (wr.kind === ENTITY_KIND_POINT_SHAPE) {
        const indices = pointShapeMap.get(wr.id);
        if (!indices) continue;
        applyWorld(indices, wr.nodes);
      }
    }

    setStatusLine(`tick ${frame.tick} · ${frame.players.length} blob(s) · ${frame.world.length} world obj`);
  }

  // ─── Local player join + keyboard capture ─────────────────────────────────
  function joinAsLocalPlayer(): void {
    const manager = managerRef.current;
    if (!manager || localPlayerJoined) return;
    const evt: ReliableEvent = {
      type: "player_join",
      playerId: localPlayerIdRef.current,
      name: localNameRef.current,
      color: localColor,
      faceId: localFaceId,
    };
    manager.send("host", "state", JSON.stringify(evt));

    // Spawn our blob in the local sim. Old code waited for the host's
    // snapshot to synthesize the blob, but with the 1 Hz keyframe rate
    // (the snapshot is no longer the primary sync) that lag would be
    // up to a full second. Spawn is deterministic (derived from playerId
    // via hashStringSeed inside PlayerManager.addPlayer), so adding it
    // locally produces the exact same position the host will use.
    //
    // If the canvas hasn't initialised yet (no game context →
    // game.onPlayerJoin would silently no-op because game.state is null),
    // queue the spawn into pendingLocalSpawnRef. `onCanvasInit` drains it
    // once `game.initialize(context)` has run.
    const synth: Player = {
      player_id: localPlayerIdRef.current,
      session_id: "",
      name: localNameRef.current,
      slot: 0,
      status: "connected",
      controller_config: null,
      joined_at: new Date().toISOString(),
      color: localColor,
      faceId: localFaceId,
    } as Player;
    const game = gameRef.current;
    const ctx = gameContextRef.current;
    if (game && ctx) {
      game.onPlayerJoin(ctx, synth);
      game.setLocalPlayerIds([localPlayerIdRef.current]);
    } else {
      pendingLocalSpawnRef.current = synth;
    }

    setLocalPlayerJoined(true);
  }

  // Auto-join as a player once we're connected to the host AND the local sim
  // has a level loaded. We DON'T gate on canvasReady here — the lobby UI has
  // no canvas yet but still needs the player_join to fire so the host (and
  // other guests via lobby_state) see this player's name + color. If the
  // canvas isn't ready, joinAsLocalPlayer queues the local-blob spawn into
  // `pendingLocalSpawnRef` and `onCanvasInit` drains it.
  useEffect(() => {
    if (phase === "connected" && hasLevel && !localPlayerJoined) {
      joinAsLocalPlayer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, hasLevel, localPlayerJoined]);

  // When the local color/face changes after joining, push a customization
  // event to the host so the lobby roster (and other guests' GuestLobbyPanel)
  // reflect the change.
  function sendCustomizationUpdate(color: string, faceId: string): void {
    const manager = managerRef.current;
    if (!manager || !localPlayerJoined) return;
    const evt: ReliableEvent = {
      type: "customization",
      playerId: localPlayerIdRef.current,
      color,
      faceId,
    };
    manager.send("host", "state", JSON.stringify(evt));
  }

  // (leaveAsLocalPlayer removed — `leaveAndExit` is the single leave path now.)

  // Keyboard → host only. We DON'T apply locally — the host's per-tick
  // broadcast (post-tick hook) echoes the applied input back, and the
  // guest's lockstep gate consumes it at the exact tick the host applied.
  // Applying locally would defeat lockstep: the local input would land at
  // some "now" tick while the host's echo would say to apply at host's
  // tick — different histories, instant divergence.
  //
  // Cost: ~50 ms input lag on the guest (one network one-way trip).
  // Bouncy Blobs at 60 Hz: 3 ticks of delay. Invisible for soft-body
  // physics where bodies have inertia anyway.
  useEffect(() => {
    if (!localPlayerJoined) return;
    // `keys` is the local view; `liveKeysRef.current` is the same view
    // exposed to the prediction gate so it can read "what's pressed
    // right now" each tick.
    const keys = liveKeysRef.current;

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        keys[k] = true;
        e.preventDefault();
      } else if (e.code === "Space") {
        keys.space = true;
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") { keys[k] = false; }
      else if (e.code === "Space") { keys.space = false; }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    let tick = 0;
    const interval = setInterval(() => {
      const manager = managerRef.current;
      if (!manager) return;
      const moveX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      const moveY = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
      recordLocalInput(moveX, moveY, keys.space);
      const batch: InputBatch = {
        type: "input",
        frames: [{ playerId: localPlayerIdRef.current, moveX, moveY, expanding: keys.space, tick: tick++ }],
      };
      manager.send("host", "input", JSON.stringify(batch));
    }, 1000 / INPUT_HZ);

    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      clearInterval(interval);
    };
  }, [localPlayerJoined]);

  // Send a player_leave on unmount if joined.
  useEffect(() => {
    return () => {
      const manager = managerRef.current;
      if (manager && localPlayerIdRef.current && localPlayerJoined) {
        try {
          const evt: ReliableEvent = { type: "player_leave", playerId: localPlayerIdRef.current };
          manager.send("host", "state", JSON.stringify(evt));
        } catch { /* best-effort */ }
      }
    };
  }, [localPlayerJoined]);

  // The guest shows GuestLobbyPanel + canvas side-by-side during the lobby
  // phase (mirroring the host). When the host starts a real round the
  // lobby_state's `phase` flips to "playing"; we drop the panel so the canvas
  // gets the full width.
  const inLobbyPhase = lobbyState?.phase !== "playing";
  const showPanel = inLobbyPhase && phase !== "host_disconnected";

  const onChangeColor = (c: string) => {
    setLocalColor(c);
    sendCustomizationUpdate(c, localFaceId);
  };
  const onChangeFace = (f: string) => {
    setLocalFaceId(f);
    sendCustomizationUpdate(localColor, f);
  };

  // Full exit: fire a player_leave so the host immediately knows we're gone
  // (before its peer-disconnect detector kicks in), DELETE our peer row from
  // the rooms backend (decrements peer_count for the lobby browser), tear
  // down WebRTC / Steam transports, then navigate. The component unmount
  // cleanup runs too but this kicks the network side off explicitly so the
  // host sees us leave even if React's effect ordering is unusual.
  const leaveAndExit = () => {
    const manager = managerRef.current;
    try {
      if (manager && localPlayerJoined) {
        const evt: ReliableEvent = { type: "player_leave", playerId: localPlayerIdRef.current };
        manager.send("host", "state", JSON.stringify(evt));
      }
    } catch { /* best-effort */ }
    void roomRef.current?.leaveRoom().catch(() => {});
    navigate("/lobbies");
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "row" }}>
      {showPanel && (
        <GuestLobbyPanel
          lobbyState={lobbyState}
          joinCode={lobbyCode}
          phase={phase}
          localPlayerJoined={localPlayerJoined}
          onLeaveGame={leaveAndExit}
          localColor={localColor}
          onChangeLocalColor={onChangeColor}
          localFaceId={localFaceId}
          onChangeLocalFaceId={onChangeFace}
        />
      )}
      <div style={{ flex: 1, position: "relative", minWidth: 0, display: "flex", flexDirection: "column" }}>
        {error && <div style={{ padding: 16, color: "#f77", background: "#3a0000" }}>{error}</div>}
        {statusLine && (
          <div data-testid="guest-status" style={{
            position: "absolute", top: 8, left: 8, color: "#aaa", fontSize: 11,
            background: "rgba(0,0,0,0.4)", padding: "3px 6px", borderRadius: 3, zIndex: 5,
          }}>{statusLine}</div>
        )}
        {phase === "host_disconnected" ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
            <h2>Host disconnected — match ended</h2>
            <Link to="/lobbies"><button style={{ padding: "10px 20px", background: "#c77dff" }}>Back to lobbies</button></Link>
          </div>
        ) : !hasLevel ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
            {phase === "connected" ? "Waiting for the host…" : "Connecting…"}
          </div>
        ) : (
          <div style={{ position: "relative", flex: 1 }}>
            <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />
            {/* Always-visible Leave Game button during the playing phase,
                so guests can return to the lobby list without waiting for
                the host to end the round. Hidden during the lobby phase
                (the panel already has a leave button there). */}
            {!showPanel && (
              <button
                data-testid="leave-game-button"
                onClick={leaveAndExit}
                title="Leave this game and return to the lobby list"
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  background: "#7a1f2e",
                  color: "#fff",
                  border: "2px solid #1a0a10",
                  borderRadius: 4,
                  cursor: "pointer",
                  zIndex: 10,
                }}
              >
                ← Leave Game
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
