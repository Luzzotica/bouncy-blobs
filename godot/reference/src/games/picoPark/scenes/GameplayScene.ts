// Gameplay Scene - Main platformer gameplay

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import { Player } from '../entities/Player';
import { Coin } from '../entities/Coin';
import { Goal } from '../objects/Goal';
import { PressurePlate } from '../objects/PressurePlate';
import { Door } from '../objects/Door';
import { MovingPlatform } from '../objects/Platform';
import {
  PicoParkLevel,
  Position,
  LEVEL_COMPLETE_DELAY,
} from '../types';
import {
  renderLevel,
  createLevelColliders,
  getMapScaleAndOffset,
  gridToWorld,
} from '../utils/levelUtils';

interface GameplaySceneData {
  level: PicoParkLevel;
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

export class GameplayScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private currentLevel!: PicoParkLevel;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number }> = [];
  
  // Map rendering
  private levelGraphics!: Phaser.GameObjects.Graphics;
  private mapOffset: Position = { x: 0, y: 0 };
  private effectiveCellSize: number = 32;
  
  // Entities
  private players: Map<string, Player> = new Map();
  private coins: Coin[] = [];
  private goal!: Goal;
  private pressurePlates: PressurePlate[] = [];
  private doors: Door[] = [];
  private movingPlatforms: MovingPlatform[] = [];
  
  // Game state
  private isRoundActive: boolean = false;
  private levelStartTime: number = 0;
  private levelTime: number = 0;
  private playersAtGoal: Set<string> = new Set();
  private levelAttempts: number = 0;
  
  // UI elements
  private countdownText!: Phaser.GameObjects.Text;
  private completeText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'GameplayScene' });
  }

  init(data: GameplaySceneData): void {
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    this.currentLevel = data.level;
    this.pendingPlayerData = data.playerData || [];
    
    // Reset state
    this.players.clear();
    this.coins = [];
    this.pressurePlates = [];
    this.doors = [];
    this.movingPlatforms = [];
    this.isRoundActive = false;
    this.levelTime = 0;
    this.playersAtGoal.clear();
  }

  create(): void {
    const { width, height } = this.scale;

    // Calculate map scale and offset to fill screen
    const { cellSize, offset } = getMapScaleAndOffset(this.currentLevel, width, height, 80);
    this.effectiveCellSize = cellSize;
    this.mapOffset = offset;

    // Create graphics
    this.levelGraphics = this.add.graphics().setDepth(0);

    // Render level
    renderLevel(this.levelGraphics, this.currentLevel, this.effectiveCellSize, this.mapOffset);

    // Create physics colliders
    createLevelColliders(this, this.currentLevel, this.effectiveCellSize, this.mapOffset);

    // Create goal area
    this.createGoal();

    // Create coins
    this.createCoins();

    // Create special objects (doors, pressure plates, moving platforms)
    this.createSpecialObjects();

    // Setup collision detection
    this.setupCollisions();

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

  private createGoal(): void {
    const goalDef = this.currentLevel.goalArea;
    const worldPos = gridToWorld(
      goalDef.x + goalDef.width / 2,
      goalDef.y + goalDef.height / 2,
      this.effectiveCellSize,
      this.mapOffset.x,
      this.mapOffset.y
    );
    
    this.goal = new Goal(
      this,
      worldPos.x,
      worldPos.y,
      goalDef.width * this.effectiveCellSize,
      goalDef.height * this.effectiveCellSize
    );
  }

  private createCoins(): void {
    this.currentLevel.coinPositions.forEach((pos, index) => {
      const worldPos = gridToWorld(
        pos.x + 0.5,
        pos.y + 0.5,
        this.effectiveCellSize,
        this.mapOffset.x,
        this.mapOffset.y
      );
      
      const coin = new Coin(this, `coin_${index}`, worldPos.x, worldPos.y);
      this.coins.push(coin);
    });
  }

  private createSpecialObjects(): void {
    // Create doors
    if (this.currentLevel.doors) {
      this.currentLevel.doors.forEach(doorDef => {
        const worldPos = gridToWorld(
          doorDef.position.x + doorDef.width / 2,
          doorDef.position.y + doorDef.height / 2,
          this.effectiveCellSize,
          this.mapOffset.x,
          this.mapOffset.y
        );
        
        const door = new Door(
          this,
          doorDef.id,
          worldPos.x,
          worldPos.y,
          doorDef.width * this.effectiveCellSize,
          doorDef.height * this.effectiveCellSize,
          doorDef.isOpen
        );
        this.doors.push(door);
      });
    }

    // Create pressure plates
    if (this.currentLevel.pressurePlates) {
      this.currentLevel.pressurePlates.forEach(plateDef => {
        const worldPos = gridToWorld(
          plateDef.position.x + plateDef.width / 2,
          plateDef.position.y + 0.5,
          this.effectiveCellSize,
          this.mapOffset.x,
          this.mapOffset.y
        );
        
        const plate = new PressurePlate(
          this,
          plateDef.id,
          worldPos.x,
          worldPos.y,
          plateDef.width * this.effectiveCellSize,
          plateDef.requiredWeight,
          (isPressed) => this.onPressurePlateChange(plateDef.id, plateDef.controls, isPressed)
        );
        this.pressurePlates.push(plate);
      });
    }

    // Create moving platforms
    if (this.currentLevel.movingPlatforms) {
      this.currentLevel.movingPlatforms.forEach(platformDef => {
        const startPos = gridToWorld(
          platformDef.startPos.x + platformDef.width / 2,
          platformDef.startPos.y + 0.5,
          this.effectiveCellSize,
          this.mapOffset.x,
          this.mapOffset.y
        );
        const endPos = gridToWorld(
          platformDef.endPos.x + platformDef.width / 2,
          platformDef.endPos.y + 0.5,
          this.effectiveCellSize,
          this.mapOffset.x,
          this.mapOffset.y
        );
        
        const platform = new MovingPlatform(
          this,
          platformDef.id,
          startPos,
          endPos,
          platformDef.width * this.effectiveCellSize,
          platformDef.speed,
          platformDef.pauseTime,
          platformDef.triggeredBy
        );
        this.movingPlatforms.push(platform);
      });
    }
  }

  private onPressurePlateChange(_plateId: string, controlledIds: string[], isPressed: boolean): void {
    // Toggle controlled objects
    for (const id of controlledIds) {
      // Check doors
      const door = this.doors.find(d => d.getId() === id);
      if (door) {
        if (isPressed) {
          door.open();
        } else {
          door.close();
        }
      }

      // Check moving platforms
      const platform = this.movingPlatforms.find(p => p.getId() === id);
      if (platform) {
        platform.setActive(isPressed);
      }
    }
  }

  private setupCollisions(): void {
    // Helper to check if a body is a player body (compound body has parts with different labels)
    const isPlayerBody = (body: MatterJS.BodyType) => {
      return body.label === 'player' || body.label === 'player_main' || body.label === 'ground_sensor';
    };

    // Player-hazard collision
    this.matter.world.on('collisionstart', (event: Phaser.Physics.Matter.Events.CollisionStartEvent) => {
      for (const pair of event.pairs) {
        const bodyA = pair.bodyA;
        const bodyB = pair.bodyB;

        // Check for player-hazard collision
        if ((isPlayerBody(bodyA) && bodyB.label === 'hazard') ||
            (isPlayerBody(bodyB) && bodyA.label === 'hazard')) {
          if (this.isRoundActive) {
            this.resetLevel('Hit hazard!');
          }
          return;
        }

        // Check for player-coin collision
        if (isPlayerBody(bodyA) && bodyB.label === 'coin') {
          this.handleCoinCollection(bodyA, bodyB);
        } else if (isPlayerBody(bodyB) && bodyA.label === 'coin') {
          this.handleCoinCollection(bodyB, bodyA);
        }

        // Check for player-bouncy collision
        if ((isPlayerBody(bodyA) && bodyB.label === 'bouncy') ||
            (isPlayerBody(bodyB) && bodyA.label === 'bouncy')) {
          const playerBody = isPlayerBody(bodyA) ? bodyA : bodyB;
          this.handleBouncyCollision(playerBody);
        }
      }
    });
  }

  private handleCoinCollection(playerBody: MatterJS.BodyType, coinBody: MatterJS.BodyType): void {
    // Get playerId from the body or its parent
    let playerId = (playerBody as any).playerId as string;
    if (!playerId && (playerBody as any).parent) {
      playerId = ((playerBody as any).parent as any).playerId as string;
    }
    const coinId = (coinBody as any).coinId as string;
    
    if (!playerId || !coinId) return;

    const coin = this.coins.find(c => c.getId() === coinId);
    if (coin && !coin.isCollected()) {
      coin.collect(playerId);
      this.bridge?.addToPlayerScore(playerId, 1);
      this.bridge?.getEvents().onCoinCollected(playerId, coinId);
    }
  }

  private handleBouncyCollision(playerBody: MatterJS.BodyType): void {
    // Apply bounce force
    const bounceForce = -0.025;
    this.matter.body.setVelocity(playerBody, {
      x: playerBody.velocity.x,
      y: bounceForce * 1000,
    });
  }

  private createUI(): void {
    const { width, height } = this.scale;

    // Countdown text
    this.countdownText = this.add.text(width / 2, height / 2, '', {
      fontSize: '100px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(100).setVisible(false);

    // Level complete text
    this.completeText = this.add.text(width / 2, height / 2 - 50, '', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#00ff00',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(101).setVisible(false);
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
    this.levelStartTime = Date.now();
    this.bridge?.setPhase('playing');
  }

  private resetLevel(reason: string): void {
    this.levelAttempts++;
    this.bridge?.getEvents().onLevelReset(reason);
    
    // Flash screen red briefly
    this.cameras.main.flash(300, 255, 0, 0);
    
    // Reset players to spawn positions
    const spawnPoints = this.currentLevel.spawnPoints;
    let spawnIndex = 0;
    
    for (const [, player] of this.players) {
      const spawnPos = spawnPoints[spawnIndex % spawnPoints.length];
      const worldPos = gridToWorld(
        spawnPos.x + 0.5,
        spawnPos.y + 0.5,
        this.effectiveCellSize,
        this.mapOffset.x,
        this.mapOffset.y
      );
      player.resetToPosition(worldPos.x, worldPos.y);
      spawnIndex++;
    }

    // Reset coins
    for (const coin of this.coins) {
      coin.reset();
    }

    // Reset goal tracking
    this.playersAtGoal.clear();
    
    // Reset doors
    for (const door of this.doors) {
      door.reset();
    }

    // Reset pressure plates
    for (const plate of this.pressurePlates) {
      plate.reset();
    }

    // Reset moving platforms
    for (const platform of this.movingPlatforms) {
      platform.reset();
    }

    // Reset timer
    this.levelStartTime = Date.now();
    this.levelTime = 0;
  }

  private checkLevelComplete(): void {
    const totalPlayers = this.players.size;
    const atGoal = this.playersAtGoal.size;
    
    if (atGoal >= totalPlayers && totalPlayers > 0) {
      this.levelComplete();
    }
  }

  private levelComplete(): void {
    this.isRoundActive = false;
    this.bridge?.setPhase('level_complete');
    
    // Show completion text
    this.completeText.setText('🎉 Level Complete! 🎉');
    this.completeText.setVisible(true);

    // Get final scores
    const scores = this.bridge?.getPlayerScores() || new Map();
    
    // Notify events
    this.bridge?.getEvents().onLevelComplete(this.levelTime, scores);

    // Go to results after delay
    this.time.delayedCall(LEVEL_COMPLETE_DELAY, () => {
      this.bridge?.showResults(this.levelTime, scores);
    });
  }

  addPlayer(playerId: string, name: string, color: number): void {
    if (this.players.has(playerId)) return;

    // Get spawn position
    const spawnPoints = this.currentLevel.spawnPoints;
    const spawnIndex = this.players.size % spawnPoints.length;
    const spawnPos = spawnPoints[spawnIndex];
    const worldPos = gridToWorld(
      spawnPos.x + 0.5,
      spawnPos.y + 0.5,
      this.effectiveCellSize,
      this.mapOffset.x,
      this.mapOffset.y
    );

    // Create player entity
    const player = new Player(this, playerId, name, color, worldPos.x, worldPos.y);
    this.players.set(playerId, player);
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.destroy();
      this.players.delete(playerId);
    }
    this.playersAtGoal.delete(playerId);
  }

  update(time: number, delta: number): void {
    // Update level time
    if (this.isRoundActive) {
      this.levelTime = Date.now() - this.levelStartTime;
      this.bridge?.emitStateUpdate({ levelTime: this.levelTime });
    }

    // Update players
    for (const [playerId, player] of this.players) {
      // Only allow input when round is active (prevents movement during countdown)
      const input = this.isRoundActive ? this.bridge?.getPlayerInput(playerId) : undefined;
      player.update(time, delta, input);

      // Check if player is in goal
      if (this.isRoundActive) {
        const playerPos = player.getPosition();
        const wasAtGoal = this.playersAtGoal.has(playerId);
        const isAtGoal = this.goal.isPlayerInGoal(playerPos.x, playerPos.y);

        if (isAtGoal && !wasAtGoal) {
          this.playersAtGoal.add(playerId);
          this.bridge?.getEvents().onPlayerReachedGoal(playerId);
          this.bridge?.emitStateUpdate({ playersAtGoal: this.playersAtGoal });
          this.checkLevelComplete();
        } else if (!isAtGoal && wasAtGoal) {
          this.playersAtGoal.delete(playerId);
          this.bridge?.getEvents().onPlayerLeftGoal(playerId);
          this.bridge?.emitStateUpdate({ playersAtGoal: this.playersAtGoal });
        }
      }
    }

    // Update coins
    for (const coin of this.coins) {
      coin.update(time, delta);
    }

    // Update pressure plates (check which players are on them)
    for (const plate of this.pressurePlates) {
      const playersOnPlate: string[] = [];
      for (const [playerId, player] of this.players) {
        if (plate.isPlayerOnPlate(player.getPosition(), player.getSize())) {
          playersOnPlate.push(playerId);
        }
      }
      plate.updateWeight(playersOnPlate.length);
    }

    // Update moving platforms
    for (const platform of this.movingPlatforms) {
      platform.update(time, delta);
    }

    // Update goal visual
    this.goal.update(time, delta);
  }
}

