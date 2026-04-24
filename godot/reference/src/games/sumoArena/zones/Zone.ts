// Base Zone Class - Areas that modify physics

import Phaser from 'phaser';
import { ZoneDefinition, Position, ZoneType } from '../types';

export abstract class Zone {
  protected scene: Phaser.Scene;
  protected definition: ZoneDefinition;
  protected graphics: Phaser.GameObjects.Graphics;
  protected position: Position;
  protected arenaCenter: Position;

  constructor(
    scene: Phaser.Scene,
    definition: ZoneDefinition,
    arenaCenter: Position
  ) {
    this.scene = scene;
    this.definition = definition;
    this.arenaCenter = arenaCenter;

    // Position relative to arena center
    this.position = {
      x: arenaCenter.x + definition.position.x,
      y: arenaCenter.y + definition.position.y,
    };

    // Create graphics layer
    this.graphics = scene.add.graphics().setDepth(1);

    // Initial draw
    this.draw();
  }

  abstract draw(): void;

  abstract applyEffect(
    body: MatterJS.BodyType,
    playerX: number,
    playerY: number,
    delta: number
  ): void;

  isPlayerInZone(playerX: number, playerY: number, playerRadius: number): boolean {
    if (this.definition.shape === 'circle') {
      const dx = playerX - this.position.x;
      const dy = playerY - this.position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      return distance < (this.definition.radius || 50) + playerRadius;
    } else {
      // Rectangle
      const halfWidth = (this.definition.width || 100) / 2;
      const halfHeight = (this.definition.height || 100) / 2;
      return (
        playerX >= this.position.x - halfWidth - playerRadius &&
        playerX <= this.position.x + halfWidth + playerRadius &&
        playerY >= this.position.y - halfHeight - playerRadius &&
        playerY <= this.position.y + halfHeight + playerRadius
      );
    }
  }

  update(_time: number, _delta: number): void {
    // Override in subclasses for animated zones
  }

  getType(): ZoneType {
    return this.definition.type;
  }

  getId(): string {
    return this.definition.id;
  }

  getPosition(): Position {
    return this.position;
  }

  destroy(): void {
    this.graphics.destroy();
  }
}

