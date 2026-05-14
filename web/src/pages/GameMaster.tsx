import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useUser } from '../contexts/UserContext';
import { createHostRoom, RoomService, PeerManager } from '../lib/party';
import type { RoomPeer, PeerCallbacks } from '../lib/party';
import { roomConfig, GAME_ID } from '../lib/partyConfig';
import { serializeSnapshot, type WorldSnapshot } from '../lib/multiplayerSnapshot';
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
import { GameContext, GameState } from '../game/GameInterface';
import { LevelData, LevelType, getLevelTypes } from '../levels/types';
import { useAuth } from '../contexts/AuthContext';
import { DEFAULT_CONTROLLER_CONFIG } from '../types/controllerConfig';
import { WebRTCMessage } from '../types/webrtc';
import GameCanvas from '../components/GameCanvas';
import type { Player } from '../types/database';
import { GameMode, GamePhase } from '../game/gameModes/types';
import * as contentApi from '../lib/contentApi';

// Game mode registry
import { ClassicMode } from '../game/gameModes/classicMode';
import { ChainedMode } from '../game/gameModes/chainedMode';
import { PartyMode } from '../game/gameModes/partyMode';
import { KingOfTheHillMode } from '../game/gameModes/kingOfTheHillMode';
import { FreeplayMode } from '../game/gameModes/freeplayMode';

import { getAvailableLevels, loadBuiltinLevel } from '../levels/levelRegistry';

/** LAN IP for dev QR codes — set VITE_LOCAL_LAN_IP in .env to your machine's IP */
const LOCAL_LAN_IP = import.meta.env.VITE_LOCAL_LAN_IP ?? '127.0.0.1';

function createModeForLevel(levelData: LevelData, broadcastFn?: (msg: any) => void, overrideMode?: LevelType): GameMode {
  // KOTH levels with hillZones always use KingOfTheHillMode
  if (levelData.hillZones && levelData.hillZones.length > 0) {
    return new KingOfTheHillMode(levelData);
  }
  const mode = overrideMode ?? getLevelTypes(levelData)[0];
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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [joinUrl, setJoinUrl] = useState('');
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
  const [maxPlayers, setMaxPlayers] = useState(4);
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
    }, 150);
    return () => clearTimeout(handle);
  }, [canvasKey, bots, localPlayerJoined, sessionId]);
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
    // Broadcast updated taken list to all controllers
    broadcastCustomizationUpdate();
  }, [broadcastCustomizationUpdate]);

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
    // Broadcast updated taken list to all controllers
    broadcastCustomizationUpdate();
  }, [broadcastCustomizationUpdate]);

  // Broadcast a message to all connected phone controllers (not screen peers).
  const broadcastToControllers = useCallback((message: any) => {
    const manager = managerRef.current;
    if (!manager) return;
    const json = JSON.stringify(message);
    manager.broadcast('data', json, 'phone');
  }, []);

  /** Resolve a map dropdown id ('builtin:x' or 'cloud:<uuid>') to LevelData. */
  const loadMapById = useCallback(async (mapId: string): Promise<LevelData> => {
    if (mapId.startsWith('builtin:')) {
      return loadBuiltinLevel(mapId.slice('builtin:'.length));
    }
    if (mapId.startsWith('cloud:')) {
      return contentApi.loadLevel(mapId.slice('cloud:'.length));
    }
    throw new Error(`Unknown map id: ${mapId}`);
  }, []);

  /** Populate the Map dropdown options on mount: every built-in + every
   * cloud level the user can see (their own if signed in, else public). */
  const refreshMapOptions = useCallback(async () => {
    const options: MapOption[] = [];
    try {
      const manifest = await getAvailableLevels();
      for (const entry of manifest) {
        options.push({
          id: `builtin:${entry.id}`,
          name: entry.name,
          source: 'builtin',
          // Default solo_racing so older entries without `levelTypes` still surface
          // under at least one mode rather than vanishing from every dropdown.
          levelTypes: entry.levelTypes && entry.levelTypes.length > 0
            ? entry.levelTypes
            : ['solo_racing'],
        });
      }
    } catch (err) {
      console.warn('Failed to load level manifest:', err);
    }
    try {
      const session = authSessionRef.current;
      const cloudItems = session
        ? await contentApi.listLevels(session)
        : await contentApi.listPublicLevels();
      for (const item of cloudItems) {
        // Cloud levels: we can't introspect without fetching the JSON. Show
        // them under every mode and let the runtime adapt — KOTH hill zones
        // still force KOTH; otherwise the override mode applies.
        options.push({
          id: `cloud:${item.id}`,
          name: item.name,
          source: 'cloud',
          levelTypes: ['solo_racing', 'team_racing', 'party', 'koth'],
        });
      }
    } catch (err) {
      console.warn('Failed to fetch cloud levels:', err);
    }
    if (options.length > 0) setMapOptions(options);
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
  }, []);

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
    managerRef.current?.broadcast('state', JSON.stringify({
      type: 'level_loaded',
      levelId,
      levelData: arena,
      levelType: 'solo_racing',
    }), 'screen');

    setPhase('lobby');
    setCanvasKey((k) => k + 1);
    setTimeout(() => { game.startRound(); }, 100);
  }, [makeContext, spawnExistingPlayers]);

  /** Start a game with a specific level (after voting resolves). */
  const startGameWithLevel = useCallback((sid: string, levelData: LevelData, overrideMode?: LevelType) => {
    const game = new BouncyBlobsGame();
    gameRef.current = game;

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
              // Late joiner — push current level so its local sim catches up.
              const lvl = currentLevelRef.current;
              if (lvl) {
                managerRef.current?.send(peerId, 'state', JSON.stringify({
                  type: 'level_loaded',
                  levelId: lvl.levelId,
                  levelData: lvl.levelData,
                  levelType: lvl.levelType,
                }));
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
            max_peers: 4,
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
      managerRef.current = null;
      roomRef.current = null;
      inputManagerRef.current.clear();
    };
  }, []);

  // Broadcast world snapshots to remote screens at 20 Hz when an online match is active.
  useEffect(() => {
    if (!roomReady) return;
    let tick = 0;
    const interval = setInterval(() => {
      const manager = managerRef.current;
      const game = gameRef.current;
      if (!manager || !game) return;
      const pm = game.getPlayerManager();
      if (!pm) return;
      const modeMgr = (game as any).state?.modeManager;
      const modeState = modeMgr?.getState?.() ?? null;
      const scores: Record<string, number> = {};
      if (modeState?.scores instanceof Map) {
        for (const [k, v] of modeState.scores) scores[k] = v as number;
      }
      const snap: WorldSnapshot = {
        tick: tick++,
        ts: Date.now(),
        levelId: currentLevelRef.current?.levelId ?? null,
        modeState: {
          phase: modeState?.phase ?? 'playing',
          timeRemainingMs: typeof modeState?.timeRemaining === 'number'
            ? modeState.timeRemaining * 1000
            : undefined,
          scores,
          winner: modeState?.winner ?? null,
        },
        players: pm.getAllPlayers().map((p) => {
          const c = p.blob.getCentroid();
          return {
            id: p.playerId,
            name: p.name,
            color: p.color,
            faceId: p.faceId,
            x: c.x,
            y: c.y,
            vx: 0,
            vy: 0,
            radius: 48,
            moveX: p.moveX,
            moveY: p.moveY,
            expanding: !!p.expanding,
            expandScale: p.blob.getExpandScale(),
            score: scores[p.playerId] ?? 0,
            ownerScreenSlot: 1,
          };
        }),
      };
      // Broadcast world snapshot only to screen peers — phones don't need it.
      manager.broadcast('state', serializeSnapshot(snap), 'screen');
    }, 50);
    return () => clearInterval(interval);
  }, [roomReady]);

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
