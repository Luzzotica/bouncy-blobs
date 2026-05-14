import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob, HullPreset } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { playerColor } from '../renderer/colors';
import type { AIController } from './aiController';

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
    world: SoftBodyWorld,
    hullPreset: HullPreset = 'circle16',
    customColor?: string,
    faceId?: string,
  ): ManagedPlayer {
    if (this.players.has(playerId)) {
      return this.players.get(playerId)!;
    }

    const baseSpawn = this.spawnPoints[this.nextSpawnIndex % this.spawnPoints.length];
    this.nextSpawnIndex++;
    // Randomize within ±200px horizontally so players don't stack
    const spawnPos = vec2(
      baseSpawn.x + (Math.random() - 0.5) * 400,
      baseSpawn.y,
    );

    const blob = new SlimeBlob(world, spawnPos, {
      playerControlled: true,
      hullPreset,
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
    // Free the blob's slot in the SoftBodyWorld so other blobs no longer
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

  updateAll(dt: number): void {
    for (const player of this.players.values()) {
      // Let AI controllers re-decide their input each tick.
      if (player.inputSource === 'ai' && player.aiController) {
        const out = player.aiController.tick(player, this, dt);
        player.moveX = out.moveX;
        player.moveY = out.moveY;
        player.expanding = out.expanding;
      }
      player.blob.setInput(player.moveX, player.moveY, player.expanding);
      player.blob.update(dt);
    }
  }

  getSpawnPoints(): Vec2[] {
    return this.spawnPoints;
  }

  getCentroids(): Vec2[] {
    return this.getAllPlayers().map(p => p.blob.getCentroid());
  }

  updateCustomization(playerId: string, color?: string, faceId?: string): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (color !== undefined) player.color = color;
    if (faceId !== undefined) player.faceId = faceId;
  }

  clear(): void {
    this.players.clear();
    this.nextColorIndex = 0;
    this.nextSpawnIndex = 0;
  }
}
