// Conveyor Zone - Moving floor that pushes players

import { Zone } from './Zone';
import { ZoneDefinition, Position } from '../types';

export class ConveyorZone extends Zone {
  private arrowOffset: number = 0;
  private direction: number; // Angle in radians

  constructor(scene: Phaser.Scene, definition: ZoneDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
    this.direction = definition.direction || 0;
  }

  draw(): void {
    this.graphics.clear();

    const radius = this.definition.radius || 100;
    const x = this.position.x;
    const y = this.position.y;

    if (this.definition.shape === 'circle') {
      // Base conveyor area
      this.graphics.fillStyle(0x374151, 0.6);
      this.graphics.fillCircle(x, y, radius);

      // Conveyor lines (moving arrows)
      this.graphics.lineStyle(3, 0x6b7280, 0.8);
      
      const numArrows = 12;
      for (let i = 0; i < numArrows; i++) {
        const ringAngle = (i / numArrows) * Math.PI * 2;
        const ringRadius = radius * 0.7;
        const arrowX = x + Math.cos(ringAngle) * ringRadius;
        const arrowY = y + Math.sin(ringAngle) * ringRadius;
        
        // Arrow pointing in conveyor direction (tangent to ring)
        const arrowDir = ringAngle + Math.PI / 2 + (this.direction > 0 ? 0 : Math.PI);
        const arrowLen = 15;
        
        // Animate arrow position
        const animOffset = ((this.arrowOffset + i / numArrows) % 1) * 2 - 1;
        const animX = arrowX + Math.cos(ringAngle) * animOffset * 20;
        const animY = arrowY + Math.sin(ringAngle) * animOffset * 20;
        
        this.drawArrow(animX, animY, arrowDir, arrowLen);
      }

      // Center indicator
      this.graphics.fillStyle(0x4b5563, 1);
      this.graphics.fillCircle(x, y, 15);
      
      // Direction indicator in center
      const dirLen = 10;
      const tangentDir = Math.PI / 2 + (this.direction > 0 ? 0 : Math.PI);
      this.graphics.lineStyle(3, 0x10b981, 1);
      this.drawArrow(x, y, tangentDir, dirLen);

      // Edge
      this.graphics.lineStyle(2, 0x10b981, 0.6);
      this.graphics.strokeCircle(x, y, radius);
    } else {
      // Rectangle conveyor
      const width = this.definition.width || 200;
      const height = this.definition.height || 50;

      this.graphics.fillStyle(0x374151, 0.6);
      this.graphics.fillRect(x - width / 2, y - height / 2, width, height);

      // Moving lines
      const numLines = Math.floor(width / 30);
      for (let i = 0; i < numLines; i++) {
        const lineX = x - width / 2 + ((i / numLines + this.arrowOffset) % 1) * width;
        this.graphics.lineStyle(2, 0x6b7280, 0.8);
        this.graphics.lineBetween(lineX, y - height / 2 + 5, lineX, y + height / 2 - 5);
        
        // Arrow
        this.drawArrow(lineX, y, this.direction, 10);
      }

      this.graphics.lineStyle(2, 0x10b981, 0.6);
      this.graphics.strokeRect(x - width / 2, y - height / 2, width, height);
    }
  }

  private drawArrow(x: number, y: number, angle: number, length: number): void {
    const tipX = x + Math.cos(angle) * length;
    const tipY = y + Math.sin(angle) * length;
    
    const backAngle1 = angle + Math.PI * 0.8;
    const backAngle2 = angle - Math.PI * 0.8;
    const backLen = length * 0.5;

    this.graphics.fillStyle(0x10b981, 0.8);
    this.graphics.fillTriangle(
      tipX, tipY,
      tipX + Math.cos(backAngle1) * backLen,
      tipY + Math.sin(backAngle1) * backLen,
      tipX + Math.cos(backAngle2) * backLen,
      tipY + Math.sin(backAngle2) * backLen
    );
  }

  update(_time: number, delta: number): void {
    // Animate conveyor movement
    const speed = Math.abs(this.definition.strength || 0.5) * 0.001;
    this.arrowOffset += delta * speed;
    if (this.arrowOffset > 1) this.arrowOffset -= 1;
    
    this.draw();
  }

  applyEffect(
    body: MatterJS.BodyType,
    playerX: number,
    playerY: number,
    delta: number
  ): void {
    const strength = this.definition.strength || 0.5;

    // For circular conveyor, direction is tangent to position
    let forceAngle: number;
    
    if (this.definition.shape === 'circle') {
      // Calculate angle from center to player
      const dx = playerX - this.position.x;
      const dy = playerY - this.position.y;
      const angleToPlayer = Math.atan2(dy, dx);
      
      // Tangent direction (perpendicular to radius)
      forceAngle = angleToPlayer + Math.PI / 2;
      
      // Apply direction sign
      if (this.direction < 0) {
        forceAngle += Math.PI;
      }
    } else {
      // Rectangle uses defined direction
      forceAngle = this.direction;
    }

    // Apply continuous force
    const forceMagnitude = strength * delta * 0.00002;
    this.scene.matter.body.applyForce(body, body.position, {
      x: Math.cos(forceAngle) * forceMagnitude,
      y: Math.sin(forceAngle) * forceMagnitude,
    });
  }
}

