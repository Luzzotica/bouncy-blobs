// Enemy Entity - AI-controlled enemies

import Phaser from 'phaser';
import { Position, EnemyType, DASH_FORCE } from '../types';
import { Player } from './Player';

const ENEMY_CONFIGS: Record<EnemyType, {
  color: number;
  mass: number;
  speed: number;
  size: number;
  dashInterval: number;
  description: string;
}> = {
  chaser: {
    color: 0xef4444, // Red
    mass: 0.8,
    speed: 2,
    size: 18,
    dashInterval: 2500,
    description: 'CHASER - Hunts players!',
  },
  bumper: {
    color: 0xf59e0b, // Yellow/Orange
    mass: 2.5,
    speed: 1.5,
    size: 28,
    dashInterval: 1500,
    description: 'BUMPER - Heavy hitter!',
  },
  slime: {
    color: 0x10b981, // Green
    mass: 1.2,
    speed: 1,
    size: 24,
    dashInterval: 4000,
    description: 'SLIME - Slow but sticky!',
  },
};

const ENEMY_LIFESPAN = 25000; // 25 seconds before fully expired

export class Enemy {
  private scene: Phaser.Scene;
  private id: string;
  private type: EnemyType;
  private body: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Arc;
  private eyeLeft: Phaser.GameObjects.Arc;
  private eyeRight: Phaser.GameObjects.Arc;
  private trailGraphics?: Phaser.GameObjects.Graphics;
  private labelText: Phaser.GameObjects.Text;
  
  private config: typeof ENEMY_CONFIGS.chaser;
  private lastDashTime: number = 0;
  private patrolAngle: number = 0;
  private arenaCenter: Position;
  private arenaRadius: number;
  private isDestroyed: boolean = false;
  private spawnTime: number = 0;
  private currentScale: number = 1;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    type: EnemyType,
    arenaCenter: Position,
    arenaRadius: number
  ) {
    this.scene = scene;
    this.id = `enemy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.type = type;
    this.config = ENEMY_CONFIGS[type];
    this.arenaCenter = arenaCenter;
    this.arenaRadius = arenaRadius;
    this.spawnTime = scene.time.now;

    // Create physics body
    this.body = scene.matter.add.circle(x, y, this.config.size, {
      mass: this.config.mass,
      friction: 0.1,
      frictionAir: 0.05,
      restitution: 0.7,
      label: 'enemy',
    });
    (this.body as any).enemyId = this.id;

    // Create visual sprite
    this.sprite = scene.add.circle(x, y, this.config.size, this.config.color);
    this.sprite.setStrokeStyle(3, 0x000000);
    this.sprite.setDepth(8);

    // Create eyes
    const eyeOffset = this.config.size * 0.4;
    this.eyeLeft = scene.add.circle(x - eyeOffset, y - 5, 4, 0xffffff);
    this.eyeRight = scene.add.circle(x + eyeOffset, y - 5, 4, 0xffffff);
    this.eyeLeft.setDepth(9);
    this.eyeRight.setDepth(9);

    // Create type label
    const typeLabel = type === 'chaser' ? '🎯' : type === 'bumper' ? '💪' : '🟢';
    this.labelText = scene.add.text(x, y - this.config.size - 10, typeLabel, {
      fontSize: '16px',
    }).setOrigin(0.5).setDepth(9);

    // Create slime trail for slime type
    if (type === 'slime') {
      this.trailGraphics = scene.add.graphics();
      this.trailGraphics.setDepth(1);
    }

    // Spawn animation
    this.sprite.setScale(0);
    this.eyeLeft.setScale(0);
    this.eyeRight.setScale(0);
    this.labelText.setScale(0);
    scene.tweens.add({
      targets: [this.sprite, this.eyeLeft, this.eyeRight, this.labelText],
      scale: 1,
      duration: 500,
      ease: 'Back.easeOut',
    });
  }

  update(time: number, _delta: number, nearestPlayer: Player | null): boolean {
    if (this.isDestroyed) return false;

    // Handle expiration - shrink over time
    const age = time - this.spawnTime;
    const lifeProgress = Math.min(age / ENEMY_LIFESPAN, 1);
    
    // Scale from 1.0 down to 0.0 over lifespan
    const newScale = 1 - lifeProgress;
    
    // If fully expired, mark for destruction
    if (newScale <= 0.1) {
      this.destroy();
      return false; // Signal enemy should be removed
    }
    
    // Scale physics body if scale changed significantly
    if (Math.abs(newScale - this.currentScale) > 0.02) {
      const scaleRatio = newScale / this.currentScale;
      this.scene.matter.body.scale(this.body, scaleRatio, scaleRatio);
      this.currentScale = newScale;
    }
    
    // Update visual scale
    const visualScale = this.currentScale;
    this.sprite.setScale(visualScale);
    this.eyeLeft.setScale(visualScale);
    this.eyeRight.setScale(visualScale);
    
    // Make enemies more transparent as they expire
    const alpha = 0.5 + (this.currentScale * 0.5);
    this.sprite.setAlpha(alpha);
    this.labelText.setAlpha(alpha);

    // Update visuals position
    this.sprite.setPosition(this.body.position.x, this.body.position.y);
    this.labelText.setPosition(this.body.position.x, this.body.position.y - this.config.size * visualScale - 12);

    // Update eyes to look at player or forward
    let lookDir = { x: 1, y: 0 };
    if (nearestPlayer) {
      const playerPos = nearestPlayer.getPosition();
      const dx = playerPos.x - this.body.position.x;
      const dy = playerPos.y - this.body.position.y;
      const mag = Math.sqrt(dx * dx + dy * dy) || 1;
      lookDir = { x: dx / mag, y: dy / mag };
    }

    const eyeOffset = this.config.size * 0.4 * visualScale;
    const eyeMove = 2 * visualScale;
    this.eyeLeft.setPosition(
      this.body.position.x - eyeOffset + lookDir.x * eyeMove,
      this.body.position.y - 5 * visualScale + lookDir.y * eyeMove
    );
    this.eyeRight.setPosition(
      this.body.position.x + eyeOffset + lookDir.x * eyeMove,
      this.body.position.y - 5 * visualScale + lookDir.y * eyeMove
    );

    // Keep enemy within arena bounds
    this.stayInArena();

    // AI behavior based on type
    switch (this.type) {
      case 'chaser':
        this.updateChaser(time, nearestPlayer);
        break;
      case 'bumper':
        this.updateBumper(time, nearestPlayer);
        break;
      case 'slime':
        this.updateSlime(time, nearestPlayer);
        break;
    }
    
    return true; // Enemy still alive
  }

  private stayInArena(): void {
    // Check distance from arena center
    const dx = this.body.position.x - this.arenaCenter.x;
    const dy = this.body.position.y - this.arenaCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // If getting too close to edge, push back toward center
    const safeRadius = this.arenaRadius - 50;
    if (dist > safeRadius) {
      const pushStrength = 0.002 * ((dist - safeRadius) / 50);
      this.scene.matter.body.applyForce(this.body, this.body.position, {
        x: -(dx / dist) * pushStrength,
        y: -(dy / dist) * pushStrength,
      });
    }
  }

  setArenaRadius(radius: number): void {
    this.arenaRadius = radius;
  }

  private updateChaser(time: number, nearestPlayer: Player | null): void {
    if (!nearestPlayer) return;

    const playerPos = nearestPlayer.getPosition();
    const dx = playerPos.x - this.body.position.x;
    const dy = playerPos.y - this.body.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance < 1) return;

    // Move toward player
    const force = 0.0002 * this.config.speed;
    this.scene.matter.body.applyForce(this.body, this.body.position, {
      x: (dx / distance) * force,
      y: (dy / distance) * force,
    });

    // Dash when close and cooldown is ready
    if (distance < 150 && time - this.lastDashTime > this.config.dashInterval) {
      this.performDash(dx / distance, dy / distance);
      this.lastDashTime = time;
    }
  }

  private updateBumper(time: number, nearestPlayer: Player | null): void {
    // Patrol in a circle around arena center (stay inside)
    this.patrolAngle += 0.008;
    const patrolRadius = Math.min(this.arenaRadius * 0.5, 150); // Stay well within arena
    const targetX = this.arenaCenter.x + Math.cos(this.patrolAngle) * patrolRadius;
    const targetY = this.arenaCenter.y + Math.sin(this.patrolAngle) * patrolRadius;

    const dx = targetX - this.body.position.x;
    const dy = targetY - this.body.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 5) {
      const force = 0.00015 * this.config.speed;
      this.scene.matter.body.applyForce(this.body, this.body.position, {
        x: (dx / distance) * force,
        y: (dy / distance) * force,
      });
    }

    // Dash at player if they get close - bumper is the heavy hitter
    if (nearestPlayer) {
      const playerPos = nearestPlayer.getPosition();
      const playerDx = playerPos.x - this.body.position.x;
      const playerDy = playerPos.y - this.body.position.y;
      const playerDist = Math.sqrt(playerDx * playerDx + playerDy * playerDy);

      if (playerDist < 120 && time - this.lastDashTime > this.config.dashInterval) {
        this.performDash(playerDx / playerDist, playerDy / playerDist);
        this.lastDashTime = time;
      }
    }
  }

  private updateSlime(_time: number, nearestPlayer: Player | null): void {
    // Slow movement toward nearest player
    if (nearestPlayer) {
      const playerPos = nearestPlayer.getPosition();
      const dx = playerPos.x - this.body.position.x;
      const dy = playerPos.y - this.body.position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > 1) {
        const force = 0.00005 * this.config.speed;
        this.scene.matter.body.applyForce(this.body, this.body.position, {
          x: (dx / distance) * force,
          y: (dy / distance) * force,
        });
      }
    }

    // Leave slippery trail
    if (this.trailGraphics) {
      // Fade existing trail
      this.trailGraphics.alpha = Math.max(0, this.trailGraphics.alpha - 0.001);
      
      // Add new trail segment
      this.trailGraphics.fillStyle(0x10b981, 0.3);
      this.trailGraphics.fillCircle(this.body.position.x, this.body.position.y, 15);
    }
  }

  private performDash(dirX: number, dirY: number): void {
    // Chaser has reduced dash - it's fast but not deadly
    // Bumper is the heavy hitter
    const dashMultiplier = this.type === 'chaser' ? 0.35 : 0.8;
    const dashForce = DASH_FORCE * dashMultiplier * 0.01 * this.currentScale;
    
    this.scene.matter.body.applyForce(this.body, this.body.position, {
      x: dirX * dashForce,
      y: dirY * dashForce,
    });

    // Visual feedback
    this.scene.tweens.add({
      targets: this.sprite,
      scale: 1.3 * this.currentScale,
      duration: 100,
      yoyo: true,
    });
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.sprite.destroy();
    this.eyeLeft.destroy();
    this.eyeRight.destroy();
    this.labelText.destroy();
    if (this.trailGraphics) {
      this.trailGraphics.destroy();
    }
    this.scene.matter.world.remove(this.body);
  }

  getId(): string {
    return this.id;
  }

  getType(): EnemyType {
    return this.type;
  }

  getPosition(): Position {
    return { x: this.body.position.x, y: this.body.position.y };
  }

  getBody(): MatterJS.BodyType {
    return this.body;
  }
}

