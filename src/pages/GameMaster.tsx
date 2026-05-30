import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useUser } from '../contexts/UserContext';
import { createHostRoom, RoomService, PeerManager, SteamTransport, steamNetStartListening, getSelfSteamId, steamNetCloseAll } from '../lib/party';
import { isSteamAvailable } from '../lib/workshopApi';
import {
  createLobby,
  leaveLobby,
  openInviteOverlay,
  onMemberChanged,
} from '../lib/steamLobbyApi';
import type { RoomPeer, PeerCallbacks } from '../lib/party';
import { roomConfig, GAME_ID } from '../lib/partyConfig';
import { serializeSnapshot, type WorldSnapshot, type SnapshotEntity, type LobbyStateEvent, type ReliableEvent } from '../lib/multiplayerSnapshot';
import {
  encodeSnapshot,
  ENTITY_KIND_NPC,
  ENTITY_KIND_PLATFORM,
  ENTITY_KIND_POINT_SHAPE,
  MAX_OFFSET,
  type PlayerRecord,
  type WorldRecord,
  type EntityOffset,
} from '../lib/wireProtocol';
import { encodeAggregatedInputs } from '../lib/inputProtocol';
import { installDebugBridge } from '../lib/debugBridge';
import {
  DEFAULT_PERSONALITY,
  GOAL_SEEKER_PALETTE,
  PERSONALITY_COLORS,
  PERSONALITY_LABELS,
  isPersonalityName,
  type PersonalityName,
} from '../game/aiPersonalities';
import { COLOR_PALETTE } from '../constants/customization';
import LobbyPanel, { type MapOption, type PlayerSummary } from '../components/LobbyPanel';
import { getAllFacePresets } from '../renderer/faceRenderer';
import { InputManager } from '../managers/InputManager';
import { BouncyBlobsGame } from '../game/bouncyBlobsGame';
import { createGamepadInput } from '../game/gamepadInput';
import { GameContext, GameState } from '../game/GameInterface';
import { LevelData, LevelType, getLevelTypes } from '../levels/types';
import { useAuth } from '../contexts/AuthContext';
import { DEFAULT_CONTROLLER_CONFIG } from '../types/controllerConfig';
import { WebRTCMessage } from '../types/webrtc';
import GameCanvas from '../components/GameCanvas';
import type { Player } from '../types/database';
import { GameMode, GamePhase } from '../game/gameModes/types';
// Game mode registry
import { ClassicMode } from '../game/gameModes/classicMode';
import { ChainedMode } from '../game/gameModes/chainedMode';
import { PartyMode } from '../game/gameModes/partyMode';
import { KingOfTheHillMode } from '../game/gameModes/kingOfTheHillMode';
import { FreeplayMode } from '../game/gameModes/freeplayMode';

import { getAvailableLevels, loadBuiltinLevel, listAllLevels, loadLevelById } from '../levels/levelRegistry';

/** LAN IP for dev QR codes — set VITE_LOCAL_LAN_IP in .env to your machine's IP */
const LOCAL_LAN_IP = import.meta.env.VITE_LOCAL_LAN_IP ?? '127.0.0.1';

function createModeForLevel(levelData: LevelData, broadcastFn?: (msg: any) => void, overrideMode?: LevelType): GameMode {
  // Host's chosen mode wins. Only fall back to the level's declared type
  // (or KOTH when the level only has hillZones) when no override is set.
  const fallback: LevelType = (levelData.hillZones && levelData.hillZones.length > 0 && !(levelData.goalZones && levelData.goalZones.length > 0))
    ? 'koth'
    : getLevelTypes(levelData)[0];
  const mode = overrideMode ?? fallback;
  switch (mode) {
    case 'team_racing': return new ChainedMode(levelData);
    case 'party': return new PartyMode(levelData, broadcastFn);
    case 'koth': return new KingOfTheHillMode(levelData);
    case 'solo_racing':
    default:
      return new ClassicMode(levelData);
  }
}

function peerToPlayer(p: RoomPeer, sessionId: string): Player {
  return {
    player_id: p.peer_id,
    session_id: sessionId,
    name: p.display_name,
    slot: p.slot,
    status: p.status,
    controller_config: null,
    joined_at: p.joined_at,
  };
}

type SessionPhase = 'creating' | 'lobby' | 'playing' | 'error';

/** Pick a color the lobby doesn't already have in use. Tries the personality's
 * preferred color first, then the goal-seeker rainbow, then the general
 * controller palette. Falls back to the first preferred color if literally
 * every entry is taken (small lobbies will never hit this). */
function pickAvailableColor(
  personality: PersonalityName,
  taken: ReadonlySet<string>,
): string {
  const preferred = personality === 'goal_seeker'
    ? GOAL_SEEKER_PALETTE
    : [PERSONALITY_COLORS[personality], ...GOAL_SEEKER_PALETTE, ...COLOR_PALETTE];
  for (const c of preferred) if (!taken.has(c)) return c;
  return preferred[0];
}

export default function GameMaster() {
  const { anonymousId } = useUser();
  const { session: authSession, user: authUser } = useAuth();
  const authSessionRef = useRef(authSession);
  authSessionRef.current = authSession;
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<SessionPhase>('creating');
  // Mirror of `phase` for closures that captured it stale (e.g. the
  // onPeerConnected callback inside init() can fire any time after mount).
  const phaseRef = useRef<SessionPhase>('creating');
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
  const [steamLobbyReady, setSteamLobbyReady] = useState(false);
  const steamLobbyIdRef = useRef<string | null>(null);
  const steamMemberUnlistenRef = useRef<(() => void) | null>(null);

  // Latest lobby_state snapshot. Updated in a useEffect below whenever any
  // tracked piece of host state changes; broadcast to connected screen peers
  // both from that effect and from the onPeerConnected handler (for late
  // joiners getting their first lobby_state right after level_loaded).
  const lobbyStateRef = useRef<LobbyStateEvent | null>(null);

  // Session RNG seed. Generated once at mount and reused across both the
  // lobby playground and any actual match. Every `level_loaded` event
  // broadcast to guests carries this seed; the guest's BouncyBlobsGame is
  // constructed with the matching seed so the host's and guest's worlds
  // produce identical AI decisions, powerup rolls, etc.
  // Seed defaults to a random u32 per session. Overridable via `?seed=N`
  // for deterministic playwright/replay scenarios.
  const sessionSeedRef = useRef<number>(((): number => {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      const s = sp.get('seed');
      if (s) {
        const n = Number(s);
        if (Number.isFinite(n)) return (n >>> 0) || 1;
      }
    }
    return (Math.random() * 0xffffffff) >>> 0;
  })());

  // Delta-compression scratch for the binary snapshot loop. Maps entity id
  // (player id, npc-N, plat-X, point-shape id) to the last root + offsets we
  // sent on the wire, plus a counter of how many consecutive ticks the
  // entity has been at rest (used to compute the settled flag — once it's
  // been still for SETTLED_FRAMES ticks we emit `settled: true` so the
  // receiver can skip per-tick reconciliation for it). Every Nth tick we
  // force a full keyframe so peers that missed updates can recover. Set
  // `forceKeyframeRef.current = true` to request a keyframe on the next
  // snapshot (used when a new screen peer connects mid-stream).
  const lastSentRef = useRef<Map<string, {
    rootX: number; rootY: number;
    offsets: Float32Array;
    /** Consecutive ticks with no significant change. */
    stillTicks: number;
  }>>(new Map());
  // Separate history for world objects — those use absolute positions on the
  // wire (not root+offsets) because their spans and node counts blow past the
  // player record's u16-mask / ±MAX_OFFSET budget. We track every particle's
  // last sent absolute position to compute the settled flag.
  const lastSentWorldRef = useRef<Map<string, {
    cx: number; cy: number;
    positions: Float32Array;
    stillTicks: number;
  }>>(new Map());
  const ticksSinceKeyframeRef = useRef<number>(0);
  const forceKeyframeRef = useRef<boolean>(true);

  // Late-joiner replay support. The host caches the most recent keyframe
  // payload + a ring buffer of recent aggregated-input ticks. When a new
  // screen peer connects, it gets the cached keyframe followed by every
  // buffered input frame, lets it snap to the keyframe state and replay
  // forward to ~the host's current tick.
  const latestKeyframeRef = useRef<{ tick: number; buf: ArrayBuffer } | null>(null);
  /** Most recent `manager_state` JSON event we've broadcast. Replayed to
   * late joiners alongside the latest keyframe so their stateful managers
   * (spring pads etc.) start in the host's state rather than the level's
   * fresh-from-init state. */
  const latestManagerStateRef = useRef<{ tick: number; json: string } | null>(null);
  /** Aggregated input ticks since the most recent keyframe. Ring-buffered
   * to ~10 s @ 30 Hz worth of frames. */
  const inputHistoryRef = useRef<Array<{ tick: number; inputs: { playerId: string; moveX: number; moveY: number; expanding: boolean }[] }>>([]);
  const INPUT_HISTORY_MAX = 300;
  const [connectedPlayers, setConnectedPlayers] = useState<Player[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [gamePhase, setGamePhase] = useState<GamePhase | null>(null);
  /** Counter to force GameCanvas remount on phase transitions */
  const [canvasKey, setCanvasKey] = useState(0);

  const gameRef = useRef<BouncyBlobsGame | null>(null);
  // Unified rooms refs. Replaces the previous quartet
  // (managerRef + signalingRef + matchHostRef + matchMpRef) from when phone-
  // signaling and screen-signaling were separate systems.
  const managerRef = useRef<PeerManager | null>(null);
  const roomRef = useRef<RoomService | null>(null);
  const [roomReady, setRoomReady] = useState(false);
  // playerId → { screenId, name, color, faceId } for every player joined from a guest
  // screen. Used to clean up on disconnect and re-spawn after canvasKey rebuilds.
  const guestPlayersRef = useRef<Map<string, { screenId: string; name: string; color: string; faceId: string }>>(new Map());
  // Latest level the host's authoritative game is running. Broadcast to every
  // newly connected guest, and re-broadcast on every level transition so guests
  // rebuild their local sim with identical LevelData.
  const currentLevelRef = useRef<{ levelId: string; levelData: LevelData; levelType: LevelType } | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  // Host's local-player customization. Picker UI lives in the LobbyPanel.
  // Defaults are reconciled against the live taken-color set in an effect
  // below so a host opening the page after others have joined doesn't collide.
  const [localColor, setLocalColor] = useState<string>(COLOR_PALETTE[0]);
  const [localFaceId, setLocalFaceId] = useState<string>('default');
  // Lobby selections — drive the Start button.
  const [selectedMapId, setSelectedMapId] = useState<string>('builtin:default');
  const [selectedModeId, setSelectedModeId] = useState<LevelType>('solo_racing');
  const [mapOptions, setMapOptions] = useState<MapOption[]>([
    { id: 'builtin:default', name: 'Default Arena', source: 'builtin', levelTypes: ['solo_racing'] },
  ]);
  // True once any human has joined this lobby. Auto-end fires only after a human
  // arrives and then every human leaves — never on a freshly-created empty lobby.
  const hadHumanRef = useRef(false);
  const autoEndingRef = useRef(false);
  // Stable id used by both onPlayerJoin and InputManager for the keyboard player.
  const LOCAL_PLAYER_ID = 'local-keyboard';
  const [localPlayerJoined, setLocalPlayerJoined] = useState(false);

  // Player IDs the camera should follow on the host: every player whose
  // INPUT originates on this machine — keyboard, gamepads, and phone
  // controllers connected directly to this room. Online guests (screen
  // peers) and AI bots are intentionally excluded so the host's view
  // stays on the people physically playing here. Pushed to the game via
  // setLocalPlayerIds each time the set changes.
  const localPlayerIdsRef = useRef<Set<string>>(new Set());
  const pushLocalPlayerIds = useCallback(() => {
    const game = gameRef.current;
    if (!game) return;
    const ids = [...localPlayerIdsRef.current];
    game.setLocalPlayerIds(ids.length > 0 ? ids : null);
  }, []);
  const addLocalPlayerId = useCallback((id: string) => {
    localPlayerIdsRef.current.add(id);
    pushLocalPlayerIds();
  }, [pushLocalPlayerIds]);
  const removeLocalPlayerId = useCallback((id: string) => {
    localPlayerIdsRef.current.delete(id);
    pushLocalPlayerIds();
  }, [pushLocalPlayerIds]);

  // Local AI bots spawned from the lobby UI or the ?ai= URL param.
  // Tracked separately from `connectedPlayers` (which mirrors the party API)
  // because bots have no party_player row.
  const [bots, setBots] = useState<Array<{ playerId: string; name: string; personality: PersonalityName; color: string }>>([]);

  const addBot = useCallback((personality?: PersonalityName) => {
    const game = gameRef.current;
    if (!game) return;
    const pm = game.getPlayerManager();
    if (!pm) return;
    const currentCount = pm.getPlayerCount();
    if (currentCount >= maxPlayers) return;
    const pick = personality ?? DEFAULT_PERSONALITY;
    // Avoid clashing with any color already in use (humans + other bots).
    const taken = new Set(pm.getAllPlayers().map((p) => p.color));
    const presetColor = pickAvailableColor(pick, taken);
    const { playerId, name, color } = game.addAIPlayer(pick, { color: presetColor });
    setBots((prev) => [...prev, { playerId, name, personality: pick, color }]);
  }, [maxPlayers]);

  const removeBot = useCallback((playerId: string) => {
    gameRef.current?.removeAIPlayer(playerId);
    setBots((prev) => prev.filter((b) => b.playerId !== playerId));
  }, []);

  const joinAsLocalPlayer = useCallback(() => {
    const game = gameRef.current;
    const ctx = contextRef.current;
    if (!game || !ctx || localPlayerJoined) return;
    const player: Player = {
      player_id: LOCAL_PLAYER_ID,
      session_id: sessionId ?? '',
      name: 'You',
      slot: 0,
      status: 'connected',
      controller_config: null,
      joined_at: new Date().toISOString(),
      color: localColor,
      faceId: localFaceId,
    } as Player;
    game.onPlayerJoin(ctx, player);
    addLocalPlayerId(LOCAL_PLAYER_ID);
    // Mirror the local player's customization into the shared taken-list ref
    // so phone controllers and bot-color-avoidance see this slot as taken.
    playerCustomRef.current.set(LOCAL_PLAYER_ID, { color: localColor, faceId: localFaceId });
    setLocalPlayerJoined(true);
  }, [localPlayerJoined, sessionId, localColor, localFaceId]);

  const leaveAsLocalPlayer = useCallback(() => {
    if (!localPlayerJoined) return;
    const game = gameRef.current;
    const ctx = contextRef.current;
    if (game && ctx) game.onPlayerDisconnect(ctx, LOCAL_PLAYER_ID);
    removeLocalPlayerId(LOCAL_PLAYER_ID);
    playerCustomRef.current.delete(LOCAL_PLAYER_ID);
    setLocalPlayerJoined(false);
  }, [localPlayerJoined]);

  /** Update the local player's color (or face) live. Pushes through the same
   * `onPlayerCustomizationUpdate` path phone controllers use so the blob
   * re-renders without a respawn, and re-broadcasts the taken list. */
  const updateLocalCustomization = useCallback((color?: string, faceId?: string) => {
    if (color) setLocalColor(color);
    if (faceId) setLocalFaceId(faceId);
    if (!localPlayerJoined) return;
    const game = gameRef.current;
    const ctx = contextRef.current;
    const existing = playerCustomRef.current.get(LOCAL_PLAYER_ID) ?? {};
    const next = { color: color ?? existing.color, faceId: faceId ?? existing.faceId };
    playerCustomRef.current.set(LOCAL_PLAYER_ID, next);
    if (game && ctx) {
      game.onPlayerCustomizationUpdate(ctx, LOCAL_PLAYER_ID, next.color, next.faceId);
    }
  }, [localPlayerJoined]);

  // Keyboard → InputManager bridge. WASD = left joystick, Space = button_right
  // (the "expand" action). Only attached while the local player has joined.
  useEffect(() => {
    if (!localPlayerJoined) return;
    const im = inputManagerRef.current;
    const keys = { w: false, a: false, s: false, d: false, space: false };
    let lastStickTs = 0;
    const sendStick = () => {
      const x = (keys.d ? 1 : 0) + (keys.a ? -1 : 0);
      const y = (keys.s ? 1 : 0) + (keys.w ? -1 : 0);
      // Continuous events dedupe on (playerId+type, timestamp) — bump if same ms.
      let ts = Date.now();
      if (ts <= lastStickTs) ts = lastStickTs + 1;
      lastStickTs = ts;
      im.processInput(LOCAL_PLAYER_ID, 'joystick_left', { x, y }, ts);
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        if (keys[k]) return;
        keys[k] = true;
        sendStick();
        e.preventDefault();
      } else if (e.code === 'Space') {
        if (keys.space) return;
        keys.space = true;
        im.processInput(LOCAL_PLAYER_ID, 'button_right', { pressed: true }, Date.now());
        e.preventDefault();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
        if (!keys[k]) return;
        keys[k] = false;
        sendStick();
      } else if (e.code === 'Space') {
        keys.space = false;
        im.processInput(LOCAL_PLAYER_ID, 'button_right', { pressed: false }, Date.now());
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, [localPlayerJoined]);

  // Gamepad → InputManager bridge. Up to 4 controllers (Xbox, PlayStation,
  // Steam Deck built-in, generic XInput) auto-join as separate local
  // players the FIRST time each one produces real input (stick past
  // deadzone OR A/right-trigger pressed). Standard browser-gamepad
  // mapping: left stick → move, A button or right trigger → expand.
  useEffect(() => {
    const im = inputManagerRef.current;
    const joinedGamepads = new Set<string>();

    const onJoinRequest = (playerId: string, gamepadIndex: number) => {
      if (joinedGamepads.has(playerId)) return;
      const game = gameRef.current;
      const ctx = contextRef.current;
      if (!game || !ctx) return;
      const pm = game.getPlayerManager();
      if (!pm) return;
      if (pm.getPlayerCount() >= maxPlayers) return;
      const taken = new Set(pm.getAllPlayers().map((p) => p.color));
      const color = COLOR_PALETTE.find((c) => !taken.has(c))
        ?? COLOR_PALETTE[gamepadIndex % COLOR_PALETTE.length];
      const takenFaces = new Set(pm.getAllPlayers().map((p) => p.faceId).filter(Boolean));
      const face = getAllFacePresets().find((f) => !takenFaces.has(f.id))?.id ?? 'default';
      const player: Player = {
        player_id: playerId,
        session_id: sessionId ?? '',
        name: `Gamepad ${gamepadIndex + 1}`,
        slot: 100 + gamepadIndex,
        status: 'connected',
        controller_config: null,
        joined_at: new Date().toISOString(),
        color,
        faceId: face,
      } as Player;
      game.onPlayerJoin(ctx, player);
      addLocalPlayerId(playerId);
      playerCustomRef.current.set(playerId, { color, faceId: face });
      joinedGamepads.add(playerId);
    };

    const onDisconnect = (playerId: string) => {
      if (!joinedGamepads.has(playerId)) return;
      const game = gameRef.current;
      const ctx = contextRef.current;
      if (game && ctx) game.onPlayerDisconnect(ctx, playerId);
      removeLocalPlayerId(playerId);
      playerCustomRef.current.delete(playerId);
      joinedGamepads.delete(playerId);
    };

    const pad = createGamepadInput({
      inputManager: im,
      onJoinRequest,
      onDisconnect,
    });
    pad.start();
    return () => {
      pad.stop();
      const game = gameRef.current;
      const ctx = contextRef.current;
      if (game && ctx) {
        for (const id of joinedGamepads) game.onPlayerDisconnect(ctx, id);
      }
      joinedGamepads.clear();
    };
  }, [maxPlayers, sessionId]);

  // Per-game player cap. Limits AI bots locally AND pushes max_peers to the
  // server so phone-join attempts past the new limit get a clean 409. Without
  // the server push the room stays stuck at whatever max_peers was when the
  // room was created (default 4).
  const changeMaxPlayers = useCallback((next: number) => {
    const clamped = Math.min(Math.max(Math.trunc(next), 1), 16);
    setMaxPlayers(clamped);
    roomRef.current?.setMaxPeers(clamped).catch((err) => {
      console.warn('Failed to update server max_peers:', err);
    });
  }, []);

  const togglePublic = useCallback(async () => {
    const room = roomRef.current;
    if (!room || visibilityBusy) return;
    const next = !isPublic;
    setVisibilityBusy(true);
    try {
      await room.setVisibility(next ? 'public' : 'private');
      setIsPublic(next);
    } catch (err) {
      console.warn('Failed to update room visibility:', err);
    } finally {
      setVisibilityBusy(false);
    }
  }, [isPublic, visibilityBusy]);

  // Auto-spawn bots from ?ai=chaser,fleer,... once the game is ready.
  // Fires when the lobby playground is up (or a game is running) so both
  // manual and Playwright runs hit the same code path.
  const aiParamAppliedRef = useRef(false);
  useEffect(() => {
    if (aiParamAppliedRef.current) return;
    if (phase !== 'lobby' && phase !== 'playing') return;
    if (!gameRef.current) return;
    const raw = searchParams.get('ai');
    if (!raw) { aiParamAppliedRef.current = true; return; }
    const personalities = raw.split(',').map((s) => s.trim()).filter(isPersonalityName);
    aiParamAppliedRef.current = true;
    for (const p of personalities) addBot(p);
  }, [phase, addBot, searchParams]);

  // After the game is rebuilt (canvasKey bumps on phase transitions), re-attach
  // every existing bot so they survive voting → playing → voting cycles.
  const lastCanvasKeyRef = useRef(canvasKey);
  useEffect(() => {
    if (canvasKey === lastCanvasKeyRef.current) return;
    lastCanvasKeyRef.current = canvasKey;
    if (bots.length === 0 && !localPlayerJoined) return;
    // Defer one tick so the new BouncyBlobsGame has finished initialize().
    const handle = setTimeout(() => {
      const game = gameRef.current;
      const ctx = contextRef.current;
      if (!game) return;
      for (const b of bots) {
        game.addAIPlayer(b.personality, { id: b.playerId, name: b.name, color: b.color });
      }
      if (localPlayerJoined && ctx) {
        game.onPlayerJoin(ctx, {
          player_id: LOCAL_PLAYER_ID,
          session_id: sessionId ?? '',
          name: 'You',
          slot: 0,
          status: 'connected',
          controller_config: null,
          joined_at: new Date().toISOString(),
          color: '#5dd6ff',
          faceId: 'default',
        } as Player);
      }
      if (ctx) {
        for (const [pid, info] of guestPlayersRef.current.entries()) {
          game.onPlayerJoin(ctx, {
            player_id: pid,
            session_id: '',
            name: info.name,
            slot: 0,
            status: 'connected',
            controller_config: null,
            joined_at: new Date().toISOString(),
            color: info.color,
            faceId: info.faceId,
          } as Player);
        }
      }
      // The new game instance has empty localPlayerIds — replay our set
      // so the camera keeps following the right blobs after rebuild.
      pushLocalPlayerIds();
    }, 150);
    return () => clearTimeout(handle);
  }, [canvasKey, bots, localPlayerJoined, sessionId, pushLocalPlayerIds]);
  const inputManagerRef = useRef<InputManager>(new InputManager());
  const contextRef = useRef<GameContext | null>(null);
  const knownPlayerIdsRef = useRef<Set<string>>(new Set());
  /** Stores color/faceId from player_join messages so they persist across game restarts. */
  const playerCustomRef = useRef<Map<string, { color?: string; faceId?: string }>>(new Map());
  /** Track connected players via ref for use in callbacks without stale closures */
  const connectedPlayersRef = useRef<Player[]>([]);
  connectedPlayersRef.current = connectedPlayers;

  // Reference to the active party mode (if any) for routing party messages
  const partyModeRef = useRef<PartyMode | null>(null);

  const handlePartyMessage = useCallback((playerId: string, message: WebRTCMessage) => {
    const partyMode = partyModeRef.current;
    if (!partyMode) return;

    if (message.type === 'item_select' && message.value) {
      partyMode.handleItemSelect(playerId, message.value.itemIndex);
    } else if (message.type === 'cursor_move' && message.value) {
      partyMode.handleCursorMove(playerId, message.value.x, message.value.y);
    } else if (message.type === 'placement_confirm') {
      partyMode.handlePlacementConfirm(playerId);
    }
  }, []);

  /** Build taken lists excluding a specific player's own selections. */
  const getTakenExcluding = useCallback((excludePlayerId?: string) => {
    const takenColors: string[] = [];
    const takenFaces: string[] = [];
    for (const [pid, custom] of playerCustomRef.current) {
      if (pid === excludePlayerId) continue; // don't mark player's own as taken
      if (custom.color) takenColors.push(custom.color);
      if (custom.faceId) takenFaces.push(custom.faceId);
    }
    return { takenColors, takenFaces };
  }, []);

  /** Send personalized taken lists to every connected controller (excluding each player's own). */
  const broadcastCustomizationUpdate = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    for (const player of connectedPlayersRef.current) {
      const { takenColors, takenFaces } = getTakenExcluding(player.player_id);
      manager.sendPrimary(player.player_id, JSON.stringify({
        type: 'customization_update',
        value: { takenColors, takenFaces },
      }));
    }
  }, [getTakenExcluding]);

  /** Send taken customizations to a specific player (excluding their own). */
  const sendCustomizationTo = useCallback((playerId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    const { takenColors, takenFaces } = getTakenExcluding(playerId);
    manager.sendPrimary(playerId, JSON.stringify({
      type: 'customization_update',
      value: { takenColors, takenFaces },
    }));
  }, [getTakenExcluding]);

  const handlePlayerJoin = useCallback((player: Player, _webrtcPlayerId: string) => {
    // Save customizations for reuse across game restarts
    if (player.color || player.faceId) {
      playerCustomRef.current.set(player.player_id, {
        color: player.color,
        faceId: player.faceId,
      });
    }
    if (gameRef.current && contextRef.current) {
      gameRef.current.onPlayerJoin(contextRef.current, player);
    }
    // Phone controllers join over WebRTC directly to this host — they
    // count as local for camera-follow purposes.
    addLocalPlayerId(player.player_id);
    // Broadcast updated taken list to all controllers
    broadcastCustomizationUpdate();
  }, [broadcastCustomizationUpdate, addLocalPlayerId]);

  const handlePlayerDisconnect = useCallback((playerId: string) => {
    // Free their customizations
    playerCustomRef.current.delete(playerId);
    // Remove from known players so they can re-join cleanly
    knownPlayerIdsRef.current.delete(playerId);
    // Remove from connected players list (prevents ghost re-spawn on game transitions)
    setConnectedPlayers(prev => prev.filter(p => p.player_id !== playerId));
    if (gameRef.current && contextRef.current) {
      gameRef.current.onPlayerDisconnect(contextRef.current, playerId);
    }
    removeLocalPlayerId(playerId);
    // Broadcast updated taken list to all controllers
    broadcastCustomizationUpdate();
  }, [broadcastCustomizationUpdate, removeLocalPlayerId]);

  // Broadcast a message to all connected phone controllers (not screen peers).
  const broadcastToControllers = useCallback((message: any) => {
    const manager = managerRef.current;
    if (!manager) return;
    const json = JSON.stringify(message);
    manager.broadcast('data', json, 'phone');
  }, []);

  /** Resolve a map dropdown id (builtin / local / workshop) to LevelData. */
  const loadMapById = useCallback(async (mapId: string): Promise<LevelData> => {
    return loadLevelById(mapId);
  }, []);

  /** Populate the Map dropdown options: every built-in + every local + every
   * subscribed Workshop map. */
  const refreshMapOptions = useCallback(async () => {
    try {
      const merged = await listAllLevels();
      const options: MapOption[] = merged.map(m => ({
        id: m.id,
        name: m.name,
        source: m.source,
        levelTypes: m.levelTypes,
      }));
      if (options.length > 0) setMapOptions(options);
    } catch (err) {
      console.warn('Failed to refresh map options:', err);
    }
  }, []);

  // ─── Core game lifecycle ──────────────────────────────────────────────────
  // Use refs to break circular dependency between createPlaygroundGame <-> startGameWithLevel
  const createPlaygroundGameRef = useRef<(sid: string) => Promise<void>>();
  const startGameWithLevelRef = useRef<(sid: string, levelData: LevelData, overrideMode?: LevelType) => void>();

  /** Helper to spawn players into a freshly-created game */
  const spawnExistingPlayers = useCallback((game: BouncyBlobsGame, context: GameContext) => {
    for (const player of connectedPlayersRef.current) {
      const custom = playerCustomRef.current.get(player.player_id);
      const enriched = custom
        ? { ...player, color: custom.color, faceId: custom.faceId }
        : player;
      game.onPlayerJoin(context, enriched);
    }
    game.setStateChangeCallback(() => {
      setConnectedPlayers(prev => [...prev]);
    });
    // Fresh game instance — replay our local-player set so the camera
    // follows the same blobs it did before the rebuild.
    pushLocalPlayerIds();
  }, [pushLocalPlayerIds]);

  const makeContext = useCallback((sid: string): GameContext => ({
    connection: null,
    sessionId: sid,
    players: connectedPlayersRef.current,
    gameState: {},
    playerStates: new Map(),
    inputManager: inputManagerRef.current,
    api: { updateControllerLayout: () => {} },
  }), []);

  /** Create the lobby playground. Loads the default arena and runs FreeplayMode
   * so players can move around with no goal/scoring while the host configures
   * the next match in the React panel. */
  const createPlaygroundGame = useCallback(async (sid: string) => {
    let arena: LevelData;
    try {
      arena = await loadBuiltinLevel('default');
    } catch (err) {
      console.error('Failed to load default arena:', err);
      setErrorMsg('Failed to load playground arena');
      setPhase('error');
      return;
    }

    gameRef.current?.destroy();
    gameRef.current = null;

    const game = new BouncyBlobsGame();
    gameRef.current = game;
    game.setRngSeed(sessionSeedRef.current);
    installHostBroadcastHook(game);

    const mode = new FreeplayMode(arena);
    game.setGameMode(mode);
    // FreeplayMode never sets a winner, so the phase callback only fires on
    // explicit startRound() in startGameWithLevel — no special handling needed.

    const context = makeContext(sid);
    contextRef.current = context;
    game.initialize(context);
    spawnExistingPlayers(game, context);

    const levelId = `playground-${Date.now()}`;
    currentLevelRef.current = { levelId, levelData: arena, levelType: 'solo_racing' };
    // freeplay:true tells guests this is the pre-round playground — they
    // should use FreeplayMode (no countdown, no round timer) just like the host.
    managerRef.current?.broadcast('state', JSON.stringify({
      type: 'level_loaded',
      levelId,
      levelData: arena,
      levelType: 'solo_racing',
      freeplay: true,
      rngSeed: sessionSeedRef.current,
    }), 'screen');

    setPhase('lobby');
    setCanvasKey((k) => k + 1);
    setTimeout(() => { game.startRound(); }, 100);
  }, [makeContext, spawnExistingPlayers]);

  /** Start a game with a specific level (after voting resolves). */
  const startGameWithLevel = useCallback((sid: string, levelData: LevelData, overrideMode?: LevelType) => {
    // Tear down the previous game (playground or otherwise). Without this,
    // its GameLoop keeps ticking and its installed postTickHook keeps
    // broadcasting aggregated inputs at the OLD tick numbers, polluting
    // every guest's inputBuffer with a parallel stream that crowds out
    // the new game's per-tick broadcasts.
    gameRef.current?.destroy();
    gameRef.current = null;

    const game = new BouncyBlobsGame();
    gameRef.current = game;
    game.setRngSeed(sessionSeedRef.current);
    installHostBroadcastHook(game);

    const mode = createModeForLevel(levelData, broadcastToControllers, overrideMode);
    game.setGameMode(mode);

    // Remember the level for late-joining guests + broadcast it now so any
    // already-connected guest rebuilds its local sim with the new data.
    const resolvedType: LevelType = (overrideMode ?? mode.config.id ?? 'solo_racing') as LevelType;
    const levelId = `level-${Date.now()}`;
    currentLevelRef.current = { levelId, levelData, levelType: resolvedType };
    managerRef.current?.broadcast('state', JSON.stringify({
      type: 'level_loaded',
      levelId,
      levelData,
      levelType: resolvedType,
      rngSeed: sessionSeedRef.current,
    }), 'screen');
    game.setBroadcastToControllers(broadcastToControllers);
    partyModeRef.current = mode instanceof PartyMode ? mode : null;

    game.setPhaseChangeCallback((gp) => {
      setGamePhase(gp);
      if (gp === 'results') {
        setTimeout(() => {
          gameRef.current?.destroy();
          gameRef.current = null;
          partyModeRef.current = null;
          setGamePhase(null);
          createPlaygroundGameRef.current?.(sid);
        }, (mode.config.resultsDuration + 0.5) * 1000);
      }
    });

    game.setGameOverCallback((winnerId, winnerName) => {
      console.log(`Game over! Winner: ${winnerName} (${winnerId})`);
    });

    const context = makeContext(sid);
    contextRef.current = context;
    game.initialize(context);
    spawnExistingPlayers(game, context);

    setPhase('playing');
    setCanvasKey(k => k + 1);

    setTimeout(() => { game.startRound(); }, 100);
  }, [broadcastToControllers, makeContext, spawnExistingPlayers]);

  // Keep refs in sync
  createPlaygroundGameRef.current = createPlaygroundGame;
  startGameWithLevelRef.current = startGameWithLevel;

  /**
   * End the current game immediately and return the lobby to the
   * playground state. Triggered by the host's "End Game" button.
   *
   * Mirrors the cleanup the normal `setPhaseChangeCallback('results')`
   * path does after results-screen duration elapses, just without
   * waiting. Broadcasts a fresh `level_loaded` with `freeplay: true`
   * to every connected guest — they tear down their current game,
   * load the playground arena, and rejoin the lobby UI. Bots are
   * preserved through `spawnExistingPlayers` inside the new playground
   * game.
   */
  const endGame = useCallback(() => {
    if (!sessionId) return;
    gameRef.current?.destroy();
    gameRef.current = null;
    partyModeRef.current = null;
    setGamePhase(null);
    createPlaygroundGameRef.current?.(sessionId);
  }, [sessionId]);

  // ─── Session setup ────────────────────────────────────────────────────────

  // Create session on mount, then immediately launch voting
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const inputManager = inputManagerRef.current;

        // Offline mode: skip the hexii backend entirely. Used by Playwright
        // tests + AI-only sessions where there are no phone controllers. We
        // skip voting and drop straight into the default arena so the AI bots
        // can run their physics in a stable environment.
        if (searchParams.get('offline') === '1') {
          const fakeSid = 'offline-' + Math.random().toString(36).slice(2, 10);
          setSessionId(fakeSid);
          setJoinCode('OFFLINE');
          inputManager.addEventListener((event, playerId) => {
            if (gameRef.current && contextRef.current) {
              gameRef.current.onPlayerInput(contextRef.current, playerId, event);
            }
          });
          try {
            // ?level=koth|classic|chained|party|blob-hill|default
            // ?mode=koth|solo_racing|team_racing|party (overrides the level's default mode)
            const levelId = (searchParams.get('level') ?? 'default').trim();
            const modeOverride = (searchParams.get('mode') ?? '').trim() as LevelType | '';
            const level = await loadBuiltinLevel(levelId);
            startGameWithLevel(fakeSid, level, modeOverride || undefined);
          } catch (err) {
            console.error('Offline init failed:', err);
            setErrorMsg(String((err as Error).message ?? err));
            setPhase('error');
          }
          return;
        }

        // Track which screen peer owns each guest-player blob, so we can
        // clean up on screen disconnect. Mirrors the old guestPlayersRef
        // semantics but keyed off room peer ids instead of mp_lobby_screen ids.
        const handleScreenMessage = (peerId: string, channel: string, raw: string | ArrayBuffer) => {
          const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
          if (channel === 'state') {
            try {
              const evt = JSON.parse(text);
              const game = gameRef.current;
              const ctx = contextRef.current;
              if (!game || !ctx) return;
              if (evt.type === 'player_join' && typeof evt.playerId === 'string') {
                const info = {
                  screenId: peerId,
                  name: typeof evt.name === 'string' ? evt.name : 'Guest',
                  color: typeof evt.color === 'string' ? evt.color : '#5dd6ff',
                  faceId: typeof evt.faceId === 'string' ? evt.faceId : 'default',
                };
                game.onPlayerJoin(ctx, {
                  player_id: evt.playerId,
                  session_id: '',
                  name: info.name,
                  slot: 0,
                  status: 'connected',
                  controller_config: null,
                  joined_at: new Date().toISOString(),
                  color: info.color,
                  faceId: info.faceId,
                } as Player);
                guestPlayersRef.current.set(evt.playerId, info);
              } else if (evt.type === 'player_leave' && typeof evt.playerId === 'string') {
                game.onPlayerDisconnect(ctx, evt.playerId);
                guestPlayersRef.current.delete(evt.playerId);
              } else if (evt.type === 'customization' && typeof evt.playerId === 'string') {
                // Guest pushed a color/face change for one of their players.
                // Apply it to the live blob and update our tracking so the
                // roster broadcast and taken-set computations stay correct.
                const existing = guestPlayersRef.current.get(evt.playerId);
                if (existing) {
                  if (typeof evt.color === 'string') existing.color = evt.color;
                  if (typeof evt.faceId === 'string') existing.faceId = evt.faceId;
                  guestPlayersRef.current.set(evt.playerId, existing);
                }
                game.onPlayerCustomizationUpdate(ctx, evt.playerId, evt.color, evt.faceId);
              }
            } catch (err) {
              console.warn('[room] bad reliable event from screen:', err);
            }
          } else if (channel === 'input') {
            try {
              const batch = JSON.parse(text);
              if (batch?.type !== 'input' || !Array.isArray(batch.frames)) return;
              const im = inputManagerRef.current;
              const ts = Date.now();
              for (const f of batch.frames) {
                if (typeof f?.playerId !== 'string') continue;
                im.processInput(f.playerId, 'joystick_left',
                  { x: Number(f.moveX) || 0, y: Number(f.moveY) || 0 }, ts);
                im.processInput(f.playerId, 'button_right',
                  { pressed: !!f.expanding }, ts);
              }
            } catch (err) {
              console.warn('[room] bad input batch from screen:', err);
            }
          }
        };

        // Single PeerCallbacks for all peers in the room. Dispatch on kind:
        // 'phone' peers go through the existing controller path; 'screen'
        // peers go through the snapshot/event path.
        const callbacks: PeerCallbacks = {
          onPeerConnected: (peerId, kind) => {
            if (kind === 'phone') {
              setTimeout(() => sendCustomizationTo(peerId), 100);
            } else if (kind === 'screen') {
              // New screen peer — force the next binary snapshot to be a
              // full keyframe so they can sync without waiting for the
              // periodic keyframe interval.
              forceKeyframeRef.current = true;
              // Late joiner — push current level so its local sim catches up.
              const lvl = currentLevelRef.current;
              if (lvl) {
                managerRef.current?.send(peerId, 'state', JSON.stringify({
                  type: 'level_loaded',
                  levelId: lvl.levelId,
                  levelData: lvl.levelData,
                  levelType: lvl.levelType,
                  // While the host is still in the lobby phase the running
                  // sim is FreeplayMode — tell the late joiner so they
                  // don't run a competitive countdown over the playground.
                  freeplay: phaseRef.current !== 'playing',
                  rngSeed: sessionSeedRef.current,
                }));
              }
              // Followed by the lobby_state snapshot so they can render their
              // GuestLobbyPanel immediately. May be null on the first peer
              // connecting before the state-tracking effect has run; the
              // effect's first run will catch them up.
              if (lobbyStateRef.current) {
                managerRef.current?.send(peerId, 'state', JSON.stringify(lobbyStateRef.current));
              }

              // Late-joiner replay bundle:
              //   1. rng_state — align the guest's PRNG to ours so any
              //      subsequent draw (AI decisions etc) matches.
              //   2. Latest cached keyframe — guest snaps positions and
              //      sets world.tick to the keyframe's tick.
              //   3. Aggregated inputs covering every tick since the
              //      keyframe — guest catches up by stepping the sim
              //      forward through each tick.
              const game = gameRef.current;
              const world = game?.getWorld();
              if (world) {
                const rngEvt: ReliableEvent = {
                  type: 'rng_state',
                  tick: world.tick,
                  state: world.rng.getState(),
                };
                managerRef.current?.send(peerId, 'state', JSON.stringify(rngEvt));
              }
              if (latestKeyframeRef.current) {
                managerRef.current?.send(peerId, 'state', latestKeyframeRef.current.buf);
              }
              // Replay the most-recent manager-state alongside the keyframe.
              // Order matters: keyframe snaps positions, then manager_state
              // restores cooldowns/timers, then buffered inputs replay
              // forward. Without this, late joiners start every spring pad
              // in `loaded` and snap visibly on first interaction.
              if (latestManagerStateRef.current) {
                managerRef.current?.send(peerId, 'state', latestManagerStateRef.current.json);
              }
              if (inputHistoryRef.current.length > 0) {
                const bundle = encodeAggregatedInputs({ ticks: inputHistoryRef.current });
                managerRef.current?.send(peerId, 'state', bundle);
              }
            }
          },
          onPeerDisconnected: (peerId) => {
            // Phone path: remove its blob and broadcast updated taken list.
            handlePlayerDisconnect(peerId);
            // Screen path: remove every guest blob owned by that screen.
            const game = gameRef.current;
            const ctx = contextRef.current;
            for (const [pid, info] of guestPlayersRef.current.entries()) {
              if (info.screenId !== peerId) continue;
              if (game && ctx) game.onPlayerDisconnect(ctx, pid);
              guestPlayersRef.current.delete(pid);
            }
          },
          onMessage: (peerId, channel, data) => {
            // Screen peers use named channels ('state', 'input'); route to the
            // screen handler. Phone peers use the primary channel ('data');
            // route to the controller handler.
            if (channel === 'state' || channel === 'input') {
              handleScreenMessage(peerId, channel, data);
              return;
            }
            try {
              const message: WebRTCMessage = JSON.parse(data as string);
              if (message.type === 'player_join' && message.player) {
                handlePlayerJoin(message.player, peerId);
                return;
              }
              if (message.type === 'customization_update' && message.value) {
                const { color, faceId } = message.value;
                const existing = playerCustomRef.current.get(peerId) ?? {};
                if (color) existing.color = color;
                if (faceId) existing.faceId = faceId;
                playerCustomRef.current.set(peerId, existing);
                if (gameRef.current && contextRef.current) {
                  gameRef.current.onPlayerCustomizationUpdate(contextRef.current, peerId, color, faceId);
                }
                broadcastCustomizationUpdate();
                return;
              }
              if (message.type === 'item_select' || message.type === 'cursor_move' || message.type === 'placement_confirm') {
                handlePartyMessage(peerId, message);
                return;
              }
              inputManager.handleWebRTCMessage(message, peerId);
            } catch (e) {
              console.error('Failed to parse WebRTC message:', e);
            }
          },
          onError: (err) => {
            console.error('WebRTC error:', err);
          },
        };

        const { result, manager, room } = await createHostRoom(
          roomConfig,
          {
            game_id: GAME_ID,
            display_name: 'Bouncy Lobby',
            host_kind: 'screen',
            // Use the current `maxPlayers` (defaults to 8) instead of a
            // hardcoded 4. Live slider changes hit the server via
            // changeMaxPlayers → setMaxPeers; this just keeps the initial
            // room creation in sync with the UI default.
            max_peers: maxPlayers,
            visibility: 'private',
          },
          callbacks,
        );

        if (cancelled) {
          manager.dispose();
          return;
        }

        managerRef.current = manager;
        roomRef.current = room;

        const sid = result.room_id;
        setSessionId(sid);
        setJoinCode(result.join_code);
        setRoomReady(true);
        setIsPublic(false);

        // Opportunistically stand up a Steam Lobby + Networking listener so
        // PC friends can be invited via the Steam overlay. Failures here are
        // non-fatal — the WebRTC room-code path keeps working regardless.
        try {
          if (await isSteamAvailable()) {
            await steamNetStartListening();
            const { lobbyId } = await createLobby(maxPlayers, 'friends');
            const selfSteamId = await getSelfSteamId();
            steamLobbyIdRef.current = lobbyId;
            const unlisten = await onMemberChanged((_lobbyId, userChanged, state) => {
              const mgr = managerRef.current;
              if (!mgr) return;
              if (userChanged === selfSteamId) return; // skip self
              if (state === 'entered') {
                // Pre-register the incoming SteamTransport. The actual P2P
                // connection lands via the steam_net://connected event and
                // gets bound to the SteamID we just registered.
                SteamTransport.accept(userChanged, mgr.callbacksFor(userChanged))
                  .then((t) => mgr.attachTransport(t))
                  .catch((err) => console.warn('[steam] accept failed:', err));
              } else if (state === 'left' || state === 'disconnected' || state === 'kicked') {
                mgr.disposePeer(userChanged);
              }
            });
            steamMemberUnlistenRef.current = unlisten;
            if (!cancelled) setSteamLobbyReady(true);
          }
        } catch (err) {
          console.warn('[steam] lobby/networking setup failed (non-fatal):', err);
        }

        // In dev, use the LAN IP so phones on the same network can connect
        let origin = window.location.origin;
        if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
          const port = window.location.port || '5173';
          origin = `http://${LOCAL_LAN_IP}:${port}`;
        }
        setJoinUrl(`${origin}/controller/${sid}`);

        // Setup input listener to forward to game
        inputManager.addEventListener((event, playerId) => {
          if (gameRef.current && contextRef.current) {
            gameRef.current.onPlayerInput(contextRef.current, playerId, event);
          }
        });

        // Check for test level from editor
        const testLevelJson = searchParams.get('testLevel')
          ? sessionStorage.getItem('testLevel')
          : null;
        if (testLevelJson) {
          try {
            const levelData = JSON.parse(testLevelJson) as LevelData;
            startGameWithLevel(sid, levelData);
            return;
          } catch { /* fall through to voting */ }
        }

        // Go directly to voting — no lobby
        await createPlaygroundGame(sid);
        // Populate the Map dropdown in the background.
        void refreshMapOptions();
      } catch (err: any) {
        if (!cancelled) {
          setErrorMsg(err.message || 'Failed to create session');
          setPhase('error');
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      managerRef.current?.dispose();
      // End the room on unmount — same semantics as the old dual endSession +
      // endLobby. Fire-and-forget; the cleanup cron will sweep stragglers.
      void roomRef.current?.endRoom().catch(() => {});
      // Tear down Steam Lobby + Networking if we stood them up.
      steamMemberUnlistenRef.current?.();
      steamMemberUnlistenRef.current = null;
      if (steamLobbyIdRef.current) {
        void leaveLobby().catch(() => {});
        steamLobbyIdRef.current = null;
      }
      void steamNetCloseAll().catch(() => {});
      managerRef.current = null;
      roomRef.current = null;
      inputManagerRef.current.clear();
    };
  }, []);

  // Broadcast binary world-snapshot frames to remote screens at 20 Hz when an
  // online match is active. Wire format defined in src/lib/wireProtocol.ts:
  // root + activeMask + quantized hull-node offsets per entity. Per-peer
  // delta compression and the settled/sleep flag are wired in S2.3 / S2.5;
  // for now every frame is a full keyframe (activeMask=0xFFFF).
  useEffect(() => {
    if (!roomReady) return;
    let tick = 0;

    // Keyframe every 60 ticks (~3 seconds at 20 Hz). Receivers recover from
    // missed deltas at each keyframe even without an ACK channel.
    const KEYFRAME_INTERVAL = 60;
    // Per-node delta threshold in px. Anything smaller is ignored in delta
    // frames (the receiver keeps its last value). MAX_OFFSET/32767 ≈ 0.006 px
    // is the encoder's quantum, so 0.5 px ≈ 80 quanta — comfortably above
    // floating-point noise.
    const DELTA_THRESHOLD = 0.5;
    // Number of consecutive ticks with no offset changes AND no root change
    // before we flag an entity as `settled`. Receivers can then skip
    // per-tick reconciliation work for it until it moves again.
    const SETTLED_FRAMES = 20;
    // Root-position change considered noise. The settled detector ignores
    // shifts below this magnitude.
    const ROOT_REST_THRESHOLD = 0.5;

    /** Build a per-entity record from a set of particle indices. The first
     * index is the "root" (centroid reference); remaining indices are
     * encoded as offsets relative to the root. On non-keyframe ticks we
     * clear bits for nodes whose offset hasn't moved more than
     * DELTA_THRESHOLD since the last sent record for this entity. Returns a
     * `settled` flag computed from the still-tick counter so receivers can
     * skip reconciliation for resting entities. */
    const buildRecord = (
      world: { pos: readonly { x: number; y: number }[]; vel: readonly { x: number; y: number }[] } | null,
      id: string,
      indices: number[],
      isKeyframe: boolean,
    ): {
      rootX: number; rootY: number;
      rootVx: number; rootVy: number;
      activeMask: number;
      offsets: EntityOffset[];
      settled: boolean;
    } | null => {
      if (!world || indices.length === 0) return null;
      const rootIdx = indices[0];
      const root = world.pos[rootIdx];
      const rootVel = world.vel[rootIdx];
      if (!root || !rootVel) return null;
      const offsetIndices = indices.slice(1, 17); // up to 16 hull nodes
      const last = lastSentRef.current.get(id);
      const newOffsets = new Float32Array(16 * 2);
      const offsets: EntityOffset[] = [];
      let mask = 0;
      let anyOffsetMoved = false;
      for (let i = 0; i < offsetIndices.length; i++) {
        const p = world.pos[offsetIndices[i]];
        const v = world.vel[offsetIndices[i]];
        if (!p || !v) continue;
        const ox = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, p.x - root.x));
        const oy = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, p.y - root.y));
        newOffsets[i * 2] = ox;
        newOffsets[i * 2 + 1] = oy;

        let moved = false;
        if (last) {
          const dx = ox - last.offsets[i * 2];
          const dy = oy - last.offsets[i * 2 + 1];
          if (Math.abs(dx) > DELTA_THRESHOLD || Math.abs(dy) > DELTA_THRESHOLD) moved = true;
        }
        anyOffsetMoved = anyOffsetMoved || moved;
        if (isKeyframe || !last || moved) {
          offsets.push({ idx: i, ox, oy, vx: v.x, vy: v.y });
          mask |= 1 << i;
        }
      }

      const rootMoved = last
        ? (Math.abs(root.x - last.rootX) > ROOT_REST_THRESHOLD
            || Math.abs(root.y - last.rootY) > ROOT_REST_THRESHOLD)
        : true;
      const movedThisTick = rootMoved || anyOffsetMoved;
      const stillTicks = movedThisTick ? 0 : ((last?.stillTicks ?? 0) + 1);
      const settled = stillTicks >= SETTLED_FRAMES;

      lastSentRef.current.set(id, {
        rootX: root.x, rootY: root.y,
        offsets: newOffsets,
        stillTicks,
      });
      return {
        rootX: root.x, rootY: root.y,
        rootVx: rootVel.x, rootVy: rootVel.y,
        activeMask: mask, offsets, settled,
      };
    };

    /** World-object record builder — emits all particle positions as
     * absolute coords. No quantization, no 16-node cap. Used for NPC blobs,
     * soft platforms, and point shapes. Computes a centroid (used as the
     * rootX/rootY in the wire record for camera/proximity, not for
     * reconstruction). Returns null on missing indices. */
    const buildWorldRecord = (
      world: { pos: readonly { x: number; y: number }[]; vel: readonly { x: number; y: number }[] } | null,
      id: string,
      indices: number[],
    ): { rootX: number; rootY: number; nodes: { x: number; y: number; vx: number; vy: number }[]; settled: boolean } | null => {
      if (!world || indices.length === 0) return null;
      const positions = new Float32Array(indices.length * 2);
      const nodes: { x: number; y: number; vx: number; vy: number }[] = new Array(indices.length);
      let cx = 0, cy = 0;
      for (let i = 0; i < indices.length; i++) {
        const p = world.pos[indices[i]];
        const v = world.vel[indices[i]];
        if (!p || !v) return null;
        positions[i * 2] = p.x;
        positions[i * 2 + 1] = p.y;
        nodes[i] = { x: p.x, y: p.y, vx: v.x, vy: v.y };
        cx += p.x;
        cy += p.y;
      }
      cx /= indices.length;
      cy /= indices.length;

      // Settled detection: a particle moved by more than ROOT_REST_THRESHOLD
      // anywhere in the entity counts as movement. Stays-still long enough →
      // flag as settled and the guest can skip reconciliation for this tick.
      const last = lastSentWorldRef.current.get(id);
      let movedThisTick = !last;
      if (last && last.positions.length === positions.length) {
        for (let i = 0; i < positions.length; i++) {
          if (Math.abs(positions[i] - last.positions[i]) > ROOT_REST_THRESHOLD) {
            movedThisTick = true;
            break;
          }
        }
      } else if (last) {
        // Length mismatch (e.g. level reload) — treat as moved.
        movedThisTick = true;
      }
      const stillTicks = movedThisTick ? 0 : (last!.stillTicks + 1);
      const settled = stillTicks >= SETTLED_FRAMES;

      lastSentWorldRef.current.set(id, { cx, cy, positions, stillTicks });
      return { rootX: cx, rootY: cy, nodes, settled };
    };

    const interval = setInterval(() => {
      const manager = managerRef.current;
      const game = gameRef.current;
      if (!manager || !game) return;
      const pm = game.getPlayerManager();
      if (!pm) return;
      const world = game.getWorld();
      if (!world) return;
      const modeMgr = (game as any).state?.modeManager;
      const modeState = modeMgr?.getState?.() ?? null;
      const scores: Record<string, number> = {};
      if (modeState?.scores instanceof Map) {
        for (const [k, v] of modeState.scores) scores[k] = v as number;
      }

      // Determine keyframe vs delta for this tick.
      const isKeyframe = forceKeyframeRef.current || ticksSinceKeyframeRef.current >= KEYFRAME_INTERVAL;
      forceKeyframeRef.current = false;
      ticksSinceKeyframeRef.current = isKeyframe ? 0 : ticksSinceKeyframeRef.current + 1;

      const players: PlayerRecord[] = [];
      for (const p of pm.getAllPlayers()) {
        // Players: center is the root, hull nodes are the offsets.
        const indices = [p.blob.centerIdx, ...p.blob.hullIndices];
        const rec = buildRecord(world, p.playerId, indices, isKeyframe);
        if (!rec) continue;
        players.push({
          id: p.playerId,
          rootX: rec.rootX,
          rootY: rec.rootY,
          rootVx: rec.rootVx,
          rootVy: rec.rootVy,
          activeMask: rec.activeMask,
          offsets: rec.offsets,
          // Same rationale as the per-tick broadcast: read input values
          // from the blob (which captured them via setInput at the start
          // of the tick that built this keyframe's positions) rather
          // than from the ManagedPlayer (which may have been overwritten
          // by an async input event arriving AFTER the tick ran).
          // Keeps the keyframe's input fields consistent with its
          // position fields — both reflect the same logical tick.
          moveX: p.blob.getStickX(),
          moveY: p.blob.getStickY(),
          expandScale: p.blob.getExpandScale(),
          expanding: p.blob.isExpanding(),
          settled: false,
          score: scores[p.playerId] ?? 0,
        });
      }

      const worldRecords: WorldRecord[] = [];
      // World records use absolute positions for every particle — root+offset
      // can't handle a 560-px-wide platform with 18 hull nodes (the spec's
      // u16/16-node-mask/±MAX_OFFSET budget is sized for ~50 px player blobs).
      // Settled entities are still included so the receiver knows their
      // current positions on the first keyframe after they wake; we just
      // skip them in the host-side delta accounting via the settled flag.
      const npcBlobs = game.getNpcBlobs();
      for (let i = 0; i < npcBlobs.length; i++) {
        const b = npcBlobs[i];
        const id = `npc-${i}`;
        const rec = buildWorldRecord(world, id, [b.centerIdx, ...b.hullIndices]);
        if (!rec) continue;
        if (rec.settled && !isKeyframe) continue; // skip steady-state on deltas
        worldRecords.push({
          kind: ENTITY_KIND_NPC,
          id,
          rootX: rec.rootX,
          rootY: rec.rootY,
          settled: rec.settled,
          nodes: rec.nodes,
        });
      }
      for (const sp of game.getSoftPlatforms()) {
        const rec = buildWorldRecord(world, `plat:${sp.id}`, sp.hullIndices);
        if (!rec) continue;
        if (rec.settled && !isKeyframe) continue;
        worldRecords.push({
          kind: ENTITY_KIND_PLATFORM,
          id: sp.id,
          rootX: rec.rootX,
          rootY: rec.rootY,
          settled: rec.settled,
          nodes: rec.nodes,
        });
      }
      for (const [id, indices] of game.getPointShapeParticles()) {
        const rec = buildWorldRecord(world, `ps:${id}`, indices);
        if (!rec) continue;
        if (rec.settled && !isKeyframe) continue;
        worldRecords.push({
          kind: ENTITY_KIND_POINT_SHAPE,
          id,
          rootX: rec.rootX,
          rootY: rec.rootY,
          settled: rec.settled,
          nodes: rec.nodes,
        });
      }

      // Tag the keyframe with the world's actual tick, NOT a separate
      // counter. The guest uses this to align `world.tick` so subsequent
      // live aggregated-input broadcasts (which also tag with world.tick)
      // map correctly into the lockstep input buffer. The old counter
      // approach made guest.world.tick advance 1 per second instead of
      // jumping to the host's real tick number, so the gate never found
      // matching ticks and the sim froze.
      tick++; // unused now, kept to avoid touching outer-scope deps
      const keyframeTick = world.tick;
      const buf = encodeSnapshot({
        version: 1,
        isKeyframe,
        tick: keyframeTick,
        players,
        world: worldRecords,
      });
      // Cache for late-joiner replay — peers that connect after this tick
      // need this keyframe + the input history that follows it. Reset the
      // input history every time we cache a new keyframe; replay only
      // needs to cover from the keyframe forward.
      latestKeyframeRef.current = { tick: keyframeTick, buf };
      inputHistoryRef.current = [];
      // Broadcast to screen peers. Phones don't need physics state.
      manager.broadcast('state', buf, 'screen');
      // Re-align every guest's PRNG to ours alongside the keyframe. Host
      // and guest PRNG streams drift over time if either consumes a value
      // the other didn't (an AI decision firing one tick earlier, etc.).
      // 1 Hz re-align bounds that drift to ≤ 1 s of decisions. Cheap.
      const rngEvt: ReliableEvent = {
        type: 'rng_state',
        tick: world.tick,
        state: world.rng.getState(),
      };
      manager.broadcast('state', JSON.stringify(rngEvt), 'screen');

      // Sync stateful-manager state alongside the keyframe. The keyframe
      // already covers particle positions/velocities and the world's RNG,
      // but managers like SpringPadManager carry their own mutable state
      // (cooldowns, state-machine slot, plate offset) that lockstep alone
      // can't reproduce because the host has typically been running for
      // longer than the guest. Without this, a player hitting a spring
      // pad on the host bounces; on the guest the pad's local cooldown
      // says "reloading" and the player just lands. The two sims then
      // diverge until the next keyframe yanks positions back, producing
      // the visible "snap" the user is reporting.
      const gameRef2 = gameRef.current;
      if (gameRef2) {
        // Per-blob ground-contact tally per player. This is populated
        // inside `world.step`'s collision pass and read by the NEXT tick's
        // `SlimeBlob.update` (for the `grounded` air-move multiplier). A
        // freshly-keyframed guest reads a stale (or zero) value for one
        // tick, applies the wrong force, and drifts by a small fraction
        // of a pixel — which the next keyframe yanks back as a snap.
        // Determinism test (`determinism.test.ts:replicateState` step 4)
        // proved this is the missing field needed for bit-identical
        // late-joiner replication.
        const blobGroundContacts: Record<string, number> = {};
        const pm2 = gameRef2.getPlayerManager();
        if (pm2) {
          for (const p of pm2.getAllPlayers()) {
            blobGroundContacts[p.playerId] = world.getBlobGroundContacts(p.blob.blobId);
          }
        }
        const managerStateEvt = {
          type: 'manager_state',
          tick: world.tick,
          state: {
            springPads: gameRef2.getSpringPadManager()?.dumpState() ?? null,
            blobGroundContacts,
          },
        };
        const managerStateJson = JSON.stringify(managerStateEvt);
        manager.broadcast('state', managerStateJson, 'screen');
        latestManagerStateRef.current = { tick: world.tick, json: managerStateJson };
      }
    }, 250); // 4 Hz keyframe — the local sim runs deterministically on each
             // client, so the keyframe is mostly a drift-recovery safety
             // net; but in practice tiny per-tick float-math noise OR
             // any-state-we-haven't-found-yet accumulates over enough
             // ticks to become visible as a snap. 1 Hz left ~60 ticks of
             // accumulation. 4 Hz bounds it to ~15 ticks, making any
             // residual snap small enough to read as smooth correction
             // rather than teleport. Bandwidth at 4 Hz is still tiny
             // (~5 KB × 4 = 20 KB/s outbound + 4 KB/s input echo).
    return () => clearInterval(interval);
  }, [roomReady]);

  // 30 Hz aggregated-input broadcast — host → all screen peers. Each tick
  // we sample every player's current input state (host's keyboard, each
  // guest's last-received input, AI controllers' decisions) and broadcast
  // them as the canonical input set for the current sim tick. Guests apply
  // these to drive their own local sim's remote players, keeping every
  // client in deterministic lockstep with the host.
  // Helper: install the host's per-tick broadcast hook on a freshly
  // created BouncyBlobsGame. Fires AFTER each logic tick with the world's
  // current tick. Broadcasts the inputs that were applied this tick so
  // every connected guest can apply them at exactly the matching tick on
  // its side — true input-paced lockstep instead of "apply at current
  // wall-clock time," which was the source of the visible desync.
  //
  // Bandwidth: 4 players × ~16 bytes × 60 Hz ≈ 4 KB/s. Tiny.
  const installHostBroadcastHook = useCallback((game: BouncyBlobsGame) => {
    game.setPostTickHook((world) => {
      const manager = managerRef.current;
      const pm = game.getPlayerManager();
      if (!manager || !pm) return;
      // CRITICAL: read the input values the BLOB used this tick, not the
      // ManagedPlayer's current values. `ManagedPlayer.moveX/Y/expanding`
      // can be overwritten by an async input event arriving via
      // `BouncyBlobsGame.onPlayerInput` BETWEEN `updateAll` (which read
      // them into `blob.setInput`) and `postTickHook` (which fires after
      // `world.step`). The blob's `stickX/Y/expandPressed` fields are
      // captured by `setInput` at the start of the tick and are
      // immutable for the rest of the tick — so they always reflect what
      // physics actually computed with. Broadcasting `ManagedPlayer.*`
      // would tell the guest to apply the NEW value at this tick, but
      // the host's physics for this tick used the OLD value — guest
      // diverges by one tick of input every async event. With WebRTC
      // input batches arriving at 30 Hz and physics ticking at 60 Hz,
      // this happens constantly during any input change.
      const inputs = pm.getAllPlayers().map((p) => ({
        playerId: p.playerId,
        moveX: p.blob.getStickX(),
        moveY: p.blob.getStickY(),
        expanding: p.blob.isExpanding(),
      }));
      const buf = encodeAggregatedInputs({
        ticks: [{ tick: world.tick, inputs }],
      });
      manager.broadcast('state', buf, 'screen');

      // Append to the late-joiner replay buffer. The keyframe broadcast
      // clears this whenever a new keyframe is cached, so the buffer
      // contents are always "what happened since the latest keyframe."
      inputHistoryRef.current.push({ tick: world.tick, inputs });
      if (inputHistoryRef.current.length > INPUT_HISTORY_MAX) {
        inputHistoryRef.current.shift();
      }
    });
  }, []);

  // lobby_state broadcast loop. Rebuilds the LobbyStateEvent at ~2 Hz so that
  // remote guests render an up-to-date GuestLobbyPanel even when nothing
  // about React-level state has visibly changed (e.g. guest customization
  // round-trips, phone player joins). Also keeps `lobbyStateRef` warm so the
  // onPeerConnected hand-off has something to send.
  useEffect(() => {
    if (!roomReady) return;
    const broadcast = () => {
      const game = gameRef.current;
      if (!game) return;
      const pm = game.getPlayerManager();
      if (!pm) return;

      const botIds = new Set(bots.map((b) => b.playerId));
      const guestIds = new Set(guestPlayersRef.current.keys());
      const players = pm.getAllPlayers().map((p) => {
        let kind: 'host' | 'guest' | 'bot' = 'guest';
        if (p.playerId === LOCAL_PLAYER_ID) kind = 'host';
        else if (botIds.has(p.playerId)) kind = 'bot';
        return {
          id: p.playerId,
          name: p.name,
          color: p.color,
          faceId: p.faceId,
          kind,
        };
      });

      const modeMgr = (game as any).state?.modeManager;
      const ms = modeMgr?.getState?.() ?? null;
      const scores: Record<string, number> = {};
      if (ms?.scores instanceof Map) {
        for (const [k, v] of ms.scores) scores[k] = v as number;
      }

      const evt: LobbyStateEvent = {
        type: 'lobby_state',
        // Use the host's actual session-phase state machine — `currentLevelRef`
        // is also set by createPlaygroundGame during the lobby phase, so it
        // can't disambiguate "lobby with playground arena" from "real round".
        phase: phase === 'playing' ? 'playing' : 'lobby',
        selectedMapId,
        selectedModeId,
        maxPlayers,
        isPublic,
        mapOptions: mapOptions.map((m) => ({ id: m.id, name: m.name })),
        players,
        modeState: ms ? {
          phase: ms.phase ?? 'playing',
          timeRemainingMs: typeof ms.timeRemaining === 'number' ? ms.timeRemaining * 1000 : undefined,
          scores,
          winner: ms.winner ?? null,
        } : undefined,
      };
      lobbyStateRef.current = evt;
      managerRef.current?.broadcast('state', JSON.stringify(evt), 'screen');
    };
    broadcast(); // initial fire so a peer that just connected gets it ASAP
    const interval = setInterval(broadcast, 500);
    return () => clearInterval(interval);
  }, [roomReady, bots, selectedMapId, selectedModeId, maxPlayers, isPublic, mapOptions, phase]);

  // Poll the room for new peers. Connects to each new one (phones get a
  // single ordered channel; screens get the state+input pair). Then derive
  // `connectedPlayers` (phones with an active connection) for downstream UI.
  useEffect(() => {
    if (!roomReady) return;

    const interval = setInterval(async () => {
      try {
        const room = roomRef.current;
        const manager = managerRef.current;
        if (!room || !manager) return;
        const detail = await room.getRoom();
        const remotePeers = detail.peers.filter((p) => !p.is_host);

        // Open WebRTC connections to new peers, regardless of kind.
        for (const peer of remotePeers) {
          if (!knownPlayerIdsRef.current.has(peer.peer_id)) {
            knownPlayerIdsRef.current.add(peer.peer_id);
            await manager.connectTo(peer.peer_id, peer.kind);
          }
        }

        // Derive the "connected phone players" list off active data channels.
        const connectedIds = new Set(manager.getConnectedPeers().map((p) => p.peerId));
        const phonePlayers = remotePeers
          .filter((p) => p.kind === 'phone' && connectedIds.has(p.peer_id))
          .map((p) => peerToPlayer(p, sessionId ?? ''));
        setConnectedPlayers(phonePlayers);
      } catch (err) {
        console.warn('Failed to poll room:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [roomReady, sessionId]);

  // ── Feature: auto-end lobby when only AIs remain ─────────────────────────
  // Counts non-bot players (phones on this screen + local keyboard + guest
  // screens). Bots are local-only and don't count. Polls because guestPlayers
  // is a ref, not state. Debounces one tick so a brief disconnect doesn't kill
  // the lobby. Only fires after at least one human has joined.
  useEffect(() => {
    if (!roomReady) return;
    const interval = setInterval(() => {
      const humanCount =
        connectedPlayers.length +
        (localPlayerJoined ? 1 : 0) +
        guestPlayersRef.current.size;
      if (humanCount > 0) {
        hadHumanRef.current = true;
        return;
      }
      if (!hadHumanRef.current || autoEndingRef.current) return;
      autoEndingRef.current = true;
      console.log('[lobby] no humans remaining — ending room');
      void roomRef.current?.endRoom().catch(() => {});
      navigate('/');
    }, 1500);
    return () => clearInterval(interval);
  }, [roomReady, connectedPlayers, localPlayerJoined, navigate]);

  // ── Feature: lock joins while a round is in progress ─────────────────────
  // joinable=false makes the join endpoint reject new peers server-side.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || !roomReady) return;
    const joinable = phase !== 'playing';
    room.setJoinable(joinable).catch((err) => {
      console.warn('Failed to update joinable state:', err);
    });
  }, [phase, roomReady]);

  // Keep `selectedMapId` in sync with the mode filter: when the mode changes
  // (or the map list refreshes) and the current map is no longer valid for
  // this mode, snap to the first compatible map. Without this the dropdown's
  // visual fallback would diverge from the value Start actually uses.
  useEffect(() => {
    const valid = mapOptions.filter((m) => m.levelTypes.includes(selectedModeId));
    if (valid.length === 0) return;
    if (!valid.some((m) => m.id === selectedMapId)) {
      setSelectedMapId(valid[0].id);
    }
  }, [selectedModeId, mapOptions, selectedMapId]);

  /** Start the selected map+mode from the lobby. */
  const startGame = useCallback(async () => {
    if (!sessionId) return;
    try {
      const levelData = await loadMapById(selectedMapId);
      startGameWithLevelRef.current?.(sessionId, levelData, selectedModeId);
    } catch (err) {
      console.error('Failed to load selected map:', err);
      setErrorMsg(`Failed to load map: ${(err as Error).message}`);
    }
  }, [sessionId, selectedMapId, selectedModeId, loadMapById]);

  /** Build the React-facing player list straight off the live PlayerManager
   * (single source of truth). Tags each row so the panel can render the right
   * affordances (× for bots, no controls for others). */
  const playerSummaries: PlayerSummary[] = (() => {
    const pm = gameRef.current?.getPlayerManager();
    if (!pm) return [];
    const botIds = new Set(bots.map((b) => b.playerId));
    const guestIds = new Set(guestPlayersRef.current.keys());
    return pm.getAllPlayers().map((p) => {
      let kind: PlayerSummary['kind'] = 'phone';
      if (p.playerId === LOCAL_PLAYER_ID) kind = 'local';
      else if (botIds.has(p.playerId)) kind = 'bot';
      else if (guestIds.has(p.playerId)) kind = 'guest';
      return {
        playerId: p.playerId,
        name: p.name,
        color: p.color,
        faceId: p.faceId,
        kind,
      };
    });
  })();

  const playerCount = playerSummaries.length;
  const canAddBot = playerCount < maxPlayers;
  const canStart = playerCount > 0 && !!sessionId;

  // Pick a default local color/face that doesn't collide with anyone already
  // in the lobby — runs once on mount (and again if the picker hasn't been
  // touched while the taken set changes underneath us).
  const localPickerTouchedRef = useRef(false);
  useEffect(() => {
    if (localPickerTouchedRef.current) return;
    const taken = new Set(playerSummaries.filter(p => p.playerId !== LOCAL_PLAYER_ID).map(p => p.color));
    const free = COLOR_PALETTE.find(c => !taken.has(c));
    if (free && free !== localColor) setLocalColor(free);
    const takenFaces = new Set(playerSummaries.filter(p => p.playerId !== LOCAL_PLAYER_ID).map(p => p.faceId));
    const freeFace = getAllFacePresets().find(f => !takenFaces.has(f.id));
    if (freeFace && freeFace.id !== localFaceId) setLocalFaceId(freeFace.id);
  }, [playerSummaries, localColor, localFaceId]);

  // Mark the picker as user-touched the first time the host actually clicks
  // a swatch (the wrapper below) so we stop auto-reconciling.
  const onPickLocalColor = useCallback((c: string) => {
    localPickerTouchedRef.current = true;
    updateLocalCustomization(c, undefined);
  }, [updateLocalCustomization]);
  const onPickLocalFaceId = useCallback((f: string) => {
    localPickerTouchedRef.current = true;
    updateLocalCustomization(undefined, f);
  }, [updateLocalCustomization]);

  const onCanvasInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const game = gameRef.current;
    if (!game) return;
    game.setCanvas(ctx.canvas, ctx, width, height);
    game.start();
    installDebugBridge(game);
  }, []);

  const onCanvasResize = useCallback((width: number, height: number) => {
    gameRef.current?.setCanvasSize(width, height);
  }, []);


  // Room cleanup happens in the init effect's cleanup callback (endRoom()).
  // No separate unmount hook needed — kept blank for symmetry with the old
  // dual-cleanup pattern in case future refactors want a single place to
  // attach mount-lifetime logic.

  // ─── Render ───────────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p data-testid="error-message" style={{ color: '#f66', fontSize: 16 }}>Error: {errorMsg}</p>
        <Link to="/"><button style={{ padding: '8px 16px', fontSize: 14 }}>Home</button></Link>
      </div>
    );
  }

  if (phase === 'creating') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p data-testid="creating-session" style={{ color: '#aaa', fontSize: 16 }}>Creating session...</p>
      </div>
    );
  }

  // Lobby phase — left React panel drives selection; right canvas is the
  // freeplay playground where players can mess around.
  if (phase === 'lobby') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex' }}>
        <LobbyPanel
          joinCode={joinCode}
          players={playerSummaries}
          maxPlayers={maxPlayers}
          onChangeMaxPlayers={changeMaxPlayers}
          mapOptions={mapOptions}
          selectedMapId={selectedMapId}
          onChangeMap={setSelectedMapId}
          selectedModeId={selectedModeId}
          onChangeMode={setSelectedModeId}
          loadLevel={loadMapById}
          onAddBot={addBot}
          onRemoveBot={removeBot}
          canAddBot={canAddBot}
          localPlayerJoined={localPlayerJoined}
          onJoinLocal={joinAsLocalPlayer}
          onLeaveLocal={leaveAsLocalPlayer}
          localColor={localColor}
          onChangeLocalColor={onPickLocalColor}
          localFaceId={localFaceId}
          onChangeLocalFaceId={onPickLocalFaceId}
          isPublic={isPublic}
          visibilityBusy={visibilityBusy}
          onTogglePublic={togglePublic}
          canStart={canStart}
          onStart={startGame}
        />
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />

          {/* Invite Friends on Steam — bottom-right, above QR. Paper+tape
              styling matches the Home menu sticky notes. */}
          {steamLobbyReady && (
            <button
              onClick={() => { void openInviteOverlay().catch(() => {}); }}
              title="Open the Steam friend picker to invite friends"
              style={{
                position: 'absolute',
                bottom: 160,
                right: 16,
                fontSize: 14,
                fontWeight: 800,
                padding: '10px 18px 9px',
                background: '#fffae6',
                color: '#1a0f2e',
                border: '3px solid #0a0612',
                borderRadius: 4,
                cursor: 'pointer',
                fontFamily: 'inherit',
                letterSpacing: 0.4,
                boxShadow: '0 6px 14px rgba(0,0,0,0.35)',
                transform: 'rotate(-2deg)',
              }}
            >
              <span style={{
                position: 'absolute',
                top: -8,
                left: '50%',
                transform: 'translateX(-50%) rotate(-3deg)',
                width: '60%',
                height: 12,
                background: '#5dd6ff',
                border: '1px solid rgba(0,0,0,0.25)',
                opacity: 0.85,
                pointerEvents: 'none',
                boxShadow: '0 2px 3px rgba(0,0,0,0.2)',
              }} />
              Invite Friends
            </button>
          )}

          {/* Join QR — bottom-right, click to copy */}
          {joinUrl && (
            <div
              onClick={() => {
                if (navigator.clipboard?.writeText) {
                  navigator.clipboard.writeText(joinUrl);
                } else {
                  const ta = document.createElement('textarea');
                  ta.value = joinUrl;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                }
              }}
              style={{
                position: 'absolute',
                bottom: 16,
                right: 16,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
              title="Click to copy join link"
            >
              <div style={{ padding: 8, background: '#fff', borderRadius: 10, lineHeight: 0 }}>
                <QRCodeSVG value={joinUrl} size={110} />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Playing phase — no join info, just game + home button + bot controls.
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />
      <div style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'stretch',
        maxWidth: 200,
      }}>
        <Link to="/">
          <button style={{ padding: '6px 12px', fontSize: 13, width: '100%' }}>Home</button>
        </Link>
        <button
          data-testid="end-game-button"
          onClick={endGame}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: '#7a1f2e',
            color: '#fff',
            fontWeight: 600,
          }}
          title="End this round and return everyone to the lobby"
        >
          End Game
        </button>
        <span style={{ color: '#888', fontSize: 13 }}>
          Players: {gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0}
        </span>
        <button
          data-testid="add-bot"
          onClick={() => addBot()}
          disabled={(gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0) >= maxPlayers}
          style={{
            padding: '6px 12px',
            fontSize: 13,
            background: (gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0) >= maxPlayers ? '#333' : '#5a189a',
            opacity: (gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0) >= maxPlayers ? 0.5 : 1,
          }}
          title="Add a scripted AI bot"
        >
          + Add AI Bot
        </button>
        <button
          data-testid="local-player-toggle"
          onClick={localPlayerJoined ? leaveAsLocalPlayer : joinAsLocalPlayer}
          style={{ padding: '6px 12px', fontSize: 13, background: localPlayerJoined ? '#2d6a4f' : '#5dd6ff', color: localPlayerJoined ? '#fff' : '#000' }}
          title={localPlayerJoined ? 'Leave the game (free up the laptop slot)' : 'Join as a local player using WASD + Space'}
        >
          {localPlayerJoined ? '🎮 Leave (You)' : '🎮 Play from laptop'}
        </button>
        {bots.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {bots.map((b) => (
              <span
                key={b.playerId}
                data-testid={`bot-chip-${b.personality}`}
                style={{
                  padding: '4px 8px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.08)',
                  fontSize: 12,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: b.color,
                }} />
                {PERSONALITY_LABELS[b.personality]}
                <button
                  onClick={() => removeBot(b.playerId)}
                  style={{ padding: '0 4px', background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer' }}
                  title="Remove bot"
                >×</button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
