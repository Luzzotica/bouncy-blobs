import { SoftBodyWorld } from '../../physics/softBodyWorld';
import type { SoftBodyEngine } from "../../physics/SoftBodyEngine";
import { Vec2, vec2 } from '../../physics/vec2';
import { isPointInPolygon } from '../../physics/collision';
import { PlayerManager, ManagedPlayer } from '../playerManager';
import { PowerupSpawnDef } from '../../levels/types';
import {
  PowerupType,
  PowerupDef,
  ActivePowerup,
  SpawnedPowerup,
  POWERUP_DEFS,
  POWERUP_TYPES,
} from './types';
import { getSprite } from '../../assets/spriteRegistry';
import { drawSprite } from '../../renderer/spriteRenderer';

const PICKUP_RADIUS = 50;
const RESPAWN_DELAY = 10;
const BOB_SPEED = 2.5;
const BOB_AMPLITUDE = 8;

export class PowerupManager {
  private spawned: SpawnedPowerup[] = [];
  private activePowerups: Map<string, ActivePowerup[]> = new Map(); // playerId -> active effects
  private world: SoftBodyEngine | null = null;
  private time = 0;
  /** Fired on pickup. Receives the collecting player and the powerup's
   * world position + display color (for VFX). */
  onCollect?: (player: ManagedPlayer, color: string, position: Vec2) => void;

  initialize(world: SoftBodyEngine, spawnDefs: PowerupSpawnDef[]): void {
    this.world = world;
    this.spawned = [];
    this.activePowerups.clear();
    this.time = 0;

    // Create spawned powerups with random types. Pull from the world's
    // seeded RNG so two clients pick the same type for each spawner.
    for (const spawn of spawnDefs) {
      const r = world.rng?.next() ?? Math.random();
      const type = POWERUP_TYPES[Math.floor(r * POWERUP_TYPES.length)];
      this.spawned.push({
        id: spawn.id,
        def: POWERUP_DEFS[type],
        position: vec2(spawn.x, spawn.y),
        respawnTimer: 0,
        collected: false,
      });
    }
  }

  update(dt: number, playerManager: PlayerManager): void {
    this.time += dt;

    // Check for pickups
    for (const powerup of this.spawned) {
      if (powerup.collected) {
        // Respawn timer
        powerup.respawnTimer -= dt;
        if (powerup.respawnTimer <= 0) {
          powerup.collected = false;
          // Randomize type on respawn — deterministic via the world's seeded RNG.
          const r = this.world?.rng?.next() ?? Math.random();
          const type = POWERUP_TYPES[Math.floor(r * POWERUP_TYPES.length)];
          powerup.def = POWERUP_DEFS[type];
        }
        continue;
      }

      // Check if any player blob is near this powerup
      for (const player of playerManager.getAllPlayers()) {
        const centroid = player.blob.getCentroid();
        const dx = centroid.x - powerup.position.x;
        const dy = centroid.y - powerup.position.y;
        if (dx * dx + dy * dy < PICKUP_RADIUS * PICKUP_RADIUS) {
          this.collectPowerup(powerup, player);
          break;
        }
      }
    }

    // Update active powerup timers
    for (const [playerId, actives] of this.activePowerups) {
      const player = playerManager.getPlayer(playerId);
      for (let i = actives.length - 1; i >= 0; i--) {
        actives[i].remainingTime -= dt;
        if (actives[i].remainingTime <= 0) {
          // Expire effect
          this.removeEffect(actives[i], player);
          actives.splice(i, 1);
        }
      }
      if (actives.length === 0) {
        this.activePowerups.delete(playerId);
      }
    }
  }

  private collectPowerup(powerup: SpawnedPowerup, player: ManagedPlayer): void {
    powerup.collected = true;
    powerup.respawnTimer = RESPAWN_DELAY;
    this.onCollect?.(player, powerup.def.color, powerup.position);

    // Apply effect
    const active: ActivePowerup = {
      type: powerup.def.type,
      remainingTime: powerup.def.duration,
      multiplier: powerup.def.multiplier,
    };

    if (!this.activePowerups.has(player.playerId)) {
      this.activePowerups.set(player.playerId, []);
    }
    this.activePowerups.get(player.playerId)!.push(active);

    this.applyEffect(active, player);
  }

  private applyEffect(active: ActivePowerup, player: ManagedPlayer | undefined): void {
    if (!player || !this.world) return;

    switch (active.type) {
      case 'mass_boost':
        this.world.setBlobMassScale(player.blob.blobId, active.multiplier);
        break;
      case 'expand_speed':
        player.blob.setExpandSpeedMultiplier(active.multiplier);
        break;
      case 'bouncy':
        player.blob.setMoveForceMultiplier(active.multiplier * 0.75);
        break;
    }
  }

  private removeEffect(active: ActivePowerup, player: ManagedPlayer | undefined): void {
    if (!player || !this.world) return;

    switch (active.type) {
      case 'mass_boost':
        this.world.resetBlobMassScale(player.blob.blobId);
        break;
      case 'expand_speed':
        player.blob.setExpandSpeedMultiplier(1.0);
        break;
      case 'bouncy':
        player.blob.setMoveForceMultiplier(1.0);
        break;
    }
  }

  getActivePowerups(playerId: string): ActivePowerup[] {
    return this.activePowerups.get(playerId) ?? [];
  }

  /** Render powerup items in world space (call inside camera transform). */
  render(ctx: CanvasRenderingContext2D): void {
    for (const powerup of this.spawned) {
      if (powerup.collected) continue;

      const { position, def } = powerup;
      const bobY = position.y + Math.sin(this.time * BOB_SPEED) * BOB_AMPLITUDE;

      ctx.save();

      // Sprite path — single painted orb with baked-in glow. Powerup color
      // is conveyed by a tinted overlay since the sprite is one design.
      const orbSprite = getSprite('powerup_orb');
      if (orbSprite) {
        drawSprite(ctx, orbSprite, position.x, bobY, 0, 1, 1);
        // Color cue + label still useful so player can tell what they're
        // grabbing without learning the orb art by heart.
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = def.color + '55';
        ctx.beginPath();
        ctx.arc(position.x, bobY, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(def.label, position.x, bobY);
        ctx.restore();
        continue;
      }

      // Glow
      ctx.beginPath();
      ctx.arc(position.x, bobY, 22, 0, Math.PI * 2);
      ctx.fillStyle = def.color + '33';
      ctx.fill();

      // Circle
      ctx.beginPath();
      ctx.arc(position.x, bobY, 16, 0, Math.PI * 2);
      ctx.fillStyle = def.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(def.label, position.x, bobY);

      ctx.restore();
    }
  }

  cleanup(): void {
    this.spawned = [];
    this.activePowerups.clear();
    this.world = null;
  }

  /** Rollback snapshot. Captures spawn collected/timer state +
   *  per-player active effects + the manager clock. Powerup types are
   *  serialized as the type string; restore re-resolves to POWERUP_DEFS. */
  dumpState(): {
    time: number;
    spawned: Array<{ id: string; type: PowerupType; respawnTimer: number; collected: boolean }>;
    activePowerups: Array<[string, Array<{ type: PowerupType; remainingTime: number; multiplier: number }>]>;
  } {
    return {
      time: this.time,
      spawned: this.spawned.map(s => ({
        id: s.id,
        type: s.def.type,
        respawnTimer: s.respawnTimer,
        collected: s.collected,
      })),
      activePowerups: [...this.activePowerups.entries()]
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
        .map(([pid, effs]) => [pid, effs.map(e => ({
          type: e.type,
          remainingTime: e.remainingTime,
          multiplier: e.multiplier,
        }))]),
    };
  }

  restoreState(state: ReturnType<PowerupManager['dumpState']>): void {
    this.time = state.time;
    const byId = new Map(this.spawned.map(s => [s.id, s] as const));
    for (const entry of state.spawned) {
      const s = byId.get(entry.id);
      if (!s) continue;
      s.def = POWERUP_DEFS[entry.type];
      s.respawnTimer = entry.respawnTimer;
      s.collected = entry.collected;
    }
    this.activePowerups.clear();
    for (const [pid, effs] of state.activePowerups) {
      this.activePowerups.set(pid, effs.map(e => ({
        type: e.type,
        remainingTime: e.remainingTime,
        multiplier: e.multiplier,
      })));
    }
  }
}
