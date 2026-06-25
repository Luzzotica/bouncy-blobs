import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import type { SlimeBlob } from '../physics/slimeBlob';
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
  /** Immutable authored definition — `def.x/y/rotation` is the CLOSED (base)
   *  pose. Width/height never animate. */
  def: SpikeDef;
  /** Live pose, read by collision + render. Starts at the def pose; an Action
   *  targeting this spike drives it each tick (a moving spike trap). Kept
   *  separate from `def` so reloading/replaying a level always starts from the
   *  authored base, never a previously-animated position. */
  x: number;
  y: number;
  rotation: number;
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
  /** NPC blobs (the multi-shape decorative/obstacle blobs). They aren't players,
   *  so they have no respawn — they're simply retired (destroy()) when they fall
   *  past the kill plane. */
  private npcBlobs: SlimeBlob[] = [];

  setDeathZones(zones: ZoneDef[]): void {
    this.deathZones = zones;
  }

  setKillBelowY(y: number | null): void {
    this.killBelowY = y;
  }

  initialize(
    world: SoftBodyEngine,
    playerManager: PlayerManager,
    defs: SpikeDef[],
    npcBlobs: SlimeBlob[] = [],
  ): void {
    this.world = world;
    this.playerManager = playerManager;
    this.npcBlobs = npcBlobs;
    this.spikes = [];
    this.invulnerable.clear();

    for (const def of defs) {
      this.spikes.push({ def, x: def.x, y: def.y, rotation: def.rotation });
    }
  }

  /** Closed (authored) pose of a spike — used by the action system as the
   *  base to animate from. Null if the id is unknown. */
  getSpikeBasePose(spikeId: string): { x: number; y: number; rotation: number } | null {
    const s = this.spikes.find(sp => sp.def.id === spikeId);
    return s ? { x: s.def.x, y: s.def.y, rotation: s.def.rotation } : null;
  }

  /** Set a spike's live pose (collision + render follow it next frame).
   *  Driven by the action system; the authored `def` is left untouched. */
  setSpikePose(spikeId: string, x: number, y: number, rotation: number): void {
    const s = this.spikes.find(sp => sp.def.id === spikeId);
    if (!s) return;
    s.x = x;
    s.y = y;
    s.rotation = rotation;
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
          if (this.isInsideSpikeZone(p, spike)) {
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

    // NPC blobs fall off the map too. They have no respawn, so a fall past the
    // kill plane simply retires them (destroy() → inactive in physics + skipped
    // by the renderer). Centroid-based, same as the player fall-off check.
    //
    // Re-derived from world state every tick rather than gated on a JS flag:
    // removeBlob() is idempotent and parks dead particles in a far-above
    // graveyard (so the centroid check is naturally false afterwards), and the
    // inactive state lives in the world snapshot. A latch the snapshot can't
    // restore would resurrect-but-not-rekill an NPC after a rollback → desync.
    if (this.killBelowY !== null) {
      for (const npc of this.npcBlobs) {
        if (npc.getCentroid().y > this.killBelowY) npc.destroy();
      }
    }
  }

  private isInsideSpikeZone(point: Vec2, spike: RegisteredSpike): boolean {
    // Transform point into the spike's LIVE local space (live pose may be
    // animated by an action; width/height come from the immutable def).
    const dx = point.x - spike.x;
    const dy = point.y - spike.y;
    const cos = Math.cos(-spike.rotation);
    const sin = Math.sin(-spike.rotation);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    // Check if inside the spike's bounding box (local space)
    const hw = spike.def.width / 2;
    return localX >= -hw && localX <= hw && localY >= -spike.def.height && localY <= 0;
  }

  /** Add a spike at runtime (for party mode placement). */
  addSpike(def: SpikeDef, isPlayerPlaced = false): void {
    this.spikes.push({ def, x: def.x, y: def.y, rotation: def.rotation });
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
      // respawnReset (not teleportBlob) so a blob that died DEFORMED — e.g.
      // crushed, hull squeezed/spread — comes back as a clean rest-shaped
      // blob. A translated-but-still-spread hull spans a huge AABB and makes
      // every other softbody in the scene collide with it.
      player.blob.respawnReset(spawnPoints[spawnIdx]);
      this.invulnerable.set(playerId, RESPAWN_INVULNERABILITY);
    } else {
      // no_respawn or timer: move blob offscreen, track as dead. Still reset
      // the shape — a deformed hull off-screen has the same giant-AABB problem.
      player.blob.respawnReset(vec2(deathPos.x, DEAD_OFFSCREEN_Y));
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
    // Clean rest pose on respawn (see killPlayer for why a plain teleport
    // would leave a crushed/deformed blob spread across the map).
    player.blob.respawnReset(spawnPoints[spawnIdx]);

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
      ctx.translate(spike.x, spike.y);
      ctx.rotate(spike.rotation);

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
