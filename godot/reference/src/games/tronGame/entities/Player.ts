// Tron Player Entity - Grid-based movement with light trail

import Phaser from 'phaser';
import {
  Position,
  Direction,
  TrailSegment,
  PlayerInputState,
  PLAYER_SIZE,
  GHOST_DURATION,
  GHOST_COOLDOWN,
} from '../types';

export class TronPlayer {
  private scene: Phaser.Scene;
  private playerId: string;
  private playerName: string;
  private color: number;
  
  // Grid position
  private gridX: number;
  private gridY: number;
  private direction: Direction;
  private nextDirection: Direction | null = null; // Queued direction change
  
  // Trail
  private trail: TrailSegment[] = [];
  private trailGraphics: Phaser.GameObjects.Graphics;
  
  // Visual elements
  private sprite: Phaser.GameObjects.Rectangle;
  private nameText: Phaser.GameObjects.Text;
  private glowGraphics: Phaser.GameObjects.Graphics;
  
  // State
  private isAliveFlag: boolean = true;
  private isGhostFlag: boolean = false;
  private ghostEndTime: number = 0;
  private ghostCooldownEnd: number = 0;
  private placement: number = 0;
  
  // Grid/cell configuration
  private cellSize: number;
  private offsetX: number;
  private offsetY: number;

  constructor(
    scene: Phaser.Scene,
    playerId: string,
    name: string,
    color: number,
    startGridX: number,
    startGridY: number,
    startDirection: Direction,
    cellSize: number,
    offsetX: number,
    offsetY: number
  ) {
    this.scene = scene;
    this.playerId = playerId;
    this.playerName = name;
    this.color = color;
    this.gridX = startGridX;
    this.gridY = startGridY;
    this.direction = startDirection;
    this.cellSize = cellSize;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    
    // Create trail graphics (behind player)
    this.trailGraphics = scene.add.graphics().setDepth(5);
    
    // Create glow graphics
    this.glowGraphics = scene.add.graphics().setDepth(8);
    
    // Create player visual
    const worldPos = this.gridToWorld(startGridX, startGridY);
    const playerSize = cellSize * PLAYER_SIZE;
    
    this.sprite = scene.add.rectangle(
      worldPos.x,
      worldPos.y,
      playerSize,
      playerSize,
      color
    ).setDepth(10);
    
    // Add a bright border
    this.sprite.setStrokeStyle(2, 0xffffff);
    
    // Create name text
    this.nameText = scene.add.text(worldPos.x, worldPos.y - cellSize, name, {
      fontSize: '10px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5).setDepth(11);
    
    // Add starting position to trail
    this.trail.push({ x: startGridX, y: startGridY });
    this.drawTrail();
  }

  /**
   * Convert grid coordinates to world (pixel) coordinates
   */
  private gridToWorld(gridX: number, gridY: number): Position {
    return {
      x: this.offsetX + gridX * this.cellSize + this.cellSize / 2,
      y: this.offsetY + gridY * this.cellSize + this.cellSize / 2,
    };
  }

  /**
   * Process input and queue direction changes
   */
  processInput(input: PlayerInputState): void {
    if (!this.isAliveFlag) return;

    const now = Date.now();
    
    // Handle ghost button
    if (input.ghostButton && now >= this.ghostCooldownEnd && !this.isGhostFlag) {
      this.activateGhost();
    }
    
    // Handle direction input - only allow perpendicular turns
    const { x, y } = input.movement;
    const magnitude = Math.sqrt(x * x + y * y);
    
    if (magnitude > 0.5) {
      // Determine primary direction from joystick
      let newDirection: Direction;
      
      if (Math.abs(x) > Math.abs(y)) {
        // Horizontal movement
        newDirection = x > 0 ? 'right' : 'left';
      } else {
        // Vertical movement (inverted Y for screen coordinates)
        newDirection = y < 0 ? 'up' : 'down';
      }
      
      // Only allow perpendicular turns (can't reverse direction)
      if (this.isValidTurn(newDirection)) {
        this.nextDirection = newDirection;
      }
    }
  }

  /**
   * Check if a turn is valid (perpendicular, not reverse)
   */
  private isValidTurn(newDirection: Direction): boolean {
    const opposites: Record<Direction, Direction> = {
      'up': 'down',
      'down': 'up',
      'left': 'right',
      'right': 'left',
    };
    
    return newDirection !== this.direction && newDirection !== opposites[this.direction];
  }

  /**
   * Move one cell in the current direction
   * Returns true if move was successful, false if collision
   */
  move(
    gridWidth: number, 
    gridHeight: number, 
    allTrails: Map<string, TrailSegment[]>,
    isRoundActive: boolean
  ): boolean {
    if (!this.isAliveFlag || !isRoundActive) return true;

    // Apply queued direction change
    if (this.nextDirection) {
      this.direction = this.nextDirection;
      this.nextDirection = null;
    }

    // Calculate next position
    let nextX = this.gridX;
    let nextY = this.gridY;
    
    switch (this.direction) {
      case 'up': nextY--; break;
      case 'down': nextY++; break;
      case 'left': nextX--; break;
      case 'right': nextX++; break;
    }

    // Check wall collision
    if (nextX < 0 || nextX >= gridWidth || nextY < 0 || nextY >= gridHeight) {
      return false; // Hit wall
    }

    // Check trail collision (unless in ghost mode)
    if (!this.isGhostFlag) {
      // Check own trail (skip last segment which is current position)
      for (let i = 0; i < this.trail.length - 1; i++) {
        if (this.trail[i].x === nextX && this.trail[i].y === nextY) {
          return false; // Hit own trail
        }
      }
      
      // Check other players' trails
      for (const [otherId, otherTrail] of allTrails) {
        if (otherId === this.playerId) continue;
        
        for (const segment of otherTrail) {
          if (segment.x === nextX && segment.y === nextY) {
            return false; // Hit other trail
          }
        }
      }
    }

    // Move is valid - update position
    this.gridX = nextX;
    this.gridY = nextY;
    
    // Add to trail
    this.trail.push({ x: nextX, y: nextY });
    
    // Update visuals
    this.updateVisuals();
    
    return true;
  }

  /**
   * Activate ghost mode
   */
  private activateGhost(): void {
    const now = Date.now();
    this.isGhostFlag = true;
    this.ghostEndTime = now + GHOST_DURATION;
    this.ghostCooldownEnd = now + GHOST_DURATION + GHOST_COOLDOWN;
    
    // Visual feedback
    this.sprite.setAlpha(0.5);
  }

  /**
   * Update player state (called every frame)
   */
  update(_time: number, _delta: number): void {
    if (!this.isAliveFlag) return;

    const now = Date.now();
    
    // Check ghost mode expiration
    if (this.isGhostFlag && now >= this.ghostEndTime) {
      this.isGhostFlag = false;
      this.sprite.setAlpha(1);
    }
    
    // Flashing effect during ghost mode
    if (this.isGhostFlag) {
      const flash = Math.sin(now / 50) > 0;
      this.sprite.setAlpha(flash ? 0.7 : 0.3);
    }
    
    // Update glow effect
    this.drawGlow();
  }

  /**
   * Update visual positions
   */
  private updateVisuals(): void {
    const worldPos = this.gridToWorld(this.gridX, this.gridY);
    
    this.sprite.setPosition(worldPos.x, worldPos.y);
    this.nameText.setPosition(worldPos.x, worldPos.y - this.cellSize);
    
    this.drawTrail();
    this.drawGlow();
  }

  /**
   * Draw the light trail
   */
  private drawTrail(): void {
    this.trailGraphics.clear();
    
    if (this.trail.length < 2) return;
    
    // Draw trail segments
    this.trailGraphics.lineStyle(this.cellSize * 0.6, this.color, 0.8);
    
    for (let i = 0; i < this.trail.length - 1; i++) {
      const from = this.gridToWorld(this.trail[i].x, this.trail[i].y);
      const to = this.gridToWorld(this.trail[i + 1].x, this.trail[i + 1].y);
      this.trailGraphics.lineBetween(from.x, from.y, to.x, to.y);
    }
    
    // Draw glow around trail
    this.trailGraphics.lineStyle(this.cellSize * 0.9, this.color, 0.2);
    
    for (let i = 0; i < this.trail.length - 1; i++) {
      const from = this.gridToWorld(this.trail[i].x, this.trail[i].y);
      const to = this.gridToWorld(this.trail[i + 1].x, this.trail[i + 1].y);
      this.trailGraphics.lineBetween(from.x, from.y, to.x, to.y);
    }
  }

  /**
   * Draw glow effect around player
   */
  private drawGlow(): void {
    this.glowGraphics.clear();
    
    if (!this.isAliveFlag) return;
    
    const worldPos = this.gridToWorld(this.gridX, this.gridY);
    const glowRadius = this.cellSize * 1.5;
    
    // Outer glow
    this.glowGraphics.fillStyle(this.color, 0.15);
    this.glowGraphics.fillCircle(worldPos.x, worldPos.y, glowRadius);
    
    // Inner glow
    this.glowGraphics.fillStyle(this.color, 0.3);
    this.glowGraphics.fillCircle(worldPos.x, worldPos.y, glowRadius * 0.6);
    
    // Ghost mode indicator
    if (this.isGhostFlag) {
      this.glowGraphics.lineStyle(2, 0xffffff, 0.5);
      this.glowGraphics.strokeCircle(worldPos.x, worldPos.y, glowRadius * 1.2);
    }
  }

  /**
   * Kill the player
   */
  die(placement: number): void {
    this.isAliveFlag = false;
    this.placement = placement;
    
    // Death visual effect
    this.sprite.setVisible(false);
    this.nameText.setVisible(false);
    this.glowGraphics.clear();
    
    // Fade trail
    this.scene.tweens.add({
      targets: this.trailGraphics,
      alpha: 0.3,
      duration: 500,
    });
  }

  /**
   * Check if player can use ghost ability
   */
  canUseGhost(): boolean {
    return this.isAliveFlag && !this.isGhostFlag && Date.now() >= this.ghostCooldownEnd;
  }

  /**
   * Get ghost cooldown progress (0-1)
   */
  getGhostCooldownProgress(): number {
    const now = Date.now();
    if (now >= this.ghostCooldownEnd) return 1;
    
    const cooldownStart = this.ghostCooldownEnd - GHOST_COOLDOWN;
    return (now - cooldownStart) / GHOST_COOLDOWN;
  }

  // Getters
  getPlayerId(): string { return this.playerId; }
  getName(): string { return this.playerName; }
  getColor(): number { return this.color; }
  getGridPosition(): Position { return { x: this.gridX, y: this.gridY }; }
  getDirection(): Direction { return this.direction; }
  getTrail(): TrailSegment[] { return this.trail; }
  isAlive(): boolean { return this.isAliveFlag; }
  isGhost(): boolean { return this.isGhostFlag; }
  getPlacement(): number { return this.placement; }

  /**
   * Destroy the player entity
   */
  destroy(): void {
    this.sprite.destroy();
    this.nameText.destroy();
    this.trailGraphics.destroy();
    this.glowGraphics.destroy();
  }
}
