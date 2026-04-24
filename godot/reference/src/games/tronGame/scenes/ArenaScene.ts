// Tron Arena Scene - Main gameplay scene

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import {
  TronMapDefinition,
  Direction,
  TrailSegment,
  PLAYER_SPEED,
  ROUND_END_DELAY,
  GRID_PADDING,
} from '../types';
import { TronPlayer } from '../entities/Player';

interface ArenaSceneData {
  map: TronMapDefinition;
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

// Starting positions and directions for up to 16 players
const SPAWN_CONFIGS: Array<{ xPct: number; yPct: number; direction: Direction }> = [
  { xPct: 0.25, yPct: 0.25, direction: 'right' },
  { xPct: 0.75, yPct: 0.75, direction: 'left' },
  { xPct: 0.75, yPct: 0.25, direction: 'down' },
  { xPct: 0.25, yPct: 0.75, direction: 'up' },
  { xPct: 0.5, yPct: 0.15, direction: 'down' },
  { xPct: 0.5, yPct: 0.85, direction: 'up' },
  { xPct: 0.15, yPct: 0.5, direction: 'right' },
  { xPct: 0.85, yPct: 0.5, direction: 'left' },
  { xPct: 0.35, yPct: 0.35, direction: 'right' },
  { xPct: 0.65, yPct: 0.65, direction: 'left' },
  { xPct: 0.65, yPct: 0.35, direction: 'down' },
  { xPct: 0.35, yPct: 0.65, direction: 'up' },
  { xPct: 0.2, yPct: 0.8, direction: 'right' },
  { xPct: 0.8, yPct: 0.2, direction: 'left' },
  { xPct: 0.4, yPct: 0.1, direction: 'down' },
  { xPct: 0.6, yPct: 0.9, direction: 'up' },
];

export class ArenaScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private currentMap!: TronMapDefinition;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number }> = [];
  
  // Grid rendering
  private gridGraphics!: Phaser.GameObjects.Graphics;
  private mapOffset: { x: number; y: number } = { x: 0, y: 0 };
  private effectiveCellSize: number = 16;
  
  // Players
  private players: Map<string, TronPlayer> = new Map();
  private spawnIndex: number = 0;
  
  // Game state
  private isRoundActive: boolean = false;
  private lastMoveTime: number = 0;
  private moveInterval: number = 1000 / PLAYER_SPEED;
  private alivePlayers: number = 0;
  
  // UI elements
  private countdownText!: Phaser.GameObjects.Text;
  private winnerText!: Phaser.GameObjects.Text;
  private aliveCountText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  init(data: ArenaSceneData): void {
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    this.currentMap = data.map;
    this.pendingPlayerData = data.playerData || [];
    
    // Reset state
    this.players.clear();
    this.isRoundActive = false;
    this.lastMoveTime = 0;
    this.spawnIndex = 0;
    this.alivePlayers = 0;
  }

  create(): void {
    const { width, height } = this.scale;

    // Calculate map scale and offset to fit screen
    const { cellSize, offset } = this.getMapScaleAndOffset(this.currentMap, width, height);
    this.effectiveCellSize = cellSize;
    this.mapOffset = offset;

    // Create graphics
    this.gridGraphics = this.add.graphics().setDepth(0);

    // Render grid
    this.renderGrid();

    // Create UI
    this.createUI();

    // Add pending players
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color);
    }
    this.pendingPlayerData = [];

    // Start countdown
    this.startCountdown();
  }

  private getMapScaleAndOffset(
    map: TronMapDefinition,
    screenWidth: number,
    screenHeight: number
  ): { cellSize: number; offset: { x: number; y: number } } {
    const availableWidth = screenWidth - GRID_PADDING * 2;
    const availableHeight = screenHeight - GRID_PADDING * 2;
    
    const scaleX = availableWidth / (map.gridWidth * map.cellSize);
    const scaleY = availableHeight / (map.gridHeight * map.cellSize);
    const scale = Math.min(scaleX, scaleY, 1); // Don't scale up, only down
    
    const cellSize = map.cellSize * scale;
    const scaledWidth = map.gridWidth * cellSize;
    const scaledHeight = map.gridHeight * cellSize;
    
    return {
      cellSize,
      offset: {
        x: (screenWidth - scaledWidth) / 2,
        y: (screenHeight - scaledHeight) / 2,
      },
    };
  }

  private renderGrid(): void {
    const { gridWidth, gridHeight, theme } = this.currentMap;
    const { x: offsetX, y: offsetY } = this.mapOffset;
    const cellSize = this.effectiveCellSize;
    
    this.gridGraphics.clear();
    
    // Background
    this.gridGraphics.fillStyle(theme.backgroundColor, 1);
    this.gridGraphics.fillRect(
      offsetX,
      offsetY,
      gridWidth * cellSize,
      gridHeight * cellSize
    );
    
    // Grid lines
    this.gridGraphics.lineStyle(1, theme.gridLineColor, 0.5);
    
    // Vertical lines
    for (let x = 0; x <= gridWidth; x++) {
      this.gridGraphics.lineBetween(
        offsetX + x * cellSize,
        offsetY,
        offsetX + x * cellSize,
        offsetY + gridHeight * cellSize
      );
    }
    
    // Horizontal lines
    for (let y = 0; y <= gridHeight; y++) {
      this.gridGraphics.lineBetween(
        offsetX,
        offsetY + y * cellSize,
        offsetX + gridWidth * cellSize,
        offsetY + y * cellSize
      );
    }
    
    // Border walls
    this.gridGraphics.lineStyle(4, theme.wallColor, 1);
    this.gridGraphics.strokeRect(
      offsetX,
      offsetY,
      gridWidth * cellSize,
      gridHeight * cellSize
    );
    
    // Inner glow on walls
    this.gridGraphics.lineStyle(2, theme.wallColor, 0.5);
    this.gridGraphics.strokeRect(
      offsetX + 2,
      offsetY + 2,
      gridWidth * cellSize - 4,
      gridHeight * cellSize - 4
    );
  }

  private createUI(): void {
    const { width, height } = this.scale;

    // Countdown text
    this.countdownText = this.add.text(width / 2, height / 2, '', {
      fontSize: '80px',
      fontFamily: 'Arial Black',
      color: '#00ffff',
      stroke: '#000000',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(100).setVisible(false);

    // Winner text
    this.winnerText = this.add.text(width / 2, height / 2, '', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#00ff00',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(101).setVisible(false);

    // Alive count
    this.aliveCountText = this.add.text(width / 2, 30, '', {
      fontSize: '24px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(100);

    this.updateAliveCount();
  }

  private startCountdown(): void {
    this.bridge?.setPhase('countdown');
    this.countdownText.setVisible(true);

    let countdown = 3;
    this.countdownText.setText(countdown.toString());

    const timer = this.time.addEvent({
      delay: 1000,
      callback: () => {
        countdown--;
        if (countdown > 0) {
          this.countdownText.setText(countdown.toString());
        } else if (countdown === 0) {
          this.countdownText.setText('GO!');
        } else {
          this.countdownText.setVisible(false);
          this.startRound();
          timer.destroy();
        }
      },
      loop: true,
    });
  }

  private startRound(): void {
    this.isRoundActive = true;
    this.lastMoveTime = this.time.now;
    this.bridge?.setPhase('playing');
  }

  private endRound(winnerId: string | null): void {
    this.isRoundActive = false;
    this.bridge?.setPhase('round_end');

    // Show winner
    if (winnerId) {
      const winner = this.players.get(winnerId);
      const winText = `🏆 ${winner?.getName() || 'Player'} WINS! 🏆`;
      this.winnerText.setText(winText);
      this.winnerText.setColor(`#${winner?.getColor().toString(16).padStart(6, '0')}`);
    } else {
      this.winnerText.setText('DRAW!');
      this.winnerText.setColor('#ffff00');
    }
    this.winnerText.setVisible(true);

    // Notify bridge
    this.bridge?.getEvents().onGameOver(winnerId);

    // Return to main menu after delay
    this.time.delayedCall(ROUND_END_DELAY, () => {
      this.bridge?.restartGame();
    });
  }

  addPlayer(playerId: string, name: string, color: number): void {
    if (this.players.has(playerId)) return;

    // Get spawn position
    const spawnConfig = SPAWN_CONFIGS[this.spawnIndex % SPAWN_CONFIGS.length];
    const gridX = Math.floor(this.currentMap.gridWidth * spawnConfig.xPct);
    const gridY = Math.floor(this.currentMap.gridHeight * spawnConfig.yPct);
    
    // Create player
    const player = new TronPlayer(
      this,
      playerId,
      name,
      color,
      gridX,
      gridY,
      spawnConfig.direction,
      this.effectiveCellSize,
      this.mapOffset.x,
      this.mapOffset.y
    );
    
    this.players.set(playerId, player);
    this.spawnIndex++;
    this.alivePlayers++;
    this.updateAliveCount();
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      if (player.isAlive()) {
        this.alivePlayers--;
      }
      player.destroy();
      this.players.delete(playerId);
      this.updateAliveCount();
    }
  }

  private updateAliveCount(): void {
    const total = this.players.size;
    this.aliveCountText.setText(`Players: ${this.alivePlayers}/${total}`);
  }

  private getAllTrails(): Map<string, TrailSegment[]> {
    const trails = new Map<string, TrailSegment[]>();
    for (const [playerId, player] of this.players) {
      trails.set(playerId, player.getTrail());
    }
    return trails;
  }

  update(time: number, delta: number): void {
    // Update all players
    for (const player of this.players.values()) {
      // Process input
      const input = this.bridge?.getPlayerInput(player.getPlayerId());
      if (input) {
        player.processInput(input);
      }
      
      // Update visual effects
      player.update(time, delta);
    }

    // Handle movement ticks
    if (this.isRoundActive) {
      if (time - this.lastMoveTime >= this.moveInterval) {
        this.lastMoveTime = time;
        this.processMovementTick();
      }
    }
  }

  private processMovementTick(): void {
    const allTrails = this.getAllTrails();
    const eliminatedThisTick: string[] = [];

    // Move all players
    for (const [playerId, player] of this.players) {
      if (!player.isAlive()) continue;

      const success = player.move(
        this.currentMap.gridWidth,
        this.currentMap.gridHeight,
        allTrails,
        this.isRoundActive
      );

      if (!success) {
        eliminatedThisTick.push(playerId);
      }
    }

    // Process eliminations
    for (const playerId of eliminatedThisTick) {
      const player = this.players.get(playerId);
      if (player) {
        player.die(this.alivePlayers);
        this.alivePlayers--;
        this.bridge?.getEvents().onPlayerEliminated(playerId, player.getPlacement());
      }
    }

    this.updateAliveCount();

    // Check win condition
    if (this.alivePlayers <= 1) {
      let winnerId: string | null = null;
      
      for (const [playerId, player] of this.players) {
        if (player.isAlive()) {
          winnerId = playerId;
          player.die(1); // Winner gets placement 1
          break;
        }
      }

      this.endRound(winnerId);
    }
  }
}
