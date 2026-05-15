import type { HullPreset } from '../physics/slimeBlob';
import type { SurfaceMaterial, GravityField } from '../physics/types';

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
  gravityZones?: GravityZoneDef[];
  powerupSpawns?: PowerupSpawnDef[];
  springPads?: SpringPadDef[];
  spikes?: SpikeDef[];
  pointShapes?: PointShapeDef[];
  pressurePlates?: PressurePlateDef[];
  triggers?: TriggerDef[];
}

export interface PointShapePoint {
  x: number;
  y: number;
  anchored: boolean;
  mass?: number;
}

export interface PointShapeEdge {
  a: number;
  b: number;
  stiffness?: number;
  damping?: number;
}

export interface PointShapeDef {
  id: string;
  points: PointShapePoint[];
  edges: PointShapeEdge[];
  /** When true, an implicit edge connects the last point to the first at load time. */
  closed?: boolean;
}

export interface PressurePlateDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  triggerIds: string[];
  oneShot?: boolean;
}

export type TriggerEasing = 'linear' | 'easeInOut' | 'easeOut';

export interface TriggerTarget {
  shapeId: string;
  pointIndex: number;
  endX: number;
  endY: number;
}

export interface TriggerDef {
  id: string;
  kind: 'movePoints';
  targets: TriggerTarget[];
  /** Seconds. */
  duration: number;
  easing?: TriggerEasing;
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

/** A rectangular trigger zone that applies a non-default gravity field
 * to blobs whose centroid is inside it. */
export interface GravityZoneDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  field: GravityField;
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
  /** Surface material affecting friction/restitution. Defaults to 'default'. */
  material?: SurfaceMaterial;
}

export interface WallDef {
  id: string;
  points: { x: number; y: number }[];
  /** Surface material affecting friction/restitution. Defaults to 'default'. */
  material?: SurfaceMaterial;
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
