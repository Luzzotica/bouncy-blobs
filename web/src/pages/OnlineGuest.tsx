import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { joinAsPeer, RoomService, PeerManager } from "../lib/party";
import { roomConfig } from "../lib/partyConfig";
import {
  deserializeSnapshot,
  type WorldSnapshot,
  type InputBatch,
  type ReliableEvent,
} from "../lib/multiplayerSnapshot";
import GameCanvas from "../components/GameCanvas";
import { BouncyBlobsGame } from "../game/bouncyBlobsGame";
import type { GameContext } from "../game/GameInterface";
import { InputManager } from "../managers/InputManager";
import type { LevelData, LevelType } from "../levels/types";
import type { Player } from "../types/database";
import { ClassicMode } from "../game/gameModes/classicMode";
import { ChainedMode } from "../game/gameModes/chainedMode";
import { PartyMode } from "../game/gameModes/partyMode";
import { KingOfTheHillMode } from "../game/gameModes/kingOfTheHillMode";
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
function createMirrorMode(level: LevelData, override?: LevelType): GameMode {
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
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [lobbyCode, setLobbyCode] = useState<string>("");
  const [localPlayerJoined, setLocalPlayerJoined] = useState(false);
  const [hasLevel, setHasLevel] = useState(false);
  const [statusLine, setStatusLine] = useState<string>("");

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
  const [canvasKey, setCanvasKey] = useState(0);

  // ─── Bootstrap: join the host's room as a 'screen' peer ────────────────────
  useEffect(() => {
    const pending = getPendingJoin();
    if (!pending) {
      navigate("/lobbies");
      return;
    }

    let cancelled = false;
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
          {
            onPeerConnected: () => { if (!cancelled) setPhase("connected"); },
            onPeerDisconnected: () => { if (!cancelled) setPhase("host_disconnected"); },
            onMessage: (_peerId, _channel, data) => {
              if (cancelled) return;
              handleHostMessage(data);
            },
            onError: (e) => { if (!cancelled) setError(e.message); },
          },
        );
        roomRef.current = room;
        managerRef.current = manager;
        localPlayerIdRef.current = `guest-${result.peer_id}-keyboard`;

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
      // Best-effort: leave the room + tear down the WebRTC peers.
      void roomRef.current?.leaveRoom().catch(() => {});
      managerRef.current?.dispose();
      managerRef.current = null;
      roomRef.current = null;
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, [navigate]);

  // ─── Host → guest message routing ──────────────────────────────────────────
  // Reliable channel multiplexes: WorldSnapshot frames AND level_loaded events.
  // Differentiate on the `type` discriminator.
  function handleHostMessage(data: string | ArrayBuffer): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return; }

    if (parsed?.type === "level_loaded") {
      installLevel(parsed.levelId, parsed.levelData, parsed.levelType);
      return;
    }
    // Fallback: treat as a WorldSnapshot.
    const snap = deserializeSnapshot(text) as WorldSnapshot | null;
    if (!snap || !Array.isArray(snap.players)) return;
    applySnapshot(snap);
  }

  // ─── Local sim setup on level_loaded ───────────────────────────────────────
  function installLevel(levelId: string, levelData: LevelData, levelType: LevelType): void {
    // Tear down any previous game.
    gameRef.current?.destroy();
    gameRef.current = null;
    remoteInputRef.current.clear();

    const game = new BouncyBlobsGame();
    const mode = createMirrorMode(levelData, levelType);
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
    setTimeout(() => game.startRound(), 100);
  }

  function onCanvasResize(width: number, height: number): void {
    gameRef.current?.setCanvasSize(width, height);
  }

  // ─── Snapshot application ─────────────────────────────────────────────────
  function applySnapshot(snap: WorldSnapshot): void {
    const game = gameRef.current;
    const ctx = gameContextRef.current;
    if (!game || !ctx) return;
    const pm = game.getPlayerManager();
    if (!pm) return;

    // Stale-level guard: if the host has swapped levels and we haven't received
    // the level_loaded yet, drop frames until we do.
    if (snap.levelId && currentLevelRef.current && snap.levelId !== currentLevelRef.current.levelId) return;

    const incomingIds = new Set<string>();
    for (const sp of snap.players) {
      incomingIds.add(sp.id);
      let mp = pm.getPlayer(sp.id);
      if (!mp) {
        // Spawn a new local blob mirroring the host's.
        const synth: Player = {
          player_id: sp.id,
          session_id: "",
          name: sp.name,
          slot: 0,
          status: "connected",
          controller_config: null,
          joined_at: new Date().toISOString(),
          color: sp.color,
          faceId: sp.faceId,
        } as Player;
        game.onPlayerJoin(ctx, synth);
        mp = pm.getPlayer(sp.id);
        if (!mp) continue;
      }

      // For the guest's OWN player: skip overriding inputs (local keys already
      // drive it via inputManager). Still apply position drift correction.
      const isOwn = sp.id === localPlayerIdRef.current;
      if (!isOwn) {
        mp.moveX = sp.moveX;
        mp.moveY = sp.moveY;
        mp.expanding = sp.expanding;
        remoteInputRef.current.set(sp.id, {
          moveX: sp.moveX,
          moveY: sp.moveY,
          expanding: sp.expanding,
          expandScale: sp.expandScale,
        });
      }

      // Drift correction — gently translate the blob toward the host's
      // authoritative centroid. Don't fight the physics for own player
      // (small alpha) and be slightly more aggressive for remote players.
      const c = mp.blob.getCentroid();
      const dx = sp.x - c.x;
      const dy = sp.y - c.y;
      const distSq = dx * dx + dy * dy;
      const alpha = isOwn ? 0.05 : 0.25;
      // Threshold to ignore noise; teleport on large drift to recover quickly.
      if (distSq > 500 * 500) {
        mp.blob.teleportTo({ x: sp.x, y: sp.y });
      } else if (distSq > 1) {
        mp.blob.nudgeCentroidToward({ x: sp.x, y: sp.y }, alpha);
      }
    }

    // Despawn local players the host no longer reports.
    for (const p of pm.getAllPlayers()) {
      if (!incomingIds.has(p.playerId)) {
        game.onPlayerDisconnect(ctx, p.playerId);
      }
    }

    // Surface mode info in the header for debugging / feedback.
    setStatusLine(`tick ${snap.tick} · phase ${snap.modeState?.phase ?? '?'} · ${snap.players.length} blob(s)`);
  }

  // ─── Local player join + keyboard capture ─────────────────────────────────
  function joinAsLocalPlayer(): void {
    const manager = managerRef.current;
    if (!manager || localPlayerJoined) return;
    const evt: ReliableEvent = {
      type: "player_join",
      playerId: localPlayerIdRef.current,
      name: "You (Guest)",
      color: "#ffd166",
      faceId: "default",
    };
    manager.send("host", "state", JSON.stringify(evt));
    setLocalPlayerJoined(true);
  }

  function leaveAsLocalPlayer(): void {
    const manager = managerRef.current;
    if (!manager || !localPlayerJoined) return;
    const evt: ReliableEvent = { type: "player_leave", playerId: localPlayerIdRef.current };
    manager.send("host", "state", JSON.stringify(evt));
    setLocalPlayerJoined(false);
  }

  // Keyboard → local sim (instant) + upstream to host at 30Hz.
  useEffect(() => {
    if (!localPlayerJoined) return;
    const keys = { w: false, a: false, s: false, d: false, space: false };

    const applyLocalInput = () => {
      const game = gameRef.current;
      const pm = game?.getPlayerManager();
      const player = pm?.getPlayer(localPlayerIdRef.current);
      if (!player) return;
      player.moveX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      player.moveY = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
      player.expanding = keys.space;
    };

    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") {
        keys[k] = true;
        applyLocalInput();
        e.preventDefault();
      } else if (e.code === "Space") {
        keys.space = true;
        applyLocalInput();
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "w" || k === "a" || k === "s" || k === "d") { keys[k] = false; applyLocalInput(); }
      else if (e.code === "Space") { keys.space = false; applyLocalInput(); }
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);

    let tick = 0;
    const interval = setInterval(() => {
      const manager = managerRef.current;
      if (!manager) return;
      const moveX = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      const moveY = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #222", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14 }}>
          <strong>Online match</strong>
          {lobbyCode && <span style={{ color: "#888", marginLeft: 8 }}>code {lobbyCode}</span>}
          <span style={{ marginLeft: 16, color: phase === "connected" ? "#7f7" : phase === "connecting" ? "#fc7" : "#f77" }}>
            ● {phase}
          </span>
          {statusLine && <span style={{ marginLeft: 12, color: "#888", fontSize: 12 }} data-testid="guest-status">{statusLine}</span>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            data-testid="local-player-toggle"
            onClick={localPlayerJoined ? leaveAsLocalPlayer : joinAsLocalPlayer}
            disabled={phase !== "connected" || !hasLevel}
            style={{ padding: "6px 12px", fontSize: 13, background: localPlayerJoined ? "#2d6a4f" : "#5dd6ff", color: localPlayerJoined ? "#fff" : "#000" }}
            title={localPlayerJoined ? "Leave the game" : "Join the game using WASD + Space"}
          >
            {localPlayerJoined ? "🎮 Leave (You)" : "🎮 Play from laptop"}
          </button>
          <Link to="/lobbies"><button style={{ padding: "6px 12px" }}>Leave</button></Link>
        </div>
      </div>
      {error && <div style={{ padding: 16, color: "#f77", background: "#3a0000" }}>{error}</div>}
      {phase === "host_disconnected" ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <h2>Host disconnected — match ended</h2>
          <Link to="/lobbies"><button style={{ padding: "10px 20px", background: "#c77dff" }}>Back to lobbies</button></Link>
        </div>
      ) : !hasLevel ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
          {phase === "connected" ? "Waiting for the host to start a game…" : "Connecting…"}
        </div>
      ) : (
        <div style={{ position: "relative", flex: 1 }}>
          <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />
        </div>
      )}
    </div>
  );
}
