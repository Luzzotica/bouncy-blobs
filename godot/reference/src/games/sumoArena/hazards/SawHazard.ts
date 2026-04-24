// Saw Hazard - Rotating saw blade that patrols

import { Hazard } from './Hazard';
import { HazardDefinition, Position } from '../types';

export class SawHazard extends Hazard {
  private sawRadius: number = 30;
  private rotation: number = 0;
  private pathProgress: number = 0;
  private currentPathIndex: number = 0;

  constructor(scene: Phaser.Scene, definition: HazardDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
    this.isActive = true; // Saws are always active
  }

  protected initialize(): void {
    this.rotation = 0;
    this.pathProgress = 0;
  }

  update(_time: number, delta: number): void {
    // Rotate the saw
    this.rotation += 0.15;

    // Move along path
    if (this.definition.path && this.definition.path.length > 1) {
      const speed = (this.definition.speed || 2) * delta * 0.001;
      this.pathProgress += speed;

      if (this.pathProgress >= 1) {
        this.pathProgress = 0;
        this.currentPathIndex = (this.currentPathIndex + 1) % this.definition.path.length;
      }

      const current = this.definition.path[this.currentPathIndex];
      const nextIndex = (this.currentPathIndex + 1) % this.definition.path.length;
      const next = this.definition.path[nextIndex];

      this.position = {
        x: this.arenaCenter.x + current.x + (next.x - current.x) * this.pathProgress,
        y: this.arenaCenter.y + current.y + (next.y - current.y) * this.pathProgress,
      };
    }

    // Redraw
    this.graphics.clear();
    this.drawActive();
  }

  protected drawActive(): void {
    const x = this.position.x;
    const y = this.position.y;

    // Draw path line (preview)
    if (this.definition.path && this.definition.path.length > 1) {
      this.graphics.lineStyle(2, 0xff6600, 0.3);
      this.graphics.beginPath();
      this.definition.path.forEach((point, i) => {
        const px = this.arenaCenter.x + point.x;
        const py = this.arenaCenter.y + point.y;
        if (i === 0) {
          this.graphics.moveTo(px, py);
        } else {
          this.graphics.lineTo(px, py);
        }
      });
      this.graphics.closePath();
      this.graphics.strokePath();
    }

    // Danger zone indicator
    this.graphics.fillStyle(0xff4400, 0.2);
    this.graphics.fillCircle(x, y, this.sawRadius + 10);

    // Draw saw blade (circular with teeth)
    this.graphics.fillStyle(0x888888, 1);
    this.graphics.fillCircle(x, y, this.sawRadius);

    // Draw teeth
    const numTeeth = 12;
    for (let i = 0; i < numTeeth; i++) {
      const angle = this.rotation + (i / numTeeth) * Math.PI * 2;
      const innerRadius = this.sawRadius - 5;
      const outerRadius = this.sawRadius + 8;

      const innerX = x + Math.cos(angle) * innerRadius;
      const innerY = y + Math.sin(angle) * innerRadius;
      const outerX = x + Math.cos(angle) * outerRadius;
      const outerY = y + Math.sin(angle) * outerRadius;

      const perpAngle = angle + Math.PI / 2;
      const sideOffset = 5;

      this.graphics.fillStyle(0xaaaaaa, 1);
      this.graphics.fillTriangle(
        innerX - Math.cos(perpAngle) * sideOffset,
        innerY - Math.sin(perpAngle) * sideOffset,
        innerX + Math.cos(perpAngle) * sideOffset,
        innerY + Math.sin(perpAngle) * sideOffset,
        outerX,
        outerY
      );
    }

    // Center bolt
    this.graphics.fillStyle(0x444444, 1);
    this.graphics.fillCircle(x, y, 8);
    this.graphics.fillStyle(0x222222, 1);
    this.graphics.fillCircle(x, y, 4);

    // Sparks effect when moving
    if (Math.random() < 0.3) {
      const sparkAngle = Math.random() * Math.PI * 2;
      const sparkDist = this.sawRadius + Math.random() * 5;
      this.graphics.fillStyle(0xffff00, 0.8);
      this.graphics.fillCircle(
        x + Math.cos(sparkAngle) * sparkDist,
        y + Math.sin(sparkAngle) * sparkDist,
        2
      );
    }
  }

  protected drawWarning(): void {
    // Saws are always visible, no warning needed
    this.drawActive();
  }

  protected drawInactive(): void {
    // Saws are never inactive
    this.drawActive();
  }

  protected isCollidingWith(playerX: number, playerY: number, playerRadius: number): boolean {
    const dx = playerX - this.position.x;
    const dy = playerY - this.position.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance < this.sawRadius + playerRadius;
  }
}

