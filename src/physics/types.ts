import { Vec2 } from './vec2';

export type Spring = [i: number, j: number, rest: number, kBase: number, dampBase: number];

export type SurfaceMaterial = 'default' | 'ice' | 'sticky' | 'bouncy';

export interface MaterialParams {
  restitution: number;
  frictionMu: number;
}

export interface StaticSurface {
  poly: Vec2[];
  material: SurfaceMaterial;
  id?: string;
  /** Kinematic surface velocity in world units/sec. When set, collision and CCD
   * resolve the contact in the surface frame so blobs in contact get carried
   * along (used by the spring-loaded plate). undefined ≡ stationary. */
  velocity?: Vec2;
  /** Bitmask collision layer this surface sits on. Defaults to LAYER_WORLD. */
  layer?: number;
  /** Bitmask of layers this surface accepts collisions from. Defaults to LAYER_ALL. */
  mask?: number;
}

/** Gravity vector field applied inside a trigger zone. */
export type GravityField =
  | { kind: 'uniform'; vector: Vec2 }
  | { kind: 'point'; center: Vec2; strength: number; falloff: 'linear' | 'inverseSquare' };

export interface BlobRange {
  id: number;
  start: number;
  end: number;
  hull: number[];
  shapeIdx: number;
  springBegin: number;
  springEnd: number;
  springStiffnessScale: number;
  springDampScale: number;
  /** Stable identifier used to sort blobs for order-sensitive iteration
   * (blob-blob collision pair traversal). For player blobs this is the
   * `playerId`; for NPCs the level-defined NPC id; for soft-platform
   * "blobs" the platform id. The local blob `id` (= array index) is NOT
   * the same on every client — host's PM and guest's PM insert players in
   * different orders, so `id=5` might be the host's player on one client
   * and the guest's player on the other. Iterating collision pairs by raw
   * `id` order would then process the same physical pair with the roles
   * reversed (which blob's hull gets pushed first), and a Gauss-Seidel
   * collision pass produces different positions depending on that role.
   * Sorting by `sortKey` makes the iteration order client-agnostic. */
  sortKey: string;
  /** Set by SoftBodyWorld.removeBlob(). All physics passes skip inactive ranges
   * so the blob's particles/springs/shape stay in the flat arrays (keeping every
   * other blob's indices stable) but contribute nothing to forces or collisions. */
  inactive?: boolean;
}

export interface Shape {
  indices: number[];
  staticPoly: Vec2[];
  isTrigger: boolean;
  isStatic: boolean;
  targetRestArea: number;
  pressureK: number;
  shapeMatchK: number;
  shapeMatchDamp: number;
  restLocal: Vec2[];
  shapeMatchRestScale: number;
  useFrameOverride: boolean;
  frameOverride: Transform2D;
  gravityField: GravityField | null;
  centerIdx: number;
  /** Mirrors BlobRange.inactive on the shape that backs an inactive blob. */
  inactive?: boolean;
  /** Bitmask collision layer this shape sits on. Defaults to LAYER_BLOB. */
  layer?: number;
  /** Bitmask of layers this shape accepts collisions from. Defaults to LAYER_ALL. */
  mask?: number;
}

export interface Transform2D {
  cos: number;
  sin: number;
  tx: number;
  ty: number;
}

export interface WorldConfig {
  gravity: Vec2;
  gravityScale: number;
  fixedDt: number;
  substeps: number;
  collisionMargin: number;
  collisionRestitution: number;
  constraintIters: number;
  staticRestitution: number;
  staticContactSlop: number;
  blobBlobFrictionMu: number;
  blobBlobFrictionImpulseScale: number;
  staticEdgeFrictionMu: number;
  staticFrictionMinTangSpeed: number;
  staticFrictionNormalLoadScale: number;
  hullVertexDampingPerSec: number;
  centerHullDampingPerSec: number;
  hullDampSkipAboveSpeed: number;
}

export interface BlobResult {
  blobId: number;
  centerIdx: number;
  hullIndices: number[];
  shapeIdx: number;
}

export interface PumpEdge {
  i0: number;
  i1: number;
  mid: Vec2;
  normal: Vec2;
  impulse: number;
}

export interface RayHit {
  hit: boolean;
  distance: number;
  position: Vec2;
  normal: Vec2;
}

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
