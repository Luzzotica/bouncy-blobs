// Player Entity - Physics body with movement and shooting mechanics

import Phaser from 'phaser';
import {
  Position,
  Team,
  PlayerInputState,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PLAYER_MASS,
  FIRE_RATE,
  RESPAWN_DELAY,
  INVULNERABILITY_TIME,
} from '../types';

export class Player {
  private scene: Phaser.Scene;
  private playerId: string;
  private playerName: string;
  private color: number;
  private team: Team;
  
  // Physics
  private body: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Arc;
  private nameText: Phaser.GameObjects.Text;
  
  // Gun visual
  private gunGraphics: Phaser.GameObjects.Graphics;
  private gunAngle: number = 0;
  
  // State
  private isAliveFlag: boolean = true;
  private kills: number = 0;
  private deaths: number = 0;
  private respawnTimer: number = 0;
  private isInvulnerableFlag: boolean = false;
  private invulnerabilityEndTime: number = 0;
  private lastFireTime: number = 0;
  private flagCarrying: Team | null = null;
  
  // Visual effects
  private respawnText?: Phaser.GameObjects.Text;
  private teamIndicator?: Phaser.GameObjects.Arc;

  constructor(
    scene: Phaser.Scene,
    playerId: string,
    name: string,
    color: number,
    team: Team,
    x: number,
    y: number
  ) {
    this.scene = scene;
    this.playerId = playerId;
    this.playerName = name;
    this.color = color;
    this.team = team;
    
    // Create physics body - controlled movement with drag
    this.body = scene.matter.add.circle(x, y, PLAYER_RADIUS, {
      mass: PLAYER_MASS,
      friction: 0.1,       // Some friction
      frictionAir: 0.15,   // Higher air resistance to limit max speed
      restitution: 0.3,    // Slight bounce
      label: 'player',
    });
    (this.body as any).playerId = playerId;

    // Create visual sprite
    this.sprite = scene.add.circle(x, y, PLAYER_RADIUS, color);
    this.sprite.setStrokeStyle(3, this.getTeamBorderColor());
    this.sprite.setDepth(10);

    // Create team indicator ring (larger ring around player)
    if (team !== 'none') {
      this.teamIndicator = scene.add.circle(x, y, PLAYER_RADIUS + 4);
      this.teamIndicator.setStrokeStyle(2, this.getTeamColor());
      this.teamIndicator.setDepth(9);
      this.teamIndicator.setFillStyle(0x000000, 0); // Transparent fill
    }

    // Create name text
    this.nameText = scene.add.text(x, y + PLAYER_RADIUS + 12, name, {
      fontSize: '11px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5).setDepth(11);

    // Create gun graphics
    this.gunGraphics = scene.add.graphics().setDepth(12);
    this.drawGun();
  }

  /**
   * Get the team border color
   */
  private getTeamBorderColor(): number {
    switch (this.team) {
      case 'red': return 0xff4444;
      case 'blue': return 0x4444ff;
      default: return 0xffffff;
    }
  }

  /**
   * Get the team color
   */
  private getTeamColor(): number {
    switch (this.team) {
      case 'red': return 0xff0000;
      case 'blue': return 0x0088ff;
      default: return 0xffffff;
    }
  }

  /**
   * Draw the gun attached to the player
   */
  private drawGun(): void {
    this.gunGraphics.clear();
    
    if (!this.isAliveFlag) return;
    
    const pos = this.getPosition();
    const gunLength = 18;
    const gunWidth = 6;
    
    // Calculate gun position based on aim angle
    const gunX = pos.x + Math.cos(this.gunAngle) * PLAYER_RADIUS;
    const gunY = pos.y + Math.sin(this.gunAngle) * PLAYER_RADIUS;
    const gunEndX = pos.x + Math.cos(this.gunAngle) * (PLAYER_RADIUS + gunLength);
    const gunEndY = pos.y + Math.sin(this.gunAngle) * (PLAYER_RADIUS + gunLength);
    
    // Gun barrel
    this.gunGraphics.lineStyle(gunWidth, 0x666666);
    this.gunGraphics.lineBetween(gunX, gunY, gunEndX, gunEndY);
    
    // Gun tip
    this.gunGraphics.fillStyle(0x888888);
    this.gunGraphics.fillCircle(gunEndX, gunEndY, gunWidth / 2);
    
    // Muzzle flash effect (when firing)
    const timeSinceFire = Date.now() - this.lastFireTime;
    if (timeSinceFire < 50) {
      this.gunGraphics.fillStyle(0xffff00, 1 - timeSinceFire / 50);
      this.gunGraphics.fillCircle(gunEndX, gunEndY, gunWidth);
    }
  }

  /**
   * Update player state
   */
  update(_time: number, delta: number, input?: PlayerInputState): void {
    // Handle respawn timer
    if (!this.isAliveFlag) {
      if (this.respawnTimer > 0) {
        this.respawnTimer -= delta;
        this.updateRespawnText();
        
        if (this.respawnTimer <= 0) {
          // Ready to respawn (ArenaScene will handle actual respawn)
        }
      }
      return;
    }

    // Handle invulnerability (use Date.now() since invulnerabilityEndTime uses it)
    const now = Date.now();
    if (this.isInvulnerableFlag && now > this.invulnerabilityEndTime) {
      this.isInvulnerableFlag = false;
      this.sprite.setAlpha(1);
    }

    // Flash effect during invulnerability
    if (this.isInvulnerableFlag) {
      const flash = Math.sin(now / 50) > 0;
      this.sprite.setAlpha(flash ? 1 : 0.5);
    }

    // Apply movement from input
    if (input && input.movement) {
      const magnitude = Math.sqrt(input.movement.x ** 2 + input.movement.y ** 2);
      if (magnitude > 0.1) {
        const normalizedX = input.movement.x / magnitude;
        const normalizedY = input.movement.y / magnitude;
        
        const force = {
          x: normalizedX * PLAYER_SPEED * 0.001,
          y: -normalizedY * PLAYER_SPEED * 0.001, // Inverted Y axis
        };
        
        this.scene.matter.body.applyForce(this.body, this.body.position, force);
      }
    }

    // Update aim angle from input (Y-axis inverted)
    if (input && input.aim) {
      const aimMagnitude = Math.sqrt(input.aim.x ** 2 + input.aim.y ** 2);
      if (aimMagnitude > 0.3) {
        this.gunAngle = Math.atan2(-input.aim.y, input.aim.x); // Inverted Y
      }
    }

    // Update visual positions
    this.updateVisuals();
  }

  /**
   * Update visual elements to match physics body
   */
  private updateVisuals(): void {
    const pos = this.getPosition();
    
    this.sprite.setPosition(pos.x, pos.y);
    this.nameText.setPosition(pos.x, pos.y + PLAYER_RADIUS + 12);
    
    if (this.teamIndicator) {
      this.teamIndicator.setPosition(pos.x, pos.y);
    }
    
    this.drawGun();
    
    // Draw flag if carrying
    if (this.flagCarrying) {
      // Flag visual handled by Flag entity
    }
  }

  /**
   * Update respawn countdown text
   */
  private updateRespawnText(): void {
    const seconds = Math.ceil(this.respawnTimer / 1000);
    
    if (!this.respawnText) {
      this.respawnText = this.scene.add.text(
        this.sprite.x,
        this.sprite.y,
        seconds.toString(),
        {
          fontSize: '24px',
          fontFamily: 'Arial Black',
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 4,
        }
      ).setOrigin(0.5).setDepth(100);
    }
    
    this.respawnText.setText(seconds > 0 ? seconds.toString() : '');
    this.respawnText.setPosition(this.sprite.x, this.sprite.y);
  }

  /**
   * Check if player can fire
   */
  canFire(time: number): boolean {
    return this.isAliveFlag && (time - this.lastFireTime >= FIRE_RATE);
  }

  /**
   * Record a shot being fired
   */
  recordFire(time: number): void {
    this.lastFireTime = time;
    this.drawGun(); // Update muzzle flash
  }

  /**
   * Get the position where bullets should spawn
   */
  getGunTipPosition(): Position {
    const pos = this.getPosition();
    const gunLength = PLAYER_RADIUS + 18;
    return {
      x: pos.x + Math.cos(this.gunAngle) * gunLength,
      y: pos.y + Math.sin(this.gunAngle) * gunLength,
    };
  }

  /**
   * Get current aim angle
   */
  getAimAngle(): number {
    return this.gunAngle;
  }

  /**
   * Kill the player
   */
  die(): void {
    this.isAliveFlag = false;
    this.deaths++;
    this.respawnTimer = RESPAWN_DELAY;
    
    // Hide visuals
    this.sprite.setVisible(false);
    this.nameText.setVisible(false);
    this.gunGraphics.clear();
    if (this.teamIndicator) {
      this.teamIndicator.setVisible(false);
    }
    
    // Disable physics collisions by making it a sensor (no physical collision)
    this.body.isSensor = true;
    this.scene.matter.body.setStatic(this.body, true);
    this.scene.matter.body.setVelocity(this.body, { x: 0, y: 0 });
    
    // Drop flag if carrying
    if (this.flagCarrying) {
      // Flag drop handled by ArenaScene
      this.flagCarrying = null;
    }
  }

  /**
   * Respawn the player at a position
   */
  respawn(x: number, y: number): void {
    this.isAliveFlag = true;
    this.respawnTimer = 0;
    
    // Re-enable physics collisions
    this.body.isSensor = false;
    
    // Set position
    this.scene.matter.body.setPosition(this.body, { x, y });
    this.scene.matter.body.setVelocity(this.body, { x: 0, y: 0 });
    this.scene.matter.body.setStatic(this.body, false);
    
    // Show visuals
    this.sprite.setVisible(true);
    this.sprite.setPosition(x, y);
    this.nameText.setVisible(true);
    this.nameText.setPosition(x, y + PLAYER_RADIUS + 12);
    if (this.teamIndicator) {
      this.teamIndicator.setVisible(true);
      this.teamIndicator.setPosition(x, y);
    }
    
    // Remove respawn text
    if (this.respawnText) {
      this.respawnText.destroy();
      this.respawnText = undefined;
    }
    
    // Start invulnerability
    this.isInvulnerableFlag = true;
    this.invulnerabilityEndTime = Date.now() + INVULNERABILITY_TIME;
  }

  /**
   * Check if ready to respawn
   */
  isReadyToRespawn(): boolean {
    return !this.isAliveFlag && this.respawnTimer <= 0;
  }

  /**
   * Add a kill
   */
  addKill(): void {
    this.kills++;
  }

  /**
   * Pick up a flag
   */
  pickUpFlag(flagTeam: Team): void {
    this.flagCarrying = flagTeam;
  }

  /**
   * Drop the flag
   */
  dropFlag(): Team | null {
    const flag = this.flagCarrying;
    this.flagCarrying = null;
    return flag;
  }

  /**
   * Get current position
   */
  getPosition(): Position {
    return {
      x: this.body.position.x,
      y: this.body.position.y,
    };
  }

  /**
   * Get physics body
   */
  getBody(): MatterJS.BodyType {
    return this.body;
  }

  /**
   * Get player ID
   */
  getPlayerId(): string {
    return this.playerId;
  }

  /**
   * Get team
   */
  getTeam(): Team {
    return this.team;
  }

  /**
   * Set team
   */
  setTeam(team: Team): void {
    this.team = team;
    this.sprite.setStrokeStyle(3, this.getTeamBorderColor());
    
    if (team !== 'none') {
      if (!this.teamIndicator) {
        const pos = this.getPosition();
        this.teamIndicator = this.scene.add.circle(pos.x, pos.y, PLAYER_RADIUS + 4);
        this.teamIndicator.setStrokeStyle(2, this.getTeamColor());
        this.teamIndicator.setDepth(9);
        this.teamIndicator.setFillStyle(0x000000, 0);
      } else {
        this.teamIndicator.setStrokeStyle(2, this.getTeamColor());
      }
    } else if (this.teamIndicator) {
      this.teamIndicator.destroy();
      this.teamIndicator = undefined;
    }
  }

  /**
   * Check if alive
   */
  isAlive(): boolean {
    return this.isAliveFlag;
  }

  /**
   * Check if invulnerable
   */
  isInvulnerable(): boolean {
    return this.isInvulnerableFlag;
  }

  /**
   * Get kills count
   */
  getKills(): number {
    return this.kills;
  }

  /**
   * Get deaths count
   */
  getDeaths(): number {
    return this.deaths;
  }

  /**
   * Get flag being carried
   */
  getCarriedFlag(): Team | null {
    return this.flagCarrying;
  }

  /**
   * Get color
   */
  getColor(): number {
    return this.color;
  }

  /**
   * Get player name
   */
  getName(): string {
    return this.playerName;
  }

  /**
   * Destroy the player entity
   */
  destroy(): void {
    this.sprite.destroy();
    this.nameText.destroy();
    this.gunGraphics.destroy();
    if (this.teamIndicator) {
      this.teamIndicator.destroy();
    }
    if (this.respawnText) {
      this.respawnText.destroy();
    }
    this.scene.matter.world.remove(this.body);
  }
}

