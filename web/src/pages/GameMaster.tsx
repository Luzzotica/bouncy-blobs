import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { useUser } from '../contexts/UserContext';
import { createHostSession, SignalingService, HostWebRTCManager } from '../lib/party';
import type { PartyPlayer, HostCallbacks } from '../lib/party';
import { partyConfig } from '../lib/partyConfig';
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
import { VotingMode, VotingCandidate as VotingCandidateType } from '../game/gameModes/votingMode';

import { getAvailableLevels, loadBuiltinLevel } from '../levels/levelRegistry';

// Re-export for use elsewhere
export type VotingCandidate = VotingCandidateType;

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

function partyPlayerToPlayer(pp: PartyPlayer, sessionId: string): Player {
  return {
    player_id: pp.player_id,
    session_id: sessionId,
    name: pp.display_name,
    slot: pp.slot,
    status: pp.status,
    controller_config: null,
    joined_at: pp.joined_at,
  };
}

type SessionPhase = 'creating' | 'voting' | 'playing' | 'error';

export default function GameMaster() {
  const { anonymousId } = useUser();
  const { session: authSession, user: authUser } = useAuth();
  const authSessionRef = useRef(authSession);
  authSessionRef.current = authSession;
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;
  const [searchParams] = useSearchParams();

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
  const managerRef = useRef<HostWebRTCManager | null>(null);
  const signalingRef = useRef<SignalingService | null>(null);
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
  // Reference to the active voting mode for resolving votes / starting countdown
  const votingModeRef = useRef<VotingMode | null>(null);

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

  /** Build and broadcast the current taken colors/faces to all controllers. */
  const broadcastCustomizationUpdate = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    const takenColors: string[] = [];
    const takenFaces: string[] = [];
    for (const [, custom] of playerCustomRef.current) {
      if (custom.color) takenColors.push(custom.color);
      if (custom.faceId) takenFaces.push(custom.faceId);
    }
    manager.broadcast(JSON.stringify({
      type: 'customization_update',
      value: { takenColors, takenFaces },
    }));
  }, []);

  /** Send taken customizations to a specific player. */
  const sendCustomizationTo = useCallback((playerId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    const takenColors: string[] = [];
    const takenFaces: string[] = [];
    for (const [, custom] of playerCustomRef.current) {
      if (custom.color) takenColors.push(custom.color);
      if (custom.faceId) takenFaces.push(custom.faceId);
    }
    manager.send(playerId, JSON.stringify({
      type: 'customization_update',
      value: { takenColors, takenFaces },
    }));
  }, []);

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
    if (gameRef.current && contextRef.current) {
      gameRef.current.onPlayerDisconnect(contextRef.current, playerId);
    }
    // Broadcast updated taken list to all controllers
    broadcastCustomizationUpdate();
  }, [broadcastCustomizationUpdate]);

  // Broadcast a message to all connected controllers
  const broadcastToControllers = useCallback((message: any) => {
    const manager = managerRef.current;
    if (!manager) return;
    const json = JSON.stringify(message);
    manager.broadcast(json);
  }, []);

  // Load the actual level data for a voting candidate
  const loadCandidateLevel = useCallback(async (candidate: VotingCandidate): Promise<LevelData> => {
    if (candidate.source === 'builtin') {
      const builtinId = candidate.id.replace('builtin:', '');
      return loadBuiltinLevel(builtinId);
    }
    // Cloud level
    const cloudId = candidate.id.replace('cloud:', '');
    return contentApi.loadLevel(cloudId);
  }, []);

  // Fetch voting candidates (built-in + cloud)
  const fetchCandidates = useCallback(async (): Promise<VotingCandidate[]> => {
    // Load built-in levels from manifest
    const candidates: VotingCandidate[] = [];
    try {
      const manifest = await getAvailableLevels();
      for (const entry of manifest) {
        if (entry.id === 'default') continue; // skip default arena from voting
        candidates.push({
          id: `builtin:${entry.id}`,
          name: entry.name,
          levelType: entry.levelTypes?.[0] ?? 'solo_racing',
          levelTypes: entry.levelTypes,
          source: 'builtin',
        });
      }
    } catch (err) {
      console.warn('Failed to load level manifest:', err);
    }
    try {
      // If authenticated, fetch user's own levels + public levels; otherwise public only
      const session = authSessionRef.current;
      const cloudItems = session
        ? await contentApi.listLevels(session)
        : await contentApi.listPublicLevels();
      const userId = authUserRef.current?.id;
      for (const item of cloudItems) {
        candidates.push({
          id: `cloud:${item.id}`,
          name: item.name,
          levelType: 'solo_racing', // default; actual type loaded when selected
          source: 'cloud',
          isOwn: userId ? item.creatorId === userId : false,
        });
      }
    } catch (err) {
      console.warn('Failed to fetch levels for voting:', err);
    }
    return candidates;
  }, []);

  // ─── Core game lifecycle ──────────────────────────────────────────────────
  // Use refs to break circular dependency between createVotingGame <-> startGameWithLevel
  const createVotingGameRef = useRef<(sid: string) => Promise<void>>();
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

  /** Create and start a voting game. Players move freely; auto-countdown starts when all on platforms. */
  const createVotingGame = useCallback(async (sid: string) => {
    const candidates = await fetchCandidates();
    if (candidates.length === 0) return;

    // Destroy any existing game
    gameRef.current?.destroy();
    gameRef.current = null;

    const game = new BouncyBlobsGame();
    gameRef.current = game;

    const votingMode = new VotingMode(candidates, () => {});
    votingModeRef.current = votingMode;
    game.setGameMode(votingMode);
    game.setAllowCountdownInput(true);

    game.setPhaseChangeCallback((gp) => {
      setGamePhase(gp);
      if (gp === 'results') {
        const winner = votingMode.resolveVote();
        setTimeout(async () => {
          gameRef.current?.destroy();
          gameRef.current = null;
          votingModeRef.current = null;
          setGamePhase(null);
          try {
            const levelData = await loadCandidateLevel(winner);
            startGameWithLevelRef.current?.(sid, levelData, winner.levelType);
          } catch (err: any) {
            console.error('Failed to load level:', err);
            createVotingGameRef.current?.(sid);
          }
        }, (votingMode.config.resultsDuration + 0.5) * 1000);
      }
    });

    const context = makeContext(sid);
    contextRef.current = context;
    game.initialize(context);
    spawnExistingPlayers(game, context);

    setPhase('voting');
    setCanvasKey(k => k + 1);

    setTimeout(() => { game.startRound(); }, 100);
  }, [fetchCandidates, loadCandidateLevel, makeContext, spawnExistingPlayers]);

  /** Start a game with a specific level (after voting resolves). */
  const startGameWithLevel = useCallback((sid: string, levelData: LevelData, overrideMode?: LevelType) => {
    const game = new BouncyBlobsGame();
    gameRef.current = game;

    const mode = createModeForLevel(levelData, broadcastToControllers, overrideMode);
    game.setGameMode(mode);
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
          createVotingGameRef.current?.(sid);
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
  createVotingGameRef.current = createVotingGame;
  startGameWithLevelRef.current = startGameWithLevel;

  // ─── Session setup ────────────────────────────────────────────────────────

  // Create session on mount, then immediately launch voting
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const inputManager = inputManagerRef.current;

        const callbacks: HostCallbacks = {
          onPlayerConnected: (playerId) => {
            // Send currently-taken colors/faces so the controller can show availability
            setTimeout(() => sendCustomizationTo(playerId), 100);
          },
          onPlayerDisconnected: (playerId) => {
            handlePlayerDisconnect(playerId);
          },
          onMessage: (playerId, data) => {
            try {
              const message: WebRTCMessage = JSON.parse(data as string);
              if (message.type === 'player_join' && message.player) {
                handlePlayerJoin(message.player, playerId);
                return;
              }
              // Route party mode messages
              if (message.type === 'item_select' || message.type === 'cursor_move' || message.type === 'placement_confirm') {
                handlePartyMessage(playerId, message);
                return;
              }
              inputManager.handleWebRTCMessage(message, playerId);
            } catch (e) {
              console.error('Failed to parse WebRTC message:', e);
            }
          },
          onError: (err) => {
            console.error('WebRTC error:', err);
          },
        };

        const { result, manager, signaling } = await createHostSession(
          partyConfig,
          { game_id: 'bouncy-blobs' },
          callbacks,
        );

        if (cancelled) {
          manager.dispose();
          return;
        }

        managerRef.current = manager;
        signalingRef.current = signaling;

        const sid = result.session_id;
        setSessionId(sid);
        setJoinCode(result.join_code);

        const origin = window.location.origin;
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
        await createVotingGame(sid);
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
      inputManagerRef.current.clear();
    };
  }, []);

  // Poll for new players via hexii API
  useEffect(() => {
    if (!sessionId || !signalingRef.current) return;

    const interval = setInterval(async () => {
      try {
        const session = await signalingRef.current!.getSession(sessionId);
        const players = session.players.map((pp) => partyPlayerToPlayer(pp, sessionId));
        setConnectedPlayers(players);

        // Create WebRTC connections for new players (sequential to avoid races)
        for (const player of players) {
          if (!knownPlayerIdsRef.current.has(player.player_id)) {
            knownPlayerIdsRef.current.add(player.player_id);
            await managerRef.current?.connectToPlayer(player.player_id);
          }
        }
      } catch (err) {
        console.warn('Failed to poll session:', err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [sessionId]);

  const onCanvasInit = useCallback((ctx: CanvasRenderingContext2D, width: number, height: number) => {
    const game = gameRef.current;
    if (!game) return;
    game.setCanvas(ctx.canvas, ctx, width, height);
    game.start();
  }, []);

  const onCanvasResize = useCallback((width: number, height: number) => {
    gameRef.current?.setCanvasSize(width, height);
  }, []);


  // End the session on unmount
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  useEffect(() => {
    return () => {
      const sid = sessionIdRef.current;
      if (sid && signalingRef.current) {
        signalingRef.current.endSession(sid).catch(() => {});
      }
    };
  }, []);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ color: '#f66', fontSize: 16 }}>Error: {errorMsg}</p>
        <Link to="/"><button style={{ padding: '8px 16px', fontSize: 14 }}>Home</button></Link>
      </div>
    );
  }

  if (phase === 'creating') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#aaa', fontSize: 16 }}>Creating session...</p>
      </div>
    );
  }

  // Voting phase — the main "lobby". Players spawn in and move around.
  if (phase === 'voting') {
    return (
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />

        {/* Top-left controls */}
        <div style={{
          position: 'absolute',
          top: 12,
          left: 12,
          display: 'flex',
          gap: 12,
          alignItems: 'center',
        }}>
          <Link to="/">
            <button style={{ padding: '6px 12px', fontSize: 13 }}>Home</button>
          </Link>
          <span style={{ color: '#888', fontSize: 13 }}>
            Players: {gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0}
          </span>
        </div>

        {/* Join info overlay (bottom-right): QR code + join code */}
        {joinUrl && (
          <div
            onClick={() => navigator.clipboard.writeText(joinUrl)}
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
            <div style={{
              padding: 8,
              background: '#fff',
              borderRadius: 10,
              lineHeight: 0,
            }}>
              <QRCodeSVG value={joinUrl} size={110} />
            </div>
            {joinCode && (
              <div style={{
                padding: '4px 12px',
                background: 'rgba(30, 45, 74, 0.85)',
                borderRadius: 6,
                backdropFilter: 'blur(4px)',
              }}>
                <span style={{ color: '#fff', fontSize: 22, fontWeight: 'bold', letterSpacing: 4 }}>
                  {joinCode}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Playing phase — no join info, just game + home button
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <GameCanvas key={canvasKey} onInit={onCanvasInit} onResize={onCanvasResize} />
      <div style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        gap: 12,
        alignItems: 'center',
      }}>
        <Link to="/">
          <button style={{ padding: '6px 12px', fontSize: 13 }}>Home</button>
        </Link>
        <span style={{ color: '#888', fontSize: 13 }}>
          Players: {gameRef.current?.getPlayerManager()?.getPlayerCount() ?? 0}
        </span>
      </div>
    </div>
  );
}
