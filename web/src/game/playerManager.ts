import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob, HullPreset } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { playerColor } from '../renderer/colors';

export interface ManagedPlayer {
  playerId: string;
  name: string;
  blob: SlimeBlob;
  colorIndex: number;
  color: string;
  faceId: string;
  moveX: number;
  expanding: boolean;
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

    const spawnPos = this.spawnPoints[this.nextSpawnIndex % this.spawnPoints.length];
    this.nextSpawnIndex++;

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
      expanding: false,
    };

    this.players.set(playerId, managed);
    return managed;
  }

  removePlayer(playerId: string): void {
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
      player.blob.setInput(player.moveX, player.expanding);
      player.blob.update(dt);
    }
  }

  getSpawnPoints(): Vec2[] {
    return this.spawnPoints;
  }

  getCentroids(): Vec2[] {
    return this.getAllPlayers().map(p => p.blob.getCentroid());
  }

  clear(): void {
    this.players.clear();
    this.nextColorIndex = 0;
    this.nextSpawnIndex = 0;
  }
}
