// Spike Hazard - Retractable spikes that pop up

import { Hazard } from './Hazard';
import { HazardDefinition, Position } from '../types';

export class SpikeHazard extends Hazard {
  private spikeRadius: number = 25;
  private spikeHeight: number = 0;
  private maxSpikeHeight: number = 20;

  constructor(scene: Phaser.Scene, definition: HazardDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
    this.activationInterval = 3000; // Every 3 seconds
  }

  protected initialize(): void {
    // Spikes start retracted
    this.spikeHeight = 0;
  }

  protected drawActive(): void {
    // Animate spike extending
    this.spikeHeight = Math.min(this.spikeHeight + 2, this.maxSpikeHeight);

    // Draw base
    this.graphics.fillStyle(0x444444, 1);
    this.graphics.fillCircle(this.position.x, this.position.y, this.spikeRadius);

    // Draw spikes (triangles pointing outward)
    const numSpikes = 8;
    for (let i = 0; i < numSpikes; i++) {
      const angle = (i / numSpikes) * Math.PI * 2;
      const innerX = this.position.x + Math.cos(angle) * (this.spikeRadius - 5);
      const innerY = this.position.y + Math.sin(angle) * (this.spikeRadius - 5);
      const outerX = this.position.x + Math.cos(angle) * (this.spikeRadius + this.spikeHeight);
      const outerY = this.position.y + Math.sin(angle) * (this.spikeRadius + this.spikeHeight);
      
      const perpAngle = angle + Math.PI / 2;
      const sideX = Math.cos(perpAngle) * 8;
      const sideY = Math.sin(perpAngle) * 8;

      this.graphics.fillStyle(0xdc2626, 1);
      this.graphics.fillTriangle(
        innerX - sideX, innerY - sideY,
        innerX + sideX, innerY + sideY,
        outerX, outerY
      );
    }

    // Draw danger glow
    this.graphics.fillStyle(0xff0000, 0.3);
    this.graphics.fillCircle(this.position.x, this.position.y, this.spikeRadius + this.spikeHeight + 10);
  }

  protected drawWarning(): void {
    // Red pulsing glow warning
    const pulse = Math.sin(this.scene.time.now * 0.01) * 0.3 + 0.5;
    
    this.warningGraphics.fillStyle(0xff0000, pulse);
    this.warningGraphics.fillCircle(this.position.x, this.position.y, this.spikeRadius + 15);

    // Draw base (inactive)
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillCircle(this.position.x, this.position.y, this.spikeRadius);
  }

  protected drawInactive(): void {
    // Retract spikes
    this.spikeHeight = Math.max(this.spikeHeight - 2, 0);

    // Draw just the base plate
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillCircle(this.position.x, this.position.y, this.spikeRadius);

    // Small indicator dots
    this.graphics.fillStyle(0x666666, 1);
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const x = this.position.x + Math.cos(angle) * (this.spikeRadius - 10);
      const y = this.position.y + Math.sin(angle) * (this.spikeRadius - 10);
      this.graphics.fillCircle(x, y, 3);
    }
  }

  protected isCollidingWith(playerX: number, playerY: number, playerRadius: number): boolean {
    const dx = playerX - this.position.x;
    const dy = playerY - this.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < this.spikeRadius + this.spikeHeight + playerRadius;
  }
}

