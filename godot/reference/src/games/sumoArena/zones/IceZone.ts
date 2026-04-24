// Ice Zone - Reduces friction for players inside

import { Zone } from './Zone';
import { ZoneDefinition, Position } from '../types';

export class IceZone extends Zone {
  private shimmerOffset: number = 0;

  constructor(scene: Phaser.Scene, definition: ZoneDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
  }

  draw(): void {
    this.graphics.clear();

    const radius = this.definition.radius || 50;
    const x = this.position.x;
    const y = this.position.y;

    if (this.definition.shape === 'circle') {
      // Ice base
      this.graphics.fillStyle(0x67e8f9, 0.4);
      this.graphics.fillCircle(x, y, radius);

      // Ice edge glow
      this.graphics.lineStyle(3, 0x0ea5e9, 0.6);
      this.graphics.strokeCircle(x, y, radius);

      // Shimmer effect
      this.graphics.fillStyle(0xffffff, 0.3);
      for (let i = 0; i < 5; i++) {
        const angle = this.shimmerOffset + (i / 5) * Math.PI * 2;
        const shimmerX = x + Math.cos(angle) * radius * 0.6;
        const shimmerY = y + Math.sin(angle) * radius * 0.6;
        this.graphics.fillCircle(shimmerX, shimmerY, 5);
      }

      // Frost patterns
      this.graphics.lineStyle(1, 0xbae6fd, 0.5);
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const len = radius * 0.7;
        this.graphics.lineBetween(
          x, y,
          x + Math.cos(angle) * len,
          y + Math.sin(angle) * len
        );
        // Branch patterns
        const midX = x + Math.cos(angle) * len * 0.5;
        const midY = y + Math.sin(angle) * len * 0.5;
        const branchLen = len * 0.3;
        this.graphics.lineBetween(
          midX, midY,
          midX + Math.cos(angle + 0.5) * branchLen,
          midY + Math.sin(angle + 0.5) * branchLen
        );
        this.graphics.lineBetween(
          midX, midY,
          midX + Math.cos(angle - 0.5) * branchLen,
          midY + Math.sin(angle - 0.5) * branchLen
        );
      }
    } else {
      // Rectangle ice
      const width = this.definition.width || 100;
      const height = this.definition.height || 100;
      
      this.graphics.fillStyle(0x67e8f9, 0.4);
      this.graphics.fillRect(x - width / 2, y - height / 2, width, height);
      
      this.graphics.lineStyle(3, 0x0ea5e9, 0.6);
      this.graphics.strokeRect(x - width / 2, y - height / 2, width, height);
    }
  }

  update(_time: number, delta: number): void {
    // Animate shimmer
    this.shimmerOffset += delta * 0.001;
    this.draw();
  }

  applyEffect(
    body: MatterJS.BodyType,
    _playerX: number,
    _playerY: number,
    _delta: number
  ): void {
    // Reduce friction when in ice zone
    const iceFriction = this.definition.strength || 0.1;
    
    // Apply slippery effect by reducing air friction
    body.frictionAir = iceFriction * 0.02;
  }

  // Called when player exits zone to restore normal friction
  removeEffect(body: MatterJS.BodyType): void {
    body.frictionAir = 0.02; // Normal air friction
  }
}

