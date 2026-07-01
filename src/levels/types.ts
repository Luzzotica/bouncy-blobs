import type { HullPreset } from '../physics/slimeBlob';
import type { SurfaceMaterial, GravityField } from '../physics/types';

export type LevelType = 'solo_racing' | 'team_racing' | 'koth';

/** Normalize level mode(s) from either the new `levelTypes` array or legacy `levelType` field. */
export function getLevelTypes(level: LevelData): LevelType[] {
  if (level.levelTypes && level.levelTypes.length > 0) return level.levelTypes;
  if (level.levelType) return [level.levelType];
  return ['solo_racing'];
}

/** Validate that a level has the entities a given game mode needs. Returns
 *  `null` when the mode is playable, or a short human-readable reason
 *  string when it isn't. Used by the editor to disable mode toggles whose
 *  requirements aren't met, and to flag currently-enabled modes that have
 *  lost their requirements (e.g. the user deleted the goal zone). */
export function validateLevelType(level: LevelData, type: LevelType): string | null {
  switch (type) {
    case 'solo_racing':
    case 'team_racing':
      if ((level.goalZones?.length ?? 0) === 0) return 'needs a Goal zone';
      if (level.spawnPoints.filter(sp => sp.type === 'player').length === 0) return 'needs a player Spawn';
      return null;
    case 'koth':
      if ((level.hillZones?.length ?? 0) === 0) return 'needs a Hill zone';
      if (level.spawnPoints.filter(sp => sp.type === 'player').length === 0) return 'needs a player Spawn';
      return null;
  }
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
  /** KOTH only: when set and 2+ `hillZones` exist, the active hill moves to a
   *  random other zone after a random interval in [minSeconds, maxSeconds].
   *  Absent (or with <2 hills) = the hill stays put on the first zone. */
  hillRotation?: { minSeconds: number; maxSeconds: number };
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
  /** Rope-chain primitives between two anchors. Anchors are either a fixed
   * world point or a reference to a blob entity (centroid). */
  chains?: ChainDef[];
  /** Placed sprite instances — props from public/sprites/manifest.json with
   * per-asset collision shapes. Physics integration is staged: visuals load
   * via the sprite registry, collision wiring is wired up per-asset as each
   * gets editor-tuned hulls. */
  sprites?: SpriteInstanceDef[];
  /** Whether to draw the goopy lava visual at the fall-off-the-map kill plane.
   * The kill plane itself is always active (a blob below it dies regardless) —
   * this only toggles the lava render. Undefined = shown (default). */
  showLava?: boolean;
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
  /** Surface material override for polygon/circle hulls. Ignored for
   * point-shape props (they flex regardless). Defaults to 'default'. */
  material?: SurfaceMaterial;
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
  /** When true, every unanchored hull vertex gets an individual home-spring
   *  pulling it toward its original rest world position. The platform stays
   *  rooted in place without per-vertex anchors, but each vertex remains
   *  fully dynamic and jellies locally. Composes with per-vertex anchors:
   *  anchored verts stay fully fixed; unanchored verts get a home-spring.
   *  Home-spring strength is scaled by `stiffness`. */
  pinned?: boolean;
  /** When true, the shape-match frame is locked to the platform's initial
   *  placement transform — the whole blob behaves like a wobbly mass on a
   *  global spring (no local jelly). Distinct from `pinned`: `pinned` gives
   *  per-vertex restoring force, `frameLocked` gives whole-body restoring
   *  force. They can be combined. */
  frameLocked?: boolean;
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
  /** Vestigial under the soft-blob interpretation — kept for back-compat with
   * old level files. Loader ignores this and treats the point ring as a
   * closed hull. */
  edges: PointShapeEdge[];
  /** Always true now (a point shape is a closed soft-body blob). Kept
   * optional in the schema so legacy files load. */
  closed?: boolean;
  /** Multiplier on spring/shape-match stiffness. Default 1.0. */
  stiffness?: number;
  /** Per-vertex home-spring pull — see SoftPlatformDef.pinned. */
  pinned?: boolean;
  /** Global shape-match frame lock (wobbly platform) — see
   *  SoftPlatformDef.frameLocked. */
  frameLocked?: boolean;
}

/** Where a chain end attaches. */
export type ChainAnchorRef =
  /** A pinned world point — loader creates a static particle there. */
  | { kind: 'fixed'; x: number; y: number }
  /** Attaches to the centroid of an existing blob entity. */
  | { kind: 'blob'; entity: 'npc' | 'softPlatform' | 'pointShape'; id: string };

export interface ChainDef {
  id: string;
  endpointA: ChainAnchorRef;
  endpointB: ChainAnchorRef;
  /** Target total rope length in world units. */
  totalLength: number;
  /** Max distance between adjacent chain particles. Default ~25. */
  maxSegmentLength?: number;
  /** Per-segment mass. Default 0.5. */
  segmentMass?: number;
  /** Per-segment collision radius. Default 10. */
  segmentRadius?: number;
  /** Chain-solver iterations per substep. Default 12. */
  iterations?: number;
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
  /** When true, NPC blobs cannot press this trigger — only player blobs
   *  count toward occupancy. Default false (NPCs can press). */
  ignoreNpcs?: boolean;
}

export type ActionEasing = 'linear' | 'easeInOut' | 'easeOut';
export type ActionMode = 'switch' | 'continuous' | 'oneShot' | 'timer';
export type RequireMode = 'any' | 'all';

export type ActionTarget =
  | { kind: 'shapePoint'; shapeId: string; pointIndex: number; endX: number; endY: number }
  /** Platform animation. `endX/endY` give the open-pose centre; optional
   *  `endRotation` (radians) gives the open-pose rotation — when absent
   *  the platform keeps its closed-pose rotation (translation-only). */
  | { kind: 'platform'; platformId: string; endX: number; endY: number; endRotation?: number }
  /** Move (and optionally rotate) a spike. `endX/endY` give the open-pose
   *  base position; optional `endRotation` (radians) the open-pose rotation.
   *  Lets a trigger drive a moving spike trap. */
  | { kind: 'spike'; spikeId: string; endX: number; endY: number; endRotation?: number }
  /** Rotate a whole point-shape hull around its REST centroid by
   *  `endRotation` radians. Lerped from 0 at closed pose. Anchored
   *  particles are skipped. */
  | { kind: 'rotateShape'; shapeId: string; endRotation: number }
  /** Translate an ENTIRE point-shape hull rigidly. `endX/endY` give the
   *  open-pose centroid; every (unanchored) vertex moves by the same delta
   *  from the rest centroid. Lets one target move a whole soft body instead
   *  of one shapePoint target per vertex. */
  | { kind: 'moveShape'; shapeId: string; endX: number; endY: number };

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
  /** For mode === 'timer' ONLY: seconds between cycle starts (open-then-close).
   *  Triggers are ignored in timer mode. Defaults to 4s if omitted. */
  intervalSeconds?: number;
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
