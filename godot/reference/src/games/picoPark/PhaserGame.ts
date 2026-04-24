// Phaser Game Bridge - Manages Phaser instance and React communication

import Phaser from 'phaser';
import { LevelSelectScene } from './scenes/LevelSelectScene';
import { GameplayScene } from './scenes/GameplayScene';
import { ResultsScene } from './scenes/ResultsScene';
import {
  PicoParkGameState,
  PicoParkGameEvents,
  PlayerInputState,
  PicoParkLevel,
  GamePhase,
  GRAVITY,
} from './types';

export interface PhaserGameConfig {
  parentElement: HTMLElement;
  width: number;
  height: number;
  onStateUpdate: (state: Partial<PicoParkGameState>) => void;
  events: PicoParkGameEvents;
}

export class PhaserGameBridge {
  private game: Phaser.Game | null = null;
  private config: PhaserGameConfig;
  private playerInputs: Map<string, PlayerInputState> = new Map();
  private previousJumpStates: Map<string, boolean> = new Map();
  private currentScene: 'LevelSelectScene' | 'GameplayScene' | 'ResultsScene' = 'LevelSelectScene';
  private isReady: boolean = false;
  private pendingPlayers: Array<{ playerId: string; name: string; color: number }> = [];
  
  // Persistent player registry (survives scene transitions)
  private registeredPlayers: Map<string, { playerId: string; name: string; color: number }> = new Map();
  
  // Current level (set after level selection)
  private selectedLevel: PicoParkLevel | null = null;
  
  // Scores persist across levels
  private playerScores: Map<string, number> = new Map();

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
          gravity: { x: 0, y: GRAVITY },
          debug: false,
        },
      },
      scene: [LevelSelectScene, GameplayScene, ResultsScene],
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
    this.previousJumpStates.clear();
    this.registeredPlayers.clear();
    this.playerScores.clear();
    this.isReady = false;
    this.pendingPlayers = [];
    this.selectedLevel = null;
  }

  /**
   * Update player input state
   */
  setPlayerInput(playerId: string, input: PlayerInputState): void {
    // Track jump pressed state (true only on frame when jump transitions from false to true)
    const previousJump = this.previousJumpStates.get(playerId) || false;
    const newJumpPressed = input.jump && !previousJump;
    this.previousJumpStates.set(playerId, input.jump);
    
    // Get existing input to preserve jumpPressed if it was set but not consumed yet
    const existingInput = this.playerInputs.get(playerId);
    const jumpPressed = newJumpPressed || (existingInput?.jumpPressed ?? false);
    
    this.playerInputs.set(playerId, {
      ...input,
      jumpPressed,
    });
  }

  /**
   * Clear the jumpPressed flag after it's been consumed
   */
  clearJumpPressed(playerId: string): void {
    const input = this.playerInputs.get(playerId);
    if (input) {
      input.jumpPressed = false;
    }
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
      movement: { x: 0, y: 0 },
      jump: false,
      jumpPressed: false,
    });
    this.previousJumpStates.set(playerId, false);

    // Initialize score
    if (!this.playerScores.has(playerId)) {
      this.playerScores.set(playerId, 0);
    }

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
    this.previousJumpStates.delete(playerId);
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
   * Get player count
   */
  getPlayerCount(): number {
    return this.registeredPlayers.size;
  }

  /**
   * Emit state update to React
   */
  emitStateUpdate(state: Partial<PicoParkGameState>): void {
    this.config.onStateUpdate(state);
  }

  /**
   * Get event handlers
   */
  getEvents(): PicoParkGameEvents {
    return this.config.events;
  }

  /**
   * Set the selected level
   */
  setLevel(level: PicoParkLevel): void {
    this.selectedLevel = level;
    this.config.events.onLevelSelected(level.id);
    this.emitStateUpdate({ currentLevel: level, selectedLevelId: level.id });
  }

  /**
   * Get the selected level
   */
  getLevel(): PicoParkLevel | null {
    return this.selectedLevel;
  }

  /**
   * Get player scores
   */
  getPlayerScores(): Map<string, number> {
    return this.playerScores;
  }

  /**
   * Add to player score
   */
  addToPlayerScore(playerId: string, amount: number): void {
    const current = this.playerScores.get(playerId) || 0;
    this.playerScores.set(playerId, current + amount);
  }

  /**
   * Start gameplay with selected level
   */
  startLevel(level: PicoParkLevel): void {
    if (!this.game || !this.isReady) return;
    
    this.selectedLevel = level;
    this.currentScene = 'GameplayScene';
    this.game.scene.stop('LevelSelectScene');
    this.game.scene.start('GameplayScene', { 
      level,
      playerData: this.getRegisteredPlayers(),
    });
  }

  /**
   * Show results screen
   */
  showResults(time: number, scores: Map<string, number>): void {
    if (!this.game || !this.isReady) return;
    
    this.currentScene = 'ResultsScene';
    this.game.scene.stop('GameplayScene');
    this.game.scene.start('ResultsScene', { 
      level: this.selectedLevel,
      time,
      scores,
      playerData: this.getRegisteredPlayers(),
    });
  }

  /**
   * Return to level select
   */
  returnToLevelSelect(): void {
    if (!this.game || !this.isReady) return;
    
    this.currentScene = 'LevelSelectScene';
    this.game.scene.stop('GameplayScene');
    this.game.scene.stop('ResultsScene');
    this.game.scene.start('LevelSelectScene', { 
      playerData: this.getRegisteredPlayers() 
    });
  }

  /**
   * Restart current level
   */
  restartLevel(): void {
    if (!this.game || !this.isReady || !this.selectedLevel) return;
    
    this.game.scene.stop('GameplayScene');
    this.game.scene.start('GameplayScene', { 
      level: this.selectedLevel,
      playerData: this.getRegisteredPlayers(),
    });
  }

  /**
   * Go to next level
   */
  nextLevel(level: PicoParkLevel): void {
    if (!this.game || !this.isReady) return;
    
    this.selectedLevel = level;
    this.currentScene = 'GameplayScene';
    this.game.scene.stop('ResultsScene');
    this.game.scene.start('GameplayScene', { 
      level,
      playerData: this.getRegisteredPlayers(),
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

  /**
   * Get current scene name
   */
  getCurrentSceneName(): string {
    return this.currentScene;
  }
}

