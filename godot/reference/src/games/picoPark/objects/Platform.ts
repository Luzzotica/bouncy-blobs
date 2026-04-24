// Moving Platform - Platform that moves between two points

import Phaser from 'phaser';
import { Position } from '../types';

export class MovingPlatform {
  private scene: Phaser.Scene;
  private id: string;
  private startPos: Position;
  private endPos: Position;
  private width: number;
  private speed: number;
  private pauseTime: number;
  private triggeredBy: string | null;
  
  // Physics
  private body: MatterJS.BodyType;
  
  // Visuals
  private sprite: Phaser.GameObjects.Rectangle;
  private graphics: Phaser.GameObjects.Graphics;
  
  // State
  private currentPos: Position;
  private isMovingToEnd: boolean = true;
  private isPaused: boolean = false;
  private pauseTimer: number = 0;
  private isActiveFlag: boolean = true;
  
  // Platform height
  private readonly PLATFORM_HEIGHT = 12;

  constructor(
    scene: Phaser.Scene,
    id: string,
    startPos: Position,
    endPos: Position,
    width: number,
    speed: number,
    pauseTime: number = 500,
    triggeredBy: string | null = null
  ) {
    this.scene = scene;
    this.id = id;
    this.startPos = startPos;
    this.endPos = endPos;
    this.width = width;
    this.speed = speed;
    this.pauseTime = pauseTime;
    this.triggeredBy = triggeredBy;
    this.currentPos = { ...startPos };
    
    // If triggered, start inactive
    if (triggeredBy) {
      this.isActiveFlag = false;
    }
    
    // Create physics body
    this.body = scene.matter.add.rectangle(
      startPos.x,
      startPos.y,
      width,
      this.PLATFORM_HEIGHT,
      {
        isStatic: true,
        friction: 0.8,
        label: 'moving_platform',
      }
    );
    (this.body as any).platformId = id;
    
    // Create visual sprite
    this.sprite = scene.add.rectangle(
      startPos.x,
      startPos.y,
      width,
      this.PLATFORM_HEIGHT,
      0x888888
    ).setDepth(5);
    this.sprite.setStrokeStyle(2, 0xaaaaaa);
    
    // Create graphics for details
    this.graphics = scene.add.graphics().setDepth(6);
    this.drawDetails();
  }

  private drawDetails(): void {
    this.graphics.clear();
    
    const x = this.currentPos.x - this.width / 2;
    const y = this.currentPos.y - this.PLATFORM_HEIGHT / 2;
    
    // Platform ridges
    this.graphics.lineStyle(1, 0x666666, 0.5);
    const ridgeCount = Math.floor(this.width / 20);
    for (let i = 1; i < ridgeCount; i++) {
      const ridgeX = x + i * (this.width / ridgeCount);
      this.graphics.lineBetween(ridgeX, y + 2, ridgeX, y + this.PLATFORM_HEIGHT - 2);
    }
    
    // Indicator lights if triggered
    if (this.triggeredBy) {
      const lightColor = this.isActiveFlag ? 0x00ff00 : 0xff0000;
      this.graphics.fillStyle(lightColor, 1);
      this.graphics.fillCircle(x + 8, y + this.PLATFORM_HEIGHT / 2, 3);
      this.graphics.fillCircle(x + this.width - 8, y + this.PLATFORM_HEIGHT / 2, 3);
    }
  }

  /**
   * Update platform position
   */
  update(_time: number, delta: number): void {
    if (!this.isActiveFlag && this.triggeredBy) {
      // Don't move if triggered and inactive
      return;
    }
    
    // Handle pause at endpoints
    if (this.isPaused) {
      this.pauseTimer -= delta;
      if (this.pauseTimer <= 0) {
        this.isPaused = false;
        this.isMovingToEnd = !this.isMovingToEnd;
      }
      return;
    }
    
    // Calculate movement
    const target = this.isMovingToEnd ? this.endPos : this.startPos;
    const dx = target.x - this.currentPos.x;
    const dy = target.y - this.currentPos.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance < 2) {
      // Reached endpoint, pause
      this.currentPos = { ...target };
      this.isPaused = true;
      this.pauseTimer = this.pauseTime;
    } else {
      // Move towards target
      const moveSpeed = this.speed * delta / 1000;
      const moveRatio = Math.min(moveSpeed / distance, 1);
      
      this.currentPos.x += dx * moveRatio;
      this.currentPos.y += dy * moveRatio;
    }
    
    // Update physics body and visual
    this.scene.matter.body.setPosition(this.body, this.currentPos);
    this.sprite.setPosition(this.currentPos.x, this.currentPos.y);
    this.drawDetails();
  }

  /**
   * Set active state (for triggered platforms)
   */
  setActive(active: boolean): void {
    this.isActiveFlag = active;
    this.drawDetails();
  }

  /**
   * Reset platform to initial state
   */
  reset(): void {
    this.currentPos = { ...this.startPos };
    this.isMovingToEnd = true;
    this.isPaused = false;
    this.pauseTimer = 0;
    
    if (this.triggeredBy) {
      this.isActiveFlag = false;
    }
    
    this.scene.matter.body.setPosition(this.body, this.currentPos);
    this.sprite.setPosition(this.currentPos.x, this.currentPos.y);
    this.drawDetails();
  }

  /**
   * Get platform ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Get current position
   */
  getPosition(): Position {
    return this.currentPos;
  }

  /**
   * Destroy the platform
   */
  destroy(): void {
    this.sprite.destroy();
    this.graphics.destroy();
    this.scene.matter.world.remove(this.body);
  }
}

