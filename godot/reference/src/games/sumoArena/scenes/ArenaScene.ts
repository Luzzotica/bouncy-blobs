// Arena Scene - Main gameplay scene with physics

import Phaser from 'phaser';
import { PhaserGameBridge } from '../PhaserGame';
import {
  MapDefinition,
  Position,
  POWERUP_SPAWN_INTERVAL,
} from '../types';
import { Player } from '../entities/Player';
import { Powerup } from '../entities/Powerup';
import { Enemy } from '../entities/Enemy';

interface ArenaSceneData {
  map: MapDefinition;
  playerData?: Array<{ playerId: string; name: string; color: number }>;
}

export class ArenaScene extends Phaser.Scene {
  private bridge!: PhaserGameBridge;
  private currentMap!: MapDefinition;
  private pendingPlayerData: Array<{ playerId: string; name: string; color: number }> = [];
  
  // Arena
  private arenaGraphics!: Phaser.GameObjects.Graphics;
  private arenaRadius: number = 300;
  private arenaCenter: Position = { x: 0, y: 0 };
  private lastShrinkTime: number = 0;
  private shrinkWarning: boolean = false;
  
  // Entities
  private players: Map<string, Player> = new Map();
  private enemies: Enemy[] = [];
  private powerups: Powerup[] = [];
  
  // Timing
  private lastPowerupSpawn: number = 0;
  private lastEnemySpawn: number = 0;
  private isRoundActive: boolean = false;
  
  // Countdown visuals
  private countdownText!: Phaser.GameObjects.Text;
  private winnerText!: Phaser.GameObjects.Text;
  
  // Game events
  private nextEventTime: number = 0;
  private eventWarningGraphics!: Phaser.GameObjects.Graphics;
  private eventCountdownText!: Phaser.GameObjects.Text;
  private eventWarningActive: boolean = false;
  private pendingEventType: string = '';

  constructor() {
    super({ key: 'ArenaScene' });
  }

  setBridge(bridge: PhaserGameBridge): void {
    this.bridge = bridge;
  }

  init(data: ArenaSceneData): void {
    // Get bridge from game registry
    this.bridge = this.game.registry.get('bridge') as PhaserGameBridge;
    
    this.currentMap = data.map;
    this.arenaRadius = data.map.arena.initialRadius;
    this.players.clear();
    this.enemies = [];
    this.powerups = [];
    this.isRoundActive = false;
    this.lastEnemySpawn = 0;
    this.nextEventTime = 0;
    this.eventWarningActive = false;
    this.pendingEventType = '';
    
    // Store player data to add after scene setup
    this.pendingPlayerData = data.playerData || [];
  }

  create(): void {
    const { width, height } = this.scale;
    this.arenaCenter = { x: width / 2, y: height / 2 };

    // Create arena graphics
    this.arenaGraphics = this.add.graphics();
    this.drawArena();

    // Create arena boundary sensor
    this.createArenaBoundary();

    // Set up collision detection
    this.setupCollisions();

    // Create countdown text (hidden initially)
    this.countdownText = this.add.text(width / 2, height / 2, '', {
      fontSize: '120px',
      fontFamily: 'Arial Black',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 8,
    }).setOrigin(0.5).setDepth(100).setVisible(false);

    // Create winner text (hidden initially)
    this.winnerText = this.add.text(width / 2, height / 2, '', {
      fontSize: '48px',
      fontFamily: 'Arial Black',
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 6,
    }).setOrigin(0.5).setDepth(100).setVisible(false);

    // Create event warning graphics
    this.eventWarningGraphics = this.add.graphics().setDepth(50);

    // Create event countdown text (top-left, below title area)
    this.eventCountdownText = this.add.text(20, 70, '', {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: '#fbbf24',
      stroke: '#000000',
      strokeThickness: 3,
      backgroundColor: '#00000088',
      padding: { x: 10, y: 5 },
    }).setOrigin(0, 0).setDepth(95).setVisible(false);

    // Add all pending players from map vote scene
    for (const playerData of this.pendingPlayerData) {
      this.addPlayer(playerData.playerId, playerData.name, playerData.color);
    }

    // Start countdown then round
    this.startCountdown();

    // Set up keyboard for testing
    this.setupDebugControls();
  }

  private drawArena(): void {
    this.arenaGraphics.clear();
    
    const theme = this.currentMap.theme;
    
    // Draw background circle (slightly larger for edge effect)
    this.arenaGraphics.fillStyle(theme.edgeColor, 1);
    this.arenaGraphics.fillCircle(
      this.arenaCenter.x,
      this.arenaCenter.y,
      this.arenaRadius + 10
    );
    
    // Draw main arena floor
    this.arenaGraphics.fillStyle(theme.floorColor, 1);
    this.arenaGraphics.fillCircle(
      this.arenaCenter.x,
      this.arenaCenter.y,
      this.arenaRadius
    );

    // Draw shrink warning ring if active
    if (this.shrinkWarning) {
      this.arenaGraphics.lineStyle(4, 0xff0000, 0.8);
      const warningRadius = this.arenaRadius - this.currentMap.arena.shrinkAmount;
      this.arenaGraphics.strokeCircle(
        this.arenaCenter.x,
        this.arenaCenter.y,
        warningRadius
      );
    }

    // Draw center marker
    this.arenaGraphics.fillStyle(0xffffff, 0.2);
    this.arenaGraphics.fillCircle(this.arenaCenter.x, this.arenaCenter.y, 20);
  }

  private createArenaBoundary(): void {
    // Create a sensor ring around the arena to detect when players fall off
    // We use multiple small bodies in a circle pattern
    const segments = 32;
    const sensorWidth = 50;
    
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = this.arenaCenter.x + Math.cos(angle) * (this.arenaRadius + sensorWidth);
      const y = this.arenaCenter.y + Math.sin(angle) * (this.arenaRadius + sensorWidth);
      
      this.matter.add.rectangle(x, y, sensorWidth, sensorWidth, {
        isStatic: true,
        isSensor: true,
        label: 'arena_boundary',
      });
    }
  }

  private setupCollisions(): void {
    this.matter.world.on('collisionstart', (event: Phaser.Physics.Matter.Events.CollisionStartEvent) => {
      for (const pair of event.pairs) {
        const bodyA = pair.bodyA;
        const bodyB = pair.bodyB;

        // Check for player-boundary collision
        if (bodyA.label === 'arena_boundary' || bodyB.label === 'arena_boundary') {
          const playerBody = bodyA.label === 'player' ? bodyA : 
                            bodyB.label === 'player' ? bodyB : null;
          if (playerBody) {
            this.handlePlayerFallOff(playerBody);
          }
        }

        // Check for player-player collision
        if (bodyA.label === 'player' && bodyB.label === 'player') {
          this.handlePlayerCollision(bodyA, bodyB);
        }

        // Check for player-powerup collision
        if ((bodyA.label === 'player' && bodyB.label === 'powerup') ||
            (bodyA.label === 'powerup' && bodyB.label === 'player')) {
          const playerBody = bodyA.label === 'player' ? bodyA : bodyB;
          const powerupBody = bodyA.label === 'powerup' ? bodyA : bodyB;
          this.handlePowerupCollision(playerBody, powerupBody);
        }

        // Check for player-enemy collision
        if ((bodyA.label === 'player' && bodyB.label === 'enemy') ||
            (bodyA.label === 'enemy' && bodyB.label === 'player')) {
          const playerBody = bodyA.label === 'player' ? bodyA : bodyB;
          const enemyBody = bodyA.label === 'enemy' ? bodyA : bodyB;
          this.handleEnemyCollision(playerBody, enemyBody);
        }
      }
    });
  }

  private handlePlayerFallOff(playerBody: MatterJS.BodyType): void {
    const playerId = (playerBody as any).playerId;
    const player = this.players.get(playerId);
    
    if (!player || player.isInvulnerable()) return;

    // Check if actually outside arena
    const dx = playerBody.position.x - this.arenaCenter.x;
    const dy = playerBody.position.y - this.arenaCenter.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > this.arenaRadius) {
      player.loseLife();
      
      if (player.getLives() > 0) {
        // Respawn player at center
        player.respawn(this.arenaCenter.x, this.arenaCenter.y);
      } else {
        // Player eliminated
        player.eliminate();
        this.bridge.getEvents().onPlayerEliminated(playerId, 0);
        this.checkRoundEnd();
      }
    }
  }

  private handlePlayerCollision(bodyA: MatterJS.BodyType, bodyB: MatterJS.BodyType): void {
    // Apply screen shake on big collisions
    const relativeVelocity = Math.abs(bodyA.velocity.x - bodyB.velocity.x) +
                            Math.abs(bodyA.velocity.y - bodyB.velocity.y);
    
    if (relativeVelocity > 10) {
      this.cameras.main.shake(100, 0.01 * Math.min(relativeVelocity / 20, 1));
    }
  }

  private handlePowerupCollision(playerBody: MatterJS.BodyType, powerupBody: MatterJS.BodyType): void {
    const playerId = (playerBody as any).playerId;
    const powerupId = (powerupBody as any).powerupId;
    
    const player = this.players.get(playerId);
    const powerupIndex = this.powerups.findIndex(p => p.getId() === powerupId);
    
    if (player && powerupIndex !== -1) {
      const powerup = this.powerups[powerupIndex];
      player.applyPowerup(powerup.getType());
      this.bridge.getEvents().onPowerupCollected(playerId, powerup.getType());
      
      powerup.destroy();
      this.powerups.splice(powerupIndex, 1);
    }
  }

  private handleEnemyCollision(playerBody: MatterJS.BodyType, enemyBody: MatterJS.BodyType): void {
    // Enemy collision applies knockback to player
    const playerId = (playerBody as any).playerId;
    const player = this.players.get(playerId);
    
    if (player && !player.isInvulnerable()) {
      // Apply knockback from enemy
      const dx = playerBody.position.x - enemyBody.position.x;
      const dy = playerBody.position.y - enemyBody.position.y;
      const magnitude = Math.sqrt(dx * dx + dy * dy) || 1;
      
      this.matter.body.applyForce(playerBody, playerBody.position, {
        x: (dx / magnitude) * 0.05,
        y: (dy / magnitude) * 0.05,
      });
    }
  }

  private startCountdown(): void {
    this.bridge.setPhase('countdown');
    
    // Show "3"
    this.countdownText.setVisible(true);
    this.countdownText.setColor('#ffffff');
    this.countdownText.setText('3');
    this.countdownText.setScale(1);
    this.countdownText.setAlpha(1);
    this.tweens.add({
      targets: this.countdownText,
      scale: 1.3,
      alpha: 0.5,
      duration: 900,
      ease: 'Power2',
    });

    // Show "2" after 1 second
    this.time.delayedCall(1000, () => {
      this.countdownText.setText('2');
      this.countdownText.setScale(1);
      this.countdownText.setAlpha(1);
      this.tweens.add({
        targets: this.countdownText,
        scale: 1.3,
        alpha: 0.5,
        duration: 900,
        ease: 'Power2',
      });
    });

    // Show "1" after 2 seconds
    this.time.delayedCall(2000, () => {
      this.countdownText.setText('1');
      this.countdownText.setScale(1);
      this.countdownText.setAlpha(1);
      this.tweens.add({
        targets: this.countdownText,
        scale: 1.3,
        alpha: 0.5,
        duration: 900,
        ease: 'Power2',
      });
    });

    // Show "GO!" and start round after 3 seconds
    this.time.delayedCall(3000, () => {
      this.countdownText.setText('GO!');
      this.countdownText.setScale(1.5);
      this.countdownText.setAlpha(1);
      this.countdownText.setColor('#10b981');
      
      this.tweens.add({
        targets: this.countdownText,
        scale: 2,
        alpha: 0,
        duration: 500,
        ease: 'Power2',
        onComplete: () => {
          this.countdownText.setVisible(false);
        },
      });

      this.startRound();
    });
  }

  private startRound(): void {
    this.isRoundActive = true;
    this.lastShrinkTime = this.time.now;
    this.lastPowerupSpawn = this.time.now;
    this.lastEnemySpawn = this.time.now;
    this.nextEventTime = this.time.now + 8000; // First event after 8 seconds
    
    this.bridge.setPhase('playing');
  }

  private checkRoundEnd(): void {
    const alivePlayers = Array.from(this.players.values()).filter(p => !p.isEliminated());
    
    if (alivePlayers.length <= 1) {
      this.isRoundActive = false;
      const winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
      const winnerId = winner ? winner.getId() : null;
      
      // Show winner announcement
      this.showWinner(winner);
      
      this.bridge.setPhase('round_end');
      this.bridge.getEvents().onRoundEnd(winnerId);
      
      // Clear enemies
      for (const enemy of this.enemies) {
        enemy.destroy();
      }
      this.enemies = [];
      
      // Return to map vote after delay
      this.time.delayedCall(4000, () => {
        this.bridge.returnToMapVote();
      });
    }
  }

  private showWinner(winner: Player | null): void {
    if (winner) {
      // Get winner name from the player
      const winnerName = this.getPlayerName(winner.getId());
      this.winnerText.setText(`🏆 ${winnerName} WINS! 🏆`);
      this.winnerText.setColor('#fbbf24');
    } else {
      this.winnerText.setText('DRAW!');
      this.winnerText.setColor('#ef4444');
    }
    
    this.winnerText.setVisible(true);
    this.winnerText.setScale(0.5);
    this.winnerText.setAlpha(0);
    
    // Animate in
    this.tweens.add({
      targets: this.winnerText,
      scale: 1.2,
      alpha: 1,
      duration: 500,
      ease: 'Back.easeOut',
      onComplete: () => {
        // Pulse effect
        this.tweens.add({
          targets: this.winnerText,
          scale: 1,
          duration: 200,
          yoyo: true,
          repeat: 3,
        });
      },
    });

    // Camera effect
    this.cameras.main.flash(500, 255, 215, 0, false);
  }

  private getPlayerName(playerId: string): string {
    // Try to find player name from registered players
    const players = this.bridge.getRegisteredPlayers();
    const playerData = players.find(p => p.playerId === playerId);
    return playerData?.name || 'Player';
  }

  private updateArenaShrink(): void {
    if (!this.isRoundActive) return;
    
    const now = this.time.now;
    const timeSinceLastShrink = now - this.lastShrinkTime;
    const shrinkInterval = this.currentMap.arena.shrinkInterval;
    
    // Show warning 2 seconds before shrink
    if (timeSinceLastShrink > shrinkInterval - 2000 && !this.shrinkWarning) {
      this.shrinkWarning = true;
      this.drawArena();
    }
    
    // Shrink the arena
    if (timeSinceLastShrink >= shrinkInterval) {
      const newRadius = Math.max(
        this.arenaRadius - this.currentMap.arena.shrinkAmount,
        this.currentMap.arena.minRadius
      );
      
      if (newRadius < this.arenaRadius) {
        this.arenaRadius = newRadius;
        this.shrinkWarning = false;
        this.lastShrinkTime = now;
        this.drawArena();
        this.bridge.getEvents().onArenaShink(this.arenaRadius);
        
        // Update enemies with new arena radius
        for (const enemy of this.enemies) {
          enemy.setArenaRadius(this.arenaRadius);
        }
        
        // Screen shake on shrink
        this.cameras.main.shake(200, 0.02);
      }
    }
  }

  private spawnPowerup(): void {
    if (!this.isRoundActive) return;
    
    const now = this.time.now;
    if (now - this.lastPowerupSpawn < POWERUP_SPAWN_INTERVAL) return;
    
    // Don't spawn too many powerups
    if (this.powerups.length >= 3) return;
    
    // Random position within arena
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * (this.arenaRadius - 50);
    const x = this.arenaCenter.x + Math.cos(angle) * distance;
    const y = this.arenaCenter.y + Math.sin(angle) * distance;
    
    const powerup = new Powerup(this, x, y);
    this.powerups.push(powerup);
    this.lastPowerupSpawn = now;
  }

  private spawnEnemy(): void {
    if (!this.isRoundActive) return;
    
    const now = this.time.now;
    const ENEMY_SPAWN_INTERVAL = 8000; // Spawn every 8 seconds
    
    if (now - this.lastEnemySpawn < ENEMY_SPAWN_INTERVAL) return;
    
    // Don't spawn too many enemies
    if (this.enemies.length >= 3) return;
    
    // Spawn at edge of arena
    const angle = Math.random() * Math.PI * 2;
    const x = this.arenaCenter.x + Math.cos(angle) * (this.arenaRadius - 30);
    const y = this.arenaCenter.y + Math.sin(angle) * (this.arenaRadius - 30);
    
    // Random enemy type
    const types: Array<'chaser' | 'bumper' | 'slime'> = ['chaser', 'bumper', 'slime'];
    const type = types[Math.floor(Math.random() * types.length)];
    
    const enemy = new Enemy(this, x, y, type, this.arenaCenter, this.arenaRadius);
    this.enemies.push(enemy);
    this.lastEnemySpawn = now;
    
    // Announce enemy spawn with description
    const descriptions: Record<string, string> = {
      chaser: '🎯 CHASER - Hunts you!',
      bumper: '💪 BUMPER - Heavy hitter!',
      slime: '🟢 SLIME - Slow & sticky!',
    };
    this.showEventText(descriptions[type] || `⚠️ ${type.toUpperCase()} SPAWNED!`);
  }

  private triggerGameEvent(): void {
    if (!this.isRoundActive) return;
    
    const now = this.time.now;
    const EVENT_INTERVAL = 12000; // Events every 12 seconds
    const WARNING_TIME = 3000; // 3 second warning
    
    // Show warning before event
    const timeUntilEvent = this.nextEventTime - now;
    
    if (timeUntilEvent > 0 && timeUntilEvent <= WARNING_TIME && !this.eventWarningActive) {
      // Start warning phase
      this.eventWarningActive = true;
      
      // Pick event based on arena category
      this.pendingEventType = this.selectEventForArena();
      
      const eventNames: Record<string, string> = {
        shockwave: '💥 SHOCKWAVE',
        wind: '💨 WIND GUST',
        bounce: '🔄 CHAOS BOUNCE',
        ice_slide: '❄️ ICE SLIDE',
        hazard_burst: '⚡ DANGER ZONE',
        gravity_pulse: '🌀 GRAVITY PULSE',
        speed_zone: '⚡ SPEED SURGE',
      };
      
      const eventName = eventNames[this.pendingEventType] || '⚠️ EVENT';
      this.eventCountdownText.setText(`${eventName} in 3...`);
      this.eventCountdownText.setVisible(true);
      
      // Countdown updates
      this.time.delayedCall(1000, () => {
        if (this.eventCountdownText) {
          this.eventCountdownText.setText(`${eventName} in 2...`);
        }
      });
      this.time.delayedCall(2000, () => {
        if (this.eventCountdownText) {
          this.eventCountdownText.setText(`${eventName} in 1...`);
        }
      });
    }
    
    // Execute event when time is up
    if (now >= this.nextEventTime && this.eventWarningActive) {
      this.eventWarningActive = false;
      this.eventCountdownText.setVisible(false);
      this.nextEventTime = now + EVENT_INTERVAL;
      
      this.executeEvent(this.pendingEventType);
    }
  }

  private selectEventForArena(): string {
    const category = this.currentMap.category;
    
    // Events specific to arena type
    const categoryEvents: Record<string, string[]> = {
      shrinking: ['shockwave', 'wind', 'speed_zone'],
      hazard: ['hazard_burst', 'shockwave', 'wind'],
      ice: ['ice_slide', 'wind', 'bounce'],
      special: ['gravity_pulse', 'bounce', 'shockwave'],
    };
    
    const events = categoryEvents[category] || ['shockwave', 'wind', 'bounce'];
    return events[Math.floor(Math.random() * events.length)];
  }

  private executeEvent(eventType: string): void {
    switch (eventType) {
      case 'shockwave':
        this.triggerShockwave();
        break;
      case 'wind':
        this.triggerWind();
        break;
      case 'bounce':
        this.triggerBounceWave();
        break;
      case 'ice_slide':
        this.triggerIceSlide();
        break;
      case 'hazard_burst':
        this.triggerHazardBurst();
        break;
      case 'gravity_pulse':
        this.triggerGravityPulse();
        break;
      case 'speed_zone':
        this.triggerSpeedZone();
        break;
    }
  }

  private triggerShockwave(): void {
    this.showEventText('💥 SHOCKWAVE!');
    
    // Shake camera
    this.cameras.main.shake(300, 0.03);
    
    // Push all players outward from center
    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const pos = player.getPosition();
      const dx = pos.x - this.arenaCenter.x;
      const dy = pos.y - this.arenaCenter.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      
      // Stronger push for players closer to center
      const pushStrength = 8 * (1 - dist / this.arenaRadius);
      const body = player.getBody();
      this.matter.body.setVelocity(body, {
        x: body.velocity.x + (dx / dist) * pushStrength,
        y: body.velocity.y + (dy / dist) * pushStrength,
      });
    }
    
    // Visual effect - expanding ring
    this.eventWarningGraphics.clear();
    this.eventWarningGraphics.lineStyle(8, 0xff6b6b, 1);
    this.eventWarningGraphics.strokeCircle(this.arenaCenter.x, this.arenaCenter.y, 30);
    
    const shockwaveState = { radius: 30 };
    this.tweens.add({
      targets: shockwaveState,
      radius: this.arenaRadius,
      duration: 300,
      onUpdate: () => {
        const r = shockwaveState.radius;
        const progress = r / this.arenaRadius;
        this.eventWarningGraphics.clear();
        this.eventWarningGraphics.lineStyle(8 * (1 - progress), 0xff6b6b, 1 - progress);
        this.eventWarningGraphics.strokeCircle(this.arenaCenter.x, this.arenaCenter.y, r);
      },
      onComplete: () => {
        this.eventWarningGraphics.clear();
      },
    });
  }

  private triggerWind(): void {
    // Random wind direction
    const windAngle = Math.random() * Math.PI * 2;
    const windDirX = Math.cos(windAngle);
    const windDirY = Math.sin(windAngle);
    
    this.showEventText('💨 WIND GUST!');
    
    // Apply wind force to all players
    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const body = player.getBody();
      this.matter.body.setVelocity(body, {
        x: body.velocity.x + windDirX * 5,
        y: body.velocity.y + windDirY * 5,
      });
    }
    
    // Apply to enemies too
    for (const enemy of this.enemies) {
      const body = enemy.getBody();
      this.matter.body.setVelocity(body, {
        x: body.velocity.x + windDirX * 5,
        y: body.velocity.y + windDirY * 5,
      });
    }
  }

  private triggerBounceWave(): void {
    this.showEventText('🔄 CHAOS BOUNCE!');
    
    // Make all players bounce off each other with increased force
    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const body = player.getBody();
      // Increase velocity in current direction
      this.matter.body.setVelocity(body, {
        x: body.velocity.x * 2.5,
        y: body.velocity.y * 2.5,
      });
    }
  }

  private triggerIceSlide(): void {
    this.showEventText('❄️ ICE SLIDE!');
    
    // Random direction everyone slides
    const slideAngle = Math.random() * Math.PI * 2;
    const slideX = Math.cos(slideAngle);
    const slideY = Math.sin(slideAngle);
    
    // Draw direction arrow
    this.eventWarningGraphics.clear();
    this.eventWarningGraphics.lineStyle(4, 0x67e8f9, 1);
    this.eventWarningGraphics.lineBetween(
      this.arenaCenter.x,
      this.arenaCenter.y,
      this.arenaCenter.x + slideX * 100,
      this.arenaCenter.y + slideY * 100
    );
    
    // Apply sliding force to all players
    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const body = player.getBody();
      this.matter.body.setVelocity(body, {
        x: body.velocity.x + slideX * 8,
        y: body.velocity.y + slideY * 8,
      });
    }
    
    // Also slide enemies
    for (const enemy of this.enemies) {
      const body = enemy.getBody();
      this.matter.body.setVelocity(body, {
        x: body.velocity.x + slideX * 6,
        y: body.velocity.y + slideY * 6,
      });
    }
    
    // Clear visual after 1 second
    this.time.delayedCall(1000, () => {
      this.eventWarningGraphics.clear();
    });
  }

  private triggerHazardBurst(): void {
    this.showEventText('⚡ DANGER ZONE!');
    
    // Create multiple knockback zones around the arena
    const numZones = 4 + Math.floor(Math.random() * 3);
    
    for (let i = 0; i < numZones; i++) {
      const angle = (i / numZones) * Math.PI * 2 + Math.random() * 0.5;
      const dist = this.arenaRadius * 0.5 * Math.random() + 50;
      const zoneX = this.arenaCenter.x + Math.cos(angle) * dist;
      const zoneY = this.arenaCenter.y + Math.sin(angle) * dist;
      const zoneRadius = 40 + Math.random() * 30;
      
      // Draw warning zone
      this.eventWarningGraphics.fillStyle(0xef4444, 0.3);
      this.eventWarningGraphics.fillCircle(zoneX, zoneY, zoneRadius);
      this.eventWarningGraphics.lineStyle(2, 0xef4444, 0.8);
      this.eventWarningGraphics.strokeCircle(zoneX, zoneY, zoneRadius);
      
      // Check players in zone and knock them back
      for (const player of this.players.values()) {
        if (player.isEliminated()) continue;
        
        const pos = player.getPosition();
        const dx = pos.x - zoneX;
        const dy = pos.y - zoneY;
        const distToZone = Math.sqrt(dx * dx + dy * dy);
        
        if (distToZone < zoneRadius) {
          const body = player.getBody();
          const knockback = 10 * (1 - distToZone / zoneRadius);
          this.matter.body.setVelocity(body, {
            x: body.velocity.x + (dx / distToZone) * knockback,
            y: body.velocity.y + (dy / distToZone) * knockback,
          });
        }
      }
    }
    
    // Camera shake
    this.cameras.main.shake(200, 0.02);
    
    // Clear visuals after 1.5 seconds
    this.time.delayedCall(1500, () => {
      this.eventWarningGraphics.clear();
    });
  }

  private triggerGravityPulse(): void {
    this.showEventText('🌀 GRAVITY PULSE!');
    
    // Pull everyone toward center, then push out
    const pullDuration = 1000;
    
    // Visual - growing circle
    const pulseState = { radius: 10 };
    this.eventWarningGraphics.clear();
    this.tweens.add({
      targets: pulseState,
      radius: this.arenaRadius * 0.7,
      duration: pullDuration,
      onUpdate: () => {
        this.eventWarningGraphics.clear();
        this.eventWarningGraphics.lineStyle(6, 0x8b5cf6, 0.6);
        this.eventWarningGraphics.strokeCircle(this.arenaCenter.x, this.arenaCenter.y, pulseState.radius);
      },
    });
    
    // Pull phase
    const pullInterval = this.time.addEvent({
      delay: 50,
      callback: () => {
        for (const player of this.players.values()) {
          if (player.isEliminated()) continue;
          
          const pos = player.getPosition();
          const dx = this.arenaCenter.x - pos.x;
          const dy = this.arenaCenter.y - pos.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          
          const body = player.getBody();
          this.matter.body.setVelocity(body, {
            x: body.velocity.x + (dx / dist) * 0.5,
            y: body.velocity.y + (dy / dist) * 0.5,
          });
        }
      },
      repeat: pullDuration / 50,
    });
    
    // Push phase after pull
    this.time.delayedCall(pullDuration, () => {
      pullInterval.destroy();
      this.triggerShockwave(); // Use shockwave for the push
      this.eventWarningGraphics.clear();
    });
  }

  private triggerSpeedZone(): void {
    this.showEventText('⚡ SPEED SURGE!');
    
    // Everyone gets a speed boost in their current direction
    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const body = player.getBody();
      const speed = Math.sqrt(body.velocity.x * body.velocity.x + body.velocity.y * body.velocity.y);
      
      if (speed > 0.5) {
        // Boost current velocity
        this.matter.body.setVelocity(body, {
          x: body.velocity.x * 2,
          y: body.velocity.y * 2,
        });
      } else {
        // Give random direction if stationary
        const angle = Math.random() * Math.PI * 2;
        this.matter.body.setVelocity(body, {
          x: Math.cos(angle) * 5,
          y: Math.sin(angle) * 5,
        });
      }
    }
    
    // Visual burst from center
    this.eventWarningGraphics.clear();
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const startX = this.arenaCenter.x + Math.cos(angle) * 30;
      const startY = this.arenaCenter.y + Math.sin(angle) * 30;
      const endX = this.arenaCenter.x + Math.cos(angle) * 100;
      const endY = this.arenaCenter.y + Math.sin(angle) * 100;
      
      this.eventWarningGraphics.lineStyle(3, 0xfbbf24, 0.8);
      this.eventWarningGraphics.lineBetween(startX, startY, endX, endY);
    }
    
    this.time.delayedCall(500, () => {
      this.eventWarningGraphics.clear();
    });
  }

  private showEventText(text: string): void {
    const eventText = this.add.text(
      this.arenaCenter.x,
      this.arenaCenter.y - 100,
      text,
      {
        fontSize: '32px',
        fontFamily: 'Arial Black',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 4,
      }
    ).setOrigin(0.5).setDepth(90);
    
    this.tweens.add({
      targets: eventText,
      y: eventText.y - 50,
      alpha: 0,
      scale: 1.5,
      duration: 1500,
      ease: 'Power2',
      onComplete: () => eventText.destroy(),
    });
  }

  update(time: number, delta: number): void {
    if (!this.bridge) return;

    // Update arena shrinking
    this.updateArenaShrink();

    // Spawn powerups
    this.spawnPowerup();

    // Spawn enemies
    this.spawnEnemy();

    // Trigger game events
    this.triggerGameEvent();

    // Update all players based on input
    for (const [playerId, player] of this.players) {
      const input = this.bridge.getPlayerInput(playerId);
      if (input) {
        player.handleInput(input, delta);
      }
      player.update(time, delta);
      
      // Check if player is outside arena
      this.checkPlayerBounds(player);
    }

    // Update enemies and remove expired ones
    const enemiesToRemove: Enemy[] = [];
    for (const enemy of this.enemies) {
      const isAlive = enemy.update(time, delta, this.getClosestPlayer(enemy.getPosition()));
      
      // Check if enemy expired or is outside arena
      if (!isAlive) {
        enemiesToRemove.push(enemy);
        continue;
      }
      
      const pos = enemy.getPosition();
      const dx = pos.x - this.arenaCenter.x;
      const dy = pos.y - this.arenaCenter.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > this.arenaRadius + 50) {
        enemy.destroy();
        enemiesToRemove.push(enemy);
      }
    }
    
    // Filter out removed enemies
    if (enemiesToRemove.length > 0) {
      this.enemies = this.enemies.filter(e => !enemiesToRemove.includes(e));
    }

    // Update powerups
    for (const powerup of this.powerups) {
      powerup.update(time, delta);
    }
  }

  private checkPlayerBounds(player: Player): void {
    const pos = player.getPosition();
    const dx = pos.x - this.arenaCenter.x;
    const dy = pos.y - this.arenaCenter.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > this.arenaRadius && !player.isInvulnerable() && !player.isEliminated()) {
      player.loseLife();
      
      if (player.getLives() > 0) {
        player.respawn(this.arenaCenter.x, this.arenaCenter.y);
      } else {
        player.eliminate();
        this.bridge.getEvents().onPlayerEliminated(player.getId(), 0);
        this.checkRoundEnd();
      }
    }
  }

  private getClosestPlayer(position: Position): Player | null {
    let closest: Player | null = null;
    let closestDist = Infinity;

    for (const player of this.players.values()) {
      if (player.isEliminated()) continue;
      
      const pos = player.getPosition();
      const dx = pos.x - position.x;
      const dy = pos.y - position.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < closestDist) {
        closestDist = dist;
        closest = player;
      }
    }

    return closest;
  }

  addPlayer(playerId: string, name: string, color: number): void {
    if (this.players.has(playerId)) return;

    // Spawn at center with slight offset based on player count
    const offset = this.players.size * 30;
    const angle = (this.players.size / 8) * Math.PI * 2;
    const x = this.arenaCenter.x + Math.cos(angle) * offset;
    const y = this.arenaCenter.y + Math.sin(angle) * offset;

    const player = new Player(this, playerId, name, color, x, y);
    this.players.set(playerId, player);
  }

  removePlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (player) {
      player.destroy();
      this.players.delete(playerId);
    }
  }

  private setupDebugControls(): void {
    // Debug key to add test player
    this.input.keyboard?.on('keydown-P', () => {
      const testId = `test_${Date.now()}`;
      this.addPlayer(testId, 'Test Player', 0x3b82f6);
    });
  }
}

