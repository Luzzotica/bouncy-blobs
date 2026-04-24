// Meteor Hazard - Falling meteors with impact zones

import { Hazard } from './Hazard';
import { HazardDefinition, Position } from '../types';

interface MeteorInstance {
  x: number;
  y: number;
  warningStartTime: number;
  impactTime: number;
  radius: number;
  impacted: boolean;
}

export class MeteorHazard extends Hazard {
  private meteors: MeteorInstance[] = [];
  private spawnInterval: number = 3000;
  private lastSpawnTime: number = 0;
  private impactRadius: number = 40;
  private knockbackRadius: number = 80;
  private arenaRadius: number = 300;

  constructor(scene: Phaser.Scene, definition: HazardDefinition, arenaCenter: Position) {
    super(scene, definition, arenaCenter);
    this.isActive = true; // Meteors are always active
  }

  setArenaRadius(radius: number): void {
    this.arenaRadius = radius;
  }

  protected initialize(): void {
    this.meteors = [];
    this.lastSpawnTime = 0;
  }

  update(time: number, _delta: number): void {
    // Spawn new meteors periodically
    if (time - this.lastSpawnTime > this.spawnInterval) {
      this.spawnMeteor(time);
      this.lastSpawnTime = time;
    }

    // Update existing meteors
    this.meteors = this.meteors.filter(meteor => {
      const timeSinceImpact = time - meteor.impactTime;
      
      // Remove meteors after impact effect ends
      if (meteor.impacted && timeSinceImpact > 500) {
        return false;
      }
      
      // Check for impact
      if (!meteor.impacted && time >= meteor.impactTime) {
        meteor.impacted = true;
        // Screen shake on impact
        this.scene.cameras.main.shake(150, 0.02);
      }
      
      return true;
    });

    // Redraw
    this.graphics.clear();
    this.warningGraphics.clear();
    this.drawActive();
  }

  private spawnMeteor(time: number): void {
    // Random position within arena
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * (this.arenaRadius - 50);
    const x = this.arenaCenter.x + Math.cos(angle) * distance;
    const y = this.arenaCenter.y + Math.sin(angle) * distance;

    this.meteors.push({
      x,
      y,
      warningStartTime: time,
      impactTime: time + this.definition.warningTime,
      radius: this.impactRadius,
      impacted: false,
    });
  }

  protected drawActive(): void {
    const now = this.scene.time.now;

    for (const meteor of this.meteors) {
      const timeToImpact = meteor.impactTime - now;
      const warningProgress = 1 - (timeToImpact / this.definition.warningTime);

      if (meteor.impacted) {
        // Impact explosion effect
        const timeSinceImpact = now - meteor.impactTime;
        const explosionProgress = timeSinceImpact / 500;
        
        // Expanding ring
        const ringRadius = this.impactRadius + explosionProgress * this.knockbackRadius;
        const ringAlpha = 1 - explosionProgress;
        
        this.graphics.lineStyle(4, 0xff6600, ringAlpha);
        this.graphics.strokeCircle(meteor.x, meteor.y, ringRadius);
        
        // Fading crater
        this.graphics.fillStyle(0x333333, ringAlpha * 0.5);
        this.graphics.fillCircle(meteor.x, meteor.y, this.impactRadius);
        
        // Fire particles
        for (let i = 0; i < 8; i++) {
          const particleAngle = (i / 8) * Math.PI * 2 + explosionProgress * 2;
          const particleDist = ringRadius * 0.8;
          const px = meteor.x + Math.cos(particleAngle) * particleDist;
          const py = meteor.y + Math.sin(particleAngle) * particleDist;
          this.graphics.fillStyle(0xff8800, ringAlpha);
          this.graphics.fillCircle(px, py, 5 * ringAlpha);
        }
      } else {
        // Warning shadow (grows as impact approaches)
        const shadowSize = this.impactRadius * (0.3 + warningProgress * 0.7);
        const shadowAlpha = 0.2 + warningProgress * 0.4;
        
        this.warningGraphics.fillStyle(0x000000, shadowAlpha);
        this.warningGraphics.fillCircle(meteor.x, meteor.y, shadowSize);
        
        // Warning ring
        const pulse = Math.sin(now * 0.02) * 0.2 + 0.8;
        this.warningGraphics.lineStyle(3, 0xff4400, pulse * warningProgress);
        this.warningGraphics.strokeCircle(meteor.x, meteor.y, this.impactRadius);
        
        // Crosshair target
        const crossSize = 10 + warningProgress * 10;
        this.warningGraphics.lineStyle(2, 0xff0000, warningProgress);
        this.warningGraphics.lineBetween(
          meteor.x - crossSize, meteor.y,
          meteor.x + crossSize, meteor.y
        );
        this.warningGraphics.lineBetween(
          meteor.x, meteor.y - crossSize,
          meteor.x, meteor.y + crossSize
        );
        
        // Falling meteor visual (above warning)
        if (warningProgress > 0.5) {
          const meteorY = meteor.y - 200 + warningProgress * 180;
          const meteorSize = 15 * warningProgress;
          
          this.graphics.fillStyle(0xff4400, 1);
          this.graphics.fillCircle(meteor.x, meteorY, meteorSize);
          
          // Flame trail
          for (let i = 0; i < 5; i++) {
            const trailY = meteorY - i * 15;
            const trailSize = meteorSize * (1 - i * 0.15);
            const trailAlpha = 1 - i * 0.2;
            this.graphics.fillStyle(0xff8800, trailAlpha);
            this.graphics.fillCircle(meteor.x + (Math.random() - 0.5) * 5, trailY, trailSize);
          }
        }
      }
    }
  }

  protected drawWarning(): void {
    this.drawActive();
  }

  protected drawInactive(): void {
    this.drawActive();
  }

  protected isCollidingWith(playerX: number, playerY: number, playerRadius: number): boolean {
    for (const meteor of this.meteors) {
      if (!meteor.impacted) continue;
      
      const timeSinceImpact = this.scene.time.now - meteor.impactTime;
      if (timeSinceImpact > 200) continue; // Only check collision briefly after impact
      
      const dx = playerX - meteor.x;
      const dy = playerY - meteor.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < this.knockbackRadius + playerRadius) {
        return true;
      }
    }
    return false;
  }

  getKnockbackDirection(playerX: number, playerY: number): { x: number; y: number } | null {
    for (const meteor of this.meteors) {
      if (!meteor.impacted) continue;
      
      const timeSinceImpact = this.scene.time.now - meteor.impactTime;
      if (timeSinceImpact > 200) continue;
      
      const dx = playerX - meteor.x;
      const dy = playerY - meteor.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < this.knockbackRadius && distance > 0) {
        return {
          x: dx / distance,
          y: dy / distance,
        };
      }
    }
    return null;
  }
}

