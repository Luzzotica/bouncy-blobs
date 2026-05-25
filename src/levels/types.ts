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
  /** Rectangular zones that instantly kill any blob whose centroid enters. */
  deathZones?: ZoneDef[];
  pointShapes?: PointShapeDef[];
  softPlatforms?: SoftPlatformDef[];
  /** Areas that detect blobs (formerly pressurePlates). Actions subscribe to these. */
  triggers?: TriggerDef[];
  /** Movement effects (formerly triggers). Each action subscribes to one or more triggers. */
  actions?: ActionDef[];
  /** Placed sprite instances — props from public/sprites/manifest.json with
   * per-asset collision shapes. Physics integration is staged: visuals load
   * via the sprite registry, collision wiring is wired up per-asset as each
   * gets editor-tuned hulls. */
  sprites?: SpriteInstanceDef[];
}

/** An instance of a sprite from the registry placed in a level. The sprite
 * `id` references public/sprites/manifest.json; everything else is the
 * per-placement transform. */
export interface SpriteInstanceDef {
  id: string;          // instance id (unique within the level)
  spriteId: string;    // sprite registry id (e.g. 'pencil')
  x: number;
  y: number;
  rotation: number;    // radians
  scale?: number;      // default 1
}

export type SoftAnchorPattern = 'corners' | 'ends' | 'left' | 'right' | 'top' | 'bottom';

/** Rectangular soft-body platform with anchored points. Loader expands into
 * a blob whose hull is a subdivided rectangle, with the indicated hull
 * indices locked in space (mass=0, invMass=0). */
export interface SoftPlatformDef {
  id: string;
  x: number;            // center x
  y: number;            // center y
  width: number;
  height: number;
  /** Rotation in radians. Default 0. Rotates the hull (anchored corners and
   * unanchored mid-edge points alike) around the platform center. */
  rotation?: number;
  /** Hull subdivisions. Defaults: segW=8 along the long axis, segH=1 along
   * the short axis. Total hull points = 2*segW + 2*segH. */
  segW?: number;
  segH?: number;
  /** Which hull points are locked in space. Default 'corners'. */
  anchors?: SoftAnchorPattern | number[];
  /** Multiplier on spring stiffness (defaults to 1.0). Higher = more rigid. */
  stiffness?: number;
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

/** An area that detects blobs. Wired to one or more Actions via the action's
 *  `sourceTriggerIds`. Pressed-state can require a charge-up of `chargeSeconds`. */
export interface TriggerDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Optional override for the trigger detection zone's width. Defaults to
   * `width`. Use when the visible plate should be small but the sensor area
   * should be larger. */
  sensorWidth?: number;
  /** Optional override for the trigger detection zone's height. Defaults to
   * `height`. The trigger zone is anchored so its bottom aligns with the
   * plate's bottom — extra height extends upward, where blobs approach from. */
  sensorHeight?: number;
  /** Seconds of continuous occupancy required before `pressed` flips true.
   *  0 = instant. Charge resets to 0 the moment occupancy drops to zero. */
  chargeSeconds?: number;
}

export type ActionEasing = 'linear' | 'easeInOut' | 'easeOut';
export type ActionMode = 'switch' | 'continuous' | 'oneShot';
export type RequireMode = 'any' | 'all';

export type ActionTarget =
  | { kind: 'shapePoint'; shapeId: string; pointIndex: number; endX: number; endY: number }
  | { kind: 'platform'; platformId: string; endX: number; endY: number };

/** A movement effect. Subscribes to one or more Triggers via `sourceTriggerIds`
 *  and animates its targets between their closed (initial) and open (endX/endY)
 *  positions according to `mode`. */
export interface ActionDef {
  id: string;
  kind: 'movePoints';
  targets: ActionTarget[];
  /** Seconds. */
  duration: number;
  easing?: ActionEasing;
  /** Triggers whose pressed-state feeds this action. */
  sourceTriggerIds: string[];
  /** Combine pressed-state of sources into a single activated signal. */
  requireMode: RequireMode;
  /** How activation maps to motion. */
  mode: ActionMode;
  /** Seconds to wait after activation rises before applying the move. */
  delaySeconds?: number;
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
  /** Speed (world units/sec) the plate extends at while firing — also the launch
   * speed imparted to a contacted blob along `rotation`. Typical range: 500–2500.
   * Omitted ≡ default (medium). */
  fireSpeed?: number;
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
