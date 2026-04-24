import { Vec2 } from './vec2';

export type Spring = [i: number, j: number, rest: number, kBase: number, dampBase: number];

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
  triggerGravity: Vec2;
  centerIdx: number;
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
