import type { HullPreset } from '../physics/slimeBlob';

export type LevelType = 'solo_racing' | 'team_racing' | 'party' | 'koth';

/** Normalize level mode(s) from either the new `levelTypes` array or legacy `levelType` field. */
export function getLevelTypes(level: LevelData): LevelType[] {
  if (level.levelTypes && level.levelTypes.length > 0) return level.levelTypes;
  if (level.levelType) return [level.levelType];
  return ['solo_racing'];
}

export interface LevelData {
  name: string;
  version: 1;
  /** @deprecated Use `levelTypes` instead. Kept for backward compatibility. */
  levelType?: LevelType;
  levelTypes?: LevelType[];
  bounds: { width: number; height: number };
  platforms: PlatformDef[];
  walls: WallDef[];
  spawnPoints: SpawnPointDef[];
  npcBlobs: NpcBlobDef[];
  goalZones?: ZoneDef[];
  hillZones?: ZoneDef[];
  powerupSpawns?: PowerupSpawnDef[];
  springPads?: SpringPadDef[];
  spikes?: SpikeDef[];
}

export interface SpikeDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in radians. Spikes point "up" (in local -Y) by default. */
  rotation: number;
}

export interface ZoneDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PowerupSpawnDef {
  id: string;
  x: number;
  y: number;
}

export interface SpringPadDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Launch direction in radians. 0 = right, -PI/2 = up, PI/2 = down, PI = left. */
  rotation: number;
  /** Launch impulse strength. */
  force: number;
}

export interface PlatformDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface WallDef {
  id: string;
  points: { x: number; y: number }[];
}

export interface SpawnPointDef {
  id: string;
  x: number;
  y: number;
  type: 'player' | 'npc';
}

export interface NpcBlobDef {
  id: string;
  x: number;
  y: number;
  hullPreset: HullPreset;
  hue?: number;
}
