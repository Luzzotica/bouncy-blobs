// Phaser Game Bridge - Manages Phaser instance and React communication

import Phaser from 'phaser';
import { ArenaScene } from './scenes/ArenaScene';
import {
  TronGameState,
  TronGameEvents,
  PlayerInputState,
  TronMapDefinition,
  GamePhase,
} from './types';
import { getDefaultMap } from './maps/MapDefinitions';

export interface PhaserGameConfig {
  parentElement: HTMLElement;
  width: number;
  height: number;
  onStateUpdate: (state: Partial<TronGameState>) => void;
  events: TronGameEvents;
}

export class PhaserGameBridge {
  private game: Phaser.Game | null = null;
  private config: PhaserGameConfig;
  private playerInputs: Map<string, PlayerInputState> = new Map();
  private isReady: boolean = false;
  private pendingPlayers: Array<{ playerId: string; name: string; color: number }> = [];
  
  // Persistent player registry
  private registeredPlayers: Map<string, { playerId: string; name: string; color: number }> = new Map();

  constructor(config: PhaserGameConfig) {
    this.config = config;
  }

  /**
   * Initialize the Phaser game instance
   */
  init(): void {
    if (this.game) {
      console.warn('[TronGame] Game already initialized');
      return;
    }

    const bridgeRef = this;

    const phaserConfig: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: this.config.parentElement,
      width: this.config.width,
      height: this.config.height,
      backgroundColor: '#000000',
      scene: [ArenaScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: '100%',
        height: '100%',
      },
      callbacks: {
        preBoot: (game) => {
          game.registry.set('bridge', bridgeRef);
        },
      },
    };

    this.game = new Phaser.Game(phaserConfig);

    // Wait for game to be ready
    this.game.events.once('ready', () => {
      console.log('[TronGame] Game ready');
      this.isReady = true;

      // Start with default map and pending players
      this.startMap(getDefaultMap());

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
    this.registeredPlayers.clear();
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
    // Initialize input state
    this.playerInputs.set(playerId, {
      movement: { x: 0, y: 0 },
      ghostButton: false,
    });

    // Register player
    this.registeredPlayers.set(playerId, { playerId, name, color });

    if (!this.isReady) {
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
   * Get player count
   */
  getPlayerCount(): number {
    return this.registeredPlayers.size;
  }

  /**
   * Emit state update to React
   */
  emitStateUpdate(state: Partial<TronGameState>): void {
    this.config.onStateUpdate(state);
  }

  /**
   * Get event handlers
   */
  getEvents(): TronGameEvents {
    return this.config.events;
  }

  /**
   * Start a specific map
   */
  startMap(map: TronMapDefinition): void {
    if (!this.game || !this.isReady) return;
    
    this.game.scene.stop('ArenaScene');
    this.game.scene.start('ArenaScene', { 
      map, 
      playerData: this.getRegisteredPlayers(),
    });
  }

  /**
   * Restart the game with current players
   */
  restartGame(): void {
    if (!this.game || !this.isReady) return;
    
    this.game.scene.stop('ArenaScene');
    this.game.scene.start('ArenaScene', { 
      map: getDefaultMap(),
      playerData: this.getRegisteredPlayers(),
    });
  }

  /**
   * Get the currently active scene
   */
  private getActiveScene(): Phaser.Scene | null {
    if (!this.game || !this.isReady) return null;
    return this.game.scene.getScene('ArenaScene');
  }

  /**
   * Set phase and notify React
   */
  setPhase(phase: GamePhase): void {
    this.config.events.onPhaseChange(phase);
    this.emitStateUpdate({ phase });
  }

  /**
   * Get game dimensions
   */
  getDimensions(): { width: number; height: number } {
    if (this.game) {
      return {
        width: this.game.scale.width,
        height: this.game.scale.height,
      };
    }
    return {
      width: this.config.width,
      height: this.config.height,
    };
  }
}
