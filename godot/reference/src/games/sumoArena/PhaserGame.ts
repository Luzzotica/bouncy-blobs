// Phaser Game Bridge - Manages Phaser instance and React communication

import Phaser from 'phaser';
import { ArenaScene } from './scenes/ArenaScene';
import { MapVoteScene } from './scenes/MapVoteScene';
import {
  SumoGameState,
  SumoGameEvents,
  PlayerInputState,
  MapDefinition,
  GamePhase,
} from './types';

export interface PhaserGameConfig {
  parentElement: HTMLElement;
  width: number;
  height: number;
  onStateUpdate: (state: Partial<SumoGameState>) => void;
  events: SumoGameEvents;
}

export class PhaserGameBridge {
  private game: Phaser.Game | null = null;
  private config: PhaserGameConfig;
  private playerInputs: Map<string, PlayerInputState> = new Map();
  private currentScene: 'MapVoteScene' | 'ArenaScene' = 'MapVoteScene';
  private isReady: boolean = false;
  private pendingPlayers: Array<{ playerId: string; name: string; color: number }> = [];
  // Persistent player registry (survives scene transitions)
  private registeredPlayers: Map<string, { playerId: string; name: string; color: number }> = new Map();

  constructor(config: PhaserGameConfig) {
    this.config = config;
  }

  /**
   * Initialize the Phaser game instance
   */
  init(): void {
    if (this.game) {
      console.warn('[PhaserGame] Game already initialized');
      return;
    }

    // Store bridge reference so scenes can access it
    const bridgeRef = this;

    const phaserConfig: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: this.config.parentElement,
      width: this.config.width,
      height: this.config.height,
      backgroundColor: '#1a1a2e',
      physics: {
        default: 'matter',
        matter: {
          gravity: { x: 0, y: 0 },
          debug: false,
        },
      },
      scene: [MapVoteScene, ArenaScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: '100%',
        height: '100%',
      },
      callbacks: {
        preBoot: (game) => {
          // Store bridge in game registry BEFORE scenes are created
          game.registry.set('bridge', bridgeRef);
        },
      },
    };

    this.game = new Phaser.Game(phaserConfig);

    // Wait for game to be ready
    this.game.events.once('ready', () => {
      console.log('[PhaserGame] Game ready');
      this.isReady = true;

      // Add any pending players
      for (const player of this.pendingPlayers) {
        this.addPlayer(player.playerId, player.name, player.color);
      }
      this.pendingPlayers = [];
    });
  }

  /**
   * Destroy the Phaser game instance
   */
  destroy(): void {
    if (this.game) {
      this.game.destroy(true);
      this.game = null;
    }
    this.playerInputs.clear();
    this.isReady = false;
    this.pendingPlayers = [];
  }

  /**
   * Update player input state
   */
  setPlayerInput(playerId: string, input: PlayerInputState): void {
    this.playerInputs.set(playerId, input);
  }

  /**
   * Get current input for a player
   */
  getPlayerInput(playerId: string): PlayerInputState | undefined {
    return this.playerInputs.get(playerId);
  }

  /**
   * Get all player inputs
   */
  getAllPlayerInputs(): Map<string, PlayerInputState> {
    return this.playerInputs;
  }

  /**
   * Add a player to the game
   */
  addPlayer(playerId: string, name: string, color: number): void {
    // Initialize input state immediately
    this.playerInputs.set(playerId, {
      joystick: { x: 0, y: 0 },
      dashPressed: false,
    });

    // Register player persistently
    this.registeredPlayers.set(playerId, { playerId, name, color });

    if (!this.isReady) {
      // Queue player to be added when ready
      this.pendingPlayers.push({ playerId, name, color });
      return;
    }

    const scene = this.getActiveScene();
    if (scene && 'addPlayer' in scene) {
      (scene as any).addPlayer(playerId, name, color);
    }
  }

  /**
   * Remove a player from the game
   */
  removePlayer(playerId: string): void {
    this.playerInputs.delete(playerId);
    this.registeredPlayers.delete(playerId);
    
    if (!this.isReady) {
      // Remove from pending if not yet added
      this.pendingPlayers = this.pendingPlayers.filter(p => p.playerId !== playerId);
      return;
    }

    const scene = this.getActiveScene();
    if (scene && 'removePlayer' in scene) {
      (scene as any).removePlayer(playerId);
    }
  }

  /**
   * Get all registered players
   */
  getRegisteredPlayers(): Array<{ playerId: string; name: string; color: number }> {
    return Array.from(this.registeredPlayers.values());
  }

  /**
   * Emit state update to React
   */
  emitStateUpdate(state: Partial<SumoGameState>): void {
    this.config.onStateUpdate(state);
  }

  /**
   * Get event handlers
   */
  getEvents(): SumoGameEvents {
    return this.config.events;
  }

  /**
   * Start a specific map with player data
   */
  startMap(map: MapDefinition, playerData?: Array<{ playerId: string; name: string; color: number }>): void {
    if (!this.game || !this.isReady) return;
    
    this.currentScene = 'ArenaScene';
    this.game.scene.stop('MapVoteScene');
    this.game.scene.start('ArenaScene', { map, playerData });
  }

  /**
   * Return to map vote with current players
   */
  returnToMapVote(): void {
    if (!this.game || !this.isReady) return;
    
    this.currentScene = 'MapVoteScene';
    this.game.scene.stop('ArenaScene');
    // Pass player data so they persist across scene transitions
    this.game.scene.start('MapVoteScene', { 
      playerData: this.getRegisteredPlayers() 
    });
  }

  /**
   * Get the currently active scene
   */
  private getActiveScene(): Phaser.Scene | null {
    if (!this.game || !this.isReady) return null;
    return this.game.scene.getScene(this.currentScene);
  }

  /**
   * Trigger phase change
   */
  setPhase(phase: GamePhase): void {
    this.config.events.onPhaseChange(phase);
    this.emitStateUpdate({ phase });
  }

  /**
   * Get game dimensions
   */
  getDimensions(): { width: number; height: number } {
    return {
      width: this.config.width,
      height: this.config.height,
    };
  }
}
