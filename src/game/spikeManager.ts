import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import type { SlimeBlob } from '../physics/slimeBlob';
import { Vec2 } from '../physics/vec2';
import { SpikeDef, ZoneDef } from '../levels/types';
import { PlayerManager } from './playerManager';
import { hashStringId } from './idHash';
import { drawHardCandy, SPIKE_CRYSTAL_PALETTE, SPIKE_BASE_PALETTE, SPIKE_CRYSTAL_PALETTE_CAVE, SPIKE_BASE_PALETTE_CAVE } from '../renderer/candySkin';
import { isCave, CAVE_SPIKE_TIP } from '../renderer/colors';

export type DeathMode = 'instant' | 'no_respawn' | 'timer';

function deathModeNum(m: DeathMode): number {
  switch (m) { case 'no_respawn': return 1; case 'timer': return 2; default: return 0; }
}

/**
 * Spikes / death zones / kill-plane / respawn now run in the Rust engine
 * (Phase 8 of the JS→Rust migration). This manager is a thin loader (registers
 * spikes/zones/kill-plane/spawn-points + death mode at init) + a kill-event
 * drainer (forwards `takeKillEvents` to `onKill` for VFX/score) + renderer
 * (reads `spikeLivePose` / `isDead` / `deadPlayer*` from the engine).
 */
export class SpikeManager {
  private spikeDefs: SpikeDef[] = [];
  private world: SoftBodyEngine | null = null;
  private playerManager: PlayerManager | null = null;
  private deathZones: ZoneDef[] = [];
  private killBelowY: number | null = null;
  private _deathMode: DeathMode = 'instant';

  /** Callback when a player is killed. `deathPosition` is the engine-reported
   *  centroid at the moment of death. */
  onKill?: (killedPlayerId: string, deathPosition: Vec2) => void;

  get deathMode(): DeathMode { return this._deathMode; }
  set deathMode(m: DeathMode) {
    this._deathMode = m;
    this.world?.setDeathMode(deathModeNum(m));
  }

  setDeathZones(zones: ZoneDef[]): void {
    this.deathZones = zones;
    if (this.world) for (const z of zones) this.world.addDeathZone(z.x, z.y, z.width, z.height);
  }

  setKillBelowY(y: number | null): void {
    this.killBelowY = y;
    this.world?.setKillBelowY(y ?? 0, y !== null);
  }

  initialize(
    world: SoftBodyEngine,
    playerManager: PlayerManager,
    defs: SpikeDef[],
    _npcBlobs: SlimeBlob[] = [],
  ): void {
    this.world = world;
    this.playerManager = playerManager;
    this.spikeDefs = [...defs];

    world.setDeathMode(deathModeNum(this._deathMode));
    const spawns = playerManager.getSpawnPoints();
    const flat: number[] = [];
    for (const s of spawns) { flat.push(s.x, s.y); }
    world.setSpawnPoints(flat);
    for (const def of defs) world.addSpike(hashStringId(def.id), def.x, def.y, def.rotation, def.width, def.height);
    // Re-apply any config set before initialize.
    for (const z of this.deathZones) world.addDeathZone(z.x, z.y, z.width, z.height);
    if (this.killBelowY !== null) world.setKillBelowY(this.killBelowY, true);
  }

  /** Closed (authored) pose of a spike — the action loader uses this as the
   *  base to animate a moving spike from. */
  getSpikeBasePose(spikeId: string): { x: number; y: number; rotation: number } | null {
    const s = this.spikeDefs.find(sp => sp.id === spikeId);
    return s ? { x: s.x, y: s.y, rotation: s.rotation } : null;
  }
  setSpikePose(spikeId: string, x: number, y: number, rotation: number): void {
    this.world?.setSpikePose(hashStringId(spikeId), x, y, rotation);
  }

  /** Add a spike at runtime (legacy party placement). */
  addSpike(def: SpikeDef, _isPlayerPlaced = false): void {
    this.spikeDefs.push(def);
    this.world?.addSpike(hashStringId(def.id), def.x, def.y, def.rotation, def.width, def.height);
  }

  /** Drain engine kill events → onKill (VFX/score). The kill/respawn itself
   *  already happened in the engine during `world.step()`. */
  update(_dt: number): void {
    if (!this.world || !this.playerManager) return;
    const ev = this.world.takeKillEvents(); // flat (gid, x, y) triples
    for (let i = 0; i + 2 < ev.length; i += 3) {
      const gid = ev[i];
      const player = this.playerManager.getPlayerByGameplayId(gid);
      if (player) this.onKill?.(player.playerId, { x: ev[i + 1], y: ev[i + 2] });
    }
  }

  /** Route a crush (`onBlobCrushed`) through the engine's death flow. */
  killPlayerByBlobId(blobId: number): void {
    this.world?.killPlayerByBlobId(blobId);
  }

  respawnAll(): void { this.world?.respawnAll(); }

  /** Dead players (playerId → death position + respawn timer), rebuilt from the
   *  engine each call. Used by the camera to follow dead players toward spawn. */
  getDeadPlayers(): Map<string, { deathPosition: Vec2; respawnTimer: number }> {
    const out = new Map<string, { deathPosition: Vec2; respawnTimer: number }>();
    const world = this.world;
    if (!world || !this.playerManager) return out;
    for (const player of this.playerManager.getAllPlayers()) {
      const gid = hashStringId(player.playerId);
      if (!world.isDead(gid)) continue;
      const pos = world.deadPlayerDeathPos(gid);
      out.set(player.playerId, {
        deathPosition: pos.length === 2 ? { x: pos[0], y: pos[1] } : { x: 0, y: 0 },
        respawnTimer: world.deadPlayerRespawnTimer(gid),
      });
    }
    return out;
  }

  isInvulnerable(playerId: string): boolean {
    return this.world?.isInvulnerable(hashStringId(playerId)) ?? false;
  }
  isDead(playerId: string): boolean {
    return this.world?.isDead(hashStringId(playerId)) ?? false;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    if (!world) return;
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

    for (let i = 0; i < this.spikeDefs.length; i++) {
      const def = this.spikeDefs[i];
      const pose = world.spikeLivePose(i); // [x, y, rot] or empty
      const x = pose.length === 3 ? pose[0] : def.x;
      const y = pose.length === 3 ? pose[1] : def.y;
      const rot = pose.length === 3 ? pose[2] : def.rotation;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      const hw = def.width / 2;
      const numTeeth = Math.max(2, Math.floor(def.width / 30));
      const toothW = def.width / numTeeth;

      const baseBar: Vec2[] = [
        { x: -hw, y: -4 }, { x: hw, y: -4 }, { x: hw, y: 4 }, { x: -hw, y: 4 },
      ];
      drawHardCandy(ctx, baseBar, isCave ? SPIKE_BASE_PALETTE_CAVE : SPIKE_BASE_PALETTE);
      for (let t = 0; t < numTeeth; t++) {
        const tx = -hw + t * toothW;
        const tooth: Vec2[] = [
          { x: tx, y: 0 }, { x: tx + toothW, y: 0 }, { x: tx + toothW / 2, y: -def.height },
        ];
        drawHardCandy(ctx, tooth, isCave ? SPIKE_CRYSTAL_PALETTE_CAVE : SPIKE_CRYSTAL_PALETTE);
      }
      if (isCave) {
        // Red tip: glowing accent fading down each black tooth — the warning cue.
        for (let t = 0; t < numTeeth; t++) {
          const tipX = -hw + (t + 0.5) * toothW;
          const tipY = -def.height;
          const glow = ctx.createLinearGradient(tipX, tipY, tipX, tipY + def.height * 0.55);
          glow.addColorStop(0, CAVE_SPIKE_TIP);
          glow.addColorStop(1, 'rgba(255,59,78,0)');
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - toothW * 0.32, tipY + def.height * 0.45);
          ctx.lineTo(tipX + toothW * 0.32, tipY + def.height * 0.45);
          ctx.closePath();
          ctx.fill();
          // Bright core dot right at the point.
          ctx.fillStyle = CAVE_SPIKE_TIP;
          ctx.beginPath();
          ctx.arc(tipX, tipY + 2.5, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        for (let t = 0; t < numTeeth; t++) {
          const tipX = -hw + (t + 0.5) * toothW;
          ctx.beginPath();
          ctx.arc(tipX, -def.height + 3, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  renderDeadPlayers(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    if (!world || !this.playerManager) return;
    for (const player of this.playerManager.getAllPlayers()) {
      const gid = hashStringId(player.playerId);
      if (!world.isDead(gid)) continue;
      const pos = world.deadPlayerDeathPos(gid);
      if (pos.length !== 2) continue;
      const x = pos[0], y = pos[1];

      ctx.save();
      ctx.globalAlpha = 0.4 + Math.sin(Date.now() / 300) * 0.1;
      ctx.beginPath();
      ctx.arc(x, y, 25, 0, Math.PI * 2);
      ctx.fillStyle = player.color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 10, y - 8); ctx.lineTo(x - 4, y - 2);
      ctx.moveTo(x - 4, y - 8); ctx.lineTo(x - 10, y - 2);
      ctx.moveTo(x + 4, y - 8); ctx.lineTo(x + 10, y - 2);
      ctx.moveTo(x + 10, y - 8); ctx.lineTo(x + 4, y - 2);
      ctx.stroke();

      if (this._deathMode === 'timer') {
        const remaining = world.deadPlayerRespawnTimer(gid);
        ctx.globalAlpha = 0.9;
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(Math.ceil(remaining).toString(), x, y + 18);
      } else if (this._deathMode === 'no_respawn') {
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
    this.spikeDefs = [];
    this.world = null;
    this.playerManager = null;
  }
}
