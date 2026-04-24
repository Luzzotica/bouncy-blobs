// Laser Hazard - Sweeping laser beam

import { Hazard } from './Hazard';
import { HazardDefinition, Position } from '../types';

export class LaserHazard extends Hazard {
  private angle: number = 0;
  private laserLength: number = 400;
  private laserWidth: number = 8;
  private isCharging: boolean = false;
  private chargeProgress: number = 0;

  constructor(scene: Phaser.Scene, definition: HazardDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
    this.activationInterval = 5000; // 5 second cycle
  }

  protected initialize(): void {
    this.angle = Math.random() * Math.PI * 2;
  }

  update(time: number, delta: number): void {
    // Rotate laser
    const rotationSpeed = (this.definition.speed || 1) * delta * 0.001;
    this.angle += rotationSpeed;

    // Update charging/firing state
    const cycleTime = time % this.activationInterval;
    const warningDuration = this.definition.warningTime;
    const fireDuration = 2000;

    if (cycleTime < fireDuration) {
      this.isActive = true;
      this.isCharging = false;
    } else if (cycleTime >= this.activationInterval - warningDuration) {
      this.isActive = false;
      this.isCharging = true;
      this.chargeProgress = (cycleTime - (this.activationInterval - warningDuration)) / warningDuration;
    } else {
      this.isActive = false;
      this.isCharging = false;
    }

    // Redraw
    this.graphics.clear();
    this.warningGraphics.clear();

    if (this.isActive) {
      this.drawActive();
    } else if (this.isCharging) {
      this.drawWarning();
    } else {
      this.drawInactive();
    }
  }

  protected drawActive(): void {
    const x = this.position.x;
    const y = this.position.y;

    // Calculate laser endpoints
    const endX = x + Math.cos(this.angle) * this.laserLength;
    const endY = y + Math.sin(this.angle) * this.laserLength;
    const endX2 = x - Math.cos(this.angle) * this.laserLength;
    const endY2 = y - Math.sin(this.angle) * this.laserLength;

    // Draw glow
    this.graphics.lineStyle(this.laserWidth + 20, 0xff0000, 0.2);
    this.graphics.lineBetween(endX2, endY2, endX, endY);

    this.graphics.lineStyle(this.laserWidth + 10, 0xff4400, 0.4);
    this.graphics.lineBetween(endX2, endY2, endX, endY);

    // Draw main beam
    this.graphics.lineStyle(this.laserWidth, 0xff0000, 1);
    this.graphics.lineBetween(endX2, endY2, endX, endY);

    // Draw core
    this.graphics.lineStyle(this.laserWidth / 2, 0xffffff, 0.8);
    this.graphics.lineBetween(endX2, endY2, endX, endY);

    // Draw emitter at center
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillCircle(x, y, 15);
    this.graphics.fillStyle(0xff0000, 1);
    this.graphics.fillCircle(x, y, 8);

    // Particle effects along beam
    for (let i = 0; i < 5; i++) {
      const t = Math.random();
      const px = endX2 + (endX - endX2) * t + (Math.random() - 0.5) * 10;
      const py = endY2 + (endY - endY2) * t + (Math.random() - 0.5) * 10;
      this.graphics.fillStyle(0xffff00, 0.8);
      this.graphics.fillCircle(px, py, 2);
    }
  }

  protected drawWarning(): void {
    const x = this.position.x;
    const y = this.position.y;

    // Calculate preview line
    const endX = x + Math.cos(this.angle) * this.laserLength;
    const endY = y + Math.sin(this.angle) * this.laserLength;
    const endX2 = x - Math.cos(this.angle) * this.laserLength;
    const endY2 = y - Math.sin(this.angle) * this.laserLength;

    // Pulsing warning line
    const pulse = Math.sin(this.scene.time.now * 0.02) * 0.3 + 0.5;
    this.warningGraphics.lineStyle(2, 0xff0000, pulse);
    this.warningGraphics.lineBetween(endX2, endY2, endX, endY);

    // Growing charge indicator
    const chargeWidth = this.laserWidth * this.chargeProgress;
    this.warningGraphics.lineStyle(chargeWidth, 0xff6600, 0.5);
    this.warningGraphics.lineBetween(endX2, endY2, endX, endY);

    // Emitter charging
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillCircle(x, y, 15);
    
    const glowSize = 8 + this.chargeProgress * 8;
    this.graphics.fillStyle(0xff6600, this.chargeProgress);
    this.graphics.fillCircle(x, y, glowSize);
  }

  protected drawInactive(): void {
    const x = this.position.x;
    const y = this.position.y;

    // Just show the emitter
    this.graphics.fillStyle(0x333333, 1);
    this.graphics.fillCircle(x, y, 15);
    this.graphics.fillStyle(0x444444, 1);
    this.graphics.fillCircle(x, y, 6);
  }

  protected isCollidingWith(playerX: number, playerY: number, playerRadius: number): boolean {
    // Check distance from player to laser line
    const x = this.position.x;
    const y = this.position.y;
    
    // Laser goes both directions from center
    const dx = Math.cos(this.angle);
    const dy = Math.sin(this.angle);

    // Project player position onto laser line
    const playerDx = playerX - x;
    const playerDy = playerY - y;
    const projection = playerDx * dx + playerDy * dy;
    
    // Check if player is within laser length
    if (Math.abs(projection) > this.laserLength) return false;

    // Calculate perpendicular distance to line
    const closestX = x + dx * projection;
    const closestY = y + dy * projection;
    const distToLine = Math.sqrt(
      Math.pow(playerX - closestX, 2) + Math.pow(playerY - closestY, 2)
    );

    return distToLine < (this.laserWidth / 2 + playerRadius);
  }
}

