// Pressure Plate - Requires player weight to activate

import Phaser from 'phaser';
import { Position } from '../types';

export class PressurePlate {
  private scene: Phaser.Scene;
  private id: string;
  private position: Position;
  private width: number;
  private requiredWeight: number;
  private onStateChange: (isPressed: boolean) => void;
  
  // Visuals
  private baseSprite: Phaser.GameObjects.Rectangle;
  private plateSprite: Phaser.GameObjects.Rectangle;
  private graphics: Phaser.GameObjects.Graphics;
  private weightText: Phaser.GameObjects.Text;
  
  // State
  private currentWeight: number = 0;
  private isPressedFlag: boolean = false;
  
  // Dimensions
  private readonly PLATE_HEIGHT = 8;
  private readonly BASE_HEIGHT = 4;
  private readonly PRESSED_OFFSET = 4;

  constructor(
    scene: Phaser.Scene,
    id: string,
    x: number,
    y: number,
    width: number,
    requiredWeight: number,
    onStateChange: (isPressed: boolean) => void
  ) {
    this.scene = scene;
    this.id = id;
    this.position = { x, y };
    this.width = width;
    this.requiredWeight = requiredWeight;
    this.onStateChange = onStateChange;
    
    // Create base (bottom part)
    this.baseSprite = scene.add.rectangle(
      x,
      y + this.PLATE_HEIGHT / 2,
      width,
      this.BASE_HEIGHT,
      0x444444
    ).setDepth(3);
    
    // Create plate (top part that moves)
    this.plateSprite = scene.add.rectangle(
      x,
      y - this.PLATE_HEIGHT / 2 + 2,
      width - 4,
      this.PLATE_HEIGHT,
      0x666666
    ).setDepth(4);
    this.plateSprite.setStrokeStyle(2, 0x888888);
    
    // Create graphics for details
    this.graphics = scene.add.graphics().setDepth(5);
    
    // Weight indicator text
    this.weightText = scene.add.text(x, y - 20, `${this.currentWeight}/${this.requiredWeight}`, {
      fontSize: '14px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5).setDepth(6);
    
    this.drawDetails();
  }

  private drawDetails(): void {
    this.graphics.clear();
    
    const plateY = this.isPressedFlag 
      ? this.position.y - this.PLATE_HEIGHT / 2 + 2 + this.PRESSED_OFFSET
      : this.position.y - this.PLATE_HEIGHT / 2 + 2;
    
    // Update plate position
    this.plateSprite.setPosition(this.position.x, plateY);
    
    // Draw ridges on plate
    this.graphics.lineStyle(1, 0x555555, 0.8);
    const ridgeCount = Math.floor(this.width / 15);
    for (let i = 1; i < ridgeCount; i++) {
      const ridgeX = this.position.x - this.width / 2 + 4 + i * ((this.width - 8) / ridgeCount);
      this.graphics.lineBetween(
        ridgeX,
        plateY - this.PLATE_HEIGHT / 2 + 2,
        ridgeX,
        plateY + this.PLATE_HEIGHT / 2 - 2
      );
    }
    
    // Indicator color based on state
    const indicatorColor = this.isPressedFlag ? 0x00ff00 : 
                          (this.currentWeight > 0 ? 0xffaa00 : 0xff0000);
    
    // Side indicators
    this.graphics.fillStyle(indicatorColor, 1);
    this.graphics.fillCircle(this.position.x - this.width / 2 + 8, plateY, 3);
    this.graphics.fillCircle(this.position.x + this.width / 2 - 8, plateY, 3);
    
    // Update weight text
    this.weightText.setText(`${this.currentWeight}/${this.requiredWeight}`);
    this.weightText.setColor(this.isPressedFlag ? '#00ff00' : '#ffffff');
  }

  /**
   * Check if a player is standing on the plate
   */
  isPlayerOnPlate(playerPos: Position, playerSize: { width: number; height: number }): boolean {
    const plateTop = this.position.y - this.PLATE_HEIGHT;
    const plateLeft = this.position.x - this.width / 2;
    const plateRight = this.position.x + this.width / 2;
    
    const playerBottom = playerPos.y + playerSize.height / 2;
    const playerLeft = playerPos.x - playerSize.width / 2;
    const playerRight = playerPos.x + playerSize.width / 2;
    
    // Check if player is on top of plate
    const isOnTop = Math.abs(playerBottom - plateTop) < 10;
    const isOverlapping = playerRight > plateLeft && playerLeft < plateRight;
    
    return isOnTop && isOverlapping;
  }

  /**
   * Update the weight on the plate
   */
  updateWeight(weight: number): void {
    if (weight === this.currentWeight) return;
    
    this.currentWeight = weight;
    const wasPressed = this.isPressedFlag;
    this.isPressedFlag = weight >= this.requiredWeight;
    
    // Trigger callback if state changed
    if (wasPressed !== this.isPressedFlag) {
      this.onStateChange(this.isPressedFlag);
      
      // Play sound effect (visual feedback)
      this.playPressEffect();
    }
    
    this.drawDetails();
  }

  private playPressEffect(): void {
    // Flash effect
    const flashColor = this.isPressedFlag ? 0x00ff00 : 0xff0000;
    const flash = this.scene.add.rectangle(
      this.position.x,
      this.position.y,
      this.width + 10,
      this.PLATE_HEIGHT + this.BASE_HEIGHT + 10,
      flashColor,
      0.5
    ).setDepth(2);
    
    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 1.2,
      duration: 200,
      onComplete: () => flash.destroy(),
    });
  }

  /**
   * Reset plate to initial state
   */
  reset(): void {
    this.currentWeight = 0;
    this.isPressedFlag = false;
    this.drawDetails();
  }

  /**
   * Get plate ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Check if pressed
   */
  isPressed(): boolean {
    return this.isPressedFlag;
  }

  /**
   * Destroy the pressure plate
   */
  destroy(): void {
    this.baseSprite.destroy();
    this.plateSprite.destroy();
    this.graphics.destroy();
    this.weightText.destroy();
  }
}

