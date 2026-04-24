// Pico Park - Cooperative platformer where players must work together to reach the goal

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Game, GameContext, PlayerState, GameState } from '../GameInterface';
import { InputEvent } from '../../types';
import { buildControllerConfig } from '../../types/controllerConfig';
import { Player } from '../../types/database';
import { PhaserGameBridge, PhaserGameConfig } from './PhaserGame';
import {
  GamePhase,
  PLAYER_COLORS,
} from './types';

// Convert hex color to CSS string
const hexToCSS = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

interface PicoParkPlayerState extends PlayerState {
  coinsCollected: number;
  color: number;
  isAtGoal: boolean;
}

// Controller config: left joystick for movement, right button for jump
const PICO_PARK_CONTROLLER_CONFIG = buildControllerConfig(
  { left: 'joystick', right: 'button' },
  { left: 'Move', right: 'Jump' }
);

// Stable player status component
const PlayerStatusBar: React.FC<{
  players: Player[];
  playerStates: Map<string, PlayerState>;
}> = React.memo(({ players, playerStates }) => {
  if (players.length === 0) return null;

  const sortedPlayers = [...players].sort((a, b) => {
    const stateA = playerStates.get(a.user_id || a.anonymous_id || '') as PicoParkPlayerState;
    const stateB = playerStates.get(b.user_id || b.anonymous_id || '') as PicoParkPlayerState;
    // Sort by coins collected
    return (stateB?.coinsCollected || 0) - (stateA?.coinsCollected || 0);
  });

  return (
    <div className="flex flex-col gap-1">
      {sortedPlayers.map((player) => {
        const playerId = player.user_id || player.anonymous_id || 'unknown';
        const playerState = playerStates.get(playerId) as PicoParkPlayerState;
        const color = playerState?.color ? hexToCSS(playerState.color) : hexToCSS(PLAYER_COLORS[0]);
        const coins = playerState?.coinsCollected ?? 0;
        const isAtGoal = playerState?.isAtGoal ?? false;

        return (
          <div
            key={playerId}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg backdrop-blur-sm transition-all ${
              isAtGoal ? 'bg-green-900/70 border border-green-500/50' : 'bg-black/70'
            }`}
          >
            <div
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className={`text-white font-medium text-sm`}>
              {player.name}
            </span>
            <span className="text-yellow-400 text-xs ml-auto flex items-center gap-1">
              <span>🪙</span>
              {coins}
            </span>
            {isAtGoal && (
              <span className="text-green-400 text-xs">✓</span>
            )}
          </div>
        );
      })}
    </div>
  );
});

PlayerStatusBar.displayName = 'PlayerStatusBar';

// React component that wraps the Phaser game
const PicoParkRenderer: React.FC<{
  context: GameContext;
  initialPlayers: Player[];
}> = ({ context, initialPlayers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bridgeRef = useRef<PhaserGameBridge | null>(null);
  const initializedRef = useRef(false);
  const [phase, setPhase] = useState<GamePhase>('level_select');
  const [levelTime, setLevelTime] = useState(0);
  const [playersAtGoal, setPlayersAtGoal] = useState(0);
  const [totalPlayers, setTotalPlayers] = useState(initialPlayers.length);
  const [players, setPlayers] = useState<Player[]>(initialPlayers);

  // Store context ref for callbacks
  const contextRef = useRef(context);
  contextRef.current = context;

  // Initialize Phaser game ONCE
  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return;
    initializedRef.current = true;

    console.log('[PicoPark] Initializing Phaser game');

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
        
        // Update local state for UI
        if (state.levelTime !== undefined) {
          setLevelTime(state.levelTime);
        }
        if (state.playersAtGoal !== undefined) {
          setPlayersAtGoal((state.playersAtGoal as Set<string>).size);
        }
      },
      events: {
        onCoinCollected: (playerId, _coinId) => {
          const playerState = contextRef.current.playerStates.get(playerId) as PicoParkPlayerState;
          if (playerState) {
            playerState.coinsCollected = (playerState.coinsCollected || 0) + 1;
          }
        },
        onPlayerReachedGoal: (playerId) => {
          const playerState = contextRef.current.playerStates.get(playerId) as PicoParkPlayerState;
          if (playerState) playerState.isAtGoal = true;
        },
        onPlayerLeftGoal: (playerId) => {
          const playerState = contextRef.current.playerStates.get(playerId) as PicoParkPlayerState;
          if (playerState) playerState.isAtGoal = false;
        },
        onLevelComplete: (time, scores) => {
          console.log('[PicoPark] Level complete! Time:', time, 'Scores:', scores);
        },
        onLevelReset: (reason) => {
          console.log('[PicoPark] Level reset:', reason);
          // Reset player states
          for (const [, state] of contextRef.current.playerStates) {
            (state as PicoParkPlayerState).isAtGoal = false;
          }
        },
        onPhaseChange: (newPhase) => {
          setPhase(newPhase);
        },
        onLevelSelected: (levelId) => {
          console.log('[PicoPark] Level selected:', levelId);
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

    setTotalPlayers(initialPlayers.length);

    return () => {
      console.log('[PicoPark] Destroying Phaser game');
      bridge.destroy();
      bridgeRef.current = null;
      initializedRef.current = false;
    };
  }, []); // Empty deps - only run once

  // Update players list when it changes (for UI only)
  useEffect(() => {
    setPlayers(initialPlayers);
    setTotalPlayers(initialPlayers.length);
  }, [initialPlayers]);

  // Format time display
  const formatTime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const centiseconds = Math.floor((ms % 1000) / 10);
    return `${minutes}:${secs.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  };

  // Get phase display info
  const phaseInfo = useMemo(() => {
    switch (phase) {
      case 'level_select': return { text: 'Select Level', color: 'bg-amber-600/80', showTimer: false };
      case 'countdown': return { text: 'Get Ready!', color: 'bg-yellow-600/80', showTimer: false };
      case 'playing': return { text: '', color: '', showTimer: true };
      case 'level_complete': return { text: 'Level Complete!', color: 'bg-green-600/80', showTimer: true };
      case 'results': return { text: 'Results', color: 'bg-blue-600/80', showTimer: false };
      default: return { text: '', color: '', showTimer: false };
    }
  }, [phase]);

  return (
    <div className="w-full h-full relative">
      {/* Phaser Game Container - full screen */}
      <div 
        ref={containerRef}
        className="absolute inset-0 bg-gray-900"
      />

      {/* Timer and goal progress - show during gameplay */}
      {phase === 'playing' && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
          <div className="px-6 py-2 bg-black/70 backdrop-blur-sm rounded-full text-white font-mono text-2xl border border-white/20 shadow-lg">
            {formatTime(levelTime)}
          </div>
          <div className="px-4 py-1 bg-black/60 backdrop-blur-sm rounded-full text-white text-sm">
            {playersAtGoal}/{totalPlayers} at goal
          </div>
        </div>
      )}

      {/* Phase indicator - show during non-playing phases */}
      {phaseInfo.text && (
        <div className="absolute top-4 right-4 z-10">
          <div className={`px-4 py-2 ${phaseInfo.color} backdrop-blur-sm rounded-full text-white font-bold border border-white/20 shadow-lg`}>
            {phaseInfo.text}
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
const MemoizedPicoParkRenderer = React.memo(PicoParkRenderer, (prevProps, nextProps) => {
  // Only re-render if players array length changes
  return prevProps.initialPlayers.length === nextProps.initialPlayers.length;
});

// Main game object implementing the Game interface
const PicoParkGame: Game = {
  gameDefinition: {
    id: 'pico_park',
    name: 'Pico Park',
    description: 'Cooperative platformer where all players must reach the goal together. Collect coins for individual scoring!',
    controllerConfig: PICO_PARK_CONTROLLER_CONFIG,
  },

  initialize(_context: GameContext): GameState {
    return {
      phase: 'level_select' as GamePhase,
      currentLevel: null,
      levelTime: 0,
      playersAtGoal: new Set<string>(),
      controllerLayout: { left: 'joystick', right: 'button' },
    };
  },

  onPlayerJoin(context: GameContext, player: Player): void {
    const playerId = player.user_id || player.anonymous_id || 'unknown';
    
    // Check if player already has a state (rejoining)
    const existingState = context.playerStates.get(playerId) as PicoParkPlayerState | undefined;
    
    // Use existing color or assign new one
    let color: number;
    
    if (existingState?.color) {
      color = existingState.color;
    } else {
      const colorIndex = (context.gameState as any)._nextColorIndex || 0;
      color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
      (context.gameState as any)._nextColorIndex = colorIndex + 1;
    }

    const playerState: PicoParkPlayerState = {
      playerId,
      position: { x: 100, y: 300 },
      coinsCollected: existingState?.coinsCollected || 0,
      color,
      isAtGoal: false,
    };
    context.playerStates.set(playerId, playerState);

    // Add player to Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.addPlayer(playerId, player.name, color);
    }

    console.log(`[PicoPark] Player ${player.name} joined with color ${color.toString(16)}`);
  },

  onPlayerDisconnect(context: GameContext, playerId: string): void {
    context.playerStates.delete(playerId);

    // Remove from Phaser game if bridge exists
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (bridge) {
      bridge.removePlayer(playerId);
    }

    console.log(`[PicoPark] Player ${playerId} disconnected`);
  },

  onPlayerInput(context: GameContext, playerId: string, inputEvent: InputEvent): void {
    const bridge = (context.gameState as any)._phaserBridge as PhaserGameBridge | undefined;
    if (!bridge) return;

    // Get or create input state
    let input = bridge.getPlayerInput(playerId);
    if (!input) {
      input = { movement: { x: 0, y: 0 }, jump: false, jumpPressed: false };
    }

    // Update input based on event
    if (inputEvent.type === 'continuous') {
      const joystick = inputEvent.value as { x: number; y: number };
      
      if (inputEvent.inputType === 'joystick_left') {
        input.movement = joystick;
      }
    } else if (inputEvent.type === 'discrete') {
      if (inputEvent.inputType === 'button_right') {
        const pressed = (inputEvent.value as { pressed: boolean }).pressed || false;
        console.log(`[PicoPark Input] Player ${playerId} jump button: ${pressed}`);
        // STICKY: Only update jump if pressing (true). Release is handled by Player when it consumes the jump.
        // This prevents race conditions where release event overwrites press before Phaser reads it.
        if (pressed) {
          input.jump = true;
        }
        // Note: we don't set input.jump = false here. Player handles that after consuming.
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
      <MemoizedPicoParkRenderer
        context={context}
        initialPlayers={players}
      />
    );
  },
};

export default PicoParkGame;

