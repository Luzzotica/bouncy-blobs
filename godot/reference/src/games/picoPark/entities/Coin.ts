// Coin Entity - Collectible coin with respawn mechanics

import Phaser from 'phaser';
import { Position, COIN_RADIUS, COIN_RESPAWN_TIME } from '../types';

export class Coin {
  private scene: Phaser.Scene;
  private id: string;
  private position: Position;
  private spawnPosition: Position;
  
  // Physics
  private body: MatterJS.BodyType;
  
  // Visuals
  private sprite: Phaser.GameObjects.Arc;
  private glowGraphics: Phaser.GameObjects.Graphics;
  private sparkleEmitter?: Phaser.GameObjects.Particles.ParticleEmitter;
  
  // State
  private isCollectedFlag: boolean = false;
  private respawnTimer: number = 0;
  private bobOffset: number = 0;
  private baseY: number;

  constructor(
    scene: Phaser.Scene,
    id: string,
    x: number,
    y: number
  ) {
    this.scene = scene;
    this.id = id;
    this.position = { x, y };
    this.spawnPosition = { x, y };
    this.baseY = y;
    this.bobOffset = Math.random() * Math.PI * 2; // Random phase for bobbing
    
    // Create sensor body for collection
    this.body = scene.matter.add.circle(x, y, COIN_RADIUS, {
      isSensor: true,
      isStatic: true,
      label: 'coin',
    });
    (this.body as any).coinId = id;
    
    // Create visual sprite
    this.sprite = scene.add.circle(x, y, COIN_RADIUS, 0xffd700);
    this.sprite.setStrokeStyle(2, 0xffaa00);
    this.sprite.setDepth(5);
    
    // Create glow effect
    this.glowGraphics = scene.add.graphics().setDepth(4);
    this.drawGlow();
  }

  private drawGlow(): void {
    this.glowGraphics.clear();
    
    if (this.isCollectedFlag) return;
    
    const pos = this.position;
    
    // Outer glow
    this.glowGraphics.fillStyle(0xffd700, 0.2);
    this.glowGraphics.fillCircle(pos.x, pos.y, COIN_RADIUS * 1.8);
    
    this.glowGraphics.fillStyle(0xffd700, 0.1);
    this.glowGraphics.fillCircle(pos.x, pos.y, COIN_RADIUS * 2.2);
  }

  /**
   * Update coin state
   */
  update(_time: number, delta: number): void {
    // Handle respawn timer
    if (this.isCollectedFlag) {
      if (this.respawnTimer > 0) {
        this.respawnTimer -= delta;
        
        if (this.respawnTimer <= 0) {
          this.respawn();
        }
      }
      return;
    }
    
    // Bobbing animation
    this.bobOffset += delta * 0.003;
    const bobAmount = Math.sin(this.bobOffset) * 3;
    
    this.position.y = this.baseY + bobAmount;
    this.sprite.setPosition(this.position.x, this.position.y);
    this.scene.matter.body.setPosition(this.body, this.position);
    
    // Rotation effect
    const scale = 0.9 + Math.abs(Math.sin(this.bobOffset * 0.5)) * 0.2;
    this.sprite.setScale(scale, 1);
    
    // Update glow
    this.drawGlow();
  }

  /**
   * Collect the coin
   */
  collect(_playerId: string): void {
    if (this.isCollectedFlag) return;
    
    this.isCollectedFlag = true;
    this.respawnTimer = COIN_RESPAWN_TIME;
    
    // Hide visuals
    this.sprite.setVisible(false);
    this.glowGraphics.clear();
    
    // Play collection effect
    this.playCollectEffect();
  }

  private playCollectEffect(): void {
    const pos = this.position;
    
    // Create sparkle particles
    const particles = this.scene.add.particles(pos.x, pos.y, undefined, {
      speed: { min: 50, max: 150 },
      scale: { start: 0.4, end: 0 },
      lifespan: 500,
      quantity: 8,
      emitting: false,
    });
    
    // Custom particle render
    const colors = [0xffd700, 0xffaa00, 0xffff00];
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const color = colors[Math.floor(Math.random() * colors.length)];
      
      const spark = this.scene.add.circle(
        pos.x,
        pos.y,
        3,
        color
      ).setDepth(20);
      
      this.scene.tweens.add({
        targets: spark,
        x: pos.x + Math.cos(angle) * speed,
        y: pos.y + Math.sin(angle) * speed - 30,
        alpha: 0,
        scale: 0,
        duration: 400,
        ease: 'Power2',
        onComplete: () => spark.destroy(),
      });
    }
    
    // Floating "+1" text
    const scoreText = this.scene.add.text(pos.x, pos.y, '+1', {
      fontSize: '20px',
      fontFamily: 'Arial Black',
      color: '#ffd700',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(21);
    
    this.scene.tweens.add({
      targets: scoreText,
      y: pos.y - 40,
      alpha: 0,
      duration: 800,
      ease: 'Power2',
      onComplete: () => scoreText.destroy(),
    });
    
    particles.destroy();
  }

  /**
   * Respawn the coin
   */
  private respawn(): void {
    this.isCollectedFlag = false;
    this.position = { ...this.spawnPosition };
    this.baseY = this.spawnPosition.y;
    
    // Reset physics body position
    this.scene.matter.body.setPosition(this.body, this.position);
    
    // Show visuals with fade in
    this.sprite.setVisible(true);
    this.sprite.setAlpha(0);
    this.sprite.setPosition(this.position.x, this.position.y);
    
    this.scene.tweens.add({
      targets: this.sprite,
      alpha: 1,
      duration: 300,
      ease: 'Power2',
    });
    
    // Spawn effect
    const ring = this.scene.add.circle(this.position.x, this.position.y, COIN_RADIUS * 0.5, 0xffd700, 0.5)
      .setDepth(6);
    
    this.scene.tweens.add({
      targets: ring,
      scale: 3,
      alpha: 0,
      duration: 400,
      ease: 'Power2',
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * Reset coin to initial state (for level restart)
   */
  reset(): void {
    this.isCollectedFlag = false;
    this.respawnTimer = 0;
    this.position = { ...this.spawnPosition };
    this.baseY = this.spawnPosition.y;
    
    this.scene.matter.body.setPosition(this.body, this.position);
    this.sprite.setVisible(true);
    this.sprite.setAlpha(1);
    this.sprite.setPosition(this.position.x, this.position.y);
    this.drawGlow();
  }

  /**
   * Check if collected
   */
  isCollected(): boolean {
    return this.isCollectedFlag;
  }

  /**
   * Get coin ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Get position
   */
  getPosition(): Position {
    return this.position;
  }

  /**
   * Destroy the coin entity
   */
  destroy(): void {
    this.sprite.destroy();
    this.glowGraphics.destroy();
    if (this.sparkleEmitter) {
      this.sparkleEmitter.destroy();
    }
    this.scene.matter.world.remove(this.body);
  }
}

