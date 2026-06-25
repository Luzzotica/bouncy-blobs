/* tslint:disable */
/* eslint-disable */

export class BlobHandle {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Hull particle indices as a typed array.
     */
    readonly hullIndices: Uint32Array;
    readonly blob_id: number;
    readonly center_idx: number;
    readonly shape_idx: number;
}

export class SoftBodyWorldHandle {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a blob from a hull (flat x,y,x,y,... rest-local coords).
     * `static_hull_indices` lists hull-local indices that should be
     * anchored (mass=0, immovable) — used by soft platforms to fix
     * corners/edges in place while the body deforms. Pass an empty
     * array for a fully-dynamic blob.
     * Returns a BlobHandle with the blob id + key particle indices.
     */
    addBlobFromHull(hull_rest_local: Float64Array, center_local_x: number, center_local_y: number, center_mass: number, hull_mass: number, spring_k: number, spring_damp: number, radial_k: number, radial_damp: number, pressure_k: number, shape_match_k: number, shape_match_damp: number, world_origin_x: number, world_origin_y: number, sort_key: string, static_hull_indices: Uint32Array, static_center: boolean, pin_frame: boolean): BlobHandle;
    /**
     * Unilateral distance leash between two blobs. See core `add_blob_tether`.
     */
    addBlobTether(blob_a: number, blob_b: number, slack: number, stiffness: number, max_force: number): void;
    addBumper(id: number, x: number, y: number, radius: number): number;
    addCannon(id: number, x: number, y: number, w: number, h: number, rotation: number): number;
    addCatapult(id: number, x: number, y: number, w: number, h: number): number;
    addConveyor(id: number, x: number, y: number, w: number, h: number, direction: number): number;
    /**
     * Hard max-distance constraint between two particles. Solved in
     * step 7 alongside welds and anchors, repeated `constraint_iters`
     * times. Use this for a real "rope length" cap that doesn't depend
     * on PBD propagation through dozens of chain segments.
     */
    addDistanceMax(idx_a: number, idx_b: number, max_dist: number): void;
    addExtraSpring(i: number, j: number, rest: number, k: number, damp: number): void;
    addGravityFlipper(id: number, x: number, y: number, w: number, h: number): number;
    addHomeAnchor(idx: number, home_x: number, home_y: number, k: number, damp: number): void;
    /**
     * Add a free particle (level loader uses this for ropes / point shapes).
     * Returns the new particle's index.
     */
    addParticle(px: number, py: number, vx: number, vy: number, mass: number, radius: number): number;
    /**
     * Build a rope between two existing particles. Returns the indices
     * of the newly-created interior segment particles (Uint32Array). See
     * the core `add_rope_chain` for parameter semantics.
     */
    addRopeChain(idx_a: number, idx_b: number, total_length: number, max_segment_length: number, segment_mass: number, segment_radius: number, layer: number, mask: number, iterations: number): Uint32Array;
    /**
     * Register a spring pad. The engine creates a kinematic
     * static_surface for the plate and runs the state machine each
     * step(). `fire_speed_override` of <=0 uses the default.
     */
    addSpringPad(id: number, x: number, y: number, width: number, height: number, rotation: number, fire_speed_override: number): number;
    addStickyGoo(id: number, x: number, y: number, w: number, h: number): number;
    addWindZone(id: number, x: number, y: number, w: number, h: number, rotation: number): number;
    addWreckingBall(id: number, x: number, y: number): number;
    applyBlobLinearVelocityDelta(blob_id: number, dvx: number, dvy: number): void;
    applyBlobMoveForce(blob_id: number, move_x: number, move_y: number, force: number, dt: number): void;
    applyExternalForcePoint(i: number, fx: number, fy: number): void;
    /**
     * Velocity damping for every hull particle of every blob in
     * `polygon`: v *= (1 - coefficient * dt). Use for sticky goo,
     * underwater drag.
     */
    applyForceInPolygonDrag(polygon: Float64Array, coefficient: number, dt: number): void;
    /**
     * Apply a radial force (outward if `strength` > 0, inward if < 0)
     * from `(cx,cy)` to every blob in `polygon` within `radius`.
     * `falloff`: 0 = Linear (mag * (1 - d/radius)), 1 = InverseSquare
     * ((radius/d)^2). Use for bumpers, wrecking-ball blasts, magnets.
     */
    applyForceInPolygonRadial(polygon: Float64Array, cx: number, cy: number, strength: number, radius: number, falloff: number, dt: number): void;
    /**
     * Apply a constant `(fx, fy)` force to every blob whose centroid
     * is inside `polygon`. Force scales by dt internally. Use for
     * wind zones, conveyors.
     */
    applyForceInPolygonUniform(polygon: Float64Array, fx: number, fy: number, dt: number): void;
    blobCenterIdx(blob_id: number): number;
    /**
     * Number of registered blobs.
     */
    blobCount(): number;
    blobIdForParticle(idx: number): number;
    /**
     * Find every blob whose centroid is inside `polygon`. Returns
     * blob_ids in ascending order. Polygon is a flat
     * `[x0,y0,x1,y1,…]` Float64Array.
     */
    blobsOverlappingPolygon(polygon: Float64Array): Uint32Array;
    clearDynamicItems(): void;
    clearSpringPads(): void;
    clearStaticPolygons(): void;
    /**
     * Read the visual `active` flag for item index `idx` — used by
     * JS-side renderers/SFX to fire VFX when an item is currently
     * firing (cannon mid-blast, bumper just-fired, etc.).
     */
    dynamicItemActive(idx: number): boolean;
    dynamicItemCount(): number;
    getBlobEffectiveGravity(blob_id: number): Float64Array;
    /**
     * Returns null if no contact this step, else a Float64Array [px,py,nx,ny].
     */
    getBlobGroundContact(blob_id: number): Float64Array | undefined;
    getBlobGroundContacts(blob_id: number): number;
    getBlobImpactContact(blob_id: number): Float64Array | undefined;
    /**
     * Per-particle "touched solid this step" bitmap, indexed in hull order.
     * Length equals the blob's hull length; each byte is 0 or 1.
     */
    getBlobParticleContacts(blob_id: number): Uint8Array;
    /**
     * Returns [start, end, hullLen, hull0, hull1, ...] as a Uint32Array.
     * Empty array if blob_id is out of bounds.
     */
    getBlobRange(blob_id: number): Uint32Array;
    /**
     * Flat (x,y,x,y,...) buffer of the shape-match target positions for
     * the blob's hull. Empty array if no shape matching active.
     */
    getBlobShapeMatchTargetHull(blob_id: number): Float64Array;
    /**
     * Returns [count, normalX, normalY].
     */
    getBlobStickyContact(blob_id: number): Float64Array;
    /**
     * Flat (x,y,x,y,...) buffer of the blob's hull polygon in CCW order.
     */
    getHullPolygon(blob_id: number): Float64Array;
    /**
     * Per-particle inverse mass (0 = anchored / static). Managers read this
     * to tell pinned points from dynamic ones (e.g. ActionManager skips
     * anchored targets).
     */
    getInvMass(): Float64Array;
    /**
     * Read a single particle position as (x, y) into a 2-element f64 array.
     */
    getParticlePos(i: number): Float64Array;
    getParticleVel(i: number): Float64Array;
    /**
     * Flat (x0,y0,x1,y1,...) buffer of all particle positions.
     */
    getPositions(): Float64Array;
    /**
     * Flat (i,j,i,j,...) buffer of spring index pairs (debug viz).
     */
    getSpringIndexPairs(): Uint32Array;
    getVelocities(): Float64Array;
    /**
     * Construct a new world.
     *
     * `gravity_y` is positive-down (matches the rest of the engine).
     * All scalars are passed as `f64` and rounded into Fx at the boundary.
     */
    constructor(rng_seed: number, gravity_x: number, gravity_y: number, substeps: number);
    nudgeBlob(blob_id: number, dx: number, dy: number): void;
    /**
     * Total particle count (across all blobs + extras).
     */
    particleCount(): number;
    pinBlobToCurrentPose(blob_id: number): void;
    /**
     * Register a static (immovable) collision polygon. `points` is a
     * flat (x0,y0,x1,y1,...) buffer in world units. `material_id`:
     * 0 default, 1 ice, 2 sticky, 3 bouncy.
     */
    registerStaticPolygon(points: Float64Array, material_id: number): number;
    /**
     * Register a point-attractor trigger.
     */
    registerTriggerPointGravity(points: Float64Array, center_x: number, center_y: number, strength: number, inverse_square: boolean): number;
    /**
     * Register a trigger zone. `gravity_x`/`gravity_y` of NaN means no
     * gravity override (just an enter/exit sensor).
     */
    registerTriggerPolygon(points: Float64Array, gravity_x: number, gravity_y: number): number;
    removeBlob(blob_id: number): void;
    removeStaticSurface(idx: number): void;
    resetBlobMassScale(blob_id: number): void;
    resetBlobToRest(blob_id: number, x: number, y: number): void;
    /**
     * Restore state from a buffer produced by `serializeState`. Returns
     * true on success; false if the buffer is malformed or world layout
     * (particle/blob/shape/static-surface counts) doesn't match.
     */
    restoreState(buf: Uint8Array): boolean;
    /**
     * Mirrors the TS `rng.next()` — uniform in [0, 1). Consumes one RNG draw.
     */
    rngNextUnit(): number;
    rngState(): number;
    /**
     * Capture full mutable engine state to a binary buffer. Used by
     * the rollback netcode controller to checkpoint each tick. See
     * `softbody::snapshot` for the binary format.
     */
    serializeState(): Uint8Array;
    setBlobGravityOverride(blob_id: number, gx: number, gy: number, clear: boolean): void;
    setBlobGroundContacts(blob_id: number, count: number): void;
    setBlobMassScale(blob_id: number, scale: number): void;
    setBlobRestLocal(blob_id: number, rest_local: Float64Array): void;
    setBlobShapeMatchRestScale(blob_id: number, s: number): void;
    setBlobSpringStiffnessScale(blob_id: number, stiffness: number, damp: number): void;
    /**
     * Engine-side hull squash + lean deformation. Replaces the JS
     * `SlimeBlob.updateHullDeformation` (which called Math.atan2 +
     * Math.cos/sin per tick — implementation-defined floats that drift
     * between V8 instances). All trig now runs against deterministic
     * integer LUTs inside the engine.
     */
    setBlobSquashLean(blob_id: number, squash: number, lean: number, gravity_x: number, gravity_y: number): void;
    setBlobTread(blob_id: number, strength: number): void;
    setParticlePos(i: number, x: number, y: number): void;
    setParticleVel(i: number, x: number, y: number): void;
    /**
     * Bulk-replace positions from a flat (x0,y0,...) f64 buffer. Used by
     * the action-manager rewind path — one wasm call per rewind instead
     * of one per particle.
     */
    setPositionsBulk(buf: Float64Array): void;
    /**
     * Override the world's RNG seed mid-flight. Should only be called
     * before any step() — changing the seed mid-sim diverges immediately.
     */
    setRngSeed(seed: number): void;
    setRngState(s: number): void;
    /**
     * Override the logical tick — used by the guest's keyframe restore
     * path to align local sim time with the host's authoritative tick.
     */
    setTick(t: number): void;
    setVelocitiesBulk(buf: Float64Array): void;
    /**
     * Returns a packed buffer of shapes. Format per shape:
     *   [shape_idx, flags, gravKind, gx_or_cx, gy_or_cy, strength, point_count, x0, y0, ...]
     * flags: bit0=is_trigger, bit1=is_static, bit2=inactive
     * gravKind: 0=none, 1=uniform, 2=point-linear, 3=point-inverse-square
     * For uniform: gx_or_cx/gy_or_cy = vector; strength ignored.
     * For point: gx_or_cx/gy_or_cy = center; strength = strength.
     */
    shapesSnapshot(include_triggers: boolean): Float64Array;
    springPadCount(): number;
    /**
     * Current plate retraction offset in world units. 0 = fully extended.
     */
    springPadOffset(idx: number): number;
    /**
     * Returns the spring pad's state: 0 = Loaded, 1 = Firing, 2 = Reloading.
     */
    springPadState(idx: number): number;
    /**
     * FNV-1a 64-bit hash of every (pos.raw, vel.raw) i64 in the sim.
     * Two clients with the same state arrays produce the same hash.
     * Useful for cheap divergence checks in netplay.
     */
    stateHash(): bigint;
    /**
     * Returns a packed buffer of static surfaces. Format:
     *   for each surface: [material_id, point_count, x0, y0, x1, y1, ...]
     * Caller walks the buffer using `point_count` to find surface boundaries.
     */
    staticSurfacesSnapshot(): Float64Array;
    /**
     * Advance the simulation by `delta_seconds`. Internally clamped to
     * [1/240, 1/20] and run for `substeps` substeps.
     */
    step(delta_seconds: number): void;
    /**
     * Drain pending crush events. Returns a flat array of blob_ids
     * whose physics state exploded during the most recent `step()` —
     * typically a blob crushed between a moving platform and static
     * geometry. The game wrapper turns each id into a player kill.
     */
    takeCrushEvents(): Uint32Array;
    /**
     * Drain pending fire events (gameplay IDs of pads that
     * transitioned loaded→firing this step). JS uses these to spawn
     * VFX/SFX.
     */
    takeSpringPadFireEvents(): Uint32Array;
    /**
     * Drain pending trigger-entered events. Returns flat (shape_idx, blob_id) pairs.
     */
    takeTriggerEntered(): Uint32Array;
    takeTriggerExited(): Uint32Array;
    teleportBlob(blob_id: number, x: number, y: number): void;
    unpinBlob(blob_id: number): void;
    /**
     * Replace a static surface's polygon. `velocity_x` / `velocity_y` are
     * the kinematic carry velocity (used by PlatformMover so blobs sitting
     * on the platform get pushed along); pass `has_velocity = false` to
     * clear the velocity slot.
     */
    updateStaticSurface(idx: number, new_poly: Float64Array, velocity_x: number, velocity_y: number, has_velocity: boolean): void;
    zeroBlobVelocity(blob_id: number): void;
    /**
     * Logical tick counter — increments once per `step()`.
     */
    readonly tick: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_blobhandle_free: (a: number, b: number) => void;
    readonly __wbg_get_blobhandle_blob_id: (a: number) => number;
    readonly __wbg_get_blobhandle_center_idx: (a: number) => number;
    readonly __wbg_get_blobhandle_shape_idx: (a: number) => number;
    readonly __wbg_softbodyworldhandle_free: (a: number, b: number) => void;
    readonly blobhandle_hullIndices: (a: number) => number;
    readonly softbodyworldhandle_addBlobFromHull: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number) => number;
    readonly softbodyworldhandle_addBlobTether: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_addBumper: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly softbodyworldhandle_addCannon: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly softbodyworldhandle_addCatapult: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly softbodyworldhandle_addConveyor: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly softbodyworldhandle_addDistanceMax: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_addExtraSpring: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_addGravityFlipper: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly softbodyworldhandle_addHomeAnchor: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_addParticle: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly softbodyworldhandle_addRopeChain: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => number;
    readonly softbodyworldhandle_addSpringPad: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly softbodyworldhandle_addStickyGoo: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly softbodyworldhandle_addWindZone: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly softbodyworldhandle_addWreckingBall: (a: number, b: number, c: number, d: number) => number;
    readonly softbodyworldhandle_applyBlobLinearVelocityDelta: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_applyBlobMoveForce: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_applyExternalForcePoint: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_applyForceInPolygonDrag: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly softbodyworldhandle_applyForceInPolygonRadial: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly softbodyworldhandle_applyForceInPolygonUniform: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_blobCenterIdx: (a: number, b: number) => number;
    readonly softbodyworldhandle_blobCount: (a: number) => number;
    readonly softbodyworldhandle_blobIdForParticle: (a: number, b: number) => number;
    readonly softbodyworldhandle_blobsOverlappingPolygon: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_clearDynamicItems: (a: number) => void;
    readonly softbodyworldhandle_clearSpringPads: (a: number) => void;
    readonly softbodyworldhandle_clearStaticPolygons: (a: number) => void;
    readonly softbodyworldhandle_dynamicItemActive: (a: number, b: number) => number;
    readonly softbodyworldhandle_dynamicItemCount: (a: number) => number;
    readonly softbodyworldhandle_getBlobEffectiveGravity: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobGroundContact: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobGroundContacts: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobImpactContact: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobParticleContacts: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobRange: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobShapeMatchTargetHull: (a: number, b: number) => number;
    readonly softbodyworldhandle_getBlobStickyContact: (a: number, b: number) => number;
    readonly softbodyworldhandle_getHullPolygon: (a: number, b: number) => number;
    readonly softbodyworldhandle_getInvMass: (a: number) => number;
    readonly softbodyworldhandle_getParticlePos: (a: number, b: number) => number;
    readonly softbodyworldhandle_getParticleVel: (a: number, b: number) => number;
    readonly softbodyworldhandle_getPositions: (a: number) => number;
    readonly softbodyworldhandle_getSpringIndexPairs: (a: number) => number;
    readonly softbodyworldhandle_getVelocities: (a: number) => number;
    readonly softbodyworldhandle_new: (a: number, b: number, c: number, d: number) => number;
    readonly softbodyworldhandle_nudgeBlob: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_particleCount: (a: number) => number;
    readonly softbodyworldhandle_pinBlobToCurrentPose: (a: number, b: number) => void;
    readonly softbodyworldhandle_registerStaticPolygon: (a: number, b: number, c: number, d: number) => number;
    readonly softbodyworldhandle_registerTriggerPointGravity: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly softbodyworldhandle_registerTriggerPolygon: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly softbodyworldhandle_removeBlob: (a: number, b: number) => void;
    readonly softbodyworldhandle_removeStaticSurface: (a: number, b: number) => void;
    readonly softbodyworldhandle_resetBlobMassScale: (a: number, b: number) => void;
    readonly softbodyworldhandle_resetBlobToRest: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_restoreState: (a: number, b: number, c: number) => number;
    readonly softbodyworldhandle_rngNextUnit: (a: number) => number;
    readonly softbodyworldhandle_rngState: (a: number) => number;
    readonly softbodyworldhandle_serializeState: (a: number) => number;
    readonly softbodyworldhandle_setBlobGravityOverride: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly softbodyworldhandle_setBlobGroundContacts: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_setBlobMassScale: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_setBlobRestLocal: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_setBlobShapeMatchRestScale: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_setBlobSpringStiffnessScale: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_setBlobSquashLean: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly softbodyworldhandle_setBlobTread: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_setParticlePos: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_setParticleVel: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_setPositionsBulk: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_setRngSeed: (a: number, b: number) => void;
    readonly softbodyworldhandle_setRngState: (a: number, b: number) => void;
    readonly softbodyworldhandle_setTick: (a: number, b: number) => void;
    readonly softbodyworldhandle_setVelocitiesBulk: (a: number, b: number, c: number) => void;
    readonly softbodyworldhandle_shapesSnapshot: (a: number, b: number) => number;
    readonly softbodyworldhandle_springPadCount: (a: number) => number;
    readonly softbodyworldhandle_springPadOffset: (a: number, b: number) => number;
    readonly softbodyworldhandle_springPadState: (a: number, b: number) => number;
    readonly softbodyworldhandle_stateHash: (a: number) => bigint;
    readonly softbodyworldhandle_staticSurfacesSnapshot: (a: number) => number;
    readonly softbodyworldhandle_step: (a: number, b: number) => void;
    readonly softbodyworldhandle_takeCrushEvents: (a: number) => number;
    readonly softbodyworldhandle_takeSpringPadFireEvents: (a: number, b: number) => void;
    readonly softbodyworldhandle_takeTriggerEntered: (a: number) => number;
    readonly softbodyworldhandle_takeTriggerExited: (a: number) => number;
    readonly softbodyworldhandle_teleportBlob: (a: number, b: number, c: number, d: number) => void;
    readonly softbodyworldhandle_tick: (a: number) => number;
    readonly softbodyworldhandle_unpinBlob: (a: number, b: number) => void;
    readonly softbodyworldhandle_updateStaticSurface: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly softbodyworldhandle_zeroBlobVelocity: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
