// Door - Barrier that can be opened/closed by triggers

import Phaser from 'phaser';
import { Position } from '../types';

export class Door {
  private scene: Phaser.Scene;
  private id: string;
  private position: Position;
  private width: number;
  private height: number;
  private initiallyOpen: boolean;
  
  // Physics
  private body: MatterJS.BodyType;
  
  // Visuals
  private sprite: Phaser.GameObjects.Rectangle;
  private graphics: Phaser.GameObjects.Graphics;
  
  // State
  private isOpenFlag: boolean;
  private animationProgress: number = 0; // 0 = closed, 1 = open
  private targetProgress: number = 0;

  constructor(
    scene: Phaser.Scene,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    isOpen: boolean = false
  ) {
    this.scene = scene;
    this.id = id;
    this.position = { x, y };
    this.width = width;
    this.height = height;
    this.initiallyOpen = isOpen;
    this.isOpenFlag = isOpen;
    this.animationProgress = isOpen ? 1 : 0;
    this.targetProgress = this.animationProgress;
    
    // Create physics body (only when closed)
    this.body = scene.matter.add.rectangle(x, y, width, height, {
      isStatic: true,
      friction: 0.5,
      label: 'door',
    });
    (this.body as any).doorId = id;
    
    if (isOpen) {
      // Disable collision when open
      this.body.isSensor = true;
    }
    
    // Create visual sprite
    this.sprite = scene.add.rectangle(x, y, width, height, 0x8b4513).setDepth(7);
    this.sprite.setStrokeStyle(2, 0x654321);
    
    // Create graphics for details
    this.graphics = scene.add.graphics().setDepth(8);
    
    this.updateVisuals();
  }

  private updateVisuals(): void {
    // Calculate current height based on animation
    const currentHeight = this.height * (1 - this.animationProgress);
    const yOffset = (this.height - currentHeight) / 2;
    
    // Update sprite
    this.sprite.setSize(this.width, Math.max(currentHeight, 1));
    this.sprite.setPosition(this.position.x, this.position.y - yOffset);
    
    // Update physics body
    if (this.animationProgress >= 0.9) {
      // Fully open - disable collision
      this.body.isSensor = true;
    } else {
      // Closed or closing - enable collision
      this.body.isSensor = false;
      this.scene.matter.body.setPosition(this.body, {
        x: this.position.x,
        y: this.position.y - yOffset,
      });
    }
    
    this.drawDetails();
  }

  private drawDetails(): void {
    this.graphics.clear();
    
    if (this.animationProgress >= 0.95) return; // Don't draw when fully open
    
    const currentHeight = this.height * (1 - this.animationProgress);
    const yOffset = (this.height - currentHeight) / 2;
    const x = this.position.x - this.width / 2;
    const y = this.position.y - yOffset - currentHeight / 2;
    
    // Door panels
    this.graphics.lineStyle(2, 0x654321, 0.8);
    
    // Horizontal lines
    const panelCount = Math.floor(currentHeight / 30);
    for (let i = 1; i < panelCount; i++) {
      const lineY = y + i * (currentHeight / panelCount);
      this.graphics.lineBetween(x + 4, lineY, x + this.width - 4, lineY);
    }
    
    // Center vertical line
    this.graphics.lineBetween(
      this.position.x,
      y + 4,
      this.position.x,
      y + currentHeight - 4
    );
    
    // Door handle
    const handleY = y + currentHeight / 2;
    this.graphics.fillStyle(0xffd700, 1);
    this.graphics.fillCircle(this.position.x - this.width / 4, handleY, 4);
    this.graphics.fillCircle(this.position.x + this.width / 4, handleY, 4);
    
    // State indicator at top
    const indicatorColor = this.isOpenFlag ? 0x00ff00 : 0xff0000;
    this.graphics.fillStyle(indicatorColor, 1);
    this.graphics.fillRect(x + this.width / 2 - 5, y - 8, 10, 6);
  }

  /**
   * Update door animation
   */
  update(_time: number, delta: number): void {
    // Animate towards target
    if (Math.abs(this.animationProgress - this.targetProgress) > 0.01) {
      const speed = 0.005 * delta;
      if (this.targetProgress > this.animationProgress) {
        this.animationProgress = Math.min(this.animationProgress + speed, this.targetProgress);
      } else {
        this.animationProgress = Math.max(this.animationProgress - speed, this.targetProgress);
      }
      this.updateVisuals();
    }
  }

  /**
   * Open the door
   */
  open(): void {
    if (this.isOpenFlag) return;
    
    this.isOpenFlag = true;
    this.targetProgress = 1;
    
    // Play open effect
    this.playOpenEffect();
  }

  /**
   * Close the door
   */
  close(): void {
    if (!this.isOpenFlag) return;
    
    this.isOpenFlag = false;
    this.targetProgress = 0;
    
    // Play close effect
    this.playCloseEffect();
  }

  private playOpenEffect(): void {
    // Particles rising up
    for (let i = 0; i < 5; i++) {
      const particle = this.scene.add.rectangle(
        this.position.x + (Math.random() - 0.5) * this.width,
        this.position.y + this.height / 2,
        4,
        8,
        0x8b4513,
        0.7
      ).setDepth(9);
      
      this.scene.tweens.add({
        targets: particle,
        y: this.position.y - this.height / 2 - 20,
        alpha: 0,
        duration: 400 + Math.random() * 200,
        delay: i * 50,
        onComplete: () => particle.destroy(),
      });
    }
  }

  private playCloseEffect(): void {
    // Particles falling down
    for (let i = 0; i < 3; i++) {
      const particle = this.scene.add.rectangle(
        this.position.x + (Math.random() - 0.5) * this.width,
        this.position.y - this.height / 2,
        4,
        8,
        0x8b4513,
        0.7
      ).setDepth(9);
      
      this.scene.tweens.add({
        targets: particle,
        y: this.position.y + this.height / 2 + 20,
        alpha: 0,
        duration: 300 + Math.random() * 150,
        delay: i * 30,
        onComplete: () => particle.destroy(),
      });
    }
  }

  /**
   * Reset door to initial state
   */
  reset(): void {
    this.isOpenFlag = this.initiallyOpen;
    this.animationProgress = this.initiallyOpen ? 1 : 0;
    this.targetProgress = this.animationProgress;
    this.body.isSensor = this.initiallyOpen;
    this.updateVisuals();
  }

  /**
   * Get door ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Check if open
   */
  isOpen(): boolean {
    return this.isOpenFlag;
  }

  /**
   * Destroy the door
   */
  destroy(): void {
    this.sprite.destroy();
    this.graphics.destroy();
    this.scene.matter.world.remove(this.body);
  }
}

