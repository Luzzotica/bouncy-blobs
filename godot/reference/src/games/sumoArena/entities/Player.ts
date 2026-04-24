// Player Entity - Physics body with movement and dash mechanics

import Phaser from 'phaser';
import {
  Position,
  PlayerInputState,
  PowerupType,
  PLAYER_BASE_MASS,
  DASH_COOLDOWN,
  INVULNERABILITY_TIME,
  STARTING_LIVES,
} from '../types';

export class Player {
  private scene: Phaser.Scene;
  private playerId: string;
  private color: number;
  
  // Physics
  private body: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Arc;
  private nameText: Phaser.GameObjects.Text;
  private trailGraphics: Phaser.GameObjects.Graphics;
  
  // Stats
  private lives: number = STARTING_LIVES;
  private mass: number = PLAYER_BASE_MASS;
  
  // Dash
  private isDashing: boolean = false;
  private lastDashTime: number = 0;
  private dashDirection: Position = { x: 0, y: 0 };
  
  // State
  private isInvulnerableFlag: boolean = false;
  private invulnerabilityEndTime: number = 0;
  private isEliminatedFlag: boolean = false;
  private hasShield: boolean = false;
  
  // Powerups
  private activePowerups: Map<PowerupType, number> = new Map();
  
  // Visual
  private trailPositions: Position[] = [];
  private shieldSprite?: Phaser.GameObjects.Arc;
  private livesIcons: Phaser.GameObjects.Arc[] = [];
  private dashCooldownIndicator?: Phaser.GameObjects.Arc;

  constructor(
    scene: Phaser.Scene,
    playerId: string,
    name: string,  // Used for nameText display
    color: number,
    x: number,
    y: number
  ) {
    this.scene = scene;
    this.playerId = playerId;
    this.color = color;
    
    // name is used below for nameText

    // Create physics body with higher friction for control
    this.body = scene.matter.add.circle(x, y, 20, {
      mass: this.mass,
      friction: 0.1,
      frictionAir: 0.08,  // Higher air friction = more control
      restitution: 0.6,
      label: 'player',
    });
    (this.body as any).playerId = playerId;

    // Create visual sprite
    this.sprite = scene.add.circle(x, y, 20, color);
    this.sprite.setStrokeStyle(3, 0xffffff);
    this.sprite.setDepth(10);

    // Create name text
    this.nameText = scene.add.text(x, y + 30, name, {
      fontSize: '12px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 2,
    }).setOrigin(0.5).setDepth(11);

    // Create trail graphics for dash effect
    this.trailGraphics = scene.add.graphics().setDepth(5);

    // Create dash cooldown indicator (small circle inside player)
    this.dashCooldownIndicator = scene.add.circle(x, y, 8, 0x00ff00, 0.6);
    this.dashCooldownIndicator.setDepth(12);
    this.dashCooldownIndicator.setStrokeStyle(1, 0xffffff);

    // Create lives icons
    this.createLivesIcons();
  }

  private createLivesIcons(): void {
    // Remove old icons
    this.livesIcons.forEach(icon => icon.destroy());
    this.livesIcons = [];

    // Create new icons above player
    for (let i = 0; i < this.lives; i++) {
      const icon = this.scene.add.circle(0, 0, 5, 0xff4444);
      icon.setStrokeStyle(1, 0xffffff);
      icon.setDepth(12);
      this.livesIcons.push(icon);
    }
  }

  handleInput(input: PlayerInputState, _delta: number): void {
    if (this.isEliminatedFlag) return;

    const { joystick, dashPressed } = input;
    
    // Calculate current speed modifier from powerups
    const speedMod = this.activePowerups.has('speed') ? 1.3 : 1;
    
    // Max velocity (pixels per frame at 60fps)
    const maxSpeed = 5.0 * speedMod;

    // Apply velocity directly based on joystick (much more controllable)
    if (Math.abs(joystick.x) > 0.1 || Math.abs(joystick.y) > 0.1) {
      // Calculate desired velocity
      const targetVelX = joystick.x * maxSpeed;
      const targetVelY = -joystick.y * maxSpeed; // Invert Y for screen coordinates
      
      // Smoothly interpolate current velocity toward target (lerp factor)
      const lerpFactor = 0.15;
      const currentVel = this.body.velocity;
      const newVelX = currentVel.x + (targetVelX - currentVel.x) * lerpFactor;
      const newVelY = currentVel.y + (targetVelY - currentVel.y) * lerpFactor;
      
      this.scene.matter.body.setVelocity(this.body, { x: newVelX, y: newVelY });

      // Store dash direction (last movement direction)
      const magnitude = Math.sqrt(joystick.x * joystick.x + joystick.y * joystick.y);
      if (magnitude > 0) {
        this.dashDirection = {
          x: joystick.x / magnitude,
          y: -joystick.y / magnitude,
        };
      }
    } else {
      // Apply friction when not moving (slow down)
      const currentVel = this.body.velocity;
      const friction = 0.92;
      this.scene.matter.body.setVelocity(this.body, { 
        x: currentVel.x * friction, 
        y: currentVel.y * friction 
      });
    }

    // Handle dash
    const now = this.scene.time.now;
    if (dashPressed && now - this.lastDashTime >= DASH_COOLDOWN) {
      this.performDash();
    }
  }

  private performDash(): void {
    if (this.isEliminatedFlag) return;

    this.isDashing = true;
    this.lastDashTime = this.scene.time.now;

    // Calculate dash speed based on mass modifier
    const massMod = this.activePowerups.has('mass') ? 1.5 : 1;
    const dashSpeed = 24 * massMod; // Doubled dash speed for faster movement

    // Use current velocity direction if no joystick input, otherwise use joystick direction
    let dashDir = this.dashDirection;
    if (Math.abs(dashDir.x) < 0.1 && Math.abs(dashDir.y) < 0.1) {
      // Use current velocity as direction
      const vel = this.body.velocity;
      const velMag = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
      if (velMag > 0.1) {
        dashDir = { x: vel.x / velMag, y: vel.y / velMag };
      } else {
        // Default forward if no direction
        dashDir = { x: 1, y: 0 };
      }
    }

    // Add dash velocity to current velocity (momentum-based)
    const currentVel = this.body.velocity;
    this.scene.matter.body.setVelocity(this.body, {
      x: currentVel.x + dashDir.x * dashSpeed,
      y: currentVel.y + dashDir.y * dashSpeed,
    });

    // Strong camera shake and visual effects on dash
    this.scene.cameras.main.shake(50, 0.008);
    
    // Flash effect - scale up and brighten
    this.scene.tweens.add({
      targets: this.sprite,
      scaleX: 1.3,
      scaleY: 1.3,
      duration: 100,
      yoyo: true,
      ease: 'Power2'
    });
    
    // Add a bright flash circle
    const flash = this.scene.add.circle(
      this.body.position.x,
      this.body.position.y,
      25,
      this.color,
      0.8
    );
    flash.setDepth(11);
    this.scene.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 1.5,
      duration: 200,
      onComplete: () => flash.destroy()
    });

    // End dash visual after short duration
    this.scene.time.delayedCall(150, () => {
      this.isDashing = false;
    });
  }

  update(time: number, _delta: number): void {
    if (this.isEliminatedFlag) {
      this.sprite.setVisible(false);
      this.nameText.setVisible(false);
      this.trailGraphics.setVisible(false);
      this.livesIcons.forEach(icon => icon.setVisible(false));
      if (this.dashCooldownIndicator) {
        this.dashCooldownIndicator.setVisible(false);
      }
      return;
    }

    // Update sprite position to match physics body
    this.sprite.setPosition(this.body.position.x, this.body.position.y);
    this.nameText.setPosition(this.body.position.x, this.body.position.y + 30);

    // Update lives icons position
    this.livesIcons.forEach((icon, i) => {
      const offsetX = (i - (this.lives - 1) / 2) * 12;
      icon.setPosition(this.body.position.x + offsetX, this.body.position.y - 35);
    });

    // Update invulnerability
    if (this.isInvulnerableFlag && time >= this.invulnerabilityEndTime) {
      this.isInvulnerableFlag = false;
      this.sprite.setAlpha(1);
    }

    // Flash when invulnerable
    if (this.isInvulnerableFlag) {
      this.sprite.setAlpha(Math.sin(time * 0.02) * 0.3 + 0.7);
    }

    // Update powerup timers
    for (const [type, endTime] of this.activePowerups) {
      if (time >= endTime) {
        this.activePowerups.delete(type);
        this.onPowerupExpire(type);
      }
    }

    // Update mass from powerup
    if (this.activePowerups.has('mass')) {
      this.scene.matter.body.setMass(this.body, PLAYER_BASE_MASS * 2);
    } else {
      this.scene.matter.body.setMass(this.body, PLAYER_BASE_MASS);
    }

    // Update dash trail
    this.updateTrail();

    // Update shield visual
    this.updateShield();
    
    // Update dash cooldown indicator
    this.updateDashCooldownIndicator(time);
  }
  
  private updateDashCooldownIndicator(time: number): void {
    if (!this.dashCooldownIndicator) return;
    
    const timeSinceDash = time - this.lastDashTime;
    const cooldownProgress = Math.min(timeSinceDash / DASH_COOLDOWN, 1);
    const canDash = cooldownProgress >= 1;
    
    // Position indicator inside player circle
    this.dashCooldownIndicator.setPosition(this.body.position.x, this.body.position.y);
    
    if (canDash) {
      // Green when ready
      this.dashCooldownIndicator.setFillStyle(0x00ff00, 0.8);
      this.dashCooldownIndicator.setStrokeStyle(2, 0xffffff);
      // Pulse effect when ready
      const pulseScale = 1 + Math.sin(time * 0.015) * 0.2;
      this.dashCooldownIndicator.setScale(pulseScale);
    } else {
      // Red when on cooldown, show progress
      this.dashCooldownIndicator.setFillStyle(0xff0000, 0.6);
      this.dashCooldownIndicator.setStrokeStyle(1, 0xffffff);
      // Scale based on cooldown progress (smaller = more cooldown remaining)
      const scale = 0.5 + (cooldownProgress * 0.5);
      this.dashCooldownIndicator.setScale(scale);
    }
  }

  private updateTrail(): void {
    this.trailGraphics.clear();

    if (this.isDashing || this.body.speed > 5) {
      // Add current position to trail
      this.trailPositions.push({ x: this.body.position.x, y: this.body.position.y });
      
      // Limit trail length
      if (this.trailPositions.length > 10) {
        this.trailPositions.shift();
      }

      // Draw trail
      this.trailPositions.forEach((pos, i) => {
        const alpha = i / this.trailPositions.length;
        const radius = 15 * alpha;
        this.trailGraphics.fillStyle(this.color, alpha * 0.5);
        this.trailGraphics.fillCircle(pos.x, pos.y, radius);
      });
    } else {
      this.trailPositions = [];
    }
  }

  private updateShield(): void {
    if (this.hasShield) {
      if (!this.shieldSprite) {
        this.shieldSprite = this.scene.add.circle(
          this.body.position.x,
          this.body.position.y,
          28,
          0x00ffff,
          0.3
        );
        this.shieldSprite.setStrokeStyle(2, 0x00ffff);
        this.shieldSprite.setDepth(9);
      }
      this.shieldSprite.setPosition(this.body.position.x, this.body.position.y);
      
      // Pulse effect
      const scale = 1 + Math.sin(this.scene.time.now * 0.01) * 0.1;
      this.shieldSprite.setScale(scale);
    } else if (this.shieldSprite) {
      this.shieldSprite.destroy();
      this.shieldSprite = undefined;
    }
  }

  applyPowerup(type: PowerupType): void {
    const now = this.scene.time.now;
    
    switch (type) {
      case 'speed':
        this.activePowerups.set('speed', now + 8000);
        break;
      case 'mass':
        this.activePowerups.set('mass', now + 10000);
        break;
      case 'dash_refresh':
        this.lastDashTime = 0; // Instant cooldown reset
        break;
      case 'shield':
        this.hasShield = true;
        break;
      case 'slippery':
        this.activePowerups.set('slippery', now + 8000);
        (this.body as any).friction = 0.01;
        break;
    }
  }

  private onPowerupExpire(type: PowerupType): void {
    switch (type) {
      case 'slippery':
        (this.body as any).friction = 0.05;
        break;
    }
  }

  loseLife(): void {
    if (this.hasShield) {
      // Shield absorbs the hit
      this.hasShield = false;
      this.makeInvulnerable();
      return;
    }

    this.lives--;
    this.createLivesIcons();

    // Particle burst on death
    this.createDeathParticles();
  }

  private createDeathParticles(): void {
    // Create colored circles as particles
    for (let i = 0; i < 15; i++) {
      const angle = (i / 15) * Math.PI * 2;
      const speed = 50 + Math.random() * 100;
      const particle = this.scene.add.circle(
        this.body.position.x,
        this.body.position.y,
        5,
        this.color
      );
      
      this.scene.tweens.add({
        targets: particle,
        x: this.body.position.x + Math.cos(angle) * speed,
        y: this.body.position.y + Math.sin(angle) * speed,
        alpha: 0,
        scale: 0,
        duration: 500,
        onComplete: () => particle.destroy(),
      });
    }
  }

  respawn(x: number, y: number): void {
    this.scene.matter.body.setPosition(this.body, { x, y });
    this.scene.matter.body.setVelocity(this.body, { x: 0, y: 0 });
    this.makeInvulnerable();
  }

  private makeInvulnerable(): void {
    this.isInvulnerableFlag = true;
    this.invulnerabilityEndTime = this.scene.time.now + INVULNERABILITY_TIME;
  }

  eliminate(): void {
    this.isEliminatedFlag = true;
    this.scene.matter.world.remove(this.body);
  }

  destroy(): void {
    this.sprite.destroy();
    this.nameText.destroy();
    this.trailGraphics.destroy();
    this.livesIcons.forEach(icon => icon.destroy());
    if (this.shieldSprite) {
      this.shieldSprite.destroy();
    }
    if (this.dashCooldownIndicator) {
      this.dashCooldownIndicator.destroy();
    }
    this.scene.matter.world.remove(this.body);
  }

  // Getters
  getId(): string {
    return this.playerId;
  }

  getLives(): number {
    return this.lives;
  }

  getPosition(): Position {
    return { x: this.body.position.x, y: this.body.position.y };
  }

  isInvulnerable(): boolean {
    return this.isInvulnerableFlag;
  }

  isEliminated(): boolean {
    return this.isEliminatedFlag;
  }

  getBody(): MatterJS.BodyType {
    return this.body;
  }
}

