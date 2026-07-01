// The contract every softbody engine implements. Both the legacy
// TS float sim (`softBodyWorld.ts`) and the wasm-backed Rust integer
// sim (`softBodyWorldRust.ts`) satisfy this interface, and the rest
// of the game programs against it via `engineSelector.createSoftBodyEngine`.
//
// The interface intentionally mirrors the original SoftBodyWorld class
// surface — methods only, with the read-only properties exposed as
// getters or query methods. This lets us swap in the Rust engine
// without rewriting every call site (most of which talk to the engine
// through a `world: SoftBodyEngine` reference).
//
// Hot-path notes:
//   - `getPositions()` / `getVelocities()` are called per frame by the
//     renderer. They return fresh arrays — callers should treat them
//     as read-only snapshots, not as live references into engine state.
//   - For per-particle reads in tight loops, prefer the bulk getters
//     (one wasm call, then iterate the typed buffer locally).
//   - For per-particle writes (action-manager rewind), use the bulk
//     `setPositionsBulk(buf: Float64Array)` setter on engines that
//     expose it — see `BulkParticleSetter` below.

import { Vec2 } from './vec2';
import {
  BlobRange, BlobResult, GravityField, MaterialParams, PumpEdge,
  RayHit, Shape, StaticSurface, SurfaceMaterial, Transform2D,
} from './types';

export interface AddBlobFromHullParams {
  hullRestLocal: Vec2[];
  centerLocal?: Vec2;
  centerMass: number;
  hullMass: number;
  springK: number;
  springDamp: number;
  radialK: number;
  radialDamp: number;
  pressureK: number;
  shapeMatchK: number;
  shapeMatchDamp: number;
  worldOrigin: Vec2;
  sortKey?: string;
  staticHullIndices?: number[];
  staticCenter?: boolean;
  /** Lock the shape-match frame to (worldOrigin, identity). Whole blob
   *  stays rooted without per-vertex anchors. */
  pinFrame?: boolean;
}

export interface RopeChainOpts {
  totalLength: number;
  maxSegmentLength: number;
  segmentMass?: number;
  segmentRadius?: number;
  layer?: number;
  mask?: number;
  iterations?: number;
}

export interface RopeChainResult { particleIndices: number[]; }

export interface GroundContact {
  point: Vec2;
  normal: Vec2;
  poly: Vec2[] | null;
}

export interface StickyContact {
  count: number;
  normal: Vec2;
}

/** Debug-only snapshot of the per-substep crush check (`enforce_blob_integrity`). */
export interface CrushDebug {
  /** Touching opposing SOLID surfaces (static or soft); min normal·normal < -0.5. */
  sandwiched: boolean;
  /** Hull area below the crush ratio (< 20% of base). */
  compressed: boolean;
  /** Of the contacts, how many are with STATIC geometry (the rest are soft). */
  staticContacts: number;
  /** Most-opposing pair of contact normals (most negative dot; 1 = none opposing). */
  minDot: number;
  /** Engine's own cur_hull_area / base_rest_area — the value `compressed` thresholds (< 0.2). */
  areaRatio: number;
  /** Consecutive crushed substeps counted toward death. */
  violations: number;
}

/** RNG draws routed through the engine — same stream visible to both
 *  the engine and game code (powerups, spike spawns, AI). Mirrors
 *  `SeededRng` in lib/rng.ts so existing callers don't need to change. */
export interface EngineRng {
  next(): number;      // [0, 1)
  int(min: number, max: number): number;
  range(min: number, max: number): number;
  bool(): boolean;
  getState(): number;
  setState(state: number): void;
}

/** Engines that support a single-buffer bulk write — used by the
 *  action-manager rewind path so it can replace every particle position
 *  in one wasm call. The TS engine implements this trivially. */
export interface BulkParticleSetter {
  setPositionsBulk?(buf: Float64Array): void;
}

export interface SoftBodyEngine extends BulkParticleSetter {
  // ---- core loop ----
  step(delta: number): void;
  readonly tick: number;
  /** Cheap particle-count read. Doesn't allocate (unlike `.pos.length`
   *  on the wasm wrapper, which materializes a fresh Vec2[] each call). */
  particleCount(): number;

  // ---- read-only state snapshots (renderers / managers iterate these
  // each frame — TS sim exposes them directly; the Rust wrapper
  // materializes a fresh snapshot per access). ----
  readonly pos: readonly Vec2[];
  readonly vel: readonly Vec2[];
  readonly mass: readonly number[];
  readonly invMass: readonly number[];
  readonly blobRanges: readonly BlobRange[];
  readonly staticSurfaces: readonly StaticSurface[];
  readonly shapes: readonly Shape[];
  readonly fixedDt: number;

  // ---- per-particle writes (action-manager rewind, network snapshot) ----
  setParticlePos(i: number, x: number, y: number): void;
  setParticleVel(i: number, x: number, y: number): void;
  /** Override the logical tick counter — used by netcode keyframe restore. */
  setTick(t: number): void;

  // ---- world setup ----
  registerStaticPolygon(poly: Vec2[], material?: SurfaceMaterial, id?: string,
    opts?: { layer?: number; mask?: number }): StaticSurface;
  removeStaticSurface(surface: StaticSurface): void;
  clearStaticPolygons(): void;
  /** wasm index of a registered static surface (-1 if unknown). */
  staticSurfaceIndex(surface: StaticSurface): number;

  /** Push a static surface's mutated `poly` + `velocity` into the
   *  engine. No-op on the TS sim (the surface object IS the engine's
   *  copy, mutations apply instantly); required on the wasm engine
   *  where the JS-side surface is a separate object from the wasm
   *  state. Call after mutating `surface.poly[i].x|.y` or
   *  `surface.velocity`. */
  commitStaticSurface(surface: StaticSurface): void;
  registerTriggerPolygon(poly: Vec2[], gravityOverride?: Vec2 | GravityField): number;

  // ---- blob lifecycle ----
  addBlobFromHull(params: AddBlobFromHullParams): BlobResult;
  removeBlob(blobId: number): void;

  // ---- per-blob tuning ----
  setBlobSpringStiffnessScale(blobId: number, stiffnessScale: number, dampScale?: number): void;
  setBlobShapeMatchRestScale(blobId: number, s: number): void;
  setBlobRestLocal(blobId: number, restLocal: Vec2[]): void;
  /** Apply a squash + lean deformation to the blob's rest hull in
   *  engine-native fixed point. Replaces the JS-side
   *  `SlimeBlob.updateHullDeformation`: the engine derives the blob's
   *  rotation angle from shape-matching, rotates `gravityDir` into the
   *  blob-local frame, and writes the deformed rest pose all in i64
   *  Fx. Determinism guaranteed across wasm instances; the JS version
   *  used `Math.atan2/cos/sin` which are implementation-defined per
   *  ECMA and were the proven cause of cross-tab drift. */
  setBlobSquashLean(blobId: number, squash: number, lean: number, gravityDir: Vec2): void;
  setBlobMassScale(blobId: number, massScale: number): void;
  resetBlobMassScale(blobId: number): void;
  setBlobGravityOverride(blobId: number, gravity: Vec2 | null): void;

  // ---- per-blob mutation ----
  nudgeBlob(blobId: number, dx: number, dy: number): void;
  teleportBlob(blobId: number, target: Vec2): void;
  /** Rebuild a blob at its undeformed rest pose centred on `target`, with zero
   *  velocity and rest-scale reset to 1. Used for clean respawns. */
  resetBlobToRest(blobId: number, target: Vec2): void;
  zeroBlobVelocity(blobId: number): void;
  pinBlobToCurrentPose(blobId: number): void;
  unpinBlob(blobId: number): void;

  // ---- forces / impulses ----
  applyBlobMoveForce(blobId: number, move: Vec2, force: number, dt: number): void;
  applyBlobLinearVelocityDelta(blobId: number, deltaV: Vec2): void;
  /** Treadmill: set this blob's tread for the current step. `strength` (signed
   *  — sign picks the circulation direction) drives the visible hull-perimeter
   *  surface circulation. Purely visual — does not translate the body. Re-set
   *  each frame; cleared per step. */
  setBlobTread(blobId: number, strength: number): void;
  applyBlobExpand(blobId: number, expandForce: number): void;
  applyExternalForcePoint(i: number, f: Vec2): void;

  // ---- Phase 3 zone-force APIs ----
  // Foundation for engine-side dynamicItems / spike-zones / powerup
  // pickup detection (Phases 4-6 of the manager migration). All zone
  // queries + force application happen in i64 fixed point, so JS
  // doesn't need to read blob positions, do Math.* trig, and write
  // forces back in — eliminates a class of cross-instance drift risk.
  /** Find every blob whose centroid lies inside `polygon`. Returns
   *  blob IDs in ascending order. Polygon is flat `[x0,y0,x1,y1,…]`. */
  blobsOverlappingPolygon(polygon: Float64Array): Uint32Array;
  /** Apply a constant force vector to every blob inside `polygon`.
   *  Scales by `dt` internally. Use for wind zones, conveyors. */
  applyForceInPolygonUniform(polygon: Float64Array, fx: number, fy: number, dt: number): void;
  /** Apply a radial force (outward if strength > 0) from (cx,cy) to
   *  every blob inside `polygon` within `radius`. `falloff`: 0 =
   *  Linear, 1 = InverseSquare. Use for bumpers, wrecking-ball blasts. */
  applyForceInPolygonRadial(
    polygon: Float64Array,
    cx: number, cy: number,
    strength: number, radius: number,
    falloff: 0 | 1,
    dt: number,
  ): void;
  /** Velocity damping per hull particle for every blob in `polygon`:
   *  v *= (1 - coefficient*dt). Use for sticky goo, underwater drag. */
  applyForceInPolygonDrag(polygon: Float64Array, coefficient: number, dt: number): void;

  // ---- Phase 4 dynamic-item APIs ----
  // Register dynamic-item zones at level-load time. The engine's `step`
  // advances per-item timers + applies forces internally — no per-tick
  // JS work needed beyond rendering. Each add_* returns the item's
  // sequential index in the engine's list. The JS DynamicItemManager
  // is reduced to a thin loader (these calls) + visual state queries
  // (dynamicItemActive).
  addCannon(id: number, x: number, y: number, w: number, h: number, rotation: number): number;
  addCatapult(id: number, x: number, y: number, w: number, h: number): number;
  addBumper(id: number, x: number, y: number, radius: number): number;
  addWindZone(id: number, x: number, y: number, w: number, h: number, rotation: number): number;
  addGravityFlipper(id: number, x: number, y: number, w: number, h: number): number;
  addConveyor(id: number, x: number, y: number, w: number, h: number, direction: 1 | -1): number;
  addStickyGoo(id: number, x: number, y: number, w: number, h: number): number;
  addWreckingBall(id: number, x: number, y: number): number;
  clearDynamicItems(): void;
  dynamicItemCount(): number;
  /** Read the engine's visual `active` flag for an item. Returns true
   *  when the item is currently firing (cannon mid-blast, bumper
   *  just-fired, etc.). JS uses this to drive VFX/SFX. */
  dynamicItemActive(idx: number): boolean;

  // ---- Phase 5 spring-pad APIs ----
  /** Register a spring pad. The engine creates a kinematic
   *  static_surface for the plate and runs the loaded/firing/reloading
   *  state machine each step. `fireSpeedOverride <= 0` uses default. */
  addSpringPad(id: number, x: number, y: number, width: number, height: number, rotation: number, fireSpeedOverride: number): number;
  clearSpringPads(): void;
  springPadCount(): number;
  /** Pad state: 0 = Loaded, 1 = Firing, 2 = Reloading. */
  springPadState(idx: number): number;
  /** Plate retraction offset in world units. 0 = fully extended. */
  springPadOffset(idx: number): number;
  /** Drain pending fire events (gameplay IDs of pads that just
   *  transitioned loaded→firing). Use for VFX/SFX. */
  takeSpringPadFireEvents(): Uint32Array;

  // ---- Phase 6: blob roles + trigger charge machines ----
  /** Tag a blob's gameplay role (0 structural / 1 player / 2 npc) + stable slot id. */
  setBlobRole(blobId: number, role: number, gameplayId: number): void;
  addGameTrigger(id: number, shapeIdx: number, chargeSeconds: number, ignoreNpcs: boolean): number;
  clearGameTriggers(): void;
  triggerPressed(idx: number): boolean;
  triggerChargeProgress(idx: number): number;
  triggerPressedById(id: number): boolean;
  takeTriggerPressedEvents(): Uint32Array;
  takeTriggerReleasedEvents(): Uint32Array;

  // ---- Phase 7: actions ----
  addGameAction(id: number, mode: number, requireAll: boolean, easing: number, delay: number, duration: number, interval: number, sourceTriggerIds: Uint32Array | number[]): number;
  actionAddTargetShapePoint(actionIdx: number, particle: number, endX: number, endY: number): void;
  actionAddTargetMoveShape(actionIdx: number, particleIds: Uint32Array | number[], endX: number, endY: number): void;
  actionAddTargetRotateShape(actionIdx: number, particleIds: Uint32Array | number[], endRotation: number): void;
  actionAddTargetPlatform(actionIdx: number, staticIdx: number, baseX: number, baseY: number, baseRot: number, localPoly: number[], endX: number, endY: number, endRot: number): void;
  actionAddTargetSpike(actionIdx: number, spikeId: number, baseX: number, baseY: number, baseRot: number, endX: number, endY: number, endRot: number): void;
  clearGameActions(): void;
  gameActionState(idx: number): number;
  gameActionTargetPose(actionIdx: number, targetIdx: number): Float64Array;
  takeActionFireEvents(): Uint32Array;

  // ---- Phase 8: spikes / death / respawn ----
  setDeathMode(mode: number): void;
  addSpike(id: number, x: number, y: number, rot: number, w: number, h: number): number;
  addDeathZone(x: number, y: number, w: number, h: number): void;
  setKillBelowY(y: number, enabled: boolean): void;
  setSpawnPoints(flat: number[]): void;
  setSpikePose(spikeId: number, x: number, y: number, rot: number): void;
  respawnAll(): void;
  /** Place every active player blob on a distinct spawn point (by sorted
   *  gameplay_id rank), so a match/round never starts with players stacked. */
  spreadPlayersToSpawns(): void;
  killPlayerByBlobId(blobId: number): void;
  clearSpikes(): void;
  takeKillEvents(): Float64Array;
  isInvulnerable(gameplayId: number): boolean;
  isDead(gameplayId: number): boolean;
  deadPlayerRespawnTimer(gameplayId: number): number;
  deadPlayerDeathPos(gameplayId: number): Float64Array;
  spikeLivePose(idx: number): Float64Array;

  // ---- Phase 9: game-mode rules ----
  setGameMode(kind: number, timeLimit: number, targetScore: number): void;
  setGoalZone(x: number, y: number, w: number, h: number): void;
  addHillZone(x: number, y: number, w: number, h: number): void;
  setHillRotation(min: number, max: number): void;
  setModePlaying(playing: boolean): void;
  resetModeForRound(): void;
  modeWinner(): number;
  modeDecided(): boolean;
  modeGameTime(): number;
  modeTimeRemaining(): number;
  modeScore(gameplayId: number): number;
  modeScores(): Float64Array;
  kothActiveHill(): Float64Array;
  kothLastMoveTime(): number;
  kothKingId(): number;
  chainedAllReached(): boolean;

  // ---- network sync ----
  setBlobGroundContacts(blobId: number, count: number): void;
  getBlobGroundContacts(blobId: number): number;
  getBlobGroundContact(blobId: number): GroundContact | null;
  getBlobImpactContact(blobId: number): GroundContact | null;
  getBlobStickyContact(blobId: number): StickyContact;
  /** Per-hull-particle "touched a solid this step" bitmap, length = hull length, each entry 0|1. */
  getBlobParticleContacts(blobId: number): Uint8Array;
  /** Like getBlobParticleContacts but STATIC-only — the contact kind the crush/sandwich check counts. */
  getBlobParticleStaticContacts(blobId: number): Uint8Array;
  /** Debug readout of the per-substep crush check for the diagnostics overlay. */
  getBlobCrushDebug(blobId: number): CrushDebug;
  getBlobEffectiveGravity(blobId: number): Vec2;
  getBlobShapeMatchTargetHull(blobId: number): Vec2[];

  // ---- queries ----
  getPositions(): Vec2[];
  getVelocities(): Vec2[];
  getHullPolygon(blobId: number): Vec2[];
  getBlobCount(): number;
  /** Returns the contiguous particle index range owned by a blob and its hull indices. */
  getBlobRange(blobId: number): { start: number; end: number; hull: readonly number[] } | null;
  getSpringIndexPairs(): [number, number][];

  // ---- level-author additions ----
  addParticle(p: Vec2, v: Vec2, m: number, radius: number): number;
  addRopeChain(idxA: number, idxB: number, opts: RopeChainOpts): RopeChainResult;
  /**
   * Unilateral distance leash between two blobs. While their hull centroids are
   * within `slack` it does nothing (zero weight, free movement/jumps); past it
   * a pull of `min(stiffness * overshoot, maxForce)` is spread evenly across
   * every hull particle of both blobs, translating each as a whole.
   */
  addBlobTether(blobA: number, blobB: number, slack: number, stiffness: number, maxForce: number): void;
  /** Add a spring outside any blob (point shapes, ropes). */
  addExtraSpring(i: number, j: number, rest: number, k: number, damp: number): void;
  /** Pull a particle toward a fixed world-position with k/damp. */
  addHomeAnchor(idx: number, home: Vec2, k: number, damp: number): void;
  /** Hard max-distance constraint between two particles. Independent of
   * the chain solver — use when you need a rigid leash regardless of
   * mass ratios or segment count. */
  addDistanceMax(i: number, j: number, max: number): void;

  // ---- snapshots for the renderer ----
  /** Snapshot of every static surface — safe to iterate per frame. */
  getStaticSurfacesSnapshot(): readonly StaticSurface[];
  /** Snapshot of every shape (optionally excluding triggers). */
  getShapesSnapshot(includeTriggers?: boolean): readonly Shape[];

  // ---- RNG (game code consumes draws for AI / powerups / spike spawns) ----
  readonly rng: EngineRng;

  // ---- RNG seed reset (for netcode handshake / replay) ----
  setRngSeed(seed: number): void;

  // ---- trigger callbacks (single assignable property — game code
  // already chains by wrapping the prior value). ----
  onTriggerEntered?: ((shapeIdx: number, blobId: number) => void) | undefined;
  onTriggerExited?:  ((shapeIdx: number, blobId: number) => void) | undefined;

  /** Fired when the physics solver detects a blob has exploded — e.g.
   *  a platform crushed it against static geometry until the position
   *  solver lost control. Game-side handler converts this into a kill
   *  through the normal `spikeManager.killPlayer` path. Only the Rust
   *  engine emits these; the TS sim leaves this hook unimplemented. */
  onBlobCrushed?: ((blobId: number) => void) | undefined;

  // ---- determinism aid (Rust engine: FNV-1a of state; TS engine:
  // returns a string hash for development comparison). ----
  stateHash(): string;

  // ---- snapshot/restore (rollback netcode). The Rust engine returns
  // a binary buffer; the TS sim's stubs return an empty buffer and
  // accept-but-ignore restores (rollback is wasm-only). ----
  serializeState(): Uint8Array;
  restoreState(buf: Uint8Array): boolean;
}

/* Re-export types for callers that import everything from the engine module. */
export type {
  BlobRange, BlobResult, GravityField, MaterialParams, PumpEdge, RayHit,
  Shape, StaticSurface, SurfaceMaterial, Transform2D,
};
