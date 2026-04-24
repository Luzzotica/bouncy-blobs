// Grid Shooter Game - Multiplayer top-down shooter with grid-based maps

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Game, GameContext, PlayerState, GameState } from '../GameInterface';
import { InputEvent } from '../../types';
import { buildControllerConfig } from '../../types/controllerConfig';
import { Player } from '../../types/database';
import { PhaserGameBridge, PhaserGameConfig } from './PhaserGame';
import {
  GamePhase,
  GameMode,
  Team,
} from './types';

// Player colors for the game (up to 16 players)
const PLAYER_COLORS = [
  0x3b82f6, // blue
  0xef4444, // red
  0x10b981, // green
  0xf59e0b, // amber
  0x8b5cf6, // purple
  0xec4899, // pink
  0x06b6d4, // cyan
  0xf97316, // orange
  0x84cc16, // lime
  0xf43f5e, // rose
  0x14b8a6, // teal
  0xa855f7, // fuchsia
  0x22c55e, // emerald
  0xeab308, // yellow
  0x6366f1, // indigo
  0x0ea5e9, // sky
];

// Convert hex color to CSS string
const hexToCSS = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

interface GridShooterPlayerState extends PlayerState {
  kills: number;
  deaths: number;
  team: Team;
  color: number;
  isAlive: boolean;
}

// Controller config for two joysticks
const GRID_SHOOTER_CONTROLLER_CONFIG = buildControllerConfig(
  { left: 'joystick', right: 'joystick' },
  { left: 'Move', right: 'Aim & Shoot' }
);

// Stable player status component
const PlayerStatusBar: React.FC<{
  players: Player[];
  playerStates: Map<string, PlayerState>;
  gameMode: GameMode | null;
}> = React.memo(({ players, playerStates, gameMode }) => {
  if (players.length === 0) return null;

  // Group by team if in team mode
  const isTeamMode = gameMode === 'team_deathmatch' || gameMode === 'capture_the_flag';

  const sortedPlayers = [...players].sort((a, b) => {
    const stateA = playerStates.get(a.user_id || a.anonymous_id || '') as GridShooterPlayerState;
    const stateB = playerStates.get(b.user_id || b.anonymous_id || '') as GridShooterPlayerState;
    
    if (isTeamMode) {
      // Sort by team first
      const teamOrder = { red: 0, blue: 1, none: 2 };
      const teamDiff = teamOrder[stateA?.team || 'none'] - teamOrder[stateB?.team || 'none'];
      if (teamDiff !== 0) return teamDiff;
    }
    
    // Then by kills
    return (stateB?.kills || 0) - (stateA?.kills || 0);
  });

  return (
    <div className="flex flex-col gap-1">
      {sortedPlayers.map((player) => {
        const playerId = player.user_id || player.anonymous_id || 'unknown';
        const playerState = playerStates.get(playerId) as GridShooterPlayerState;
        const color = playerState?.color ? hexToCSS(playerState.color) : hexToCSS(PLAYER_COLORS[0]);
        const kills = playerState?.kills ?? 0;
        const deaths = playerState?.deaths ?? 0;
        const isAlive = playerState?.isAlive ?? true;
        const team = playerState?.team;

        return (
          <div
            key={playerId}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg backdrop-blur-sm transition-all ${
              isAlive ? 'bg-black/70' : 'bg-black/40 opacity-60'
            }`}
            style={{
              borderLeft: isTeamMode && team !== 'none' 
                ? `3px solid ${team === 'red' ? '#ff4444' : '#4488ff'}`
                : 'none',
            }}
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className={`text-white font-medium text-sm ${!isAlive ? 'line-through' : ''}`}>
              {player.name}
            </span>
            <span className="text-gray-400 text-xs ml-auto">
              {kills}/{deaths}
            </span>
          </div>
        );
      })}
    </div>
  );
});

PlayerStatusBar.displayName = 'PlayerStatusBar';

// React component that wraps the Phaser game
const GridShooterRenderer: React.FC<{
  context: GameContext;
  initialPlayers: Player[];
}> = ({ context, initialPlayers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<PhaserGameBridge | null>(null);
  const initializedRef = useRef(false);
  const [phase, setPhase] = useState<GamePhase>('mode_select');
  const [gameMode, setGameMode] = useState<GameMode | null>(null);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);

  // Store context ref for callbacks
  const contextRef = useRef(context);
  contextRef.current = context;

  // Initialize Phaser game ONCE
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    console.log('[GridShooter] Initializing Phaser game');

    // Get container dimensions for responsive sizing
    const containerWidth = containerRef.current.clientWidth || window.innerWidth;
    const containerHeight = containerRef.current.clientHeight || window.innerHeight;

    const config: PhaserGameConfig = {
      parentElement: containerRef.current,
      width: containerWidth,
      height: containerHeight,
      onStateUpdate: (state) => {
        // Update context game state
        Object.assign(contextRef.current.gameState, state);
      },
      events: {
        onPlayerKilled: (killerId, victimId) => {
          const killerState = contextRef.current.playerStates.get(killerId) as GridShooterPlayerState;
          const victimState = contextRef.current.playerStates.get(victimId) as GridShooterPlayerState;
          if (killerState) killerState.kills = (killerState.kills || 0) + 1;
          if (victimState) {
            victimState.deaths = (victimState.deaths || 0) + 1;
            victimState.isAlive = false;
          }
        },
        onPlayerRespawn: (playerId) => {
          const playerState = contextRef.current.playerStates.get(playerId) as GridShooterPlayerState;
          if (playerState) playerState.isAlive = true;
        },
        onFlagPickup: (playerId, flagTeam) => {
          console.log('[GridShooter] Player', playerId, 'picked up', flagTeam, 'flag');
        },
        onFlagCapture: (playerId, flagTeam) => {
          console.log('[GridShooter] Player', playerId, 'captured', flagTeam, 'flag');
        },
        onFlagReturn: (flagTeam) => {
          console.log('[GridShooter] Flag', flagTeam, 'returned');
        },
        onScoreUpdate: (scores) => {
          (contextRef.current.gameState as any).scores = scores;
        },
        onPhaseChange: (newPhase) => {
          setPhase(newPhase);
        },
        onGameModeSelected: (mode) => {
          setGameMode(mode);
          (contextRef.current.gameState as any).gameMode = mode;
        },
        onGameOver: (winnerId, winningTeam) => {
          console.log('[GridShooter] Game over! Winner:', winnerId || winningTeam);
        },
      },
    };

    const bridge = new PhaserGameBridge(config);
    bridge.init();
    bridgeRef.current = bridge;

    // Store bridge reference in context for input handling
    (contextRef.current.gameState as any)._phaserBridge = bridge;

    // Add initial players
    initialPlayers.forEach((player, index) => {
      const playerId = player.user_id || player.anonymous_id || 'unknown';
      const color = PLAYER_COLORS[index % PLAYER_COLORS.length];
      bridge.addPlayer(playerId, player.name, color, 'none');
    });

    return () => {
      console.log('[GridShooter] Destroying Phaser game');
      bridge.destroy();
      bridgeRef.current = null;
      initializedRef.current = false;
    };
  }, []); // Empty deps - only run once

  // Update players list when it changes (for UI only)
  useEffect(() => {
    setPlayers(initialPlayers);
  }, [initialPlayers]);

  // Get phase display info
  const phaseInfo = useMemo(() => {
    switch (phase) {
      case 'mode_select': return { text: 'Select Mode', color: 'bg-amber-600/80', emoji: '🎮' };
      case 'map_vote': return { text: 'Vote for Map', color: 'bg-purple-600/80', emoji: '🗺️' };
      case 'countdown': return { text: 'Get Ready!', color: 'bg-yellow-600/80', emoji: '⏱️' };
      case 'playing': return { text: 'FIGHT!', color: 'bg-green-600/80', emoji: '🔫' };
      case 'round_end': return { text: 'Round Over', color: 'bg-blue-600/80', emoji: '🏆' };
      case 'game_over': return { text: 'Game Over', color: 'bg-red-600/80', emoji: '🎯' };
      default: return { text: '', color: '', emoji: '' };
    }
  }, [phase]);

  return (
    <div className="w-full h-full relative">
      {/* Phaser Game Container - full screen */}
      <div 
        ref={containerRef}
        className="absolute inset-0 bg-gray-900"
      />

      {/* Phase indicator - show during gameplay */}
      {phase === 'playing' && (
        <div className="absolute top-4 right-4 z-10">
          <div className={`px-4 py-2 ${phaseInfo.color} backdrop-blur-sm rounded-full text-white font-bold border border-white/20 shadow-lg`}>
            {phaseInfo.emoji} {phaseInfo.text}
          </div>
        </div>
      )}

      {/* Player Status Bar - floating bottom-left */}
      <div className="absolute bottom-4 left-4 z-10">
        <PlayerStatusBar 
          players={players}
          playerStates={context.playerStates}
          gameMode={gameMode}
        />
      </div>
    </div>
  );
};

// Memoize the renderer to prevent unnecessary re-renders
const MemoizedGridShooterRenderer = React.memo(GridShooterRenderer, (prevProps, nextProps) => {
  // Only re-render if players array length changes
  return prevProps.initialPlayers.length === nextProps.initialPlayers.length;
});

// Main game object implementing the Game interface
const GridShooterGame: Game = {
  gameDefinition: {
    id: 'grid_shooter',
    name: 'Grid Shooter',
    description: 'Top-down shooter with multiple game modes. Supports up to 16 players!',
    controllerConfig: GRID_SHOOTER_CONTROLLER_CONFIG,
  },

  initialize(_context: GameContext): GameState {
    return {
      phase: 'mode_select' as GamePhase,
      gameMode: null as GameMode | null,
      currentMapId: null,
      scores: { ffa: new Map(), red: 0, blue: 0 },
      controllerLayout: { left: 'joystick', right: 'joystick' },
      _nextColorIndex: 0,
      _teamJoinCounter: 0, // Counter to track join order for team assignment
    };
  },

  onPlayerJoin(context: GameContext, player: Player): void {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    
    // Check if player already has a state (rejoining)
    const existingState = context.playerStates.get(playerId) as GridShooterPlayerState | undefined;
    
    // Use existing color or assign new one
    let color: number;
    let team: Team = 'none';
    
    if (existingState?.color) {
      color = existingState.color;
      team = existingState.team || 'none';
      
      // Reassign team if player has 'none' but game mode requires teams
      const gameMode = (context.gameState as any).gameMode as GameMode | null;
      if (team === 'none' && (gameMode === 'team_deathmatch' || gameMode === 'capture_the_flag')) {
        const joinCounter = (context.gameState as any)._teamJoinCounter || 0;
        team = joinCounter % 2 === 0 ? 'red' : 'blue';
        (context.gameState as any)._teamJoinCounter = joinCounter + 1;
      }
    } else {
      const colorIndex = (context.gameState as any)._nextColorIndex || 0;
      color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
      (context.gameState as any)._nextColorIndex = colorIndex + 1;
      
      // Assign team if in team mode
      const gameMode = (context.gameState as any).gameMode as GameMode | null;
      if (gameMode === 'team_deathmatch' || gameMode === 'capture_the_flag') {
        // Use join counter to explicitly alternate teams
        // Even numbers -> red, odd numbers -> blue
        const joinCounter = (context.gameState as any)._teamJoinCounter || 0;
        team = joinCounter % 2 === 0 ? 'red' : 'blue';
        (context.gameState as any)._teamJoinCounter = joinCounter + 1;
      }
    }

    const playerState: GridShooterPlayerState = {
      playerId,
      position: { x: 400, y: 300 },
      kills: existingState?.kills || 0,
      deaths: existingState?.deaths || 0,
      team,
      color,
      isAlive: true,
    };
    context.playerStates.set(playerId, playerState);

    // Add player to Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.addPlayer(playerId, player.name, color, team);
    }

    console.log(`[GridShooter] Player ${player.name} joined with color ${color.toString(16)}, team: ${team}`);
  },

  onPlayerDisconnect(context: GameContext, playerId: string): void {
    context.playerStates.delete(playerId);

    // Remove from Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.removePlayer(playerId);
    }

    console.log(`[GridShooter] Player ${playerId} disconnected`);
  },

  onPlayerInput(context: GameContext, playerId: string, inputEvent: InputEvent): void {
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (!bridge) return;

    // Get or create input state
    let input = bridge.getPlayerInput(playerId);
    if (!input) {
      input = { movement: { x: 0, y: 0 }, aim: { x: 0, y: 0 } };
    }

    // Update input based on event
    if (inputEvent.type === 'continuous') {
      const joystick = inputEvent.value as { x: number; y: number };
      
      if (inputEvent.inputType === 'joystick_left') {
        input.movement = joystick;
      } else if (inputEvent.inputType === 'joystick_right') {
        input.aim = joystick;
      }
    }

    bridge.setPlayerInput(playerId, input);
  },

  // No-op: Phaser manages its own game loop
  update(_context: GameContext, _deltaTime: number): void {
    // Phaser handles its own update loop internally
  },

  render(context: GameContext, players: Player[], _colors: string[]): React.ReactNode {
    // Return memoized component to prevent Phaser re-initialization
    return (
      <MemoizedGridShooterRenderer
        context={context}
        initialPlayers={players}
      />
    );
  },
};

export default GridShooterGame;

