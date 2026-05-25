import { SoftBodyWorld } from '../physics/softBodyWorld';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { Vec2, vec2 } from '../physics/vec2';
import { SpikeDef, ZoneDef } from '../levels/types';
import { PlayerManager } from './playerManager';
import { getSprite, getSpriteWorldSize } from '../assets/spriteRegistry';
import { drawSprite as drawSpriteImg } from '../renderer/spriteRenderer';

const KILL_RADIUS = 50;
const RESPAWN_INVULNERABILITY = 1.5; // seconds
const KOTH_RESPAWN_TIME = 3.0; // seconds
const DEAD_OFFSCREEN_Y = -9999;

export type DeathMode = 'instant' | 'no_respawn' | 'timer';

interface DeadPlayer {
  deathPosition: Vec2;
  respawnTimer: number; // seconds remaining (only used in 'timer' mode)
}

interface RegisteredSpike {
  def: SpikeDef;
  /** Precomputed spike tip points in world space for rendering */
  worldPoints: Vec2[];
}

export class SpikeManager {
  private spikes: RegisteredSpike[] = [];
  private world: SoftBodyEngine | null = null;
  private playerManager: PlayerManager | null = null;
  /** Tracks invulnerability timers per player */
  private invulnerable = new Map<string, number>();
  /** Optional callback when a player is killed by spikes. `deathPosition` is
   * the blob's centroid at the moment of death — call sites must snapshot it
   * before the player is teleported away. */
  onKill?: (killedPlayerId: string, deathPosition: Vec2) => void;
  /** Set of spike IDs that were placed by players (for tracking trap kills) */
  private playerPlacedSpikeIds = new Set<string>();
  /** Death behavior: instant respawn, no respawn, or timed respawn */
  deathMode: DeathMode = 'instant';
  /** Players currently dead (not respawned) */
  private deadPlayers = new Map<string, DeadPlayer>();
  private deathZones: ZoneDef[] = [];
  /** Y coordinate below which any blob is killed (fall-off-the-map). null = disabled. */
  private killBelowY: number | null = null;

  setDeathZones(zones: ZoneDef[]): void {
    this.deathZones = zones;
  }

  setKillBelowY(y: number | null): void {
    this.killBelowY = y;
  }

  initialize(world: SoftBodyEngine, playerManager: PlayerManager, defs: SpikeDef[]): void {
    this.world = world;
    this.playerManager = playerManager;
    this.spikes = [];
    this.invulnerable.clear();

    for (const def of defs) {
      // Precompute spike tooth tip positions for collision & rendering
      const numTeeth = Math.max(2, Math.floor(def.width / 30));
      const worldPoints: Vec2[] = [];
      const cos = Math.cos(def.rotation);
      const sin = Math.sin(def.rotation);
      const hw = def.width / 2;
      const toothSpacing = def.width / numTeeth;

      for (let i = 0; i < numTeeth; i++) {
        // Local positions: teeth along x-axis, pointing up (-y)
        const localX = -hw + toothSpacing * (i + 0.5);
        const localY = -def.height;
        // Rotate + translate to world
        const wx = def.x + localX * cos - localY * sin;
        const wy = def.y + localX * sin + localY * cos;
        worldPoints.push(vec2(wx, wy));
      }

      this.spikes.push({ def, worldPoints });
    }
  }

  update(dt: number): void {
    if (!this.world || !this.playerManager) return;

    // Tick invulnerability timers
    for (const [pid, t] of this.invulnerable) {
      const remaining = t - dt;
      if (remaining <= 0) {
        this.invulnerable.delete(pid);
      } else {
        this.invulnerable.set(pid, remaining);
      }
    }

    // Tick respawn timers for dead players (timer mode only)
    if (this.deathMode === 'timer') {
      for (const [pid, dead] of this.deadPlayers) {
        dead.respawnTimer -= dt;
        if (dead.respawnTimer <= 0) {
          this.respawnPlayer(pid);
        }
      }
    }

    // Check each player blob centroid against each spike zone
    const players = this.playerManager.getAllPlayers();
    for (const player of players) {
      if (this.invulnerable.has(player.playerId)) continue;
      if (this.deadPlayers.has(player.playerId)) continue;

      const centroid = player.blob.getCentroid();

      let killed = false;
      for (const spike of this.spikes) {
        if (this.isInsideSpikeZone(centroid, spike.def)) {
          this.killPlayer(player.playerId);
          killed = true;
          break;
        }
      }
      if (killed) continue;

      for (const z of this.deathZones) {
        if (centroid.x >= z.x - z.width / 2 && centroid.x <= z.x + z.width / 2 &&
            centroid.y >= z.y - z.height / 2 && centroid.y <= z.y + z.height / 2) {
          this.killPlayer(player.playerId);
          killed = true;
          break;
        }
      }
      if (killed) continue;

      if (this.killBelowY !== null && centroid.y > this.killBelowY) {
        this.killPlayer(player.playerId);
      }
    }
  }

  private isInsideSpikeZone(point: Vec2, def: SpikeDef): boolean {
    // Transform point into spike's local space
    const dx = point.x - def.x;
    const dy = point.y - def.y;
    const cos = Math.cos(-def.rotation);
    const sin = Math.sin(-def.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    // Check if inside the spike's bounding box (local space)
    const hw = def.width / 2;
    return localX >= -hw && localX <= hw && localY >= -def.height && localY <= 0;
  }

  /** Add a spike at runtime (for party mode placement). */
  addSpike(def: SpikeDef, isPlayerPlaced = false): void {
    const numTeeth = Math.max(2, Math.floor(def.width / 30));
    const worldPoints: Vec2[] = [];
    const cos = Math.cos(def.rotation);
    const sin = Math.sin(def.rotation);
    const hw = def.width / 2;
    const toothSpacing = def.width / numTeeth;

    for (let i = 0; i < numTeeth; i++) {
      const localX = -hw + toothSpacing * (i + 0.5);
      const localY = -def.height;
      const wx = def.x + localX * cos - localY * sin;
      const wy = def.y + localX * sin + localY * cos;
      worldPoints.push(vec2(wx, wy));
    }

    this.spikes.push({ def, worldPoints });
    if (isPlayerPlaced) {
      this.playerPlacedSpikeIds.add(def.id);
    }
  }

  private killPlayer(playerId: string): void {
    if (!this.world || !this.playerManager) return;

    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const deathPos = player.blob.getCentroid();

    if (this.deathMode === 'instant') {
      // Original behavior: teleport to spawn immediately. Pull from the
      // world's seeded RNG so respawn points match across host + guests.
      const spawnPoints = this.playerManager.getSpawnPoints();
      const r = this.world.rng?.next() ?? Math.random();
      const spawnIdx = Math.floor(r * spawnPoints.length);
      this.world.teleportBlob(player.blob.blobId, spawnPoints[spawnIdx]);
      this.invulnerable.set(playerId, RESPAWN_INVULNERABILITY);
    } else {
      // no_respawn or timer: move blob offscreen, track as dead
      this.world.teleportBlob(player.blob.blobId, vec2(deathPos.x, DEAD_OFFSCREEN_Y));
      this.deadPlayers.set(playerId, {
        deathPosition: deathPos,
        respawnTimer: this.deathMode === 'timer' ? KOTH_RESPAWN_TIME : Infinity,
      });
    }

    // Notify kill callback (after teleport, so deathPos was snapshotted above).
    this.onKill?.(playerId, deathPos);
  }

  private respawnPlayer(playerId: string): void {
    if (!this.world || !this.playerManager) return;

    const player = this.playerManager.getPlayer(playerId);
    if (!player) return;

    const spawnPoints = this.playerManager.getSpawnPoints();
    const r = this.world.rng?.next() ?? Math.random();
    const spawnIdx = Math.floor(r * spawnPoints.length);
    this.world.teleportBlob(player.blob.blobId, spawnPoints[spawnIdx]);

    this.deadPlayers.delete(playerId);
    this.invulnerable.set(playerId, RESPAWN_INVULNERABILITY);
  }

  /** Respawn all dead players (call between rounds) */
  respawnAll(): void {
    for (const pid of this.deadPlayers.keys()) {
      this.respawnPlayer(pid);
    }
  }

  isInvulnerable(playerId: string): boolean {
    return this.invulnerable.has(playerId);
  }

  isDead(playerId: string): boolean {
    return this.deadPlayers.has(playerId);
  }

  getDeadPlayers(): Map<string, DeadPlayer> {
    return this.deadPlayers;
  }

  render(ctx: CanvasRenderingContext2D): void {
    // Death zones — translucent red rectangles with hatched border.
    for (const z of this.deathZones) {
      ctx.save();
      ctx.translate(z.x, z.y);
      ctx.fillStyle = 'rgba(220, 40, 40, 0.18)';
      ctx.fillRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.strokeStyle = 'rgba(255, 70, 70, 0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([10, 6]);
      ctx.strokeRect(-z.width / 2, -z.height / 2, z.width, z.height);
      ctx.setLineDash([]);
      ctx.restore();
    }

    for (const spike of this.spikes) {
      const { def } = spike;

      // Sprite path — scale to the editor-configured footprint so authored
      // levels behave the same way visually as they did pre-art-pass. The
      // sprite has its tip pointing up and base anchored near the bottom
      // (anchor.y ≈ 0.85 in the manifest), so translating to def.x/def.y
      // keeps spike teeth poking above the base bar where physics expects.
      const spriteSpike = getSprite('spike');
      if (spriteSpike) {
        const natural = getSpriteWorldSize(spriteSpike);
        const sx = def.width / natural.width;
        const sy = def.height / (natural.height * 0.7); // teeth ≈ 70% of image
        ctx.save();
        ctx.translate(def.x, def.y);
        ctx.rotate(def.rotation);
        ctx.scale(sx, sy);
        drawSpriteImg(ctx, spriteSpike, 0, 0);
        ctx.restore();
        continue;
      }

      ctx.save();
      ctx.translate(def.x, def.y);
      ctx.rotate(def.rotation);

      const hw = def.width / 2;
      const numTeeth = Math.max(2, Math.floor(def.width / 30));
      const toothW = def.width / numTeeth;

      // Base bar
      ctx.fillStyle = '#555';
      ctx.fillRect(-hw, -4, def.width, 8);

      // Teeth
      ctx.fillStyle = '#cc3333';
      ctx.strokeStyle = '#991111';
      ctx.lineWidth = 1.5;

      for (let i = 0; i < numTeeth; i++) {
        const tx = -hw + i * toothW;
        ctx.beginPath();
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx + toothW, 0);
        ctx.lineTo(tx + toothW / 2, -def.height);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Highlight on tooth tips
      ctx.fillStyle = '#ff6666';
      for (let i = 0; i < numTeeth; i++) {
        const tipX = -hw + (i + 0.5) * toothW;
        ctx.beginPath();
        ctx.arc(tipX, -def.height + 3, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  /** Render ghost markers at death positions with respawn timers */
  renderDeadPlayers(ctx: CanvasRenderingContext2D): void {
    if (!this.playerManager) return;

    for (const [pid, dead] of this.deadPlayers) {
      const player = this.playerManager.getPlayer(pid);
      if (!player) continue;

      const { x, y } = dead.deathPosition;

      ctx.save();
      ctx.globalAlpha = 0.4 + Math.sin(Date.now() / 300) * 0.1; // gentle pulse

      // Ghost blob circle
      ctx.beginPath();
      ctx.arc(x, y, 25, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();

      // X eyes
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      // Left eye
      ctx.beginPath();
      ctx.moveTo(x - 10, y - 8);
      ctx.lineTo(x - 4, y - 2);
      ctx.moveTo(x - 4, y - 8);
      ctx.lineTo(x - 10, y - 2);
      ctx.stroke();
      // Right eye
      ctx.beginPath();
      ctx.moveTo(x + 4, y - 8);
      ctx.lineTo(x + 10, y - 2);
      ctx.moveTo(x + 10, y - 8);
      ctx.lineTo(x + 4, y - 2);
      ctx.stroke();

      // Respawn timer (timer mode only)
      if (this.deathMode === 'timer' && dead.respawnTimer < Infinity) {
        const timerText = Math.ceil(dead.respawnTimer).toString();
        ctx.globalAlpha = 0.9;
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(timerText, x, y + 18);
      }

      // "DEAD" label for no_respawn mode
      if (this.deathMode === 'no_respawn') {
        ctx.globalAlpha = 0.7;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff4444';
        ctx.fillText('DEAD', x, y + 18);
      }

      ctx.restore();
    }
  }

  cleanup(): void {
    this.spikes = [];
    this.world = null;
    this.playerManager = null;
    this.invulnerable.clear();
    this.deadPlayers.clear();
  }
}
