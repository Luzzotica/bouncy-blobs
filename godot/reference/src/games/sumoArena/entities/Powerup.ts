// Powerup Entity - Collectible power-ups

import Phaser from 'phaser';
import { Position, PowerupType } from '../types';

const POWERUP_CONFIGS: Record<PowerupType, { color: number; icon: string; name: string }> = {
  speed: { color: 0x10b981, icon: '⚡', name: 'Speed Boost' },
  mass: { color: 0xf59e0b, icon: '⬤', name: 'Heavy Mass' },
  dash_refresh: { color: 0x3b82f6, icon: '↻', name: 'Dash Refresh' },
  shield: { color: 0x06b6d4, icon: '🛡', name: 'Shield' },
  slippery: { color: 0x8b5cf6, icon: '💧', name: 'Slippery' },
};

export class Powerup {
  private scene: Phaser.Scene;
  private id: string;
  private type: PowerupType;
  private body: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Arc;
  private iconText: Phaser.GameObjects.Text;
  private glowGraphics: Phaser.GameObjects.Graphics;
  private isDestroyed: boolean = false;

  constructor(scene: Phaser.Scene, x: number, y: number, type?: PowerupType) {
    this.scene = scene;
    this.id = `powerup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Random type if not specified
    const types: PowerupType[] = ['speed', 'mass', 'dash_refresh', 'shield', 'slippery'];
    this.type = type || types[Math.floor(Math.random() * types.length)];
    
    const config = POWERUP_CONFIGS[this.type];

    // Create physics body (sensor - doesn't collide but detects overlap)
    this.body = scene.matter.add.circle(x, y, 15, {
      isStatic: true,
      isSensor: true,
      label: 'powerup',
    });
    (this.body as any).powerupId = this.id;

    // Create glow effect
    this.glowGraphics = scene.add.graphics();
    this.glowGraphics.setDepth(4);

    // Create visual sprite
    this.sprite = scene.add.circle(x, y, 15, config.color);
    this.sprite.setStrokeStyle(2, 0xffffff);
    this.sprite.setDepth(5);

    // Create icon text
    this.iconText = scene.add.text(x, y, config.icon, {
      fontSize: '16px',
    }).setOrigin(0.5).setDepth(6);

    // Spawn animation
    this.sprite.setScale(0);
    this.iconText.setScale(0);
    scene.tweens.add({
      targets: [this.sprite, this.iconText],
      scale: 1,
      duration: 300,
      ease: 'Back.easeOut',
    });
  }

  update(time: number, _delta: number): void {
    if (this.isDestroyed) return;

    // Bobbing animation
    const bob = Math.sin(time * 0.005) * 3;
    this.sprite.setPosition(this.body.position.x, this.body.position.y + bob);
    this.iconText.setPosition(this.body.position.x, this.body.position.y + bob);

    // Rotation
    this.sprite.rotation += 0.02;

    // Glow effect
    this.glowGraphics.clear();
    const config = POWERUP_CONFIGS[this.type];
    const glowIntensity = 0.3 + Math.sin(time * 0.01) * 0.2;
    this.glowGraphics.fillStyle(config.color, glowIntensity);
    this.glowGraphics.fillCircle(
      this.body.position.x,
      this.body.position.y + bob,
      25
    );
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    // Collection animation
    this.scene.tweens.add({
      targets: [this.sprite, this.iconText],
      scale: 1.5,
      alpha: 0,
      duration: 200,
      onComplete: () => {
        this.sprite.destroy();
        this.iconText.destroy();
        this.glowGraphics.destroy();
        this.scene.matter.world.remove(this.body);
      },
    });
  }

  getId(): string {
    return this.id;
  }

  getType(): PowerupType {
    return this.type;
  }

  getPosition(): Position {
    return { x: this.body.position.x, y: this.body.position.y };
  }
}

