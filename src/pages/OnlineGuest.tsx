import { useEffect, useMemo, useRef, useState } from "react";
import { RollbackController, type InputSet } from "../game/rollback/RollbackController";
import { evaluateLockstepGate } from "./lockstepGate";
import { DisplaySmoother } from "../game/rollback/displaySmoothing";
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { joinAsPeer, RoomService, PeerManager, SteamTransport, getSelfSteamId } from "../lib/party";
import { installRtcDebug } from "../lib/rtcDebug";
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
import { initNetSimFromUrl, scheduleNetSim, isReliableChannel } from "../lib/netSim";
import { initPacingFromUrl, getPacingConfig, setPacingConfig } from "../lib/pacingConfig";
import { getHashHistory, recordHash, resetHashHistory } from "../lib/hashHistory";
import { quantizeAxis } from "../lib/inputProtocol";
import GameCanvas from "../components/GameCanvas";
import GuestLobbyPanel from "../components/GuestLobbyPanel";
import NetDebugOverlay from "../components/NetDebugOverlay";
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
import type { GameMode, GamePhase } from "../game/gameModes/types";
import { getPendingJoin, clearPendingJoin } from "./LobbyBrowser";

// Guest → host input send rate. Bumped from 30 → 60 to match the host's
// physics tick rate, so the host's preTickHook sees a fresh input on
// every tick instead of every-other-tick. Bandwidth cost is trivial
// (~3 KB/s from each guest, JSON-encoded). Local-player feel is
// unaffected because client-side prediction (own-player) is event-driven,
// not interval-driven.
const INPUT_HZ = 60;

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
  const fallback: LevelType = (level.hillZones && level.hillZones.length > 0 && !(level.goalZones && level.goalZones.length > 0))
    ? 'koth'
    : getLevelTypes(level)[0];
  const mode = override ?? fallback;
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
  /** Visible per-step transport progress log (most recent last). Surfaces
   * exactly where a WebRTC connection wedged so the user can report which
   * phase never advanced. */
  const [phaseLog, setPhaseLog] = useState<{ ts: number; phase: string; detail?: string }[]>([]);
  const [lobbyState, setLobbyState] = useState<LobbyStateEvent | null>(null);
  // Tracks the engine's particle count across keyframes so we only
  // invalidate the rollback ring when it ACTUALLY changes (player joined
  // or left), not on every keyframe arrival. Earlier code fired
  // unconditionally and the user logged 173 ring invalidations per
  // minute, effectively disabling the rollback ring for stall recovery.
  const lastSeenParticleCountRef = useRef<number>(-1);
  // Slot → playerId map for resolving the compact v2 input wire format.
  // Built from the host's lobby_state broadcasts; consulted by the
  // aggregated-input decoder. Frames for unknown slots are dropped (will
  // recover at the next lobby_state).
  const slotToPlayerIdRef = useRef<Map<number, string>>(new Map());
  const [localColor, setLocalColor] = useState<string>(COLOR_PALETTE[1] ?? "#ffd166");
  const [localFaceId, setLocalFaceId] = useState<string>("default");

  const roomRef = useRef<RoomService | null>(null);
  const managerRef = useRef<PeerManager | null>(null);
  // Expose `window.__rtcDebug()` for ICE-pair diagnostics. Idempotent.
  installRtcDebug(() => managerRef.current);

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
  // Net-debug overlay visibility. Initialised from `?net=debug` for
  // power users who want it on from page load, but ALSO toggleable at
  // runtime via the backtick (`) hotkey so a guest already mid-match
  // doesn't have to reload (which would drop the WebRTC connection and
  // re-join the lobby — losing the in-flight game). The hotkey is the
  // primary path; the URL param is just for "I always want this on."
  const [showNetDebug, setShowNetDebug] = useState<boolean>(() => {
    const sp = new URLSearchParams(window.location.search);
    return sp.get('net') === 'debug';
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Backtick = same key used by many engines for the dev console;
      // unlikely to collide with WASD / arrows / Space movement keys.
      // Ignore when typing in an input (chat box, etc.) so it doesn't
      // grab keystrokes from text fields.
      if (e.key !== '`') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setShowNetDebug((v) => !v);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
  //
  // React 18 StrictMode double-mounts this effect in dev: mount → cleanup
  // → mount again, synchronously. If we did `joinAsPeer` synchronously we'd
  // hit the server TWICE per page load — once for each mount, with the
  // first allocation racing its own cleanup-DELETE while the host's poll
  // loop briefly sees both peer rows. The host then splits attention
  // between a live peer and a dying zombie during the critical first
  // second of ICE checks; the result is that the first attempt always
  // fails and the host's retry succeeds. Symptom: "fails every time then
  // works on retry."
  //
  // The fix is the canonical deferred-effect pattern: don't actually fire
  // `joinAsPeer` until after the commit phase. `setTimeout(0)` puts the
  // network call on the next macrotask; StrictMode's cleanup runs before
  // then, flips `cancelled = true`, and `clearTimeout` here prevents
  // mount 1 from ever hitting the network. Only mount 2 (the surviving
  // one) actually joins. Production builds skip StrictMode double-mount,
  // so this just adds a one-tick delay to the join.
  useEffect(() => {
    const steamLobby = searchParams.get("steam_lobby");
    let cancelled = false;
    let myRoom: RoomService | null = null;
    let myManager: PeerManager | null = null;

    // Seed the network-condition simulator + pacing config from URL once
    // on mount. The overlay's controls mutate these singletons live, so
    // the user can tune mid-round without reloading (which would drop the
    // WebRTC connection and re-join the lobby).
    initNetSimFromUrl();
    initPacingFromUrl();

    // Monkey-patch a freshly-attached PeerManager so every outgoing send
    // also goes through the netSim. Wrapping here (rather than at each of
    // the many `manager.send(...)` call sites) means future call sites
    // are simulated for free. Mirrors the incoming wrap in
    // `guestCallbacks.onMessage`, so the configured latency applies to
    // both directions for a true RTT.
    const wrapManagerSend = (m: PeerManager): void => {
      const orig = m.send.bind(m);
      m.send = (peerId: string, channel: string | undefined, data: string | ArrayBuffer): boolean => {
        const reliable = channel === undefined ? true : isReliableChannel(channel);
        // Return true optimistically — the caller treats this as "queued
        // for delivery," which is still true even when the sim drops it.
        // The drop is the network simulation, not a transport failure.
        scheduleNetSim(reliable, () => orig(peerId, channel, data));
        return true;
      };
    };

    const guestCallbacks = {
      onPeerConnected: () => { if (!cancelled) setPhase("connected"); },
      onPeerDisconnected: () => {
        if (cancelled) return;
        // Distinguish "never connected → connection attempt failed" from
        // "was connected, then lost the host". The former should keep the
        // phase log visible with a Retry button (handled by setPhase("error")
        // elsewhere — don't downgrade to host_disconnected). The latter
        // shows the "match ended" screen.
        setPhase((prev) => prev === "connected" ? "host_disconnected" : prev === "error" ? prev : "error");
      },
      onMessage: (_peerId: string, channel: string, data: string | ArrayBuffer) => {
        if (cancelled) return;
        // Drop-or-delay the receipt through the configured sim. When the
        // sim is disabled this runs synchronously (zero overhead). When
        // enabled, unreliable-channel messages may be dropped; reliable
        // ones are only delayed.
        scheduleNetSim(isReliableChannel(channel), () => {
          if (cancelled) return;
          handleHostMessage(data);
        });
      },
      onError: (e: Error) => {
        if (cancelled) return;
        setError(e.message);
        // A WebRtcConnectTimeoutError (or any startup error) leaves a stale
        // peer row on the server — the host will keep counting us as a
        // pending joiner. Drop the row immediately so the host's player
        // count and our retry both start clean.
        if (e.name === "WebRtcConnectTimeoutError") {
          void roomRef.current?.leaveRoom().catch(() => {});
          setPhase("error");
        }
      },
      onPhase: (_peerId: string, phase: string, detail?: Record<string, unknown>) => {
        if (cancelled) return;
        const formatVal = (v: unknown): string => {
          if (v == null) return String(v);
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
          if (Array.isArray(v)) return `[${v.length}]`;
          // For nested objects (e.g. timeout-pairs payloads) keep the log
          // readable — full detail already lives in console.error dumps.
          return "{…}";
        };
        const detailStr = detail
          ? Object.entries(detail).map(([k, v]) => `${k}=${formatVal(v)}`).join(' ')
          : undefined;
        setPhaseLog((prev) => {
          const next = [...prev, { ts: Date.now(), phase, detail: detailStr }];
          // Keep the log bounded so it can't pin memory on a flapping connection.
          return next.length > 40 ? next.slice(next.length - 40) : next;
        });
      },
    };

    if (steamLobby) {
      const joinTimer = window.setTimeout(() => {
        if (cancelled) return;
        (async () => {
          try {
            const { hostSteamId } = await joinLobby(steamLobby);
            if (cancelled) return;
            if (!hostSteamId) throw new Error("Lobby missing host_steam_id");
            // Steam-only manager: no RoomService, no WebRTC signaling.
            const manager = new PeerManager(null, "joiner", guestCallbacks);
            wrapManagerSend(manager);
            managerRef.current = manager;
            const transport = await SteamTransport.connect(hostSteamId, manager.callbacksFor(hostSteamId));
            if (cancelled) { transport.dispose(); return; }
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
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(joinTimer);
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

    const joinTimer = window.setTimeout(() => {
      if (cancelled) return;
      // Push the "joining-room" log entry here (not before the timer) so
      // a cancelled-before-fire mount doesn't pollute the visible log
      // with a fake attempt that never hit the network.
      setPhaseLog((prev) => [...prev, { ts: Date.now(), phase: "joining-room", detail: `room=${pending.room_id}` }]);
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
          // Late-cancel path: the join allocated a peer row before cleanup
          // fired (e.g. fast unmount, navigation away mid-flight) — leave
          // it now so we don't leak a server-side row.
          if (cancelled) {
            void room.leaveRoom().catch(() => {});
            manager.dispose();
            return;
          }
          myRoom = room;
          myManager = manager;
          setPhaseLog((prev) => [...prev, { ts: Date.now(), phase: "joined-room", detail: `peer=${result.peer_id} slot=${result.slot}` }]);
          roomRef.current = room;
          wrapManagerSend(manager);
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
            // joinAsPeer may have allocated a server-side peer row before
            // it threw — drop it so the host doesn't keep counting us.
            void roomRef.current?.leaveRoom().catch(() => {});
          }
        }
      })();
    }, 0);

    // Tab close / refresh / mobile-Safari swipe-away: React effect cleanup
    // doesn't run for these, so leaveRoom would never fire and the host
    // would keep our peer row in its lobby count until the server TTL
    // swept it. `pagehide` covers all these (incl. iOS back-forward cache),
    // and leaveRoom uses `keepalive: true` so the DELETE still lands while
    // the page is tearing down.
    const onPageHide = () => {
      void roomRef.current?.leaveRoom().catch(() => {});
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearTimeout(joinTimer);
      window.removeEventListener("pagehide", onPageHide);
      // Use the per-mount captures rather than roomRef/managerRef: under
      // StrictMode the second mount may have already overwritten the refs
      // with a different room/manager. The async block above also handles
      // the case where the join hadn't resolved yet by the time `cancelled`
      // was flipped — between the two, every allocated peer row gets a
      // matching leaveRoom.
      if (myRoom) {
        void myRoom.leaveRoom().catch(() => {});
        // Only clear the refs if they still point at *our* instance.
        if (roomRef.current === myRoom) roomRef.current = null;
      }
      if (myManager) {
        myManager.dispose();
        if (managerRef.current === myManager) managerRef.current = null;
      }
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
        // Resolve slot→playerId via the locally maintained map (updated
        // by lobby_state). A frame whose slot isn't in the map yet (e.g.
        // we got the aggregated inputs before the latest lobby_state)
        // has `playerId=undefined` and is dropped by applyAggregatedInputs.
        const agg = decodeAggregatedInputs(data, (slot) => slotToPlayerIdRef.current.get(slot));
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
  /** Ready-handshake state. When level_loaded has `requireReadyConfirm: true`,
   *  the guest must send a `state_ready` reply after applying the bootstrap
   *  keyframe so the host knows it can safely start the countdown. We track
   *  the pending levelId here; cleared once the confirm has been sent. */
  const pendingReadyLevelIdRef = useRef<string | null>(null);

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

  /** Dispatch a full game-state snapshot from the host's
   *  `manager_state` event. The payload is whatever
   *  `BouncyBlobsGame.snapshotGameState()` produced on the host; the
   *  matching `restoreGameState()` here writes back per-blob SlimeBlob
   *  state + every manager's `restoreState`. Together with the
   *  engine-state restore at the top of `applySnapshot` (keyframe v2's
   *  trailing `engineState` block), this is the complete sync — no
   *  JS-side mutable field is left at the guest's local default after
   *  a keyframe + manager_state pair lands. */
  function applyManagerState(state: import("../game/bouncyBlobsGame").GameStateSnapshot): void {
    const game = gameRef.current;
    if (!game || !state) return;
    game.restoreGameState(state);
  }

  function applyAggregatedInputs(agg: import("../lib/inputProtocol").AggregatedInputs): void {
    const buf = inputBufferRef.current;
    for (const t of agg.ticks) {
      // Strip frames whose slot didn't resolve to a known playerId — they
      // arrived before the corresponding lobby_state. The redundant
      // broadcast stream re-includes them in the next packet, so we
      // recover automatically as soon as the roster lands.
      const filtered = {
        tick: t.tick,
        inputs: t.inputs.filter((inp) => inp.playerId !== undefined),
      };
      if (filtered.inputs.length === 0) continue;
      // Merge with any existing slot for this tick (rare — happens when
      // a later broadcast for the same redundant window adds a player
      // that wasn't resolvable in an earlier packet).
      const existing = buf.get(t.tick);
      if (existing) {
        const merged = new Map<string, typeof filtered.inputs[number]>();
        for (const e of existing.inputs) if (e.playerId !== undefined) merged.set(e.playerId, e);
        for (const e of filtered.inputs) if (e.playerId !== undefined) merged.set(e.playerId, e);
        buf.set(t.tick, { tick: t.tick, inputs: Array.from(merged.values()) });
      } else {
        buf.set(t.tick, filtered);
      }
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
        const localId = localPlayerIdRef.current;
        const skipLocal = getPacingConfig().clientPrediction;
        for (const t of agg.ticks) {
          const set: InputSet = {};
          for (const inp of t.inputs) {
            if (!inp.playerId) continue;
            // With prediction ON: strip local from rc comparison so
            // sub-tick timing skew between guest's predicted input and
            // host's applied input doesn't trigger rubber-band rollback.
            // With prediction OFF: include local — there's no local
            // prediction lane, the lockstep gate is the only writer.
            if (skipLocal && inp.playerId === localId) continue;
            set[inp.playerId] = {
              moveX: inp.moveX,
              moveY: inp.moveY,
              expanding: inp.expanding,
            };
          }
          byTick.set(t.tick, set);
        }
        // Guest rollback gated on PacingConfig.enableRollback (default
        // OFF). With the deterministic engine + bootstrap keyframe,
        // strict lockstep is enough — no need to reconcile predicted
        // vs authoritative inputs because the guest's predictions ARE
        // the authoritative inputs (its lockstep gate only advances
        // when the broadcast arrives, no local prediction to drift).
        if (getPacingConfig().enableRollback) {
          const smoother = displaySmootherRef.current;
          const pre = smoother?.capturePreRollback(game);
          const rolled = rc.onAuthoritativeInputs(byTick, engine, game);
          if (rolled > 0 && pre && smoother) {
            smoother.applyPostRollback(game, pre);
          }
        }
      }
    }
  }

  function handleReliableEvent(text: string): void {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return; }
    if (parsed?.type === "level_loaded") {
      installLevel(parsed.levelId, parsed.levelData, parsed.levelType, !!parsed.freeplay, parsed.rngSeed);
      // If the host requested a ready-handshake, remember the levelId
      // so applySnapshot can send `state_ready` once the bootstrap
      // keyframe is fully applied.
      pendingReadyLevelIdRef.current = parsed.requireReadyConfirm ? parsed.levelId : null;
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
    if (parsed?.type === "set_paused") {
      // Host's overlay pressed Pause/Resume — match on the guest side
      // so both sims freeze at the same wall-clock instant.
      setPacingConfig({ paused: !!parsed.paused });
      return;
    }
    if (parsed?.type === "request_hashes") {
      // Host asked for our hash history. Reply with whatever's in
      // our local ring. Sent on the reliable 'state' channel so the
      // host's overlay always sees the answer.
      const manager = managerRef.current;
      // Cap to last N entries: each entry carries a TickSummary (~500B+
      // per blob). Full ring × 5 blobs blows past the SCTP single-message
      // ceiling and the reply silently never arrives at the host.
      const RESPONSE_CAP = 60;
      const all = getHashHistory();
      const entries = all.slice(Math.max(0, all.length - RESPONSE_CAP));
      const reply = {
        type: "hashes_response",
        requestId: parsed.requestId,
        peerId: localPlayerIdRef.current,
        entries,
      };
      const payload = JSON.stringify(reply);
      console.info(
        `[netDiag] guest received request_hashes(req=${parsed.requestId}) → replying with ${entries.length} entries`,
        `peerId="${localPlayerIdRef.current}"`,
        `managerReady=${!!manager}`,
        `bytes=${payload.length}`,
      );
      manager?.send("host", "state", payload);
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
      // Refresh the slot→playerId map for compact input decoding. Rebuild
      // from scratch (not incremental) so a departed player's stale slot
      // doesn't keep resolving to their id.
      const m = new Map<number, string>();
      for (const p of evt.players) {
        if (typeof p.slot === 'number' && p.slot >= 0 && p.slot <= 254) m.set(p.slot, p.id);
      }
      slotToPlayerIdRef.current = m;
      // Push the roster's name/color/face into the live sim so existing
      // local blobs pick up any changes the host made — the binary
      // snapshot path carries physics only, never cosmetics. The name
      // update matters across round transitions: when `installLevel`
      // tears down the local game, blobs are re-synthesized from the
      // first keyframe with whatever roster snapshot is currently in
      // hand, and any racing first-keyframe is corrected here.
      const game = gameRef.current;
      const ctx = gameContextRef.current;
      const pm = game?.getPlayerManager();
      if (game && ctx && pm) {
        for (const p of evt.players) {
          if (pm.getPlayer(p.id)) {
            game.onPlayerCustomizationUpdate(ctx, p.id, p.color, p.faceId, p.name);
          }
        }
      }
      // Refresh the local-name fallback from the host's roster too —
      // `localNameRef` is read by the first-keyframe synthesis path
      // (see the `rec.id === localPlayerIdRef.current` branch below)
      // when a fresh game spins up before lobby_state has landed.
      const ownId = localPlayerIdRef.current;
      if (ownId) {
        const ownEntry = evt.players.find((p) => p.id === ownId);
        if (ownEntry && ownEntry.name && ownEntry.name.length > 0) {
          localNameRef.current = ownEntry.name;
        }
      }
      // Host-authoritative mode phase. Without this, the guest's local
      // GameModeManager never leaves `playing` after the host wins
      // (host stops emitting input ticks, lockstep gate blocks the
      // guest's update loop, the win-condition check never re-runs),
      // so the "X wins!" / "Next round…" overlay never appears.
      // DETERMINISM FIX: lobby_state broadcasts at 2 Hz off the host's
      // wall-clock — totally decoupled from the host's engine tick.
      // Applying its `modeState` to the guest's GameModeManager mid-sim
      // races the host/guest lockstep lag and can transition the guest's
      // phase (e.g. countdown → playing) one or more ticks before/after
      // the host did the same transition. The guest's physics gate then
      // runs vs doesn't-run on a different engine tick than the host,
      // and engines diverge. Mode/phase sync now happens ONLY via
      // `manager_state` events, which are keyframe-gated and arrive at
      // an exact engine tick (with the engine snapshot, atomically).
      // The lobby_state event remains useful for the lobby panel UI
      // (player list, map selection display).
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
    // Clear the per-tick hash ring. Without this, entries from the
    // previous game (playground tick=0, etc.) survive into the new
    // game's ring and the cross-tab determinism comparison reports
    // spurious "tick=0 desync" for entries that were never part of
    // the new game's recording.
    resetHashHistory();

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
          // Keep the per-tick hash ring in sync during rollback
          // replay (mirrors host-side fix in GameMaster.tsx). Without
          // this the ring keeps stale pre-rollback hashes for replayed
          // ticks and the cross-tab determinism test sees a recorded
          // mismatch even when the engines actually agree post-rollback.
          recordHash(st.world.tick, st.world.stateHash());
        },
      });
      rollbackControllerRef.current = rc;
      displaySmootherRef.current = new DisplaySmoother();
      game.setLogicGate((world) => {
        // Always advance — predict the input set for the upcoming tick
        // and apply it before bouncyBlobsGame's onLogic calls world.step.
        const inputs = rc.predictInputs();
        applyInputsToPM(inputs);
        // world.tick = "N steps completed." The step about to run
        // produces tick world.tick + 1; record inputs under THAT tick
        // to match host's broadcast tag and rc.onAuthoritativeInputs
        // lookups.
        rc.recordTick(world.tick + 1, inputs, world, game);
        return true;
      });
    } else {
      // ── Lockstep + predict-on-stall gate ───────────────────────────────
      // Default path. The guest's sim advances on authoritative inputs
      // (lockstep) when they're available; if the buffer is starved for
      // `stallPredictThreshold` consecutive frames, the guest speculates
      // forward using each remote player's last-known input. When fresh
      // authoritative inputs arrive (via `applyAggregatedInputs` →
      // `rc.onAuthoritativeInputs`), the RollbackController rewinds to
      // the last confirmed tick and replays. With K=120 input redundancy
      // on the unreliable channel, speculation is the exception, not
      // the rule.
      //
      // COUNTDOWN EXCEPTION: see comment in the prediction branch above
      // and `evaluateLockstepGate` — same behaviour applies here.
      const applyInputsToPMSkipLocal = (inputs: InputSet) => {
        const pm = game.getPlayerManager();
        if (!pm) return;
        const localId = localPlayerIdRef.current;
        const skipLocal = getPacingConfig().clientPrediction;
        for (const [pid, inp] of Object.entries(inputs)) {
          // When client prediction is OFF, apply for ALL players
          // including local — guest runs strict lockstep on its own
          // input, sims agree perfectly with no special cases.
          if (skipLocal && pid === localId) continue;
          const mp = pm.getPlayer(pid);
          if (!mp) continue;
          mp.moveX = inp.moveX;
          mp.moveY = inp.moveY;
          mp.expanding = inp.expanding;
        }
      };
      const readLocalKeys = (): { moveX: number; moveY: number; expanding: boolean } => {
        const k = liveKeysRef.current;
        return {
          moveX: quantizeAxis((k.d ? 1 : 0) + (k.a ? -1 : 0)),
          moveY: quantizeAxis((k.s ? 1 : 0) + (k.w ? -1 : 0)),
          expanding: k.space,
        };
      };
      const rc = new RollbackController({
        localPlayerId: localPlayerIdRef.current,
        readLocalInput: readLocalKeys,
        applyInputs: applyInputsToPMSkipLocal,
        stepOne: () => {
          // Used during replay — mirror bouncyBlobsGame's onLogic
          // sequence: playerManager.updateAll + world.step + managers.
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
          // Keep the per-tick hash ring in sync during rollback
          // replay (mirrors host-side fix in GameMaster.tsx). Without
          // this the ring keeps stale pre-rollback hashes for replayed
          // ticks and the cross-tab determinism test sees a recorded
          // mismatch even when the engines actually agree post-rollback.
          recordHash(st.world.tick, st.world.stateHash());
        },
      });
      rollbackControllerRef.current = rc;
      displaySmootherRef.current = new DisplaySmoother();

      let stallCount = 0;
      game.setLogicGate((world) => {
        const phase = game.getPhase();
        if (phase === 'countdown' || phase === 'lobby' || phase === 'results') {
          stallCount = 0;
          return true;
        }
        const nextTick = world.tick + 1;
        const buf = inputBufferRef.current;
        const auth = buf.get(nextTick);

        if (auth) {
          // Lockstep path: authoritative inputs arrived in time. Apply,
          // record, advance.
          stallCount = 0;
          const inputs: InputSet = {};
          const localId = localPlayerIdRef.current;
          const skipLocal = getPacingConfig().clientPrediction;
          for (const inp of auth.inputs) {
            if (!inp.playerId) continue;
            // With prediction ON, omit local from rc's history so a
            // sub-tick timing skew between guest's locally-predicted
            // input and host's view never counts as a "mismatch" that
            // would fire rollback. With prediction OFF, include local
            // — there's no local prediction to drift away from.
            if (skipLocal && inp.playerId === localId) continue;
            inputs[inp.playerId] = { moveX: inp.moveX, moveY: inp.moveY, expanding: inp.expanding };
          }
          applyInputsToPMSkipLocal(inputs);
          // Record under the tick this step produces (= nextTick =
          // world.tick + 1), matching host's broadcast tag convention.
          rc.recordTick(nextTick, inputs, world, game);
          buf.delete(nextTick);
          for (const k of buf.keys()) if (k <= world.tick) buf.delete(k);
          return true;
        }

        // Hard speculation cap: never advance more than MAX_SPECULATION
        // ticks past the highest tick the host has actually broadcast
        // inputs for. Without this, a brief input-channel hiccup turns
        // into the guest racing seconds ahead of the host forever
        // (every tick past the stall threshold just speculates again),
        // breaks the compare-hashes overlap, and produces the periodic
        // "yank back to host's tick" jitter every keyframe.
        const MAX_SPECULATION = 10;
        if (latestHostTickRef.current > 0 && nextTick > latestHostTickRef.current + MAX_SPECULATION) {
          stallCount = 0;
          return false;
        }

        // No authoritative inputs for next tick. The OLD behaviour was:
        // stall for `stallPredictThreshold` ticks, then speculate
        // forward using each remote player's last-known input, and
        // rely on `rc.onAuthoritativeInputs` to rewind+replay when the
        // actual input arrived and differed from the prediction.
        //
        // The rewind/replay only happens when `PacingConfig.enableRollback`
        // is true. With rollback OFF (the current default), speculation
        // produced the symptom user reported as "tick jumping by 60":
        // guest speculates with the wrong input → engine diverges from
        // host's → no replay path corrects it → only the periodic keyframe
        // (every 60 ticks at default) restores guest's state. Between
        // keyframes the guest's local sim was wrong; inputs the user
        // pressed during that window felt like they "did nothing"
        // because the host's view of the world had moved on without them.
        //
        // With rollback OFF: pure stall. The guest pauses its sim and
        // waits for authoritative inputs to arrive. Trades occasional
        // visible stutter (when broadcasts are delayed) for never
        // diverging from host. Net result feels much better than the
        // periodic-yank-back symptom.
        //
        // With rollback ON: speculate as before; rc.onAuthoritativeInputs
        // catches mispredictions.
        if (!getPacingConfig().enableRollback) {
          stallCount++;
          return false;
        }
        const threshold = getPacingConfig().stallPredictThreshold;
        if (stallCount < threshold) {
          stallCount++;
          return false;
        }
        stallCount++;
        const predicted = rc.predictInputs();
        // Only strip local when client prediction is on (same
        // reasoning as lockstep apply above).
        if (getPacingConfig().clientPrediction) {
          delete predicted[localPlayerIdRef.current];
        }
        applyInputsToPMSkipLocal(predicted);
        // Record under tick the step produces.
        rc.recordTick(world.tick + 1, predicted, world, game);
        return true;
      });
      // evaluateLockstepGate is still imported because its unit tests
      // exercise the same gating logic in isolation. Reference it
      // explicitly to silence the unused-import warning.
      void evaluateLockstepGate;
    }

    // Adaptive lockstep pacing. Cap the GameLoop to 1 logic step per RAF in
    // steady state — without this, a momentarily-late input arrival would
    // make the accumulator overflow, then on the next RAF the loop bursts
    // through 2-3 ticks to catch up. That burst is visibly faster than
    // realtime, and the gate-pause that preceded it is visibly slower —
    // together they're the "periodic jitter" the playtest reported.
    //
    // Two-mode cap:
    //   - depth ∈ [0, target+1]: 1 step per RAF (steady state).
    //   - depth >= target+2: 2 steps per RAF (gentle catch-up if host is
    //     consistently ahead, e.g. after the guest's tab regained focus).
    // depth=0 still trips the lockstep gate (returns false) so the sim
    // hard-pauses — that should be rare once the host's input delay
    // broadcast gives this buffer something to draw from. Tunable target
    // live via the debug overlay (initial value from `?buffer=N`).
    game.setMaxStepsPerFrame(() => {
      if (usePrediction) return 5; // prediction path drives its own pacing
      const w = game.getWorld();
      if (!w) return 1;
      const depth = latestHostTickRef.current - w.tick;
      const target = getPacingConfig().bufferTarget;
      return depth >= target + 2 ? 2 : 1;
    });

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

    // Local-player spawn now ALWAYS happens via keyframe synthesis
    // (see joinAsLocalPlayer comment). The pendingLocalSpawnRef +
    // drain path was used by the legacy "spawn locally on canvas
    // mount" flow; it's a no-op now (joinAsLocalPlayer no longer
    // populates pendingLocalSpawnRef) but we leave the drain guard in
    // place in case future code re-introduces a legitimate pending
    // spawn for a non-local-player race.
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
    // Align the local sim's tick counter to the host's ONLY when we're
    // about to restore the full engine state from this frame. For
    // delta frames (no engineState) the guest's local sim already has
    // a correctly-advancing tick counter; overwriting it with the
    // frame's tick effectively SKIPS a tick on the guest (the next
    // step lands at frame.tick+1 but produces what would have been
    // frame.tick's state — because the guest never ran the in-between
    // tick). That off-by-one was the smoking gun for the
    // "guest stays 1 tick behind host after a delta frame" symptom
    // the cross-tab determinism test caught with ?keyframe=0.
    const willRestoreEngineState = !!(frame.engineState && frame.engineState.byteLength > 0);
    if (willRestoreEngineState) {
      world.setTick(frame.tick);
    }

    // v2+: if the host shipped a full engine snapshot, restore it FIRST.
    // This is a lossless sync of every mutable engine field (contact
    // tracking, blob_pin_snapshots, static_surfaces.prev_poly, shape
    // frame_override, etc.) — fixes the "100% hash mismatch after
    // keyframe" bug that came from the prior particle-only sync
    // leaving everything else stuck at the guest's local values.
    //
    // CRITICAL: when engineState was applied, the per-entity
    // particle-apply loop below MUST be skipped. The wire format uses
    // f32 positions + q16-quantized hull offsets — lossy compared to
    // the engine's i64 fixed-point. If we run both, the lossy per-
    // particle apply overwrites the canonical engine state and
    // introduces drift every keyframe. Same logic for
    // `setExpandStateExternal(rec.expanding, rec.expandScale)` — the
    // matching `manager_state` event restores the canonical
    // `expandShapeScale` via `game.restoreGameState` (called from
    // `applyManagerState`), so re-applying the wire-quantized value
    // here would just clobber it.
    const usedEngineState = !!(frame.engineState && frame.engineState.byteLength > 0);
    console.info(
      `[netDiag] guest applySnapshot tick=${frame.tick} engineStateBytes=${frame.engineState?.byteLength ?? 0} usedEngineState=${usedEngineState}`,
    );
    // SYNTHESIZE missing players FIRST so the engine's blob count
    // matches the snapshot before we call restoreState. With the
    // deferred-local-spawn change in joinAsLocalPlayer, the guest's
    // engine has only NPCs (no player blobs) until the first keyframe
    // arrives. If we restoreState before adding players, the blob
    // count mismatches and restoreState fails silently → sim runs
    // on guest's old state → 100% hash mismatch. Adding players in
    // `frame.players` order (= host's order) also fixes the older
    // blob_id ordering bug: each player ends up at the same engine
    // slot on both sides.
    const rosterByIdEarly = new Map<string, { name: string; color: string; faceId: string }>();
    for (const p of lobbyState?.players ?? []) {
      rosterByIdEarly.set(p.id, { name: p.name, color: p.color, faceId: p.faceId });
    }
    for (const rec of frame.players) {
      if (pm.getPlayer(rec.id)) continue;
      const roster = rosterByIdEarly.get(rec.id);
      const isOwnLocalEarly = rec.id === localPlayerIdRef.current;
      const synth: Player = {
        player_id: rec.id,
        session_id: "",
        name: roster?.name ?? (isOwnLocalEarly ? localNameRef.current : rec.id),
        slot: 0,
        status: "connected",
        controller_config: null,
        joined_at: new Date().toISOString(),
        color: roster?.color ?? (isOwnLocalEarly ? localColor : "#888"),
        faceId: roster?.faceId ?? (isOwnLocalEarly ? localFaceId : "default"),
      } as Player;
      game.onPlayerJoin(ctx, synth);
    }
    // Late-joiner safety net: if WE'RE not in this keyframe (host
    // hadn't processed our player_join when it snapshotted), spawn
    // locally now so the camera has a target. Both sides will allocate
    // the same next slot when the host processes the in-flight join,
    // so blob_ids stay aligned.
    if (
      localPlayerJoined &&
      localPlayerIdRef.current &&
      !pm.getPlayer(localPlayerIdRef.current) &&
      !frame.players.some((p) => p.id === localPlayerIdRef.current)
    ) {
      const synthSelf: Player = {
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
      game.onPlayerJoin(ctx, synthSelf);
    }
    if (usedEngineState) {
      const guestBlobCount = world.getBlobCount();
      const ok = world.restoreState(frame.engineState!);
      if (!ok) {
        // Defensive: if restoreState still fails (e.g. NPCs added in
        // a non-deterministic order), at least make it visible.
        const postBlobCount = world.getBlobCount();
        console.warn(
          `[netDiag] engineState restore FAILED at tick=${frame.tick}: guest blobs before=${guestBlobCount}, after=${postBlobCount}, frame.players=${frame.players.length}, frame.world=${frame.world.length}, engineState bytes=${frame.engineState!.byteLength}`,
        );
      } else {
        // Determinism bisect: hash IMMEDIATELY after restore. Host
        // wrote this engineState from its own engine; if our restore
        // is lossless, our hash here equals host's hash at tick K.
        // If it differs, restore is dropping a field. If it matches
        // but the next tick diverges, per-tick step is the bug.
        const postRestoreHash = world.stateHash();
        console.info(
          `[netDiag] guest post-restore tick=${world.tick} hash=${postRestoreHash}`,
        );
        // Ready handshake: if the host's level_loaded asked us to
        // confirm, send `state_ready` now that the bootstrap keyframe
        // is fully applied. The host gates its countdown / startRound
        // on every connected guest confirming, so all sims actually
        // begin physics from the same restored state.
        const levelId = pendingReadyLevelIdRef.current;
        const currentLevelId = currentLevelRef.current?.levelId;
        if (levelId && levelId === currentLevelId) {
          pendingReadyLevelIdRef.current = null;
          const manager = managerRef.current;
          const playerId = localPlayerIdRef.current;
          if (manager && playerId) {
            const payload = JSON.stringify({ type: 'state_ready', levelId, playerId });
            manager.send('host', 'state', payload);
            console.info(`[netDiag] guest sent state_ready for level=${levelId} playerId=${playerId}`);
          }
        }
      }
    }

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
      // Skip if engineState was already applied — the matching
      // manager_state event will restore the canonical SlimeBlob
      // expand state via game.restoreGameState. The wire-quantized
      // rec.expandScale here is lossy (q16Unsigned over the wire) and
      // would clobber the canonical value if we re-applied.
      // DETERMINISM EXPERIMENT: delta frames carry q16-quantized
      // expandScale, which is LOSSY vs the guest's own canonical
      // value. Since the engine is deterministic and the guest
      // computes the same expandScale locally each tick, re-applying
      // the wire value just drifts us off the canonical state. We
      // already skip this branch when a keyframe arrives — extending
      // the skip to delta frames too means we trust the local sim
      // entirely. (Old behaviour preserved behind a `?wireSnap=1` URL
      // param if anyone needs the legacy "trust the wire" path.)
      const wireSnap = new URLSearchParams(window.location.search).get('wireSnap') === '1';
      if (!usedEngineState && wireSnap) {
        mp.blob.setExpandStateExternal(rec.expanding, rec.expandScale);
      }

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

      // Snap particles per the wire's PlayerRecord — ONLY when we
      // didn't already restoreState from engineState. The engineState
      // restore was lossless (i64 fixed-point per the Rust snapshot
      // format), but the wire PlayerRecord encodes positions in f32 +
      // hull offsets as q16Signed (lossy). Re-applying after a
      // lossless restoreState would clobber every particle with
      // slightly-off values, drift the sim, and we'd see exactly the
      // "100% hash mismatch" symptom we just fought through.
      // Same reasoning as setExpandStateExternal above — gated by
      // ?wireSnap=1.
      const wireSnapP = new URLSearchParams(window.location.search).get('wireSnap') === '1';
      if (!usedEngineState && wireSnapP) {
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
    // restore from snapshots taken before they existed. Only invalidate
    // when the particle count ACTUALLY changed (the user observed 173
    // invalidations from firing on every snapshot regardless of
    // whether the blob set changed).
    const currentPC = gameRef.current?.getWorld()?.particleCount() ?? -1;
    if (currentPC > 0 && currentPC !== lastSeenParticleCountRef.current) {
      rollbackControllerRef.current?.invalidateRing('particle count changed via keyframe');
      lastSeenParticleCountRef.current = currentPC;
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
    // Same reason as the player loop above — engineState already
    // restored every particle losslessly; the wire's WorldRecord
    // nodes are f32-quantized and would drift the sim if re-applied.
    // Use `usedEngineState ? [] : frame.world` to skip the loop body
    // entirely without restructuring everything inside.
    // Same reasoning as the player snaps above — bypass for NPCs,
    // platforms, point shapes too unless ?wireSnap=1 forces the legacy
    // path. With deterministic engine, the guest's own sim produces
    // identical particle positions, so re-applying lossy wire values
    // only drifts state.
    const wireSnap = new URLSearchParams(window.location.search).get('wireSnap') === '1';
    for (const wr of (usedEngineState || !wireSnap ? [] : frame.world)) {
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
    // CRITICAL: do NOT spawn the local blob here. The earlier "spawn
    // locally so the UI feels instant" path caused the guest to add
    // its blob to the engine FIRST, then the keyframe synthesized
    // host's player at the NEXT engine slot — opposite order from
    // the host. Engine `blob_id` is the slot index, so the same
    // player ended up with DIFFERENT blob_ids on host vs guest.
    // After `world.restoreState(engineState)` overwrote slots with
    // host's order, every guest `SlimeBlob.blobId` lookup hit the
    // wrong slot (guest's blob.update wrote to host's particles and
    // vice versa). Diverged within ~10 ticks (the "10 green frames"
    // the user observed were the countdown phase where physics
    // doesn't run, then divergence the moment physics started).
    //
    // Fix: defer the local blob spawn until the keyframe arrives and
    // synthesizes every player in host's order. UI delay is ~250ms
    // (first keyframe arrives at the next snapshot tick). The
    // setLocalPlayerIds call also moves into the keyframe synth path
    // (handled by the existing synthesized-player flow there).
    void synth; // synth + game/ctx kept above only for the player_join wire send
    if (game) {
      game.setLocalPlayerIds([localPlayerIdRef.current]);
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

  // Keyboard → host AND directly to local sim (client-side prediction
  // for own player). The local blob responds within 1 sim tick of
  // keypress, matching the host's feel; the lockstep gate ignores
  // broadcast inputs for the local player slot (handled below) so the
  // host's authoritative echo doesn't fight the local prediction.
  //
  // Determinism: keys → quantizeAxis → ManagedPlayer.moveX/Y. The host
  // applies the same quantized value when it receives our input batch,
  // so host's authoritative state and guest's predicted state agree
  // bit-for-bit in the common case (no input drops).
  //
  // When prediction and host disagree (rare — input batch dropped
  // beyond the K=120 redundancy window, or guest's local sim CPU
  // hitched and missed a tick): keyframes recover. Future enhancement
  // could thread a DisplaySmoother offset to make recovery seamless,
  // but with current redundancy this case is vanishingly rare.
  useEffect(() => {
    if (!localPlayerJoined) return;
    const keys = liveKeysRef.current;

    /** Push the guest's current key state into the local ManagedPlayer so
     *  the next physics tick uses it. Quantize so the value matches what
     *  the host will apply on the same input. No-op when client
     *  prediction is off — in that mode the lockstep gate is the only
     *  writer to MP for the local player. */
    const writeLocalIntent = (): void => {
      if (!getPacingConfig().clientPrediction) return;
      const game = gameRef.current;
      if (!game) return;
      const pm = game.getPlayerManager();
      if (!pm) return;
      const mp = pm.getPlayer(localPlayerIdRef.current);
      if (!mp) return;
      const rawX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      const rawY = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
      mp.moveX = quantizeAxis(rawX);
      mp.moveY = quantizeAxis(rawY);
      mp.expanding = keys.space;
    };

    /** Send the current raw key state to the host. We do NOT tag it with a
     *  tick: in the host-authoritative lockstep model the host assigns the
     *  tick — it applies whatever we send at its OWN current tick and
     *  broadcasts it back stamped with that tick. We then apply that echo
     *  in strict lockstep (~2× ping after the keypress). No local
     *  prediction, no rollback; the host is the single source of truth for
     *  input ordering. The `tick` field is kept for wire-format
     *  compatibility but is ignored by the host. */
    const sendInputUpdate = (): void => {
      const manager = managerRef.current;
      if (!manager) return;
      const moveX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      const moveY = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
      const batch: InputBatch = {
        type: "input",
        frames: [{ playerId: localPlayerIdRef.current, moveX, moveY, expanding: keys.space, tick: 0 }],
      };
      manager.send("host", "input", JSON.stringify(batch));
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        keys[k] = true;
        writeLocalIntent();
        sendInputUpdate();
        e.preventDefault();
      } else if (e.code === "Space") {
        keys.space = true;
        writeLocalIntent();
        sendInputUpdate();
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        keys[k] = false;
        writeLocalIntent();
        sendInputUpdate();
      } else if (e.code === "Space") {
        keys.space = false;
        writeLocalIntent();
        sendInputUpdate();
      }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    // Periodic resend as a robustness backstop: if a keydown/keyup
    // message was dropped on the unreliable WebRTC channel, this 60Hz
    // interval re-tags the current key state with the latest tick and
    // re-sends. Host's late-input rollback path catches it up if its
    // sim already advanced past the tagged tick.
    const interval = setInterval(() => {
      // Belt-and-suspenders: also refresh local intent in the interval,
      // in case a key event was missed (e.g. window lost focus mid-press).
      writeLocalIntent();
      sendInputUpdate();
    }, 1000 / INPUT_HZ);

    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      clearInterval(interval);
    };
  }, [localPlayerJoined]);

  // Send a player_leave on UNMOUNT if joined. Critical: do NOT
  // re-fire on every `localPlayerJoined` change — `installLevel` does
  // `setLocalPlayerJoined(false)` on every level transition (so the
  // auto-join effect re-joins the local blob into the new game), and
  // a dep-tracked cleanup would send a stray `player_leave` to the
  // host at that exact moment. The host then removes the player blob
  // (engine slot inactivated but kept), and the immediately-following
  // `joinAsLocalPlayer`'s `player_join` creates a NEW engine slot —
  // leaving an extra inactive blob in the engine. The bootstrap
  // keyframe captures all engine blobs (active + inactive); the
  // wire-format `frame.players` array only captures active players;
  // the guest synthesizes just the wire-format players, ending up
  // with one fewer blob than the host. Engine restore via the
  // engineState then technically "succeeds" but the per-tick stepping
  // diverges as soon as physics begins. Use an empty dep array so
  // cleanup fires only on component unmount, and read the latest
  // `localPlayerJoined` via a ref.
  const localPlayerJoinedLatestRef = useRef(localPlayerJoined);
  useEffect(() => { localPlayerJoinedLatestRef.current = localPlayerJoined; }, [localPlayerJoined]);
  useEffect(() => {
    return () => {
      const manager = managerRef.current;
      if (manager && localPlayerIdRef.current && localPlayerJoinedLatestRef.current) {
        try {
          const evt: ReliableEvent = { type: "player_leave", playerId: localPlayerIdRef.current };
          manager.send("host", "state", JSON.stringify(evt));
        } catch { /* best-effort */ }
      }
    };
  }, []);

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
        {statusLine && (
          <div data-testid="guest-status" style={{
            position: "absolute", top: 8, left: 8, color: "#aaa", fontSize: 11,
            background: "rgba(0,0,0,0.4)", padding: "3px 6px", borderRadius: 3, zIndex: 5,
          }}>{statusLine}</div>
        )}
        {phase === "host_disconnected" && hasLevel ? (
          // We were connected and the host went away mid-game. Keep this
          // path tight — no log, just the "match ended" message.
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
            <h2>Host disconnected — match ended</h2>
            <Link to="/lobbies"><button style={{ padding: "10px 20px", background: "#c77dff" }}>Back to lobbies</button></Link>
          </div>
        ) : !hasLevel ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 16 }}>
            <div style={{
              color: phase === "error" || phase === "host_disconnected" ? "#f99" : "#888",
              fontSize: phase === "error" || phase === "host_disconnected" ? 16 : 14,
              fontWeight: phase === "error" || phase === "host_disconnected" ? 600 : 400,
            }}>
              {phase === "error" || phase === "host_disconnected"
                ? (error ? `Could not connect — ${error}` : "Could not connect.")
                : phase === "connected" ? "Waiting for the host…" : "Connecting…"}
            </div>
            <div
              data-testid="guest-phase-log"
              style={{
                width: "min(560px, 100%)",
                maxHeight: 240,
                overflowY: "auto",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
                lineHeight: 1.45,
                color: "#bbb",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 4,
                padding: "8px 10px",
              }}
            >
              {phaseLog.length === 0 ? (
                <div style={{ color: "#666" }}>(no progress yet)</div>
              ) : (
                phaseLog.map((entry, i) => {
                  const prev = i > 0 ? phaseLog[i - 1].ts : entry.ts;
                  const dt = entry.ts - prev;
                  return (
                    <div key={i}>
                      <span style={{ color: "#666" }}>+{dt.toString().padStart(4, " ")}ms </span>
                      <span style={{ color: "#e0c0ff" }}>{entry.phase}</span>
                      {entry.detail ? <span style={{ color: "#888" }}> — {entry.detail}</span> : null}
                    </div>
                  );
                })
              )}
            </div>
            {(phase === "error" || phase === "host_disconnected") && (
              <div style={{ display: "flex", gap: 12 }}>
                <button
                  onClick={() => window.location.reload()}
                  style={{ padding: "8px 16px", background: "#c77dff", color: "#1a0a10", border: "2px solid #1a0a10", borderRadius: 4, cursor: "pointer", fontWeight: 600 }}
                >
                  Retry
                </button>
                <Link to="/lobbies">
                  <button style={{ padding: "8px 16px", background: "#444", color: "#fff", border: "2px solid #1a0a10", borderRadius: 4, cursor: "pointer" }}>
                    Back to lobbies
                  </button>
                </Link>
              </div>
            )}
          </div>
        ) : (
          <div style={{ position: "relative", flex: 1 }}>
            <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />
            {showNetDebug && <NetDebugOverlay />}
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
