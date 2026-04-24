// Bullet Entity - Projectile with physics and collision

import Phaser from 'phaser';
import {
  Position,
  Team,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_DAMAGE,
  BULLET_LIFETIME,
} from '../types';

let bulletIdCounter = 0;

export class Bullet {
  private scene: Phaser.Scene;
  private id: string;
  private ownerId: string;
  private ownerTeam: Team;
  private damage: number;
  private createdAt: number;
  private lifetime: number;
  
  // Physics
  private body: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Arc;
  private trail: Phaser.GameObjects.Graphics;
  
  // Trail positions for effect
  private trailPositions: Position[] = [];
  private maxTrailLength = 5;
  
  // State
  private isActiveFlag: boolean = true;

  constructor(
    scene: Phaser.Scene,
    ownerId: string,
    ownerTeam: Team,
    x: number,
    y: number,
    angle: number,
    color: number
  ) {
    this.scene = scene;
    this.id = `bullet_${bulletIdCounter++}`;
    this.ownerId = ownerId;
    this.ownerTeam = ownerTeam;
    this.damage = BULLET_DAMAGE;
    this.createdAt = Date.now();
    this.lifetime = BULLET_LIFETIME;
    
    // Calculate velocity from angle
    const velocityX = Math.cos(angle) * BULLET_SPEED;
    const velocityY = Math.sin(angle) * BULLET_SPEED;
    
    // Create physics body (sensor - we handle collision manually)
    this.body = scene.matter.add.circle(x, y, BULLET_RADIUS, {
      mass: 0.01,
      friction: 0,
      frictionAir: 0,
      restitution: 0,
      isSensor: false,
      label: 'bullet',
    });
    
    // Store reference to bullet on body
    (this.body as any).bulletRef = this;
    (this.body as any).ownerId = ownerId;
    (this.body as any).ownerTeam = ownerTeam;
    
    // Set initial velocity
    scene.matter.body.setVelocity(this.body, { x: velocityX / 60, y: velocityY / 60 });
    
    // Create visual sprite
    this.sprite = scene.add.circle(x, y, BULLET_RADIUS, color);
    this.sprite.setDepth(5);
    
    // Add glow effect
    this.sprite.setStrokeStyle(2, 0xffffff, 0.5);
    
    // Create trail graphics
    this.trail = scene.add.graphics().setDepth(4);
  }

  /**
   * Update bullet state
   */
  update(_time: number, _delta: number): boolean {
    if (!this.isActiveFlag) return false;
    
    // Check lifetime
    if (Date.now() - this.createdAt > this.lifetime) {
      this.destroy();
      return false;
    }
    
    // Update visual position
    const pos = this.getPosition();
    this.sprite.setPosition(pos.x, pos.y);
    
    // Update trail
    this.trailPositions.unshift({ x: pos.x, y: pos.y });
    if (this.trailPositions.length > this.maxTrailLength) {
      this.trailPositions.pop();
    }
    this.drawTrail();
    
    return true;
  }

  /**
   * Draw bullet trail
   */
  private drawTrail(): void {
    this.trail.clear();
    
    if (this.trailPositions.length < 2) return;
    
    // Draw fading trail
    for (let i = 1; i < this.trailPositions.length; i++) {
      const alpha = 1 - (i / this.trailPositions.length);
      const width = BULLET_RADIUS * 2 * (1 - i / this.trailPositions.length);
      
      this.trail.lineStyle(width, this.sprite.fillColor as number, alpha * 0.5);
      this.trail.lineBetween(
        this.trailPositions[i - 1].x,
        this.trailPositions[i - 1].y,
        this.trailPositions[i].x,
        this.trailPositions[i].y
      );
    }
  }

  /**
   * Called when bullet hits something
   */
  onHit(): void {
    if (!this.isActiveFlag) return;
    
    // Create hit effect
    this.createHitEffect();
    
    // Destroy bullet
    this.destroy();
  }

  /**
   * Create visual effect on hit
   */
  private createHitEffect(): void {
    const pos = this.getPosition();
    
    // Simple particle burst
    for (let i = 0; i < 5; i++) {
      const angle = (Math.PI * 2 * i) / 5;
      const particle = this.scene.add.circle(
        pos.x + Math.cos(angle) * 5,
        pos.y + Math.sin(angle) * 5,
        3,
        this.sprite.fillColor as number
      );
      particle.setDepth(6);
      
      // Animate and destroy
      this.scene.tweens.add({
        targets: particle,
        x: pos.x + Math.cos(angle) * 20,
        y: pos.y + Math.sin(angle) * 20,
        alpha: 0,
        scale: 0.5,
        duration: 150,
        onComplete: () => particle.destroy(),
      });
    }
  }

  /**
   * Get current position
   */
  getPosition(): Position {
    return {
      x: this.body.position.x,
      y: this.body.position.y,
    };
  }

  /**
   * Get physics body
   */
  getBody(): MatterJS.BodyType {
    return this.body;
  }

  /**
   * Get bullet ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Get owner player ID
   */
  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Get owner team
   */
  getOwnerTeam(): Team {
    return this.ownerTeam;
  }

  /**
   * Get damage value
   */
  getDamage(): number {
    return this.damage;
  }

  /**
   * Check if bullet is active
   */
  isActive(): boolean {
    return this.isActiveFlag;
  }

  /**
   * Destroy the bullet
   */
  destroy(): void {
    if (!this.isActiveFlag) return;
    
    this.isActiveFlag = false;
    this.sprite.destroy();
    this.trail.destroy();
    this.scene.matter.world.remove(this.body);
  }
}

/**
 * Bullet pool for efficient bullet management
 */
export class BulletPool {
  private scene: Phaser.Scene;
  private bullets: Bullet[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Create a new bullet
   */
  create(
    ownerId: string,
    ownerTeam: Team,
    x: number,
    y: number,
    angle: number,
    color: number
  ): Bullet {
    const bullet = new Bullet(this.scene, ownerId, ownerTeam, x, y, angle, color);
    this.bullets.push(bullet);
    return bullet;
  }

  /**
   * Update all bullets
   */
  update(time: number, delta: number): void {
    // Update all bullets and remove inactive ones
    this.bullets = this.bullets.filter(bullet => bullet.update(time, delta));
  }

  /**
   * Get all active bullets
   */
  getActiveBullets(): Bullet[] {
    return this.bullets.filter(b => b.isActive());
  }

  /**
   * Remove a specific bullet
   */
  remove(bullet: Bullet): void {
    bullet.destroy();
    this.bullets = this.bullets.filter(b => b !== bullet);
  }

  /**
   * Clear all bullets
   */
  clear(): void {
    for (const bullet of this.bullets) {
      bullet.destroy();
    }
    this.bullets = [];
  }

  /**
   * Get bullet count
   */
  getCount(): number {
    return this.bullets.length;
  }
}

