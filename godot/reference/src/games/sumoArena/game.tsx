// Sumo Arena Game - Physics-based multiplayer knockout game

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Game, GameContext, PlayerState, GameState } from '../GameInterface';
import { InputEvent } from '../../types';
import { DEFAULT_CONTROLLER_CONFIG } from '../../types/controllerConfig';
import { Player } from '../../types/database';
import { PhaserGameBridge, PhaserGameConfig } from './PhaserGame';
import {
  GamePhase,
  STARTING_LIVES,
} from './types';

// Player colors for the game
const PLAYER_COLORS = [
  0x3b82f6, // blue
  0xef4444, // red
  0x10b981, // green
  0xf59e0b, // amber
  0x8b5cf6, // purple
  0xec4899, // pink
  0x06b6d4, // cyan
  0xf97316, // orange
];

// Convert hex color to CSS string
const hexToCSS = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

interface SumoArenaPlayerState extends PlayerState {
  lives: number;
  isEliminated: boolean;
  color: number;
}

// Stable player status component - shows color and name only
const PlayerStatusBar: React.FC<{
  players: Player[];
  playerStates: Map<string, PlayerState>;
}> = React.memo(({ players, playerStates }) => {
  if (players.length === 0) return null;
  
  return (
    <div className="flex flex-col gap-1">
      {players.map((player) => {
        const playerId = player.user_id || player.anonymous_id || 'unknown';
        const playerState = playerStates.get(playerId) as SumoArenaPlayerState;
        // Use stored color from player state, fallback to first color
        const color = playerState?.color ? hexToCSS(playerState.color) : hexToCSS(PLAYER_COLORS[0]);
        const isEliminated = playerState?.isEliminated ?? false;

        return (
          <div
            key={playerId}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg bg-black/70 backdrop-blur-sm transition-all ${
              isEliminated ? 'opacity-40 line-through' : ''
            }`}
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="text-white font-medium text-sm">
              {player.name}
            </span>
          </div>
        );
      })}
    </div>
  );
});

PlayerStatusBar.displayName = 'PlayerStatusBar';

// React component that wraps the Phaser game - initialized once
const SumoArenaRenderer: React.FC<{
  context: GameContext;
  initialPlayers: Player[];
}> = ({ context, initialPlayers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<PhaserGameBridge | null>(null);
  const initializedRef = useRef(false);
  const [phase, setPhase] = useState<GamePhase>('map_vote');
  const [players, setPlayers] = useState<Player[]>(initialPlayers);

  // Store context ref for callbacks
  const contextRef = useRef(context);
  contextRef.current = context;

  // Initialize Phaser game ONCE
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    console.log('[SumoArena] Initializing Phaser game');

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
        onPlayerEliminated: (playerId, remainingLives) => {
          const playerState = contextRef.current.playerStates.get(playerId) as SumoArenaPlayerState;
          if (playerState) {
            playerState.lives = remainingLives;
            playerState.isEliminated = remainingLives <= 0;
          }
        },
        onRoundEnd: (winnerId) => {
          console.log('[SumoArena] Round ended, winner:', winnerId);
        },
        onGameOver: (winnerId) => {
          console.log('[SumoArena] Game over, winner:', winnerId);
        },
        onPhaseChange: (newPhase) => {
          setPhase(newPhase);
        },
        onArenaShink: (newRadius) => {
          console.log('[SumoArena] Arena shrunk to:', newRadius);
        },
        onPowerupCollected: (playerId, type) => {
          console.log('[SumoArena] Player', playerId, 'collected', type);
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
      bridge.addPlayer(playerId, player.name, color);
    });

    return () => {
      console.log('[SumoArena] Destroying Phaser game');
      bridge.destroy();
      bridgeRef.current = null;
      initializedRef.current = false;
    };
  }, []); // Empty deps - only run once

  // Update players list when it changes (for UI only)
  useEffect(() => {
    setPlayers(initialPlayers);
  }, [initialPlayers]);

  // Get phase display text
  const phaseText = useMemo(() => {
    switch (phase) {
      case 'map_vote': return 'Vote for Map';
      case 'countdown': return 'Get Ready!';
      case 'playing': return 'FIGHT!';
      case 'round_end': return 'Round Over';
      case 'game_over': return 'Game Over';
      default: return '';
    }
  }, [phase]);

  return (
    <div className="w-full h-full relative">
      {/* Phaser Game Container - full screen */}
      <div 
        ref={containerRef}
        className="absolute inset-0 bg-gray-900"
      />

      {/* Phase indicator - only show during playing phase (Phaser handles countdown/map vote UI) */}
      {phase === 'playing' && (
        <div className="absolute top-4 right-4 z-10">
          <div className="px-4 py-2 bg-green-600/80 backdrop-blur-sm rounded-full text-white font-bold border border-green-400/30 shadow-lg">
            🎮 {phaseText}
          </div>
        </div>
      )}
      {phase === 'round_end' && (
        <div className="absolute top-4 right-4 z-10">
          <div className="px-4 py-2 bg-amber-600/80 backdrop-blur-sm rounded-full text-white font-bold border border-amber-400/30 shadow-lg">
            🏆 {phaseText}
          </div>
        </div>
      )}

      {/* Player Status Bar - floating bottom-left */}
      <div className="absolute bottom-4 left-4 z-10">
        <PlayerStatusBar 
          players={players}
          playerStates={context.playerStates}
        />
      </div>
    </div>
  );
};

// Memoize the renderer to prevent unnecessary re-renders
const MemoizedSumoArenaRenderer = React.memo(SumoArenaRenderer, (prevProps, nextProps) => {
  // Only re-render if players array length changes
  return prevProps.initialPlayers.length === nextProps.initialPlayers.length;
});

// Main game object implementing the Game interface
const SumoArenaGame: Game = {
  gameDefinition: {
    id: 'sumo_arena',
    name: 'Sumo Arena',
    description: 'Knock opponents off the shrinking platform! Last player standing wins.',
    controllerConfig: DEFAULT_CONTROLLER_CONFIG,
  },

  initialize(_context: GameContext): GameState {
    return {
      phase: 'map_vote' as GamePhase,
      currentMapId: null,
      roundNumber: 0,
      controllerLayout: { left: 'joystick', right: 'button' },
    };
  },

  onPlayerJoin(context: GameContext, player: Player): void {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    
    // Check if player already has a state (rejoining) - keep their color
    const existingState = context.playerStates.get(playerId) as SumoArenaPlayerState | undefined;
    
    // Use existing color or assign new one based on total players ever joined
    let color: number;
    if (existingState?.color) {
      color = existingState.color;
    } else {
      // Count total unique players that have ever joined (use gameState to track)
      const colorIndex = (context.gameState as any)._nextColorIndex || 0;
      color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
      (context.gameState as any)._nextColorIndex = colorIndex + 1;
    }

    const playerState: SumoArenaPlayerState = {
      playerId,
      position: { x: 400, y: 300 },
      lives: STARTING_LIVES,
      isEliminated: false,
      color,
    };
    context.playerStates.set(playerId, playerState);

    // Add player to Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.addPlayer(playerId, player.name, color);
    }

    console.log(`[SumoArena] Player ${player.name} joined with color ${color.toString(16)}`);
  },

  onPlayerDisconnect(context: GameContext, playerId: string): void {
    context.playerStates.delete(playerId);

    // Remove from Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.removePlayer(playerId);
    }

    console.log(`[SumoArena] Player ${playerId} disconnected`);
  },

  onPlayerInput(context: GameContext, playerId: string, inputEvent: InputEvent): void {
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (!bridge) return;

    // Get or create input state
    let input = bridge.getPlayerInput(playerId);
    if (!input) {
      input = { joystick: { x: 0, y: 0 }, dashPressed: false };
    }

    // Update input based on event
    if (inputEvent.type === 'continuous' && inputEvent.inputType === 'joystick_left') {
      const joystick = inputEvent.value as { x: number; y: number };
      input.joystick = joystick;
    } else if (inputEvent.type === 'discrete' && inputEvent.inputType === 'button_right') {
      input.dashPressed = true;
      // Reset dash press after a short delay
      setTimeout(() => {
        const currentInput = bridge.getPlayerInput(playerId);
        if (currentInput) {
          currentInput.dashPressed = false;
          bridge.setPlayerInput(playerId, currentInput);
        }
      }, 100);
    }

    bridge.setPlayerInput(playerId, input);
  },

  // No-op: Phaser manages its own game loop
  update(_context: GameContext, _deltaTime: number): void {
    // Phaser handles its own update loop internally
    // This method is intentionally empty for Phaser-based games
  },

  render(context: GameContext, players: Player[], _colors: string[]): React.ReactNode {
    // Return memoized component to prevent Phaser re-initialization
    return (
      <MemoizedSumoArenaRenderer
        context={context}
        initialPlayers={players}
      />
    );
  },
};

export default SumoArenaGame;
