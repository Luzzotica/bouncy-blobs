// Flag Entity - Capture the Flag objectives

import Phaser from 'phaser';
import {
  Position,
  Team,
  FLAG_RETURN_TIME,
  FLAG_PICKUP_RADIUS,
  FLAG_CAPTURE_RADIUS,
} from '../types';

export class Flag {
  private scene: Phaser.Scene;
  private team: Team;
  private spawnPosition: Position;
  private currentPosition: Position;
  private carrierId: string | null = null;
  private isAtBaseFlag: boolean = true;
  private returnTimer: number = 0;
  
  // Visuals
  private flagSprite: Phaser.GameObjects.Container;
  private poleGraphics: Phaser.GameObjects.Graphics;
  private flagGraphics: Phaser.GameObjects.Graphics;
  private baseGraphics: Phaser.GameObjects.Graphics;
  private captureZoneGraphics: Phaser.GameObjects.Graphics;
  private returnTimerText?: Phaser.GameObjects.Text;
  
  // Animation
  private waveOffset: number = 0;

  constructor(
    scene: Phaser.Scene,
    team: Team,
    x: number,
    y: number
  ) {
    this.scene = scene;
    this.team = team;
    this.spawnPosition = { x, y };
    this.currentPosition = { x, y };
    
    // Create container for flag
    this.flagSprite = scene.add.container(x, y).setDepth(8);
    
    // Create capture zone visual
    this.captureZoneGraphics = scene.add.graphics().setDepth(1);
    this.drawCaptureZone();
    
    // Create base marker
    this.baseGraphics = scene.add.graphics().setDepth(2);
    this.drawBase();
    
    // Create pole
    this.poleGraphics = scene.add.graphics().setDepth(8);
    this.flagSprite.add(this.poleGraphics);
    
    // Create flag cloth
    this.flagGraphics = scene.add.graphics().setDepth(9);
    this.flagSprite.add(this.flagGraphics);
    
    this.drawFlag();
  }

  /**
   * Get team color
   */
  private getTeamColor(): number {
    return this.team === 'red' ? 0xff4444 : 0x4488ff;
  }


  /**
   * Draw the flag capture zone
   */
  private drawCaptureZone(): void {
    this.captureZoneGraphics.clear();
    
    // Draw larger capture zone circle
    this.captureZoneGraphics.fillStyle(this.getTeamColor(), 0.15);
    this.captureZoneGraphics.fillCircle(
      this.spawnPosition.x,
      this.spawnPosition.y,
      FLAG_CAPTURE_RADIUS
    );
    
    this.captureZoneGraphics.lineStyle(2, this.getTeamColor(), 0.5);
    this.captureZoneGraphics.strokeCircle(
      this.spawnPosition.x,
      this.spawnPosition.y,
      FLAG_CAPTURE_RADIUS
    );
  }

  /**
   * Draw the base marker
   */
  private drawBase(): void {
    this.baseGraphics.clear();
    
    // Draw base circle
    this.baseGraphics.fillStyle(this.getTeamColor(), 0.3);
    this.baseGraphics.fillCircle(
      this.spawnPosition.x,
      this.spawnPosition.y,
      FLAG_PICKUP_RADIUS
    );
    
    this.baseGraphics.lineStyle(3, this.getTeamColor(), 0.8);
    this.baseGraphics.strokeCircle(
      this.spawnPosition.x,
      this.spawnPosition.y,
      FLAG_PICKUP_RADIUS
    );
  }

  /**
   * Draw the flag
   */
  private drawFlag(): void {
    this.poleGraphics.clear();
    this.flagGraphics.clear();
    
    if (this.carrierId) {
      // Flag is being carried - don't draw here
      this.flagSprite.setVisible(false);
      return;
    }
    
    this.flagSprite.setVisible(true);
    this.flagSprite.setPosition(this.currentPosition.x, this.currentPosition.y);
    
    const poleHeight = 40;
    const flagWidth = 25;
    const flagHeight = 18;
    
    // Draw pole
    this.poleGraphics.fillStyle(0x8b4513, 1); // Brown
    this.poleGraphics.fillRect(-2, -poleHeight, 4, poleHeight);
    
    // Pole cap
    this.poleGraphics.fillStyle(0xffd700, 1); // Gold
    this.poleGraphics.fillCircle(0, -poleHeight, 4);
    
    // Draw waving flag
    this.drawWavingFlag(flagWidth, flagHeight, poleHeight);
  }

  /**
   * Draw the waving flag cloth
   */
  private drawWavingFlag(width: number, height: number, poleHeight: number): void {
    const color = this.getTeamColor();
    const waveAmplitude = 3;
    const segments = 8;
    
    this.flagGraphics.fillStyle(color, 1);
    this.flagGraphics.beginPath();
    
    // Top edge (with wave)
    this.flagGraphics.moveTo(2, -poleHeight + 2);
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = 2 + t * width;
      const y = -poleHeight + 2 + Math.sin(this.waveOffset + t * Math.PI * 2) * waveAmplitude;
      this.flagGraphics.lineTo(x, y);
    }
    
    // Bottom edge (with wave)
    for (let i = segments; i >= 0; i--) {
      const t = i / segments;
      const x = 2 + t * width;
      const y = -poleHeight + 2 + height + Math.sin(this.waveOffset + t * Math.PI * 2 + 0.5) * waveAmplitude;
      this.flagGraphics.lineTo(x, y);
    }
    
    this.flagGraphics.closePath();
    this.flagGraphics.fillPath();
    
    // Flag border
    this.flagGraphics.lineStyle(2, 0xffffff, 0.5);
    this.flagGraphics.strokePath();
    
    // Team symbol on flag
    const symbolX = 2 + width / 2;
    const symbolY = -poleHeight + 2 + height / 2;
    
    this.flagGraphics.fillStyle(0xffffff, 0.8);
    if (this.team === 'red') {
      // Star for red team
      this.drawStar(symbolX, symbolY, 5, 6, 3);
    } else {
      // Circle for blue team
      this.flagGraphics.fillCircle(symbolX, symbolY, 5);
    }
  }

  /**
   * Draw a star shape
   */
  private drawStar(cx: number, cy: number, spikes: number, outerRadius: number, innerRadius: number): void {
    let rot = Math.PI / 2 * 3;
    let step = Math.PI / spikes;
    
    this.flagGraphics.beginPath();
    this.flagGraphics.moveTo(cx, cy - outerRadius);
    
    for (let i = 0; i < spikes; i++) {
      const x1 = cx + Math.cos(rot) * outerRadius;
      const y1 = cy + Math.sin(rot) * outerRadius;
      this.flagGraphics.lineTo(x1, y1);
      rot += step;
      
      const x2 = cx + Math.cos(rot) * innerRadius;
      const y2 = cy + Math.sin(rot) * innerRadius;
      this.flagGraphics.lineTo(x2, y2);
      rot += step;
    }
    
    this.flagGraphics.closePath();
    this.flagGraphics.fillPath();
  }

  /**
   * Update flag state
   */
  update(_time: number, delta: number): void {
    // Animate wave
    this.waveOffset += delta * 0.005;
    
    // Handle return timer if dropped
    if (!this.isAtBaseFlag && !this.carrierId && this.returnTimer > 0) {
      this.returnTimer -= delta;
      this.updateReturnTimerText();
      
      if (this.returnTimer <= 0) {
        this.returnToBase();
      }
    }
    
    // Redraw flag for animation
    this.drawFlag();
  }

  /**
   * Update the return timer display
   */
  private updateReturnTimerText(): void {
    const seconds = Math.ceil(this.returnTimer / 1000);
    
    if (!this.returnTimerText) {
      this.returnTimerText = this.scene.add.text(
        this.currentPosition.x,
        this.currentPosition.y - 50,
        seconds.toString(),
        {
          fontSize: '16px',
          fontFamily: 'Arial Black',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
        }
      ).setOrigin(0.5).setDepth(100);
    }
    
    this.returnTimerText.setText(seconds > 0 ? `${seconds}` : '');
    this.returnTimerText.setPosition(this.currentPosition.x, this.currentPosition.y - 50);
  }

  /**
   * Pick up the flag
   */
  pickUp(playerId: string): void {
    this.carrierId = playerId;
    this.isAtBaseFlag = false;
    this.returnTimer = 0;
    this.flagSprite.setVisible(false);
    
    if (this.returnTimerText) {
      this.returnTimerText.destroy();
      this.returnTimerText = undefined;
    }
  }

  /**
   * Drop the flag at a position
   */
  drop(x: number, y: number): void {
    this.carrierId = null;
    this.currentPosition = { x, y };
    this.returnTimer = FLAG_RETURN_TIME;
    this.flagSprite.setVisible(true);
    this.flagSprite.setPosition(x, y);
    this.drawFlag();
  }

  /**
   * Return flag to base
   */
  returnToBase(): void {
    this.carrierId = null;
    this.currentPosition = { ...this.spawnPosition };
    this.isAtBaseFlag = true;
    this.returnTimer = 0;
    this.flagSprite.setVisible(true);
    this.flagSprite.setPosition(this.spawnPosition.x, this.spawnPosition.y);
    
    if (this.returnTimerText) {
      this.returnTimerText.destroy();
      this.returnTimerText = undefined;
    }
    
    this.drawFlag();
  }

  /**
   * Check if a position is within pickup range
   */
  isInPickupRange(x: number, y: number): boolean {
    if (this.carrierId) return false;
    
    const dist = Math.sqrt(
      Math.pow(x - this.currentPosition.x, 2) +
      Math.pow(y - this.currentPosition.y, 2)
    );
    return dist <= FLAG_PICKUP_RADIUS;
  }

  /**
   * Check if a position is within capture range (at base)
   */
  isInCaptureRange(x: number, y: number): boolean {
    const dist = Math.sqrt(
      Math.pow(x - this.spawnPosition.x, 2) +
      Math.pow(y - this.spawnPosition.y, 2)
    );
    return dist <= FLAG_CAPTURE_RADIUS;
  }

  /**
   * Get team
   */
  getTeam(): Team {
    return this.team;
  }

  /**
   * Get carrier ID
   */
  getCarrierId(): string | null {
    return this.carrierId;
  }

  /**
   * Check if flag is at base
   */
  isAtBase(): boolean {
    return this.isAtBaseFlag;
  }

  /**
   * Get current position
   */
  getPosition(): Position {
    return { ...this.currentPosition };
  }

  /**
   * Get spawn position
   */
  getSpawnPosition(): Position {
    return { ...this.spawnPosition };
  }

  /**
   * Destroy the flag entity
   */
  destroy(): void {
    this.flagSprite.destroy();
    this.baseGraphics.destroy();
    this.captureZoneGraphics.destroy();
    if (this.returnTimerText) {
      this.returnTimerText.destroy();
    }
  }
}

/**
 * Draw flag indicator on player carrying flag
 */
export function drawCarriedFlagIndicator(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  team: Team
): void {
  const color = team === 'red' ? 0xff4444 : 0x4488ff;
  const offsetX = 15;
  const offsetY = -20;
  
  graphics.clear();
  
  // Small flag pole
  graphics.fillStyle(0x8b4513, 1);
  graphics.fillRect(x + offsetX - 1, y + offsetY - 15, 2, 15);
  
  // Small flag
  graphics.fillStyle(color, 1);
  graphics.fillTriangle(
    x + offsetX + 1, y + offsetY - 15,
    x + offsetX + 12, y + offsetY - 10,
    x + offsetX + 1, y + offsetY - 5
  );
}

