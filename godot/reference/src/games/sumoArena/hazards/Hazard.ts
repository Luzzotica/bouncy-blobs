// Base Hazard Class

import Phaser from 'phaser';
import { HazardDefinition, Position, HazardDamage } from '../types';

export abstract class Hazard {
  protected scene: Phaser.Scene;
  protected definition: HazardDefinition;
  protected graphics: Phaser.GameObjects.Graphics;
  protected warningGraphics: Phaser.GameObjects.Graphics;
  protected body?: MatterJS.BodyType;
  protected isActive: boolean = false;
  protected isWarning: boolean = false;
  protected lastActivationTime: number = 0;
  protected activationInterval: number = 4000; // Default 4 second cycle
  protected position: Position;
  protected arenaCenter: Position;

  constructor(
    scene: Phaser.Scene,
    definition: HazardDefinition,
    arenaCenter: Position
  ) {
    this.scene = scene;
    this.definition = definition;
    this.arenaCenter = arenaCenter;

    // Resolve position
    if (definition.position === 'random') {
      const angle = Math.random() * Math.PI * 2;
      const distance = 50 + Math.random() * 150;
      this.position = {
        x: arenaCenter.x + Math.cos(angle) * distance,
        y: arenaCenter.y + Math.sin(angle) * distance,
      };
    } else if (definition.position === 'pattern') {
      this.position = { x: arenaCenter.x, y: arenaCenter.y };
    } else {
      this.position = {
        x: arenaCenter.x + definition.position.x,
        y: arenaCenter.y + definition.position.y,
      };
    }

    // Create graphics layers
    this.graphics = scene.add.graphics().setDepth(3);
    this.warningGraphics = scene.add.graphics().setDepth(2);

    // Initialize based on behavior
    this.initialize();
  }

  protected abstract initialize(): void;
  protected abstract drawActive(): void;
  protected abstract drawWarning(): void;
  protected abstract drawInactive(): void;

  update(time: number, delta: number): void {
    if (this.definition.behavior === 'timed') {
      this.updateTimedBehavior(time);
    } else if (this.definition.behavior === 'rotating') {
      this.updateRotatingBehavior(time, delta);
    } else if (this.definition.behavior === 'patrolling') {
      this.updatePatrollingBehavior(time, delta);
    }

    // Redraw based on state
    this.graphics.clear();
    this.warningGraphics.clear();

    if (this.isActive) {
      this.drawActive();
    } else if (this.isWarning) {
      this.drawWarning();
    } else {
      this.drawInactive();
    }
  }

  protected updateTimedBehavior(time: number): void {
    const cycleTime = time % this.activationInterval;
    const warningStart = this.activationInterval - this.definition.warningTime;
    const activeDuration = 1000; // Active for 1 second

    if (cycleTime < activeDuration) {
      this.isActive = true;
      this.isWarning = false;
    } else if (cycleTime >= warningStart) {
      this.isActive = false;
      this.isWarning = true;
    } else {
      this.isActive = false;
      this.isWarning = false;
    }
  }

  protected updateRotatingBehavior(_time: number, _delta: number): void {
    // Override in subclasses
    this.isActive = true;
  }

  protected updatePatrollingBehavior(time: number, _delta: number): void {
    // Override in subclasses with path
    if (this.definition.path && this.definition.path.length > 0) {
      const speed = this.definition.speed || 1;
      const pathLength = this.definition.path.length;
      const cycleTime = (time * speed * 0.001) % pathLength;
      const currentIndex = Math.floor(cycleTime);
      const nextIndex = (currentIndex + 1) % pathLength;
      const progress = cycleTime - currentIndex;

      const current = this.definition.path[currentIndex];
      const next = this.definition.path[nextIndex];

      this.position = {
        x: this.arenaCenter.x + current.x + (next.x - current.x) * progress,
        y: this.arenaCenter.y + current.y + (next.y - current.y) * progress,
      };
    }
    this.isActive = true;
  }

  checkCollision(playerX: number, playerY: number, playerRadius: number): boolean {
    if (!this.isActive) return false;
    return this.isCollidingWith(playerX, playerY, playerRadius);
  }

  protected abstract isCollidingWith(playerX: number, playerY: number, playerRadius: number): boolean;

  getDamageType(): HazardDamage {
    return this.definition.damage;
  }

  getPosition(): Position {
    return this.position;
  }

  destroy(): void {
    this.graphics.destroy();
    this.warningGraphics.destroy();
    if (this.body) {
      this.scene.matter.world.remove(this.body);
    }
  }
}

