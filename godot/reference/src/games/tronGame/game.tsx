// Tron Game - Multiplayer light cycle battle

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Game, GameContext, PlayerState, GameState } from '../GameInterface';
import { InputEvent } from '../../types';
import { buildControllerConfig } from '../../types/controllerConfig';
import { Player } from '../../types/database';
import { PhaserGameBridge, PhaserGameConfig } from './PhaserGame';
import { GamePhase } from './types';

// Player colors for the game (up to 16 players) - Neon/Tron colors
const PLAYER_COLORS = [
  0x00ffff, // cyan
  0xff6600, // orange
  0xff00ff, // magenta
  0x00ff00, // lime
  0xffff00, // yellow
  0xff0088, // hot pink
  0x0088ff, // blue
  0xff4444, // red
  0x88ff00, // yellow-green
  0x8800ff, // purple
  0xff8800, // amber
  0x00ff88, // teal
  0xff0044, // crimson
  0x44ff00, // green
  0x0044ff, // royal blue
  0xff00aa, // pink
];

// Convert hex color to CSS string
const hexToCSS = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

interface TronPlayerState extends PlayerState {
  color: number;
  isAlive: boolean;
  placement: number;
  ghostCooldown: number; // 0-1 progress
}

// Controller config: left joystick for direction, right button for ghost mode
const TRON_CONTROLLER_CONFIG = buildControllerConfig(
  { left: 'joystick', right: 'button' },
  { left: 'Move', right: 'Ghost' }
);

// Player status component
const PlayerStatusBar: React.FC<{
  players: Player[];
  playerStates: Map<string, PlayerState>;
}> = React.memo(({ players, playerStates }) => {
  if (players.length === 0) return null;

  // Sort by alive status first, then by placement
  const sortedPlayers = [...players].sort((a, b) => {
    const stateA = playerStates.get(a.user_id || a.anonymous_id || '') as TronPlayerState;
    const stateB = playerStates.get(b.user_id || b.anonymous_id || '') as TronPlayerState;
    
    // Alive players first
    if (stateA?.isAlive !== stateB?.isAlive) {
      return stateA?.isAlive ? -1 : 1;
    }
    
    // Then by placement (lower is better)
    return (stateA?.placement || 99) - (stateB?.placement || 99);
  });

  return (
    <div className="flex flex-col gap-1">
      {sortedPlayers.map((player) => {
        const playerId = player.user_id || player.anonymous_id || 'unknown';
        const playerState = playerStates.get(playerId) as TronPlayerState;
        const color = playerState?.color ? hexToCSS(playerState.color) : hexToCSS(PLAYER_COLORS[0]);
        const isAlive = playerState?.isAlive ?? true;
        const placement = playerState?.placement || 0;

        return (
          <div
            key={playerId}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg backdrop-blur-sm transition-all ${
              isAlive ? 'bg-black/70' : 'bg-black/40 opacity-60'
            }`}
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ 
                backgroundColor: color,
                boxShadow: isAlive ? `0 0 10px ${color}` : 'none'
              }}
            />
            <span className={`text-white font-medium text-sm ${!isAlive ? 'line-through' : ''}`}>
              {player.name}
            </span>
            {!isAlive && placement > 0 && (
              <span className="text-gray-400 text-xs ml-auto">
                #{placement}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
});

PlayerStatusBar.displayName = 'PlayerStatusBar';

// React component that wraps the Phaser game
const TronRenderer: React.FC<{
  context: GameContext;
  initialPlayers: Player[];
}> = ({ context, initialPlayers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<PhaserGameBridge | null>(null);
  const initializedRef = useRef(false);
  const [phase, setPhase] = useState<GamePhase>('countdown');
  const [players, setPlayers] = useState<Player[]>(initialPlayers);

  // Store context ref for callbacks
  const contextRef = useRef(context);
  contextRef.current = context;

  // Initialize Phaser game ONCE
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    console.log('[TronGame] Initializing Phaser game');

    const containerWidth = containerRef.current.clientWidth || window.innerWidth;
    const containerHeight = containerRef.current.clientHeight || window.innerHeight;

    const config: PhaserGameConfig = {
      parentElement: containerRef.current,
      width: containerWidth,
      height: containerHeight,
      onStateUpdate: (state) => {
        Object.assign(contextRef.current.gameState, state);
      },
      events: {
        onPlayerEliminated: (playerId, placement) => {
          const playerState = contextRef.current.playerStates.get(playerId) as TronPlayerState;
          if (playerState) {
            playerState.isAlive = false;
            playerState.placement = placement;
          }
        },
        onPhaseChange: (newPhase) => {
          setPhase(newPhase);
        },
        onGameOver: (winnerId) => {
          console.log('[TronGame] Game over! Winner:', winnerId);
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
      console.log('[TronGame] Destroying Phaser game');
      bridge.destroy();
      bridgeRef.current = null;
      initializedRef.current = false;
    };
  }, []);

  // Update players list when it changes
  useEffect(() => {
    setPlayers(initialPlayers);
  }, [initialPlayers]);

  // Get phase display info
  const phaseInfo = useMemo(() => {
    switch (phase) {
      case 'countdown': return { text: 'Get Ready!', color: 'bg-yellow-600/80', emoji: '⏱️' };
      case 'playing': return { text: 'FIGHT!', color: 'bg-cyan-600/80', emoji: '⚡' };
      case 'round_end': return { text: 'Round Over', color: 'bg-blue-600/80', emoji: '🏆' };
      case 'game_over': return { text: 'Game Over', color: 'bg-purple-600/80', emoji: '🎮' };
      default: return { text: '', color: '', emoji: '' };
    }
  }, [phase]);

  return (
    <div className="w-full h-full relative">
      {/* Phaser Game Container */}
      <div 
        ref={containerRef}
        className="absolute inset-0 bg-black"
      />

      {/* Phase indicator */}
      {phase === 'playing' && (
        <div className="absolute top-4 right-4 z-10">
          <div className={`px-4 py-2 ${phaseInfo.color} backdrop-blur-sm rounded-full text-white font-bold border border-white/20 shadow-lg`}>
            {phaseInfo.emoji} {phaseInfo.text}
          </div>
        </div>
      )}

      {/* Player Status Bar */}
      <div className="absolute bottom-4 left-4 z-10">
        <PlayerStatusBar 
          players={players}
          playerStates={context.playerStates}
        />
      </div>

      {/* Ghost ability hint */}
      <div className="absolute bottom-4 right-4 z-10">
        <div className="px-3 py-2 bg-black/70 backdrop-blur-sm rounded-lg text-white text-xs">
          <span className="text-cyan-400">👻 Ghost:</span> Pass through trails
        </div>
      </div>
    </div>
  );
};

// Memoize the renderer
const MemoizedTronRenderer = React.memo(TronRenderer, (prevProps, nextProps) => {
  return prevProps.initialPlayers.length === nextProps.initialPlayers.length;
});

// Main game object implementing the Game interface
const TronGame: Game = {
  gameDefinition: {
    id: 'tron',
    name: 'Tron',
    description: 'Light cycle battle! Create trails and avoid collisions. Use ghost mode to pass through enemy trails.',
    controllerConfig: TRON_CONTROLLER_CONFIG,
  },

  initialize(_context: GameContext): GameState {
    return {
      phase: 'countdown' as GamePhase,
      currentMapId: null,
      _nextColorIndex: 0,
    };
  },

  onPlayerJoin(context: GameContext, player: Player): void {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    
    // Check if player already has a state (rejoining)
    const existingState = context.playerStates.get(playerId) as TronPlayerState | undefined;
    
    // Use existing color or assign new one
    let color: number;
    if (existingState?.color) {
      color = existingState.color;
    } else {
      const colorIndex = (context.gameState as any)._nextColorIndex || 0;
      color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
      (context.gameState as any)._nextColorIndex = colorIndex + 1;
    }

    const playerState: TronPlayerState = {
      playerId,
      position: { x: 0, y: 0 },
      color,
      isAlive: true,
      placement: 0,
      ghostCooldown: 1,
    };
    context.playerStates.set(playerId, playerState);

    // Add player to Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.addPlayer(playerId, player.name, color);
    }

    console.log(`[TronGame] Player ${player.name} joined with color ${color.toString(16)}`);
  },

  onPlayerDisconnect(context: GameContext, playerId: string): void {
    context.playerStates.delete(playerId);

    // Remove from Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.removePlayer(playerId);
    }

    console.log(`[TronGame] Player ${playerId} disconnected`);
  },

  onPlayerInput(context: GameContext, playerId: string, inputEvent: InputEvent): void {
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (!bridge) return;

    // Get or create input state
    let input = bridge.getPlayerInput(playerId);
    if (!input) {
      input = { movement: { x: 0, y: 0 }, ghostButton: false };
    }

    // Update input based on event
    if (inputEvent.type === 'continuous') {
      const joystick = inputEvent.value as { x: number; y: number };
      
      if (inputEvent.inputType === 'joystick_left') {
        input.movement = joystick;
      }
    } else if (inputEvent.type === 'discrete') {
      // Handle button input
      if (inputEvent.inputType === 'button_right') {
        const buttonValue = inputEvent.value as { pressed: boolean };
        input.ghostButton = buttonValue.pressed;
      }
    }

    bridge.setPlayerInput(playerId, input);
  },

  // Phaser manages its own game loop
  update(_context: GameContext, _deltaTime: number): void {
    // Phaser handles updates internally
  },

  render(context: GameContext, players: Player[], _colors: string[]): React.ReactNode {
    return (
      <MemoizedTronRenderer
        context={context}
        initialPlayers={players}
      />
    );
  },
};

export default TronGame;
