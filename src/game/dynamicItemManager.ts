import { SoftBodyWorld } from '../physics/softBodyWorld';
import { Vec2, vec2, add, scale, sub, length, normalize, distanceTo } from '../physics/vec2';
import { PlayerManager } from './playerManager';
import { PartyItemType } from './partyItems/types';

/**
 * A placed dynamic item that applies forces, slows blobs, or triggers effects
 * each frame. Managed separately from static geometry.
 */
export interface DynamicItem {
  id: string;
  type: PartyItemType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Internal timer for periodic effects */
  timer: number;
  /** Whether currently active (e.g., cannon is firing) */
  active: boolean;
}

// Cannon fires every N seconds
const CANNON_PERIOD = 3.5;
const CANNON_FIRE_DURATION = 0.15;
const CANNON_FORCE = 1200;

// Catapult launches every N seconds
const CATAPULT_PERIOD = 4.0;
const CATAPULT_FIRE_DURATION = 0.2;
const CATAPULT_FORCE = 900;

// Bumper
const BUMPER_FORCE = 600;
const BUMPER_COOLDOWN = 0.15;

// Wind zone
const WIND_FORCE = 350;

// Conveyor
const CONVEYOR_FORCE = 250;

// Sticky goo
const STICKY_DRAG = 0.85; // velocity multiplier per frame

// Wrecking ball
const WRECKING_PERIOD = 5.0;
const WRECKING_BLAST_RADIUS = 200;
const WRECKING_FORCE = 800;
const WRECKING_ACTIVE_DURATION = 0.3;

export class DynamicItemManager {
  private items: DynamicItem[] = [];
  private world: SoftBodyWorld | null = null;
  private playerManager: PlayerManager | null = null;
  private time = 0;

  initialize(world: SoftBodyWorld, playerManager: PlayerManager): void {
    this.world = world;
    this.playerManager = playerManager;
    this.items = [];
    this.time = 0;
  }

  addItem(id: string, type: PartyItemType, x: number, y: number, width: number, height: number, rotation: number): void {
    this.items.push({ id, type, x, y, width, height, rotation, timer: 0, active: false });
  }

  update(dt: number): void {
    if (!this.world || !this.playerManager) return;
    this.time += dt;

    for (const item of this.items) {
      item.timer += dt;

      switch (item.type) {
        case 'cannon': this.updateCannon(item, dt); break;
        case 'catapult': this.updateCatapult(item, dt); break;
        case 'bumper': this.updateBumper(item, dt); break;
        case 'wind_zone': this.updateWindZone(item, dt); break;
        case 'gravity_flipper': this.updateGravityFlipper(item, dt); break;
        case 'conveyor_left': this.updateConveyor(item, dt, -1); break;
        case 'conveyor_right': this.updateConveyor(item, dt, 1); break;
        case 'sticky_goo': this.updateStickyGoo(item, dt); break;
        case 'wrecking_ball': this.updateWreckingBall(item, dt); break;
      }
    }
  }

  private updateCannon(item: DynamicItem, dt: number): void {
    const phase = item.timer % CANNON_PERIOD;
    item.active = phase < CANNON_FIRE_DURATION;

    if (!item.active) return;

    // Fire direction based on rotation
    const dir = vec2(Math.cos(item.rotation), Math.sin(item.rotation));
    this.applyForceInZone(item, dir, CANNON_FORCE, 1.2);
  }

  private updateCatapult(item: DynamicItem, dt: number): void {
    const phase = item.timer % CATAPULT_PERIOD;
    item.active = phase < CATAPULT_FIRE_DURATION;

    if (!item.active) return;

    // Always launches upward
    const dir = vec2(0, -1);
    this.applyForceInZone(item, dir, CATAPULT_FORCE, 1.0);
  }

  private updateBumper(item: DynamicItem, _dt: number): void {
    if (!this.world || !this.playerManager) return;

    const cx = item.x;
    const cy = item.y;
    const radius = item.width / 2;

    for (const player of this.playerManager.getAllPlayers()) {
      const centroid = player.blob.getCentroid();
      const dist = distanceTo(centroid, vec2(cx, cy));
      if (dist > radius) continue;

      // Push away from center
      const dx = centroid.x - cx;
      const dy = centroid.y - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const pushDir = vec2(dx / len, dy / len);

      this.world!.applyBlobLinearVelocityDelta(player.blob.blobId, scale(pushDir, BUMPER_FORCE * 0.02));
      item.active = true;
      setTimeout(() => { item.active = false; }, 150);
    }
  }

  private updateWindZone(item: DynamicItem, dt: number): void {
    // Wind blows in the direction of rotation
    const dir = vec2(Math.cos(item.rotation), Math.sin(item.rotation));
    this.applyForceInRect(item, dir, WIND_FORCE * dt);
  }

  private updateGravityFlipper(item: DynamicItem, dt: number): void {
    // Apply upward force to counteract gravity and then some (flip it)
    // Gravity is ~3920 units/s². We need to counteract + reverse = ~7840 upward
    const antigravForce = vec2(0, -7840 * dt);
    this.applyForceInRect(item, antigravForce, 1.0);
  }

  private updateConveyor(item: DynamicItem, dt: number, direction: number): void {
    const dir = vec2(direction, 0);
    this.applyForceInRect(item, dir, CONVEYOR_FORCE * dt);
  }

  private updateStickyGoo(item: DynamicItem, _dt: number): void {
    if (!this.world || !this.playerManager) return;

    const hw = item.width / 2;
    const hh = item.height / 2;

    for (const player of this.playerManager.getAllPlayers()) {
      const centroid = player.blob.getCentroid();
      if (centroid.x < item.x - hw || centroid.x > item.x + hw) continue;
      if (centroid.y < item.y - hh || centroid.y > item.y + hh) continue;

      // Slow down all particles in this blob
      const r = this.world!.blobRanges[player.blob.blobId];
      if (!r) continue;
      for (let i = r.start; i < r.end; i++) {
        this.world!.vel[i] = scale(this.world!.vel[i], STICKY_DRAG);
      }
    }
    item.active = true;
  }

  private updateWreckingBall(item: DynamicItem, dt: number): void {
    const phase = item.timer % WRECKING_PERIOD;
    item.active = phase < WRECKING_ACTIVE_DURATION;

    if (!item.active || !this.world || !this.playerManager) return;

    // Blast all nearby blobs away from center
    const center = vec2(item.x, item.y);
    for (const player of this.playerManager.getAllPlayers()) {
      const centroid = player.blob.getCentroid();
      const dist = distanceTo(centroid, center);
      if (dist > WRECKING_BLAST_RADIUS) continue;

      const dx = centroid.x - item.x;
      const dy = centroid.y - item.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const pushDir = vec2(dx / len, dy / len);
      const falloff = 1 - dist / WRECKING_BLAST_RADIUS;

      this.world.applyBlobLinearVelocityDelta(
        player.blob.blobId,
        scale(pushDir, WRECKING_FORCE * falloff * 0.03),
      );
    }
  }

  /** Apply a velocity impulse to all blobs whose centroid is inside the item's AABB */
  private applyForceInRect(item: DynamicItem, force: Vec2, multiplier: number): void {
    if (!this.world || !this.playerManager) return;

    const hw = item.width / 2;
    const hh = item.height / 2;

    for (const player of this.playerManager.getAllPlayers()) {
      const centroid = player.blob.getCentroid();
      if (centroid.x < item.x - hw || centroid.x > item.x + hw) continue;
      if (centroid.y < item.y - hh || centroid.y > item.y + hh) continue;

      this.world.applyBlobLinearVelocityDelta(
        player.blob.blobId,
        scale(force, multiplier),
      );
    }
  }

  /** Apply directional force to blobs in a slightly expanded zone around the item */
  private applyForceInZone(item: DynamicItem, dir: Vec2, force: number, radiusMult: number): void {
    if (!this.world || !this.playerManager) return;

    const radius = Math.max(item.width, item.height) * radiusMult;

    for (const player of this.playerManager.getAllPlayers()) {
      const centroid = player.blob.getCentroid();
      const dist = distanceTo(centroid, vec2(item.x, item.y));
      if (dist > radius) continue;

      this.world.applyBlobLinearVelocityDelta(
        player.blob.blobId,
        scale(dir, force * 0.02),
      );
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const item of this.items) {
      switch (item.type) {
        case 'cannon': this.renderCannon(ctx, item); break;
        case 'catapult': this.renderCatapult(ctx, item); break;
        case 'bumper': this.renderBumper(ctx, item); break;
        case 'wind_zone': this.renderWindZone(ctx, item); break;
        case 'gravity_flipper': this.renderGravityFlipper(ctx, item); break;
        case 'conveyor_left': this.renderConveyor(ctx, item, -1); break;
        case 'conveyor_right': this.renderConveyor(ctx, item, 1); break;
        case 'sticky_goo': this.renderStickyGoo(ctx, item); break;
        case 'wrecking_ball': this.renderWreckingBall(ctx, item); break;
      }
    }
  }

  private renderCannon(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(item.rotation);

    const r = item.width / 2;

    // Base circle
    ctx.fillStyle = '#555';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Barrel
    ctx.fillStyle = item.active ? '#ff8844' : '#777';
    ctx.fillRect(0, -r * 0.35, r * 1.4, r * 0.7);

    // Barrel tip
    ctx.fillStyle = '#999';
    ctx.fillRect(r * 1.2, -r * 0.45, r * 0.3, r * 0.9);

    // Muzzle flash when firing
    if (item.active) {
      ctx.fillStyle = 'rgba(255, 200, 50, 0.8)';
      ctx.beginPath();
      ctx.arc(r * 1.6, 0, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Center bolt
    ctx.fillStyle = '#888';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private renderCatapult(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const hw = item.width / 2;
    const hh = item.height / 2;

    // Base
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(-hw, -hh * 0.3, item.width, item.height * 0.3);

    // Arm (tilts when firing)
    const armAngle = item.active ? -0.5 : 0.2;
    ctx.save();
    ctx.rotate(armAngle);
    ctx.fillStyle = '#A0522D';
    ctx.fillRect(-hw * 0.1, -hh * 1.5, hw * 0.15, hh * 2);
    // Bucket
    ctx.fillStyle = '#CD853F';
    ctx.beginPath();
    ctx.arc(-hw * 0.03, -hh * 1.5, hh * 0.4, 0, Math.PI);
    ctx.fill();
    ctx.restore();

    // Pivot
    ctx.fillStyle = '#666';
    ctx.beginPath();
    ctx.arc(0, -hh * 0.15, hh * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Launch indicator
    const phase = item.timer % CATAPULT_PERIOD;
    const chargeRatio = Math.min(phase / (CATAPULT_PERIOD - 0.5), 1);
    ctx.fillStyle = `rgba(255, ${Math.floor(200 * (1 - chargeRatio))}, 50, ${chargeRatio * 0.6})`;
    ctx.fillRect(-hw * 0.4, hh * 0.05, hw * 0.8 * chargeRatio, hh * 0.15);

    ctx.restore();
  }

  private renderBumper(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const r = item.width / 2;
    const pulse = 1 + Math.sin(this.time * 4) * 0.05;

    // Outer glow
    ctx.fillStyle = 'rgba(255, 100, 200, 0.15)';
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.2 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Main body
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    grad.addColorStop(0, '#ff69b4');
    grad.addColorStop(1, '#cc3388');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Ring
    ctx.strokeStyle = '#ff88cc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
    ctx.stroke();

    // Star highlight
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(-r * 0.2, -r * 0.2, r * 0.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private renderWindZone(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const hw = item.width / 2;
    const hh = item.height / 2;

    // Zone background
    ctx.fillStyle = 'rgba(100, 200, 255, 0.1)';
    ctx.fillRect(-hw, -hh, item.width, item.height);

    // Dashed border
    ctx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(-hw, -hh, item.width, item.height);

    // Animated wind arrows
    const dir = vec2(Math.cos(item.rotation), Math.sin(item.rotation));
    const numArrows = 4;
    const arrowOffset = (this.time * 80) % 50;

    ctx.fillStyle = 'rgba(100, 200, 255, 0.5)';
    ctx.setLineDash([]);

    for (let i = 0; i < numArrows; i++) {
      const t = (i / numArrows + arrowOffset / 50) % 1;
      const ax = -hw + t * item.width;
      const ay = -hh / 2 + (i % 2) * hh;

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(item.rotation);
      // Arrow shape
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-4, -5);
      ctx.lineTo(-4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  private renderGravityFlipper(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const hw = item.width / 2;
    const hh = item.height / 2;

    // Zone with purple tint
    ctx.fillStyle = 'rgba(180, 80, 255, 0.12)';
    ctx.fillRect(-hw, -hh, item.width, item.height);

    ctx.strokeStyle = 'rgba(180, 80, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(-hw, -hh, item.width, item.height);
    ctx.setLineDash([]);

    // Upward arrows to show reversed gravity
    ctx.fillStyle = 'rgba(180, 80, 255, 0.5)';
    const arrowOffset = (this.time * 60) % 40;
    for (let col = 0; col < 3; col++) {
      const x = -hw * 0.5 + col * hw * 0.5;
      for (let row = 0; row < 3; row++) {
        const baseY = hh - 20 - row * (hh * 0.6);
        const y = baseY - arrowOffset;
        if (y < -hh || y > hh) continue;
        ctx.beginPath();
        ctx.moveTo(x, y - 8);
        ctx.lineTo(x - 5, y + 2);
        ctx.lineTo(x + 5, y + 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Label
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(180, 80, 255, 0.7)';
    ctx.fillText('FLIP', 0, 0);

    ctx.restore();
  }

  private renderConveyor(ctx: CanvasRenderingContext2D, item: DynamicItem, dir: number): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const hw = item.width / 2;
    const hh = item.height / 2;

    // Belt
    ctx.fillStyle = '#444';
    ctx.fillRect(-hw, -hh, item.width, item.height);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;
    ctx.strokeRect(-hw, -hh, item.width, item.height);

    // Animated chevrons
    const chevronSpacing = 30;
    const offset = (this.time * 60 * dir) % chevronSpacing;

    ctx.strokeStyle = '#ff8800';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';

    for (let i = -1; i < Math.ceil(item.width / chevronSpacing) + 1; i++) {
      const cx = -hw + i * chevronSpacing + offset * dir;
      if (cx < -hw - 10 || cx > hw + 10) continue;
      ctx.beginPath();
      if (dir > 0) {
        ctx.moveTo(cx - 6, -hh * 0.5);
        ctx.lineTo(cx, 0);
        ctx.lineTo(cx - 6, hh * 0.5);
      } else {
        ctx.moveTo(cx + 6, -hh * 0.5);
        ctx.lineTo(cx, 0);
        ctx.lineTo(cx + 6, hh * 0.5);
      }
      ctx.stroke();
    }

    // Rollers at ends
    ctx.fillStyle = '#666';
    ctx.beginPath();
    ctx.arc(-hw, 0, hh * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hw, 0, hh * 0.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private renderStickyGoo(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const hw = item.width / 2;
    const hh = item.height / 2;

    // Goo puddle (organic blobby shape)
    ctx.fillStyle = 'rgba(50, 200, 50, 0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 0, hw, hh, 0, 0, Math.PI * 2);
    ctx.fill();

    // Bubbles
    ctx.fillStyle = 'rgba(80, 255, 80, 0.3)';
    const bubbleTime = this.time * 1.5;
    for (let i = 0; i < 5; i++) {
      const bx = Math.sin(bubbleTime + i * 1.3) * hw * 0.6;
      const by = Math.cos(bubbleTime * 0.7 + i * 2.1) * hh * 0.5;
      const br = 4 + Math.sin(bubbleTime + i) * 2;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }

    // Drip highlights
    ctx.strokeStyle = 'rgba(80, 255, 80, 0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, hw * 0.9, hh * 0.9, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private renderWreckingBall(ctx: CanvasRenderingContext2D, item: DynamicItem): void {
    ctx.save();
    ctx.translate(item.x, item.y);

    const r = item.width / 2;
    const phase = item.timer % WRECKING_PERIOD;
    const chargeRatio = Math.min(phase / (WRECKING_PERIOD - 0.5), 1);

    // Warning ring when about to fire
    if (chargeRatio > 0.5) {
      ctx.strokeStyle = `rgba(255, 50, 50, ${(chargeRatio - 0.5) * 0.6})`;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, WRECKING_BLAST_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Blast effect
    if (item.active) {
      ctx.fillStyle = 'rgba(255, 100, 50, 0.2)';
      ctx.beginPath();
      ctx.arc(0, 0, WRECKING_BLAST_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chain
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 4;
    const swing = Math.sin(this.time * 2) * 20;
    ctx.beginPath();
    ctx.moveTo(0, -r * 2);
    ctx.quadraticCurveTo(swing, -r, 0, 0);
    ctx.stroke();

    // Ball
    const grad = ctx.createRadialGradient(-r * 0.2, -r * 0.2, 0, 0, 0, r);
    grad.addColorStop(0, '#666');
    grad.addColorStop(1, '#333');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Highlight
    ctx.fillStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.beginPath();
    ctx.arc(-r * 0.25, -r * 0.25, r * 0.3, 0, Math.PI * 2);
    ctx.fill();

    // Charge indicator
    if (chargeRatio > 0) {
      ctx.fillStyle = `rgba(255, ${Math.floor(200 * (1 - chargeRatio))}, 50, ${chargeRatio * 0.8})`;
      ctx.beginPath();
      ctx.arc(0, r + 12, 5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  cleanup(): void {
    this.items = [];
    this.world = null;
    this.playerManager = null;
  }
}
