// Goal Entity - Level exit area that all players must reach

import Phaser from 'phaser';
import { Position } from '../types';

export class Goal {
  private position: Position;
  private width: number;
  private height: number;
  
  // Visuals
  private graphics: Phaser.GameObjects.Graphics;
  private flagPole: Phaser.GameObjects.Rectangle;
  private flag: Phaser.GameObjects.Triangle;
  private glowGraphics: Phaser.GameObjects.Graphics;
  
  // Animation state
  private pulsePhase: number = 0;
  private flagWavePhase: number = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    width: number,
    height: number
  ) {
    this.position = { x, y };
    this.width = width;
    this.height = height;
    
    // Create glow effect (behind everything)
    this.glowGraphics = scene.add.graphics().setDepth(1);
    
    // Create main graphics
    this.graphics = scene.add.graphics().setDepth(2);
    
    // Create flag pole
    const poleX = x;
    const poleHeight = height * 0.8;
    this.flagPole = scene.add.rectangle(
      poleX,
      y - height / 2 + poleHeight / 2,
      4,
      poleHeight,
      0xffffff
    ).setDepth(3);
    
    // Create flag
    this.flag = scene.add.triangle(
      poleX + 15,
      y - height / 2 + 20,
      0, 0,
      30, 15,
      0, 30,
      0x00ff00
    ).setDepth(3);
    
    this.drawGoalArea();
  }

  private drawGoalArea(): void {
    this.graphics.clear();
    
    const x = this.position.x - this.width / 2;
    const y = this.position.y - this.height / 2;
    
    // Goal area background
    this.graphics.fillStyle(0x00ff00, 0.15);
    this.graphics.fillRect(x, y, this.width, this.height);
    
    // Checkered pattern at bottom
    const checkerSize = 16;
    const checkerRows = 2;
    for (let row = 0; row < checkerRows; row++) {
      for (let col = 0; col < Math.ceil(this.width / checkerSize); col++) {
        const isWhite = (row + col) % 2 === 0;
        this.graphics.fillStyle(isWhite ? 0xffffff : 0x000000, 0.3);
        this.graphics.fillRect(
          x + col * checkerSize,
          y + this.height - (row + 1) * checkerSize,
          Math.min(checkerSize, this.width - col * checkerSize),
          checkerSize
        );
      }
    }
    
    // Border
    this.graphics.lineStyle(3, 0x00ff00, 0.8);
    this.graphics.strokeRect(x, y, this.width, this.height);
    
    // Corner decorations
    const cornerSize = 10;
    this.graphics.lineStyle(2, 0x00ff00, 1);
    
    // Top-left
    this.graphics.lineBetween(x, y + cornerSize, x, y);
    this.graphics.lineBetween(x, y, x + cornerSize, y);
    
    // Top-right
    this.graphics.lineBetween(x + this.width - cornerSize, y, x + this.width, y);
    this.graphics.lineBetween(x + this.width, y, x + this.width, y + cornerSize);
    
    // Bottom-left
    this.graphics.lineBetween(x, y + this.height - cornerSize, x, y + this.height);
    this.graphics.lineBetween(x, y + this.height, x + cornerSize, y + this.height);
    
    // Bottom-right
    this.graphics.lineBetween(x + this.width - cornerSize, y + this.height, x + this.width, y + this.height);
    this.graphics.lineBetween(x + this.width, y + this.height - cornerSize, x + this.width, y + this.height);
  }

  private drawGlow(): void {
    this.glowGraphics.clear();
    
    const x = this.position.x - this.width / 2;
    const y = this.position.y - this.height / 2;
    const pulse = Math.sin(this.pulsePhase) * 0.5 + 0.5;
    
    // Outer glow
    const glowSize = 8 + pulse * 4;
    this.glowGraphics.fillStyle(0x00ff00, 0.1 + pulse * 0.1);
    this.glowGraphics.fillRect(
      x - glowSize,
      y - glowSize,
      this.width + glowSize * 2,
      this.height + glowSize * 2
    );
  }

  /**
   * Update goal animations
   */
  update(_time: number, delta: number): void {
    // Update pulse animation
    this.pulsePhase += delta * 0.003;
    this.drawGlow();
    
    // Update flag wave animation
    this.flagWavePhase += delta * 0.005;
    const waveOffset = Math.sin(this.flagWavePhase) * 3;
    this.flag.setPosition(
      this.position.x + 15 + waveOffset,
      this.position.y - this.height / 2 + 20
    );
    
    // Slight flag scale for wave effect
    const scaleX = 1 + Math.sin(this.flagWavePhase * 1.5) * 0.1;
    this.flag.setScale(scaleX, 1);
  }

  /**
   * Check if a player position is within the goal area
   */
  isPlayerInGoal(playerX: number, playerY: number): boolean {
    const halfWidth = this.width / 2;
    const halfHeight = this.height / 2;
    
    return playerX >= this.position.x - halfWidth &&
           playerX <= this.position.x + halfWidth &&
           playerY >= this.position.y - halfHeight &&
           playerY <= this.position.y + halfHeight;
  }

  /**
   * Get position
   */
  getPosition(): Position {
    return this.position;
  }

  /**
   * Destroy the goal entity
   */
  destroy(): void {
    this.graphics.destroy();
    this.glowGraphics.destroy();
    this.flagPole.destroy();
    this.flag.destroy();
  }
}

