// Player Entity - Platformer character with jump mechanics

import Phaser from 'phaser';
import {
  Position,
  PlayerInputState,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_SPEED,
  PLAYER_MASS,
  PLAYER_FRICTION,
  PLAYER_AIR_FRICTION,
  GROUND_SENSOR_HEIGHT,
} from '../types';

export class Player {
  private scene: Phaser.Scene;
  private playerId: string;
  private playerName: string;
  private color: number;
  
  // Physics
  private body: MatterJS.BodyType;
  private groundSensor: MatterJS.BodyType;
  private sprite: Phaser.GameObjects.Rectangle;
  private nameText: Phaser.GameObjects.Text;
  private eyesGraphics: Phaser.GameObjects.Graphics;
  private groundSensorVisual: Phaser.GameObjects.Rectangle; // Debug visual for ground detection
  
  // State
  private isGroundedFlag: boolean = false;
  private groundContacts: number = 0;
  private facingRight: boolean = true;
  
  // Stacking
  private _stackedOnPlayer: string | null = null;
  private playersOnTop: Set<string> = new Set();

  constructor(
    scene: Phaser.Scene,
    playerId: string,
    name: string,
    color: number,
    x: number,
    y: number
  ) {
    this.scene = scene;
    this.playerId = playerId;
    this.playerName = name;
    this.color = color;
    
    // Create compound body with main body and ground sensor
    const mainBody = scene.matter.bodies.rectangle(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT, {
      chamfer: { radius: 4 },
      friction: PLAYER_FRICTION,
      frictionAir: PLAYER_AIR_FRICTION,
      label: 'player_main',
    });
    
    // Ground sensor - positioned BELOW the player body to detect ground
    // Move it further down so it extends below the player
    const sensorOffsetY = PLAYER_HEIGHT / 2 + GROUND_SENSOR_HEIGHT; // Below the player
    this.groundSensor = scene.matter.bodies.rectangle(
      0,
      sensorOffsetY,
      PLAYER_WIDTH + 4, // Slightly wider than player
      GROUND_SENSOR_HEIGHT * 2, // Taller sensor for better detection
      {
        isSensor: true,
        label: 'ground_sensor',
      }
    );
    
    // Create compound body
    this.body = scene.matter.body.create({
      parts: [mainBody, this.groundSensor],
      friction: PLAYER_FRICTION,
      frictionAir: PLAYER_AIR_FRICTION,
      mass: PLAYER_MASS,
      label: 'player',
    });
    
    // Store player ID on body for collision detection
    (this.body as any).playerId = playerId;
    (mainBody as any).playerId = playerId;
    (this.groundSensor as any).playerId = playerId;
    
    // Add body to world
    scene.matter.world.add(this.body);
    scene.matter.body.setPosition(this.body, { x, y });
    
    // Prevent rotation
    scene.matter.body.setInertia(this.body, Infinity);

    // Create visual sprite (simple rectangle)
    this.sprite = scene.add.rectangle(x, y, PLAYER_WIDTH, PLAYER_HEIGHT, color);
    this.sprite.setStrokeStyle(2, 0xffffff, 0.5);
    this.sprite.setDepth(10);

    // Create name text
    this.nameText = scene.add.text(x, y - PLAYER_HEIGHT / 2 - 15, name, {
      fontSize: '12px',
      fontFamily: 'Arial',
      color: '#ffffff',
      stroke: '#000000',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(11);

    // Create eyes graphics
    this.eyesGraphics = scene.add.graphics().setDepth(12);
    this.drawEyes();
    
    // Create ground sensor visual (debug) - shows where the sensor is
    // Red = not grounded, Green = grounded
    const sensorWidth = PLAYER_WIDTH + 4;
    const sensorHeight = GROUND_SENSOR_HEIGHT * 2;
    this.groundSensorVisual = scene.add.rectangle(
      x,
      y + PLAYER_HEIGHT / 2 + GROUND_SENSOR_HEIGHT,
      sensorWidth,
      sensorHeight,
      0xff0000, // Start red (not grounded)
      0.5
    ).setDepth(15);
    
    // Setup ground detection
    this.setupGroundDetection();
  }

  private setupGroundDetection(): void {
    // Track ground contacts
    this.scene.matter.world.on('collisionstart', (event: Phaser.Physics.Matter.Events.CollisionStartEvent) => {
      for (const pair of event.pairs) {
        if (this.isGroundSensorCollision(pair)) {
          this.groundContacts++;
          this.isGroundedFlag = true;
        }
      }
    });

    this.scene.matter.world.on('collisionend', (event: Phaser.Physics.Matter.Events.CollisionEndEvent) => {
      for (const pair of event.pairs) {
        if (this.isGroundSensorCollision(pair)) {
          this.groundContacts = Math.max(0, this.groundContacts - 1);
          if (this.groundContacts === 0) {
            this.isGroundedFlag = false;
          }
        }
      }
    });
  }

  private isGroundSensorCollision(pair: { bodyA: MatterJS.BodyType; bodyB: MatterJS.BodyType }): boolean {
    const bodyA = pair.bodyA;
    const bodyB = pair.bodyB;
    
    // Check if one of the bodies is our ground sensor
    const isOurSensor = (body: MatterJS.BodyType) => {
      return body.label === 'ground_sensor' && (body as any).playerId === this.playerId;
    };
    
    // Check if the other body is something we can stand on
    const isGround = (body: MatterJS.BodyType) => {
      return body.label === 'wall' || 
             body.label === 'platform' || 
             body.label === 'boundary' ||
             body.label === 'moving_platform' ||
             body.label === 'player_main' ||
             body.label === 'door';
    };
    
    if (isOurSensor(bodyA) && isGround(bodyB)) return true;
    if (isOurSensor(bodyB) && isGround(bodyA)) return true;
    
    return false;
  }

  private drawEyes(): void {
    this.eyesGraphics.clear();
    
    const pos = this.getPosition();
    const eyeOffsetX = this.facingRight ? 3 : -3;
    const eyeY = pos.y - 4;
    
    // Left eye
    this.eyesGraphics.fillStyle(0xffffff, 1);
    this.eyesGraphics.fillCircle(pos.x + eyeOffsetX - 4, eyeY, 4);
    this.eyesGraphics.fillStyle(0x000000, 1);
    this.eyesGraphics.fillCircle(pos.x + eyeOffsetX - 4 + (this.facingRight ? 1 : -1), eyeY, 2);
    
    // Right eye
    this.eyesGraphics.fillStyle(0xffffff, 1);
    this.eyesGraphics.fillCircle(pos.x + eyeOffsetX + 4, eyeY, 4);
    this.eyesGraphics.fillStyle(0x000000, 1);
    this.eyesGraphics.fillCircle(pos.x + eyeOffsetX + 4 + (this.facingRight ? 1 : -1), eyeY, 2);
  }

  /**
   * Update player state
   */
  update(_time: number, _delta: number, input?: PlayerInputState): void {
    // Apply movement from input
    if (input) {
      // Horizontal movement
      if (Math.abs(input.movement.x) > 0.1) {
        const targetVelocityX = input.movement.x * PLAYER_SPEED;
        
        // Smoothly adjust velocity
        const currentVelocity = this.body.velocity;
        const newVelocityX = Phaser.Math.Linear(currentVelocity.x, targetVelocityX, this.isGroundedFlag ? 0.3 : 0.15);
        
        this.scene.matter.body.setVelocity(this.body, {
          x: newVelocityX,
          y: currentVelocity.y,
        });
        
        // Update facing direction
        if (input.movement.x > 0.1) {
          this.facingRight = true;
        } else if (input.movement.x < -0.1) {
          this.facingRight = false;
        }
      } else {
        // Apply friction when not moving
        if (this.isGroundedFlag) {
          const currentVelocity = this.body.velocity;
          this.scene.matter.body.setVelocity(this.body, {
            x: currentVelocity.x * 0.8,
            y: currentVelocity.y,
          });
        }
      }

      // Jump - if jump flag is set and we're grounded, jump and consume the flag
      if (input.jump && this.isGroundedFlag) {
        console.log(`[Player ${this.playerId}] JUMPING!`);
        this.jump();
        // Consume the jump by clearing the flag (this modifies the shared input object)
        input.jump = false;
      }
    }

    // Update visual positions
    this.updateVisuals();
  }

  private jump(): void {
    // Use velocity directly for more predictable jump height
    const jumpVelocity = -4; // Upward velocity (reduced 100x from -400)
    const currentVelocity = this.body.velocity;
    
    this.scene.matter.body.setVelocity(this.body, {
      x: currentVelocity.x,
      y: jumpVelocity,
    });
    
    // Don't manually set isGroundedFlag or groundContacts - let collision system handle it
    // The collisionend event will fire naturally as the ground sensor leaves the ground
  }

  /**
   * Update visual elements to match physics body
   */
  private updateVisuals(): void {
    const pos = this.getPosition();
    
    this.sprite.setPosition(pos.x, pos.y);
    this.nameText.setPosition(pos.x, pos.y - PLAYER_HEIGHT / 2 - 15);
    this.drawEyes();
    
    // Update ground sensor visual position and color
    const sensorY = pos.y + PLAYER_HEIGHT / 2 + GROUND_SENSOR_HEIGHT;
    this.groundSensorVisual.setPosition(pos.x, sensorY);
    // Green if grounded, red if not
    this.groundSensorVisual.setFillStyle(this.isGroundedFlag ? 0x00ff00 : 0xff0000, 0.5);
  }

  /**
   * Reset player to a specific position
   */
  resetToPosition(x: number, y: number): void {
    this.scene.matter.body.setPosition(this.body, { x, y });
    this.scene.matter.body.setVelocity(this.body, { x: 0, y: 0 });
    this.groundContacts = 0;
    this.isGroundedFlag = false;
    this.updateVisuals();
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
   * Get player size
   */
  getSize(): { width: number; height: number } {
    return {
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
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
   * Check if grounded
   */
  isGrounded(): boolean {
    return this.isGroundedFlag;
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
   * Set stacked on player
   */
  setStackedOn(playerId: string | null): void {
    this._stackedOnPlayer = playerId;
  }

  /**
   * Get stacked on player
   */
  getStackedOn(): string | null {
    return this._stackedOnPlayer;
  }

  /**
   * Add player on top
   */
  addPlayerOnTop(playerId: string): void {
    this.playersOnTop.add(playerId);
  }

  /**
   * Remove player from top
   */
  removePlayerFromTop(playerId: string): void {
    this.playersOnTop.delete(playerId);
  }

  /**
   * Get players on top
   */
  getPlayersOnTop(): string[] {
    return Array.from(this.playersOnTop);
  }

  /**
   * Destroy the player entity
   */
  destroy(): void {
    this.sprite.destroy();
    this.nameText.destroy();
    this.eyesGraphics.destroy();
    this.groundSensorVisual.destroy();
    this.scene.matter.world.remove(this.body);
  }
}

