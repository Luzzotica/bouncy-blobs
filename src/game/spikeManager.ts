import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { Vec2, vec2 } from '../physics/vec2';
import { SpikeDef, ZoneDef } from '../levels/types';
import { PlayerManager } from './playerManager';
import { drawHardCandy, SPIKE_CRYSTAL_PALETTE, SPIKE_BASE_PALETTE } from '../renderer/candySkin';

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
      // Use the full hull polygon for spike + death-zone tests: any part
      // of the blob touching a hazard counts. Centroid-only meant a fast
      // blob could glide its edges through a spike without dying.
      const hull = player.blob.getHullPolygon();

      let killed = false;
      for (const spike of this.spikes) {
        for (const p of hull) {
          if (this.isInsideSpikeZone(p, spike.def)) {
            this.killPlayer(player.playerId);
            killed = true;
            break;
          }
        }
        if (killed) break;
      }
      if (killed) continue;

      for (const z of this.deathZones) {
        const minX = z.x - z.width / 2, maxX = z.x + z.width / 2;
        const minY = z.y - z.height / 2, maxY = z.y + z.height / 2;
        for (const p of hull) {
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
            this.killPlayer(player.playerId);
            killed = true;
            break;
          }
        }
        if (killed) break;
      }
      if (killed) continue;

      // Fall-off-the-map kill stays centroid-based: when the centroid is
      // below the kill line the whole blob is past saving anyway, and we
      // don't want a single trailing hull particle to falsely respawn.
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

  /** Kill a player identified by their physics blob id. No-op if the
   *  blob isn't owned by a player, or the player is already dead /
   *  invulnerable. Used by the physics-engine crush detector — a blob
   *  whose solver state exploded gets routed through the normal death
   *  flow instead of teleporting lightyears away. */
  killPlayerByBlobId(blobId: number): void {
    if (!this.playerManager) return;
    const player = this.playerManager.getPlayerByBlobId(blobId);
    if (!player) return;
    if (this.invulnerable.has(player.playerId)) return;
    if (this.deadPlayers.has(player.playerId)) return;
    this.killPlayer(player.playerId);
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

      ctx.save();
      ctx.translate(def.x, def.y);
      ctx.rotate(def.rotation);

      const hw = def.width / 2;
      const numTeeth = Math.max(2, Math.floor(def.width / 30));
      const toothW = def.width / numTeeth;

      // Caramel base bar — drawn as a hard-candy rectangle so it picks up
      // the gradient + highlight pass for free.
      const baseBar: Vec2[] = [
        { x: -hw, y: -4 },
        { x:  hw, y: -4 },
        { x:  hw, y:  4 },
        { x: -hw, y:  4 },
      ];
      drawHardCandy(ctx, baseBar, SPIKE_BASE_PALETTE);

      // Rock-candy tooth crystals — each tooth is its own hard-candy
      // polygon so the gloss + sugar grain reads per spike, not as one big
      // smear across the bar.
      for (let i = 0; i < numTeeth; i++) {
        const tx = -hw + i * toothW;
        const tooth: Vec2[] = [
          { x: tx,             y: 0 },
          { x: tx + toothW,    y: 0 },
          { x: tx + toothW / 2, y: -def.height },
        ];
        drawHardCandy(ctx, tooth, SPIKE_CRYSTAL_PALETTE);
      }

      // Tiny white sugar glint on each tip — the lit-sugar spec dot that
      // sells the "sharp crystal" silhouette at a glance.
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (let i = 0; i < numTeeth; i++) {
        const tipX = -hw + (i + 0.5) * toothW;
        ctx.beginPath();
        ctx.arc(tipX, -def.height + 3, 1.6, 0, Math.PI * 2);
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

  /** Rollback netcode snapshot. Captures invulnerability + dead-player
   *  state. Configuration (deathMode, killBelowY, deathZones) is set at
   *  match init and doesn't change per tick — not in the snapshot. */
  dumpState(): {
    invulnerable: Array<[string, number]>;
    deadPlayers: Array<[string, { deathPosition: Vec2; respawnTimer: number }]>;
  } {
    // Sort entries by player id for cross-client determinism — the
    // rollback replay needs identical map iteration order on every
    // client, but JS Map iteration order is insertion-based and we
    // can't guarantee insertion order matches across clients.
    const invulnerable = [...this.invulnerable.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([id, t]) => [id, t] as [string, number]);
    const deadPlayers = [...this.deadPlayers.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      .map(([id, dp]) => [id, {
        deathPosition: { x: dp.deathPosition.x, y: dp.deathPosition.y },
        respawnTimer: dp.respawnTimer,
      }] as [string, { deathPosition: Vec2; respawnTimer: number }]);
    return { invulnerable, deadPlayers };
  }

  restoreState(state: ReturnType<SpikeManager['dumpState']>): void {
    this.invulnerable.clear();
    for (const [id, t] of state.invulnerable) this.invulnerable.set(id, t);
    this.deadPlayers.clear();
    for (const [id, dp] of state.deadPlayers) {
      this.deadPlayers.set(id, {
        deathPosition: { x: dp.deathPosition.x, y: dp.deathPosition.y },
        respawnTimer: dp.respawnTimer,
      });
    }
  }
}
