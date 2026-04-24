// Bounce Zone - Bouncy areas that reflect players with extra force

import { Zone } from './Zone';
import { ZoneDefinition, Position } from '../types';

export class BounceZone extends Zone {
  private pulsePhase: number = 0;
  private lastBounceTime: Map<string, number> = new Map();
  private bounceCooldown: number = 200; // ms between bounces

  constructor(scene: Phaser.Scene, definition: ZoneDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
  }

  draw(): void {
    this.graphics.clear();

    const radius = this.definition.radius || 30;
    const x = this.position.x;
    const y = this.position.y;
    const pulseScale = 1 + Math.sin(this.pulsePhase) * 0.1;

    if (this.definition.shape === 'circle') {
      // Outer glow
      this.graphics.fillStyle(0xf59e0b, 0.2);
      this.graphics.fillCircle(x, y, radius * pulseScale + 10);

      // Main bumper
      this.graphics.fillStyle(0xfbbf24, 0.8);
      this.graphics.fillCircle(x, y, radius * pulseScale);

      // Inner highlight
      this.graphics.fillStyle(0xfef3c7, 0.6);
      this.graphics.fillCircle(x - radius * 0.2, y - radius * 0.2, radius * 0.4);

      // Edge ring
      this.graphics.lineStyle(4, 0xf59e0b, 1);
      this.graphics.strokeCircle(x, y, radius * pulseScale);

      // Impact lines (decorative)
      const numLines = 8;
      for (let i = 0; i < numLines; i++) {
        const angle = (i / numLines) * Math.PI * 2;
        const innerR = radius * 0.6;
        const outerR = radius * 0.9;
        this.graphics.lineStyle(2, 0xfef3c7, 0.5);
        this.graphics.lineBetween(
          x + Math.cos(angle) * innerR,
          y + Math.sin(angle) * innerR,
          x + Math.cos(angle) * outerR,
          y + Math.sin(angle) * outerR
        );
      }
    } else {
      // Rectangle bumper wall
      const width = this.definition.width || 100;
      const height = this.definition.height || 20;

      this.graphics.fillStyle(0xfbbf24, 0.8);
      this.graphics.fillRect(
        x - width / 2,
        y - (height * pulseScale) / 2,
        width,
        height * pulseScale
      );

      this.graphics.lineStyle(4, 0xf59e0b, 1);
      this.graphics.strokeRect(
        x - width / 2,
        y - (height * pulseScale) / 2,
        width,
        height * pulseScale
      );
    }
  }

  update(_time: number, delta: number): void {
    this.pulsePhase += delta * 0.005;
    this.draw();
  }

  applyEffect(
    body: MatterJS.BodyType,
    playerX: number,
    playerY: number,
    _delta: number
  ): void {
    const playerId = (body as any).playerId || 'unknown';
    const now = this.scene.time.now;
    const lastBounce = this.lastBounceTime.get(playerId) || 0;

    // Cooldown to prevent rapid bouncing
    if (now - lastBounce < this.bounceCooldown) return;

    const strength = this.definition.strength || 2.0;
    const radius = this.definition.radius || 30;

    // Calculate bounce direction (away from zone center)
    const dx = playerX - this.position.x;
    const dy = playerY - this.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < radius + 25) { // Player radius + zone
      const normalX = dx / (distance || 1);
      const normalY = dy / (distance || 1);

      // Calculate reflection with extra force
      const currentVelX = body.velocity.x;
      const currentVelY = body.velocity.y;
      const dotProduct = currentVelX * normalX + currentVelY * normalY;

      // Only bounce if moving toward the bumper
      if (dotProduct < 0) {
        const bounceForce = strength * 0.05;
        
        this.scene.matter.body.setVelocity(body, {
          x: currentVelX - 2 * dotProduct * normalX + normalX * bounceForce * 10,
          y: currentVelY - 2 * dotProduct * normalY + normalY * bounceForce * 10,
        });

        this.lastBounceTime.set(playerId, now);

        // Visual feedback
        this.pulsePhase = Math.PI / 2; // Max pulse

        // Screen shake
        this.scene.cameras.main.shake(50, 0.01);
      }
    }
  }
}

