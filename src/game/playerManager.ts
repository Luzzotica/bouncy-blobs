import type { SoftBodyEngine } from '../physics/SoftBodyEngine';
import { SlimeBlob, HullPreset } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { playerColor } from '../renderer/colors';
import type { AIController } from './aiController';
import { hashStringSeed } from '../lib/rng';

export type InputSource = 'remote' | 'ai';

export interface ManagedPlayer {
  playerId: string;
  name: string;
  blob: SlimeBlob;
  colorIndex: number;
  color: string;
  faceId: string;
  moveX: number;
  moveY: number;
  expanding: boolean;
  /** Smoothed gaze direction (unit-ish vector). Eases toward normalized input
   * each frame and drifts back to (0,0) when input is zero. Consumed by the
   * face renderer to offset pupils. */
  gazeX: number;
  gazeY: number;
  inputSource: InputSource;
  /** Set when inputSource === 'ai'. */
  aiController: AIController | null;
}

export class PlayerManager {
  private players = new Map<string, ManagedPlayer>();
  private nextColorIndex = 0;
  private spawnPoints: Vec2[];
  private nextSpawnIndex = 0;

  constructor(spawnPoints: Vec2[]) {
    this.spawnPoints = spawnPoints.length > 0
      ? spawnPoints
      : [vec2(0, 380)];
  }

  addPlayer(
    playerId: string,
    name: string,
    world: SoftBodyEngine,
    hullPreset: HullPreset = 'circle16',
    customColor?: string,
    faceId?: string,
  ): ManagedPlayer {
    if (this.players.has(playerId)) {
      return this.players.get(playerId)!;
    }

    // Spawn point + jitter must be deterministic per-playerId — host and
    // guests each call addPlayer at different times, so a counter-based
    // index (nextSpawnIndex) would assign DIFFERENT spawn points to the
    // same player on each side. Derive both the spawn slot and the
    // horizontal jitter from a hash of the playerId so every client
    // independently agrees on where the blob spawns. `nextSpawnIndex` is
    // still incremented for legacy single-player / sandbox callers that
    // rely on round-robin spawn order.
    const idHash = hashStringSeed(playerId);
    const spawnIdx = idHash % this.spawnPoints.length;
    const baseSpawn = this.spawnPoints[spawnIdx];
    this.nextSpawnIndex++;
    // Top 16 bits of the hash drive jitter; using a different bit window
    // than the spawn-index bits so jitter is uncorrelated with spawn slot.
    const jitter = (((idHash >>> 16) & 0xffff) / 0xffff) - 0.5; // in [-0.5, 0.5)
    const spawnPos = vec2(
      baseSpawn.x + jitter * 400,
      baseSpawn.y,
    );

    const blob = new SlimeBlob(world, spawnPos, {
      playerControlled: true,
      hullPreset,
      // Cross-client sort key — used by SoftBodyEngine's collision-pair
      // iteration so host and guest process the same blob-blob contact in
      // the same order even when their local insertion order differs
      // (host adds itself first then receives guest's player_join; guest
      // adds itself first then synthesizes host's blob from the keyframe).
      sortKey: `player:${playerId}`,
    });

    const colorIndex = this.nextColorIndex++;
    const managed: ManagedPlayer = {
      playerId,
      name,
      blob,
      colorIndex,
      color: customColor || playerColor(colorIndex),
      faceId: faceId || 'default',
      moveX: 0,
      moveY: 0,
      expanding: false,
      gazeX: 0,
      gazeY: 0,
      inputSource: 'remote',
      aiController: null,
    };

    this.players.set(playerId, managed);
    return managed;
  }

  /** Promote (or demote) an existing player to AI control. */
  attachAIController(playerId: string, controller: AIController): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.inputSource = 'ai';
    p.aiController = controller;
  }

  removePlayer(playerId: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    // Free the blob's slot in the SoftBodyEngine so other blobs no longer
    // collide with an invisible body at the leaver's last position.
    p.blob.destroy();
    this.players.delete(playerId);
  }

  getPlayer(playerId: string): ManagedPlayer | undefined {
    return this.players.get(playerId);
  }

  getPlayerByBlobId(blobId: number): ManagedPlayer | undefined {
    for (const player of this.players.values()) {
      if (player.blob.blobId === blobId) return player;
    }
    return undefined;
  }

  getAllPlayers(): ManagedPlayer[] {
    return Array.from(this.players.values());
  }

  getPlayerBlobs(): SlimeBlob[] {
    return this.getAllPlayers().map(p => p.blob);
  }

  getPlayerColors(): string[] {
    return this.getAllPlayers().map(p => p.color);
  }

  getPlayerCount(): number {
    return this.players.size;
  }

  setPlayerInput(playerId: string, moveX: number, expanding: boolean): void {
    const player = this.players.get(playerId);
    if (player) {
      player.moveX = moveX;
      player.expanding = expanding;
    }
  }

  /** Re-decide AI inputs for this tick. Writes to ManagedPlayer.moveX/Y/expanding.
   * Host-only effect (guests have no AI controllers). Split out of updateAll so
   * the host's lockstep input-delay layer can interpose between AI decisions
   * and blob.setInput. */
  tickAIInputs(dt: number, world?: SoftBodyEngine): void {
    for (const player of this.players.values()) {
      if (player.inputSource === 'ai' && player.aiController) {
        const out = player.aiController.tick(player, this, dt, world);
        player.moveX = out.moveX;
        player.moveY = out.moveY;
        player.expanding = out.expanding;
      }
    }
  }

  /** Push ManagedPlayer's current inputs into the blob and tick its update +
   * gaze. Call this AFTER any input-delay layer has rewritten ManagedPlayer.* */
  applyInputsAndStep(dt: number): void {
    for (const player of this.players.values()) {
      player.blob.setInput(player.moveX, player.moveY, player.expanding);
      player.blob.update(dt);

      const mag = Math.hypot(player.moveX, player.moveY);
      const tx = mag > 0.01 ? player.moveX / mag : 0;
      const ty = mag > 0.01 ? player.moveY / mag : 0;
      const a = 1 - Math.exp(-12 * dt);
      player.gazeX += (tx - player.gazeX) * a;
      player.gazeY += (ty - player.gazeY) * a;
    }
  }

  updateAll(dt: number, world?: SoftBodyEngine): void {
    // Kept as a single-pass loop (not tickAIInputs + applyInputsAndStep) to
    // preserve bit-identical behavior for callers like the determinism tests
    // and the rollback replay path that depend on the legacy semantics.
    // The host's input-delay layer drives the split methods directly via
    // bouncyBlobsGame's onLogic instead.
    for (const player of this.players.values()) {
      if (player.inputSource === 'ai' && player.aiController) {
        const out = player.aiController.tick(player, this, dt, world);
        player.moveX = out.moveX;
        player.moveY = out.moveY;
        player.expanding = out.expanding;
      }
      player.blob.setInput(player.moveX, player.moveY, player.expanding);
      player.blob.update(dt);

      const mag = Math.hypot(player.moveX, player.moveY);
      const tx = mag > 0.01 ? player.moveX / mag : 0;
      const ty = mag > 0.01 ? player.moveY / mag : 0;
      const a = 1 - Math.exp(-12 * dt);
      player.gazeX += (tx - player.gazeX) * a;
      player.gazeY += (ty - player.gazeY) * a;
    }
  }

  getSpawnPoints(): Vec2[] {
    return this.spawnPoints;
  }

  getCentroids(): Vec2[] {
    return this.getAllPlayers().map(p => p.blob.getCentroid());
  }

  updateCustomization(playerId: string, color?: string, faceId?: string, name?: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (color !== undefined) player.color = color;
    if (faceId !== undefined) player.faceId = faceId;
    // Name is included here (rather than its own setter) because the
    // guest applies host roster refreshes via the same `lobby_state`
    // path that delivers color/faceId — keeping them on one update
    // surface avoids drift between the two.
    if (name !== undefined && name.length > 0) player.name = name;
  }

  clear(): void {
    this.players.clear();
    this.nextColorIndex = 0;
    this.nextSpawnIndex = 0;
  }
}
