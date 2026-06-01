import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useUser } from '../contexts/UserContext';
import { createHostRoom, RoomService, PeerManager, SteamTransport, steamNetStartListening, getSelfSteamId, steamNetCloseAll } from '../lib/party';
import { installRtcDebug } from '../lib/rtcDebug';
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
import { encodeAggregatedInputs, MAX_SLOT, quantizeAxis } from '../lib/inputProtocol';
import { RollbackController, type InputSet } from '../game/rollback/RollbackController';
import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { setRollbackStatsAccessor } from '../lib/debugBridge';

// Module-level constants used both inside the component (LOCAL_PLAYER_ID
// references) and by the slot-table refs created at the top of the component.
const LOCAL_PLAYER_ID_CONST = 'local-keyboard';
const MAX_SLOT_CONST = MAX_SLOT;
import { initPacingFromUrl, getPacingConfig, setPacingConfig, REDUNDANCY_TICKS } from '../lib/pacingConfig';
import { getHashHistory, recordHash, resetHashHistory } from '../lib/hashHistory';
import { installDebugBridge, setCompareHashesAccessor, setTogglePauseAccessor, type CompareHashesResult } from '../lib/debugBridge';
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
import HostSetupModal, { type HostSetupResult } from '../components/HostSetupModal';
import NetDebugOverlay from '../components/NetDebugOverlay';
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
  // Slot management for the compact v2 input wire format. Each player in a
  // lobby gets a stable u8 slot index that's tagged on every broadcast input.
  // Guests resolve slot→playerId from lobby_state. Slot 0 is reserved for
  // the host's local keyboard player so it stays predictable across sessions.
  const slotByPlayerIdRef = useRef<Map<string, number>>(new Map([[LOCAL_PLAYER_ID_CONST, 0]]));
  // Tick-tagged guest inputs. Each guest's keyboard event sends a message
  // tagged with the guest's `world.tick + 1` (the tick at which the
  // guest's local sim will apply that input). The host buffers them here
  // and drains the entry for `world.tick` at the start of each
  // preTickHook, so the host's sim applies the SAME input value at the
  // SAME logical tick the guest did — eliminating the desync that
  // happens when host applies a guest's input at "whenever it arrives"
  // vs. "when the guest pressed the key."
  //
  // When a guest's message arrives AFTER the host's sim already passed
  // the tagged tick, the host rolls back via `hostRollbackRef` (see
  // installHostBroadcastHook) so the late input still gets applied at
  // its claimed tick.
  const pendingGuestInputsRef = useRef<Map<string, Map<number, { moveX: number; moveY: number; expanding: boolean }>>>(new Map());
  const hostRollbackRef = useRef<RollbackController | null>(null);
  // Compare-hashes diagnostic: bucket of guest replies received in
  // response to a request_hashes broadcast. The debug overlay's
  // `triggerCompare()` button broadcasts a request, waits ~500ms, then
  // reads this bucket. Pruned to last 5 requests to keep memory bounded.
  const hashesResponsesRef = useRef<Array<{ requestId: number; peerId: string; entries: Array<{ tick: number; hash: string; summary?: import('../lib/hashHistory').TickSummary }> }>>([]);
  const hashRequestIdRef = useRef<number>(0);
  const ensureSlot = useCallback((playerId: string): number => {
    const m = slotByPlayerIdRef.current;
    const existing = m.get(playerId);
    if (existing !== undefined) return existing;
    // Lowest free slot, scanning 0..MAX_SLOT_CONST. Skip 0 (reserved for host).
    const used = new Set(m.values());
    for (let s = 1; s <= MAX_SLOT_CONST; s++) {
      if (!used.has(s)) {
        m.set(playerId, s);
        return s;
      }
    }
    // Lobby is full at the wire level — slot table can only address 16
    // players. Fall back to the unassigned sentinel; broadcast frames for
    // this player will be dropped by guests.
    return 255;
  }, []);
  const releaseSlot = useCallback((playerId: string): void => {
    if (playerId === LOCAL_PLAYER_ID_CONST) return; // never free the host's slot
    slotByPlayerIdRef.current.delete(playerId);
  }, []);

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
  // World.tick of the last broadcast keyframe. Used to gate the next
  // periodic keyframe by ACTUAL ticks elapsed (not by broadcast-call
  // count, which is the bug we just fixed). -Infinity ensures the
  // first eligible broadcast emits one.
  const lastKeyframeTickRef = useRef<number>(Number.NEGATIVE_INFINITY);
  const forceKeyframeRef = useRef<boolean>(true);
  /** Synchronously run one host→guests broadcast iteration. Populated
   *  by installHostBroadcastHook's setInterval setup. The host
   *  rollback handler calls this when a late guest input triggers a
   *  reconcile, so a fresh keyframe carrying the post-rollback engine
   *  state goes out the same tick — guests don't drift on stale deltas
   *  for up to 250ms waiting for the next periodic interval fire. */
  const broadcastOnceRef = useRef<(() => void) | null>(null);

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
  const inputHistoryRef = useRef<Array<{ tick: number; inputs: { playerId: string; slot: number; moveX: number; moveY: number; expanding: boolean }[] }>>([]);
  const INPUT_HISTORY_MAX = 300;
  const [connectedPlayers, setConnectedPlayers] = useState<Player[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [gamePhase, setGamePhase] = useState<GamePhase | null>(null);
  // Net-debug overlay visibility. Seeded from `?net=debug`, toggleable
  // live via the backtick (`) hotkey — host needs no-reload toggling
  // for the same reason guests do (in-progress lobby/match would be
  // disconnected by a page reload).
  const [showNetDebug, setShowNetDebug] = useState<boolean>(() => {
    return new URLSearchParams(window.location.search).get('net') === 'debug';
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '`') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setShowNetDebug((v) => !v);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /** Counter to force GameCanvas remount on phase transitions */
  const [canvasKey, setCanvasKey] = useState(0);

  const gameRef = useRef<BouncyBlobsGame | null>(null);
  // Unified rooms refs. Replaces the previous quartet
  // (managerRef + signalingRef + matchHostRef + matchMpRef) from when phone-
  // signaling and screen-signaling were separate systems.
  const managerRef = useRef<PeerManager | null>(null);
  const roomRef = useRef<RoomService | null>(null);
  // Expose `window.__rtcDebug()` for ICE-pair diagnostics. Idempotent.
  installRtcDebug(() => managerRef.current);
  const [roomReady, setRoomReady] = useState(false);
  // playerId → { screenId, name, color, faceId } for every player joined from a guest
  // screen. Used to clean up on disconnect and re-spawn after canvasKey rebuilds.
  const guestPlayersRef = useRef<Map<string, { screenId: string; name: string; color: string; faceId: string }>>(new Map());
  // Ready handshake: host waits for every connected screen-peer to confirm
  // it has applied the bootstrap keyframe at game start before kicking off
  // the countdown. Without this, the guest can be mid-restore when the
  // host's first physics tick fires, leading to a guest local sim that
  // ran a few ticks against initial (pre-restore) state — bit-divergent
  // from the host even though the wire kept replaying identical input.
  // Keyed by levelId so two back-to-back game starts can't cross-confirm.
  const pendingReadyConfirmsRef = useRef<{ levelId: string; expected: Set<string>; received: Set<string>; onComplete: (() => void) | null } | null>(null);
  // Latest level the host's authoritative game is running. Broadcast to every
  // newly connected guest, and re-broadcast on every level transition so guests
  // rebuild their local sim with identical LevelData.
  const currentLevelRef = useRef<{ levelId: string; levelData: LevelData; levelType: LevelType } | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  // Set once the user submits the HostSetupModal. The room-creation
  // effect blocks until this is non-null (except for ?offline=1, which
  // auto-fills it). Holds display name, room name, password, etc — the
  // values that get baked into createHostRoom opts.
  const [hostConfig, setHostConfig] = useState<HostSetupResult | null>(null);
  // Host's local-player customization. Picker UI lives in the LobbyPanel.
  // Defaults are reconciled against the live taken-color set in an effect
  // below so a host opening the page after others have joined doesn't collide.
  const [localColor, setLocalColor] = useState<string>(COLOR_PALETTE[0]);
  const [localFaceId, setLocalFaceId] = useState<string>('default');
  // Lobby selections — drive the Start button. Honour `?level=<id>` so
  // playwright tests can pick a feature-rich map (showcase, classic,
  // koth) without driving the map-picker modal click flow.
  const [selectedMapId, setSelectedMapId] = useState<string>(() => {
    const lvl = searchParams.get('level')?.trim();
    return lvl ? `builtin:${lvl}` : 'builtin:default';
  });
  const [selectedModeId, setSelectedModeId] = useState<LevelType>('solo_racing');
  const [mapOptions, setMapOptions] = useState<MapOption[]>([
    { id: 'builtin:default', name: 'Default Arena', source: 'builtin', levelTypes: ['solo_racing'] },
  ]);
  // True once any human has joined this lobby. Auto-end fires only after a human
  // arrives and then every human leaves — never on a freshly-created empty lobby.
  const hadHumanRef = useRef(false);
  const autoEndingRef = useRef(false);
  // Stable id used by both onPlayerJoin and InputManager for the keyboard player.
  const LOCAL_PLAYER_ID = LOCAL_PLAYER_ID_CONST;
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
  // Mirror of `bots` for synchronous reads in callbacks like
  // spawnExistingPlayers (which can't wait for a re-render after setBots).
  const botsRef = useRef<typeof bots>([]);
  useEffect(() => { botsRef.current = bots; }, [bots]);

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
      // Host's display name comes from the HostSetupModal (which itself
      // pre-fills from localStorage / Steam persona). 'You' is just a
      // last-resort fallback for offline/test paths.
      name: hostConfig?.displayName || 'You',
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
  }, [localPlayerJoined, sessionId, localColor, localFaceId, hostConfig]);

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

  // (Removed) Post-canvasKey 150ms deferred player re-add: the entire
  // payload — bots, host's local player, screen-peer guests — is now
  // re-added synchronously inside `spawnExistingPlayers` before the
  // bootstrap keyframe ships. Keeping the deferred path meant the
  // host emitted TWO keyframes at tick=0 (one from the synchronous
  // path, one from the deferred forceKeyframeRef), the guest's
  // `lastTickRef <= frame.tick` guard dropped the second, and any
  // blobs only present in the second keyframe ended up missing from
  // the guest's engine. Result: persistent post-bootstrap divergence.
  const inputManagerRef = useRef<InputManager>(new InputManager());
  const contextRef = useRef<GameContext | null>(null);
  const knownPlayerIdsRef = useRef<Set<string>>(new Set());
  /** Per-peer connect-state tracking so the poll loop can bounded-retry a
   * stuck WebRTC handshake. Survives `knownPlayerIdsRef` getting cleared on
   * disconnect — that's the retry signal. */
  const connectAttemptsRef = useRef<Map<string, { attempts: number; lastAttemptMs: number; status: 'connecting' | 'open' | 'failed' }>>(new Map());
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
    // Player set just changed — force the next broadcastOnce to emit a
    // keyframe so every guest's playerManager learns about the new
    // blob. Without this, with ?keyframe=0 guests never see new
    // players (periodic keyframes are disabled, deltas don't carry
    // membership) — symptom: joined player is registered in the lobby
    // panel but no blob is ever synthesized into their sim.
    forceKeyframeRef.current = true;
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
    // Same rationale as handlePlayerJoin: player set just changed,
    // need a fresh keyframe so guests prune the departed blob.
    forceKeyframeRef.current = true;
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
    // Phone-controller players (live in connectedPlayers, sourced from
    // the party API).
    for (const player of connectedPlayersRef.current) {
      const custom = playerCustomRef.current.get(player.player_id);
      const enriched = custom
        ? { ...player, color: custom.color, faceId: custom.faceId }
        : player;
      game.onPlayerJoin(context, enriched);
    }
    // Screen-peer guests (live in guestPlayersRef, sourced from the
    // screen-peer `player_join` message handler at line ~1066). Without
    // re-spawning these, every game transition (playground → playing,
    // playing → results → playground) drops every WebRTC-screen guest's
    // blob — host's playerManager goes empty for those players and the
    // host's broadcastOnce builds keyframes with an incomplete roster
    // (screen guests never see their own blob in the new game).
    for (const [playerId, info] of guestPlayersRef.current.entries()) {
      game.onPlayerJoin(context, {
        player_id: playerId,
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
    // Host's own keyboard player (if they've clicked "Play from laptop").
    if (localPlayerJoined) {
      const custom = playerCustomRef.current.get(LOCAL_PLAYER_ID);
      game.onPlayerJoin(context, {
        player_id: LOCAL_PLAYER_ID,
        session_id: context.sessionId,
        name: hostConfig?.displayName || 'You',
        slot: 0,
        status: 'connected',
        controller_config: null,
        joined_at: new Date().toISOString(),
        color: custom?.color ?? localColor,
        faceId: custom?.faceId ?? localFaceId,
      } as Player);
    }
    // AI bots — added LAST so player slots stay packed before bots.
    // Previously this lived in a 150ms-deferred canvasKey useEffect,
    // which caused the bootstrap keyframe at tick=0 to ship WITHOUT
    // these blobs (different player set vs. the host's eventual one
    // → engine state divergence). Re-adding bots synchronously here
    // means the bootstrap keyframe captures the full roster.
    for (const b of botsRef.current) {
      game.addAIPlayer(b.personality, { id: b.playerId, name: b.name, color: b.color });
    }
    game.setStateChangeCallback(() => {
      setConnectedPlayers(prev => [...prev]);
    });
    // Fresh game instance — replay our local-player set so the camera
    // follows the same blobs it did before the rebuild.
    pushLocalPlayerIds();
  }, [pushLocalPlayerIds, localPlayerJoined, localColor, localFaceId, hostConfig]);

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
      // Honour `?level=<id>` for tests/local play that want a richer
      // playground (spring pads, spikes, dynamic items) than the bare
      // default arena. Falls back to 'default' on any load error.
      const lvlOverride = searchParams.get('level')?.trim();
      arena = await loadBuiltinLevel(lvlOverride || 'default');
    } catch (err) {
      console.error('Failed to load default arena:', err);
      setErrorMsg('Failed to load playground arena');
      setPhase('error');
      return;
    }

    gameRef.current?.destroy();
    gameRef.current = null;
    resetHashHistory();

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
    // Bootstrap the same way as startGameWithLevel: send level_loaded then
    // immediately trigger a synchronous keyframe so already-connected guests
    // are race-free populated with players (see comment in startGameWithLevel).
    managerRef.current?.broadcast('state', JSON.stringify({
      type: 'level_loaded',
      levelId,
      levelData: arena,
      levelType: 'solo_racing',
      freeplay: true,
      rngSeed: sessionSeedRef.current,
    }), 'screen');
    forceKeyframeRef.current = true;
    broadcastOnceRef.current?.();

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
    // Clear the per-tick hash ring on game start. Stale entries from
    // the previous game (playground tick=0 in particular) survive into
    // the new game's ring and pollute cross-tab determinism comparisons
    // with apparent "tick=0 desync" entries that don't reflect the new
    // game's state.
    resetHashHistory();

    const game = new BouncyBlobsGame();
    gameRef.current = game;
    game.setRngSeed(sessionSeedRef.current);
    installHostBroadcastHook(game);

    const mode = createModeForLevel(levelData, broadcastToControllers, overrideMode);
    game.setGameMode(mode);

    // Remember the level for late-joining guests.
    const resolvedType: LevelType = (overrideMode ?? mode.config.id ?? 'solo_racing') as LevelType;
    const levelId = `level-${Date.now()}`;
    currentLevelRef.current = { levelId, levelData, levelType: resolvedType };
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

    // Broadcast level_loaded now that the host's game is fully set up
    // (initialized + players spawned). Order matters: we send
    // level_loaded FIRST, then immediately fire a synchronous
    // broadcastOnce with forceKeyframeRef set so the guest receives, in
    // wire order on the reliable+ordered 'state' channel:
    //   1. level_loaded → installLevel (clears stash, schedules canvas remount)
    //   2. keyframe     → applySnapshot (stashes; game not ready yet)
    //   3. rng_state / manager_state — companion events from broadcastOnce
    // The guest's onCanvasInit then drains the stash and synthesizes
    // player blobs atomically as part of bootstrap. Without the
    // explicit keyframe trigger, the guest waits up to
    // `keyframeIntervalTicks` ticks (~1s at default, NEVER at
    // ?keyframe=0) for the next periodic keyframe — symptom: guest
    // sees the new level but has no blobs in it.
    managerRef.current?.broadcast('state', JSON.stringify({
      type: 'level_loaded',
      levelId,
      levelData,
      levelType: resolvedType,
      rngSeed: sessionSeedRef.current,
      // Tells the guest "send state_ready after applying the keyframe
      // for this levelId so the host can gate the countdown on all
      // guests being synced."
      requireReadyConfirm: true,
    }), 'screen');
    forceKeyframeRef.current = true;
    broadcastOnceRef.current?.();

    setPhase('playing');
    setCanvasKey(k => k + 1);

    // Ready handshake: defer game.startRound() until every currently-
    // connected guest has confirmed they've applied the bootstrap
    // keyframe. Without this, the guest can still be mid-canvas-mount
    // when the host fires its first physics tick — guest's local sim
    // would run a few ticks against pre-restore state, accumulating a
    // bit-divergence the rest of lockstep can't recover from.
    // Cap the wait at 3s so a dropped/disconnected guest can't soft-
    // hang the host forever; if the wait times out the round starts
    // anyway and the laggard re-syncs on the next periodic keyframe.
    const expected = new Set(guestPlayersRef.current.keys());
    if (expected.size > 0) {
      console.info(`[netDiag] host gating startRound on ready_confirm from ${expected.size} guest(s)`);
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        pendingReadyConfirmsRef.current = null;
        setTimeout(() => { game.startRound(); }, 100);
      };
      pendingReadyConfirmsRef.current = {
        levelId,
        expected,
        received: new Set(),
        onComplete: start,
      };
      setTimeout(() => {
        if (!started) {
          console.warn(`[netDiag] host ready_confirm timed out; starting anyway. expected=${expected.size}, received=${pendingReadyConfirmsRef.current?.received.size ?? 0}`);
          start();
        }
      }, 3000);
    } else {
      // No screen guests — proceed immediately.
      setTimeout(() => { game.startRound(); }, 100);
    }
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
  // Auto-fill host config in offline mode so the modal doesn't gate
  // Playwright / AI-only sessions. Real users go through the modal.
  useEffect(() => {
    if (hostConfig) return;
    if (searchParams.get('offline') === '1') {
      setHostConfig({
        displayName: 'Host',
        roomName: 'Offline Lobby',
        isPublic: false,
        password: '',
        maxPlayers: 8,
      });
    }
  }, [hostConfig, searchParams]);

  // Apply chosen visibility + max-players to the live state once the
  // host submits the modal. Done in an effect (not the submit handler)
  // so the room-creation effect — which reads these via closures —
  // sees consistent values after the next render.
  useEffect(() => {
    if (!hostConfig) return;
    setIsPublic(hostConfig.isPublic);
    setMaxPlayers(hostConfig.maxPlayers);
  }, [hostConfig]);

  useEffect(() => {
    // Block room creation until the host has submitted their setup modal.
    if (!hostConfig) return;
    let cancelled = false;

    // React 18 StrictMode double-mounts effects in dev. If we called
    // `createHostRoom` synchronously here we'd allocate TWO rooms per
    // page load and orphan the first until TTL. Deferring with
    // setTimeout(0) lets StrictMode's intervening cleanup flip
    // `cancelled = true` first; only the surviving mount actually hits
    // the server. Same one-tick delay in prod, no double-mount there.
    const initTimer = window.setTimeout(() => {
      if (cancelled) return;
      void init();
    }, 0);

    async function init() {
      if (!hostConfig) return;
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
                // Player set just changed — force a fresh keyframe so the
                // newly-joined guest (and every other peer) receives a
                // synth-eligible player record for this blob. Without
                // this, with ?keyframe=0 the blob exists in the engine
                // but no peer's playerManager ever learns about it.
                forceKeyframeRef.current = true;
              } else if (evt.type === 'player_leave' && typeof evt.playerId === 'string') {
                game.onPlayerDisconnect(ctx, evt.playerId);
                guestPlayersRef.current.delete(evt.playerId);
                forceKeyframeRef.current = true;
              } else if (evt.type === 'state_ready' && typeof evt.levelId === 'string' && typeof evt.playerId === 'string') {
                // Ready handshake from guest — they've applied the
                // bootstrap keyframe for this level and are sitting at
                // tick=0 waiting for us. Mark them confirmed; if all
                // expected guests have confirmed, fire onComplete which
                // starts the round.
                const pending = pendingReadyConfirmsRef.current;
                if (pending && pending.levelId === evt.levelId && pending.expected.has(evt.playerId)) {
                  pending.received.add(evt.playerId);
                  console.info(`[netDiag] host received state_ready from ${evt.playerId} (${pending.received.size}/${pending.expected.size})`);
                  if (pending.received.size >= pending.expected.size) {
                    console.info('[netDiag] host all guests ready; starting round');
                    pending.onComplete?.();
                  }
                } else if (pending) {
                  console.warn(`[netDiag] host ignored state_ready: levelId=${evt.levelId} (expected ${pending.levelId}), playerId=${evt.playerId} (expected? ${pending.expected.has(evt.playerId)})`);
                }
              } else if (evt.type === 'hashes_response' && typeof evt.requestId === 'number') {
                // Guest replied to our request_hashes. Store into the
                // pending compare bucket so the overlay's modal can
                // pick it up via the debug bridge.
                const peerKey = typeof evt.peerId === 'string' && evt.peerId.length > 0 ? evt.peerId : peerId;
                const entries = Array.isArray(evt.entries) ? evt.entries : [];
                console.info(
                  `[netDiag] host received hashes_response(req=${evt.requestId}) from peer="${peerKey}"`,
                  `entries=${entries.length}`,
                );
                hashesResponsesRef.current.push({ requestId: evt.requestId, peerId: peerKey, entries });
                return;
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
              // Each guest input frame is tagged with the guest's
              // `world.tick + 1` — the tick at which the guest's local
              // sim will (or did) apply the input. Queue it for the
              // host's preTickHook to drain at the same tick. If the
              // host already passed that tick, trigger a rollback so
              // the input still gets applied at its claimed tick.
              const game = gameRef.current;
              const world = game?.getWorld();
              const hostTick = world?.tick ?? 0;
              for (const f of batch.frames) {
                if (typeof f?.playerId !== 'string') continue;
                const claimedTick = Number(f.tick) >>> 0;
                const mx = quantizeAxis(Number(f.moveX) || 0);
                const my = quantizeAxis(Number(f.moveY) || 0);
                const exp = !!f.expanding;
                // Stash for preTickHook drain.
                let perTick = pendingGuestInputsRef.current.get(f.playerId);
                if (!perTick) {
                  perTick = new Map();
                  pendingGuestInputsRef.current.set(f.playerId, perTick);
                }
                perTick.set(claimedTick, { moveX: mx, moveY: my, expanding: exp });
                // Prune anything older than rollback window (~maxTicks).
                const cutoff = hostTick - 60;
                for (const t of perTick.keys()) if (t < cutoff) perTick.delete(t);
                // Late input → host rollback. world.tick === N means
                // "N steps completed" — next step produces N+1. So
                // claimedTick <= world.tick means the host already
                // produced state for that tick → rewind to claimedTick,
                // swap this player's input at that tick, replay forward.
                // The Rust+wasm engine snapshot + game.snapshotGameState()
                // are lossless together (proven by 8/8 in
                // src/lib/rollbackExactness.test.ts); rc.onAuthoritativeInputs
                // restores both via the rc.recordTick stack.
                // Host rollback is gated on PacingConfig.enableRollback.
                // Default OFF — see pacingConfig.ts for rationale. With
                // the engine proven cross-tab deterministic and the
                // bootstrap keyframe doing the only sync we need,
                // strict-lockstep play (no late-input rollback) gives
                // bit-identical sims on every client. Re-enable via
                // ?rollback=1 once the manager migrations land and the
                // rollback-vs-hash-ring interaction is fully audited.
                if (getPacingConfig().enableRollback && game && world && hostRollbackRef.current && claimedTick <= hostTick) {
                  const rc = hostRollbackRef.current;
                  const recorded = rc.getRecordedInputs(claimedTick);
                  if (recorded) {
                    const auth: InputSet = { ...recorded, [f.playerId]: { moveX: mx, moveY: my, expanding: exp } };
                    const rolled = rc.onAuthoritativeInputs(new Map([[claimedTick, auth]]), world, game);
                    // ──────────────────────────────────────────────
                    // CRITICAL FIX — keyframe-after-rollback ordering.
                    // A host rollback retroactively rewrites every
                    // tick from claimedTick forward. Any keyframe we
                    // already broadcast (which guests have already
                    // committed to by calling world.restoreState) is
                    // now based on a HISTORY THAT NEVER HAPPENED on
                    // the host. The guest is sitting at the
                    // pre-rollback state; the host is at the
                    // post-rollback state; the next per-tick deltas
                    // arrive but applying them to mismatched
                    // starting states drifts further every tick —
                    // exactly the "first overlapping tick after KF
                    // diverges, all subsequent ticks red" symptom
                    // the cross-tab determinism playwright test
                    // reproduced.
                    //
                    // Force the next broadcast to be a keyframe so
                    // the guest re-restores to the new authoritative
                    // post-rollback state. Cost: one extra ~5 KB
                    // engineState blob on the next 250ms tick; happens
                    // only when a late guest input actually fires a
                    // rollback (rare in steady-state lockstep).
                    // Rollback fired → next periodic broadcast must
                    // be a keyframe (to resync the guest to the new
                    // post-rollback state). When rollback is OFF
                    // (default) this branch is unreachable.
                    if (rolled > 0) {
                      forceKeyframeRef.current = true;
                    }
                  }
                  // If no recorded snapshot exists for that tick (too
                  // old — beyond rc's rolling window), silently drop —
                  // guest will resync via the next keyframe.
                }
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
            const rec = connectAttemptsRef.current.get(peerId);
            if (rec) rec.status = 'open';
            if (kind === 'phone') {
              setTimeout(() => sendCustomizationTo(peerId), 100);
            } else if (kind === 'screen') {
              // New screen peer — request a fresh keyframe on the next
              // broadcastOnce. The cached keyframe sent a few lines down is
              // the "immediate" snapshot from before this peer joined; it
              // bootstraps geometry/NPCs but does NOT contain the new
              // peer's own player (their player_join message arrives
              // moments after this onPeerConnected fires, processed by
              // handlePlayerJoin which also sets forceKeyframeRef). The
              // first periodic broadcastOnce after handlePlayerJoin runs
              // produces the keyframe that includes the new player blob,
              // which the broadcast carries to ALL peers including the
              // new one. With ?keyframe=0 this is the ONLY way the new
              // player ever reaches the guest's playerManager.
              forceKeyframeRef.current = true;
              // Late joiner — push current level so its local sim catches up.
              // level_loaded goes on the same reliable+ordered 'state' channel
              // as the cached keyframe sent a few lines down, so the wire
              // delivers them in order. The guest's installLevel clears the
              // pendingKeyframeRef stash synchronously, then the keyframe
              // arrives, stashes, and onCanvasInit drains it after the React
              // re-mount completes.
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
            // Mark failed and tear down the underlying transport so a retry
            // (driven by the room poll loop) gets a fresh RTCPeerConnection.
            // handlePlayerDisconnect already removed this id from
            // knownPlayerIdsRef, so the next poll tick will pick the peer
            // back up if their room row is still there.
            const rec = connectAttemptsRef.current.get(peerId);
            if (rec) rec.status = 'failed';
            managerRef.current?.disposePeer(peerId);
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
            display_name: hostConfig.roomName,
            host_display_name: hostConfig.displayName,
            host_kind: 'screen',
            max_peers: hostConfig.maxPlayers,
            visibility: hostConfig.isPublic ? 'public' : 'private',
            password: hostConfig.password || undefined,
          },
          callbacks,
        );

        if (cancelled) {
          // The room was already allocated on the server before we got
          // cancelled (e.g. very fast remount / nav-away mid-create).
          // End it explicitly so it doesn't sit orphaned in the lobby
          // browser until TTL sweeps it.
          void room.endRoom().catch(() => {});
          manager.dispose();
          return;
        }

        managerRef.current = manager;
        roomRef.current = room;

        const sid = result.room_id;
        setSessionId(sid);
        setJoinCode(result.join_code);
        setRoomReady(true);
        // Visibility was set at room-creation time from hostConfig — no
        // post-creation reset needed (it was hardcoded to false here).

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

    return () => {
      cancelled = true;
      window.clearTimeout(initTimer);
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
  }, [hostConfig]);

  // Broadcast binary world-snapshot frames to remote screens at 20 Hz when an
  // online match is active. Wire format defined in src/lib/wireProtocol.ts:
  // root + activeMask + quantized hull-node offsets per entity. Per-peer
  // delta compression and the settled/sleep flag are wired in S2.3 / S2.5;
  // for now every frame is a full keyframe (activeMask=0xFFFF).
  useEffect(() => {
    if (!roomReady) return;
    let tick = 0;

    // Keyframe interval, live-tunable via the overlay (see pacingConfig
    // `keyframeIntervalTicks`). 0 disables periodic keyframes entirely —
    // sims stay synchronized through deterministic input replay alone,
    // and on-connect keyframes still fire via forceKeyframeRef so late
    // joiners can bootstrap. Trades the periodic encode/decode hitch
    // for no auto-recovery if a desync ever sneaks in.
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

    const broadcastOnce = () => {
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

      // Determine keyframe vs delta for this tick. When interval is 0,
      // the periodic check is short-circuited and only forceKeyframeRef
      // (set on peer connect for late-joiner bootstrap) can trigger one.
      // BUG FIX (determinism): previously this counter was `++` per
      // broadcast call. With the broadcast interval at 250ms that meant
      // a keyframe fired every kfInterval × 250ms — at the default
      // kfInterval=60 that's 15 SECONDS between resyncs, not 1 second.
      // Use the engine's actual tick to measure elapsed ticks so the
      // pacing-config "ticks" units mean what they say.
      const kfInterval = getPacingConfig().keyframeIntervalTicks;
      const periodicDue =
        kfInterval > 0 && world.tick - lastKeyframeTickRef.current >= kfInterval;
      const isKeyframe = forceKeyframeRef.current || periodicDue;
      forceKeyframeRef.current = false;
      if (isKeyframe) lastKeyframeTickRef.current = world.tick;

      // Wire-protocol simplification: the wire carries ONLY inputs
      // (per-tick UDP redundant stream, broadcast from postTickHook)
      // and KEYFRAMES (full engine + manager + rng state, sent here on
      // keyframe ticks). The deterministic engine running the same
      // inputs on every client produces bit-identical state, so
      // per-tick particle deltas serve no purpose and have a habit of
      // CORRUPTING the guest's canonical state when they cross the
      // wasm boundary with f32-quantized values. Early-return on
      // non-keyframe broadcasts.
      if (!isKeyframe) return;

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
      // Capture FULL engine state alongside the snapshot. Receivers
      // with v2+ ingest this via world.restoreState() for a lossless
      // sync of every mutable field — fixes the "100% diverged after
      // keyframe" bug the user observed. ONLY emitted on keyframes
      // (per-tick delta snapshots stay particle-only to keep
      // bandwidth low; the next keyframe re-syncs everything).
      const engineState = isKeyframe ? world.serializeState() : undefined;
      if (isKeyframe) {
        // Determinism bisect partner: guest logs its post-restore
        // hash at the same tick. If they match, restore is lossless;
        // if they don't, restore is dropping a field.
        const hostHashAtKeyframe = world.stateHash();
        console.info(
          `[netDiag] host keyframe tick=${world.tick} hash=${hostHashAtKeyframe} blobs=${world.getBlobCount()} players=${players.length} world=${worldRecords.length}`,
        );
      }
      const buf = encodeSnapshot({
        version: 2,
        isKeyframe,
        tick: keyframeTick,
        players,
        world: worldRecords,
        engineState,
      });
      // Cache for late-joiner replay — peers that connect after this tick
      // need this keyframe + the input history that follows it. Reset the
      // input history every time we cache a new keyframe; replay only
      // needs to cover from the keyframe forward.
      latestKeyframeRef.current = { tick: keyframeTick, buf };
      inputHistoryRef.current = [];
      // Broadcast to screen peers. Phones don't need physics state.
      manager.broadcast('state', buf, 'screen');
      // FIX (determinism): only re-align RNG on keyframes. Broadcasting
      // host.rng.getState() every 50ms while the guest is 1-3 ticks
      // BEHIND host means the guest's RNG gets jammed to a state that
      // host has already advanced past. The guest then steps with a
      // future-tick RNG value, consumes random draws differently than
      // it would have, and engines diverge. Gating to keyframes only
      // means RNG re-align happens alongside the engine-state restore
      // at exactly the same tick — same as the manager_state gate.
      if (isKeyframe) {
        const rngEvt: ReliableEvent = {
          type: 'rng_state',
          tick: world.tick,
          state: world.rng.getState(),
        };
        manager.broadcast('state', JSON.stringify(rngEvt), 'screen');
      }

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
      // FIX (determinism): manager_state was previously broadcast every
      // 50-250ms regardless of isKeyframe, which corrupted guest sync:
      // the guest's lockstep gate runs ~1-3 ticks behind the host, so
      // a manager_state event tagged "host tick K" arrives while the
      // guest's engine is still at tick K-3. The guest restores e.g.
      // a spring pad's 'firing' state on top of an engine where the
      // blob hasn't touched the plate yet. The pad fires anyway
      // (because the JS state machine says firing) and engines diverge.
      // Gating to keyframes only means the manager state arrives
      // ALONGSIDE the full engine state restore at the same tick — the
      // pair is atomic, no asymmetric "your spring fired but my blob
      // hasn't touched it" window.
      if (isKeyframe) {
        const gameRef2 = gameRef.current;
        if (gameRef2) {
          const managerStateEvt = {
            type: 'manager_state',
            tick: world.tick,
            state: gameRef2.snapshotGameState(),
          };
          const managerStateJson = JSON.stringify(managerStateEvt);
          manager.broadcast('state', managerStateJson, 'screen');
          latestManagerStateRef.current = { tick: world.tick, json: managerStateJson };
        }
      }
    };
    // Stash so the host's rollback handler can fire an immediate
    // off-schedule broadcast (with `forceKeyframeRef` set, this sends
    // a keyframe carrying the new post-rollback engine state, so
    // guests don't spend up to 250ms applying deltas to a now-stale
    // pre-rollback snapshot).
    broadcastOnceRef.current = broadcastOnce;
    // ~60 Hz broadcast (one per sim tick). Aggregated-input echo is the
    // critical-path payload for guest lockstep — at 20Hz (50ms) the host's
    // echo of a guest's own input could sit in the outbox for up to 3
    // ticks, compounding perceived input latency. At 60Hz the echo
    // reaches the guest within one sim tick of the host applying it.
    // Snapshot broadcasts are gated to keyframe ticks by broadcastOnce
    // itself, so the bandwidth cost of the bump is just the compact
    // input batch (~1–2 KB/player) at 3× the rate — still well within
    // WebRTC reliable-channel headroom. The bootstrap keyframe race that
    // a fast interval would expose is handled at the source by deferring
    // forceKeyframeRef in onPeerConnected.
    const interval = setInterval(broadcastOnce, 17);
    return () => { clearInterval(interval); broadcastOnceRef.current = null; };
  }, [roomReady]);

  // 30 Hz aggregated-input broadcast — host → all screen peers. Each tick
  // we sample every player's current input state (host's keyboard, each
  // guest's last-received input, AI controllers' decisions) and broadcast
  // them as the canonical input set for the current sim tick. Guests apply
  // these to drive their own local sim's remote players, keeping every
  // client in deterministic lockstep with the host.
  // Helper: install the host's per-tick input pipeline on a freshly
  // created BouncyBlobsGame. Runs in `preTickHook`, which fires AFTER
  // playerManager.tickAIInputs (so AI decisions are visible) and BEFORE
  // blob.setInput (so we still own ManagedPlayer.* when we rewrite it
  // with the delayed value).
  //
  // Fixed-input-delay lockstep: each tick T the host snapshots every
  // player's INTENDED input (post-AI-tick, post-async-event), schedules
  // it for application at tick T + INPUT_DELAY_TICKS, and broadcasts the
  // snapshot tagged with T + INPUT_DELAY_TICKS so the message reaches
  // guests N ticks before they need it. The host then overwrites
  // ManagedPlayer.* with the value previously scheduled for tick T, so
  // the host's own sim feels the same delay as everyone else — no
  // asymmetry between host's local-player feel and guest's view of
  // remote players.
  //
  // Why this kills the periodic jitter: the previous postTickHook
  // broadcast left the host AT tick T tagged T, so the message had to
  // reach the guest before the guest's lockstep gate wanted to advance
  // past T. Any network jitter ate directly into that budget and
  // produced "gate pause, then burst-catch-up" — the dominant visible
  // hitch. Broadcasting N ticks early gives the guest a jitter buffer
  // to absorb that variance.
  //
  // INPUT_DELAY_TICKS defaults to 2 (~33ms at 60Hz) — small enough to
  // be imperceptible in a soft-body game where bodies have inertia,
  // large enough to cover typical LAN jitter. Tunable per session via
  // `?inputDelay=N` for the host's URL.
  // Bandwidth: 4 players × ~30 bytes × 60 Hz ≈ 7 KB/s. Tiny.
  // Helper: install the host's per-tick input pipeline on a freshly
  // created BouncyBlobsGame. Tick-tagged input model:
  //
  // 1. Guests send each input with `tick = guest.world.tick + 1` (the
  //    sim tick at which the guest's local prediction will apply it).
  //    The handleScreenMessage 'input' branch above buffers these into
  //    `pendingGuestInputsRef[playerId][tick]`. If the host has already
  //    passed the claimed tick, it ALSO triggers a rollback via
  //    `hostRollbackRef.onAuthoritativeInputs` so the late input still
  //    gets applied at its claimed tick.
  // 2. preTickHook at host.tick H drains `pendingGuestInputsRef[*][H]`
  //    into ManagedPlayer for each guest player BEFORE intent capture —
  //    so the host's sim applies the SAME input value at the SAME
  //    logical tick the guest's local sim did. Sims agree.
  // 3. Host's own local player and AI players continue to use the
  //    natural MP write path (InputManager events / tickAIInputs).
  // 4. Broadcast K=REDUNDANCY_TICKS ticks of recent inputs on the
  //    unreliable channel — drops invisible within the redundancy window.
  // 5. `hostRollbackRef.recordTick` snapshots the engine every N ticks
  //    so the rollback path has somewhere to restore from.
  //
  // The previous `inputDelay` scheduling has been removed — inputs apply
  // at the exact tick the source claimed (guest's predicted tick for
  // guests, host's tick for host's local). The `inputDelayTicks` pacing
  // slider is preserved in PacingConfig but no longer affects host
  // behaviour. Rollback covers the late-arrival case that inputDelay
  // used to mask.
  const installHostBroadcastHook = useCallback((game: BouncyBlobsGame) => {
    type Intent = { moveX: number; moveY: number; expanding: boolean };
    initPacingFromUrl();
    // Rolling history of recently-applied per-player intents (one entry
    // per tick), for redundant broadcast. RC's own inputHistory is the
    // source of truth for replay; this map is the wire-format snapshot
    // we hand to the encoder.
    const recentSchedule = new Map<string, Map<number, Intent>>();
    const RECENT_KEEP = REDUNDANCY_TICKS * 4;

    // Install the host's RollbackController. Used for two things:
    //   - Snapshots: every N ticks via recordTick (cheap; the ring
    //     buffer lets us restore engine state on late input).
    //   - Late-input recovery: when a guest input arrives tagged for a
    //     tick the host already passed, onAuthoritativeInputs rewinds
    //     to that tick, swaps the late input in, and replays forward
    //     to the host's current tick — so the host's sim matches what
    //     it WOULD have been if the input arrived on time.
    const hostId = LOCAL_PLAYER_ID_CONST;
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
      localPlayerId: hostId,
      // Host knows its own input directly; readLocalInput is used by
      // predictInputs which we never call on the host. Return zero.
      readLocalInput: () => ({ moveX: 0, moveY: 0, expanding: false }),
      applyInputs: applyInputsToPM,
      stepOne: () => {
        // Mirror bouncyBlobsGame's onLogic sequence for replay.
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
        // CRITICAL: update the per-tick hash ring during rollback
        // replay so the recorded hash for this tick reflects the
        // POST-rollback state. Without this, the host's ring keeps
        // the stale pre-rollback hash for replayed ticks while the
        // guest's ring has its own forward-sim hash — the engines
        // agree on the CURRENT state but the compare-hashes diagnostic
        // (and any per-tick determinism check) sees a recorded
        // mismatch. recordHash is normally called from
        // bouncyBlobsGame.onLogic after step+managers; mirroring it
        // here keeps the ring consistent across rollback replays.
        recordHash(st.world.tick, st.world.stateHash());
      },
    });
    hostRollbackRef.current = rc;
    // Surface host-side rollback metrics via the debug bridge so the
    // host overlay shows the same rollbacks/depth/failedRestores rows
    // the guest overlay shows. Critical for diagnosing whether the
    // late-input rollback path is (a) firing at all and (b) restoring
    // cleanly — `failedRestores > 0` means engine.restoreState returned
    // false (engine layout changed since snapshot or serializeState
    // missed required state).
    setRollbackStatsAccessor(() => {
      const t = rc.getTimingStats();
      return {
        rollbacksApplied: rc.rollbacksApplied,
        lastDepth: rc.lastRollbackDepth,
        smoothingActive: 0, // no display smoother on host
        ringInvalidations: rc.ringInvalidations,
        failedRestores: rc.failedRestores,
        avgSnapshotMs: t.avgSnapshotMs,
        avgCheapTickMs: t.avgCheapTickMs,
        avgReconcileMs: t.avgReconcileMs,
      };
    });

    game.setPreTickHook((world) => {
      const manager = managerRef.current;
      const pm = game.getPlayerManager();
      if (!pm) return;
      // CRITICAL TICK SEMANTIC: world.tick === "number of completed
      // steps." preTickHook fires BEFORE world.step, so the step about
      // to run produces state for tick world.tick + 1. EVERY tick
      // number we use here — for the drain, broadcast tag, rc.recordTick,
      // and late-joiner replay — refers to the tick this step produces,
      // i.e. world.tick + 1. Mismatching this with the guest's
      // `applyTick = guest.world.tick + 1` causes immediate desync.
      const T = world.tick + 1;
      const players = pm.getAllPlayers();

      // 1. Drain pendingGuestInputsRef[*][T] → ManagedPlayer for each
      //    guest player. This sets MP to exactly what the guest's local
      //    sim used at tick T, so the host's sim applies the same value.
      //    Sticky behaviour: if no entry for this tick, MP retains its
      //    previous value (= last drained or last InputManager write).
      for (const [pid, perTick] of pendingGuestInputsRef.current) {
        const v = perTick.get(T);
        if (!v) continue;
        const mp = pm.getPlayer(pid);
        if (mp) {
          mp.moveX = v.moveX;
          mp.moveY = v.moveY;
          mp.expanding = v.expanding;
        }
        perTick.delete(T);
      }

      // 2. Quantize ManagedPlayer values for ALL players (host local +
      //    drained guests + AI) so the value applied to physics is the
      //    canonical i8-precision value. Guests apply the same quantized
      //    value (the wire format quantizes on both sides), so sims
      //    agree bit-for-bit.
      for (const p of players) {
        p.moveX = quantizeAxis(p.moveX);
        p.moveY = quantizeAxis(p.moveY);
      }

      // 3. Build the intent list (post-drain, post-quantize). This is
      //    what physics will apply this tick.
      const intentList: Array<{ playerId: string; slot: number } & Intent> = players.map((p) => ({
        playerId: p.playerId,
        slot: ensureSlot(p.playerId),
        moveX: p.moveX,
        moveY: p.moveY,
        expanding: p.expanding,
      }));

      // 4. Record into the redundant-broadcast window AND the RC's
      //    snapshot ring. The RC uses inputs to snapshot engine state
      //    so future rollbacks have somewhere to restore from.
      const fullInputSet: InputSet = {};
      for (const it of intentList) {
        fullInputSet[it.playerId] = { moveX: it.moveX, moveY: it.moveY, expanding: it.expanding };
        let rs = recentSchedule.get(it.playerId);
        if (!rs) { rs = new Map(); recentSchedule.set(it.playerId, rs); }
        rs.set(T, { moveX: it.moveX, moveY: it.moveY, expanding: it.expanding });
        const cutoff = T - RECENT_KEEP;
        for (const k of rs.keys()) if (k < cutoff) rs.delete(k);
      }
      rc.recordTick(T, fullInputSet, world, game);

      // 5. Broadcast K=REDUNDANCY_TICKS ticks of recent inputs over the
      //    unreliable 'input' channel. Each tick t in [T-K+1 .. T] gets
      //    its recorded value per player (or current intent if missing).
      if (manager) {
        const ticksOut: Array<{ tick: number; inputs: Array<{ slot: number; moveX: number; moveY: number; expanding: boolean }> }> = [];
        const start = T - REDUNDANCY_TICKS + 1;
        for (let t = start; t <= T; t++) {
          if (t < 0) continue;
          const tickInputs = intentList.map((it) => {
            const past = recentSchedule.get(it.playerId)?.get(t);
            return past
              ? { slot: it.slot, moveX: past.moveX, moveY: past.moveY, expanding: past.expanding }
              : { slot: it.slot, moveX: it.moveX, moveY: it.moveY, expanding: it.expanding };
          });
          ticksOut.push({ tick: t, inputs: tickInputs });
        }
        const buf = encodeAggregatedInputs({ ticks: ticksOut });
        manager.broadcast('input', buf, 'screen');
      }

      // 6. Late-joiner replay: same single-tick record as before, just
      //    tagged with the actual application tick T (no +inputDelay).
      inputHistoryRef.current.push({
        tick: T,
        inputs: intentList.map((it) => ({
          playerId: it.playerId,
          slot: it.slot,
          moveX: it.moveX,
          moveY: it.moveY,
          expanding: it.expanding,
        })),
      });
      if (inputHistoryRef.current.length > INPUT_HISTORY_MAX) {
        inputHistoryRef.current.shift();
      }
    });

    // postTickHook intent restore is no longer needed — the tick-tagged
    // model writes ManagedPlayer in preTickHook from a fresh queue
    // each tick, so there's no "stale slot value" to mask. Host's local
    // ManagedPlayer is owned by InputManager events between ticks (same
    // as before).
    game.setPostTickHook(null);
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
      const allPlayers = pm.getAllPlayers();
      // Ensure every current player has a slot before we serialize the
      // lobby. Slots are stable for the player's lifetime; ensureSlot is
      // a no-op when the slot already exists.
      for (const p of allPlayers) ensureSlot(p.playerId);
      // Free slots for players who left between the last broadcast and now.
      const currentIds = new Set(allPlayers.map((p) => p.playerId));
      for (const id of Array.from(slotByPlayerIdRef.current.keys())) {
        if (id !== LOCAL_PLAYER_ID_CONST && !currentIds.has(id)) releaseSlot(id);
      }
      const players = allPlayers.map((p) => {
        let kind: 'host' | 'guest' | 'bot' = 'guest';
        if (p.playerId === LOCAL_PLAYER_ID) kind = 'host';
        else if (botIds.has(p.playerId)) kind = 'bot';
        return {
          id: p.playerId,
          name: p.name,
          color: p.color,
          faceId: p.faceId,
          kind,
          slot: ensureSlot(p.playerId),
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
          phaseTimerMs: typeof ms.phaseTimer === 'number' ? ms.phaseTimer * 1000 : undefined,
          scores,
          winner: ms.winner ? { playerId: ms.winner, name: ms.winnerName ?? null } : null,
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

    const MAX_CONNECT_ATTEMPTS = 3;
    // Short backoff so a failed attempt rolls into a fresh one quickly —
    // the per-attempt timeout (8s) already absorbs Chrome's ICE pacing
    // window, so the backoff just needs to let signaling churn settle.
    const RETRY_BACKOFF_MS = 1000;
    const interval = setInterval(async () => {
      try {
        const room = roomRef.current;
        const manager = managerRef.current;
        if (!room || !manager) return;
        const detail = await room.getRoom();
        const remotePeers = detail.peers.filter((p) => !p.is_host);
        const remotePeerIds = new Set(remotePeers.map((p) => p.peer_id));
        const now = Date.now();

        // Open WebRTC connections to new peers, regardless of kind. If a peer
        // previously failed but is still in the room, bounded-retry — the
        // onPeerDisconnected handler clears knownPlayerIdsRef so we re-enter
        // here.
        for (const peer of remotePeers) {
          if (!knownPlayerIdsRef.current.has(peer.peer_id)) {
            const rec = connectAttemptsRef.current.get(peer.peer_id);
            if (rec) {
              if (rec.status === 'failed' && rec.attempts >= MAX_CONNECT_ATTEMPTS) {
                continue; // Gave up; let server TTL clean up.
              }
              if (rec.status === 'failed' && now - rec.lastAttemptMs < RETRY_BACKOFF_MS) {
                continue; // Honor backoff before retrying.
              }
              rec.attempts += 1;
              rec.lastAttemptMs = now;
              rec.status = 'connecting';
              console.info('[webrtc] retry', { peerId: peer.peer_id, attempt: rec.attempts });
            } else {
              connectAttemptsRef.current.set(peer.peer_id, {
                attempts: 1,
                lastAttemptMs: now,
                status: 'connecting',
              });
            }
            knownPlayerIdsRef.current.add(peer.peer_id);
            await manager.connectTo(peer.peer_id, peer.kind);
          }
        }

        // Cross-check: any player in our game whose underlying peer row has
        // vanished from the room (server TTL'd them, they left without a
        // clean disconnect, partially-connected screen that gave up) should
        // be removed from game state too. Without this the lobby player
        // count stays inflated — a guest who failed mid-handshake leaves a
        // phantom blob behind because we never saw a proper disconnect.
        const pm = gameRef.current?.getPlayerManager();
        const game = gameRef.current;
        const ctx = contextRef.current;
        if (pm) {
          const botIds = new Set(bots.map((b) => b.playerId));
          for (const p of pm.getAllPlayers()) {
            if (p.playerId === LOCAL_PLAYER_ID_CONST) continue;
            if (botIds.has(p.playerId)) continue;
            const guestInfo = guestPlayersRef.current.get(p.playerId);
            if (guestInfo) {
              // Guest-screen-owned player: prune if the owning screen peer
              // has left the room.
              if (!remotePeerIds.has(guestInfo.screenId)) {
                console.info('[webrtc] cleanup-stale-guest-player', { playerId: p.playerId, screenId: guestInfo.screenId });
                if (game && ctx) game.onPlayerDisconnect(ctx, p.playerId);
                guestPlayersRef.current.delete(p.playerId);
              }
              continue;
            }
            // Phone-controller path: playerId IS the peer_id.
            if (!remotePeerIds.has(p.playerId)) {
              console.info('[webrtc] cleanup-stale-player', { playerId: p.playerId });
              handlePlayerDisconnect(p.playerId);
            }
          }
        }

        // Drop attempt records for peers that have fully left the room.
        for (const id of Array.from(connectAttemptsRef.current.keys())) {
          if (!remotePeerIds.has(id)) connectAttemptsRef.current.delete(id);
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
  }, [roomReady, sessionId, bots, handlePlayerDisconnect]);

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
    // Module-level pacingConfig.paused persists across game instances
    // (it's set by the compare-hashes "pause both" button). When the
    // user leaves a paused game and starts a new one, the new game
    // boots with paused=true and never ticks — symptom: "host's new
    // game is frozen." Reset on every fresh canvas init.
    setPacingConfig({ paused: false });

    // Host-only debug bridge wiring for the compare-hashes diagnostic.
    setTogglePauseAccessor((paused) => {
      setPacingConfig({ paused });
      // Mirror to every guest so both sides freeze together.
      const evt = { type: 'set_paused' as const, paused };
      managerRef.current?.broadcast('state', JSON.stringify(evt), 'screen');
    });
    setCompareHashesAccessor(async (): Promise<CompareHashesResult> => {
      const requestId = ++hashRequestIdRef.current;
      // Snapshot host's own ring NOW so we compare apples-to-apples
      // with what's about to be sent by guests.
      const HOST_CAP = 60;
      const _hostAll = getHashHistory();
      const hostEntries = _hostAll.slice(Math.max(0, _hostAll.length - HOST_CAP));
      // Broadcast the request and wait for replies.
      const evt = { type: 'request_hashes' as const, requestId };
      managerRef.current?.broadcast('state', JSON.stringify(evt), 'screen');
      // 5s window — each guest response can be 240 ticks × per-tick
      // summary (5+ blobs × scalars + RNG/mode) ≈ tens of KB of JSON.
      // On the reliable WebRTC channel that's a couple of fragments,
      // but if a keyframe is in flight on the same channel the reply
      // can queue behind it. 5s is generous; the host's modal is gated
      // on this, so it's fine to wait.
      const WAIT_MS = 5000;
      console.info(`[netDiag] host broadcast request_hashes(req=${requestId}); awaiting ${WAIT_MS}ms`);
      await new Promise((r) => setTimeout(r, WAIT_MS));
      // Pick up only responses tagged with our requestId.
      const responses = hashesResponsesRef.current.filter((r) => r.requestId === requestId);
      console.info(
        `[netDiag] host wait window expired for req=${requestId}; got ${responses.length} response(s)`,
        responses.map((r) => `${r.peerId}:${r.entries.length}`).join(', ') || '(none)',
      );
      // Trim the bucket to keep memory bounded.
      hashesResponsesRef.current = hashesResponsesRef.current.slice(-20);
      // Merge: union of all tick numbers from host + every guest.
      // Each peer's per-tick value is { hash, summary? } so the modal
      // can expand rows to diff structured per-blob fields.
      type PeerEntry = { hash: string | null; summary?: import('../lib/hashHistory').TickSummary };
      const byPeer: Record<string, Map<number, PeerEntry>> = {
        host: new Map(hostEntries.map((e) => [e.tick, { hash: e.hash, summary: e.summary }])),
      };
      for (const r of responses) {
        byPeer[r.peerId] = new Map(r.entries.map((e) => [e.tick, { hash: e.hash, summary: e.summary }]));
      }
      const allTicks = new Set<number>();
      for (const m of Object.values(byPeer)) for (const t of m.keys()) allTicks.add(t);
      const sortedTicks = Array.from(allTicks).sort((a, b) => a - b);
      const peerIds = Object.keys(byPeer);
      return {
        peerIds,
        byTick: sortedTicks.map((tick) => {
          const hashes: Record<string, PeerEntry> = {};
          for (const pid of peerIds) hashes[pid] = byPeer[pid].get(tick) ?? { hash: null };
          return { tick, hashes };
        }),
      };
    });
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
    // Modal blocks room creation until the user submits. Once submitted,
    // hostConfig is non-null, the room-creation effect fires, and we
    // fall through to the "Creating session..." spinner.
    if (!hostConfig) {
      return (
        <HostSetupModal
          onSubmit={setHostConfig}
          onCancel={() => navigate('/')}
        />
      );
    }
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
          {showNetDebug && <NetDebugOverlay role="host" />}

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
      {showNetDebug && <NetDebugOverlay role="host" />}
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
