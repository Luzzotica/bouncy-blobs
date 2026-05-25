/* @ts-self-types="./softbody_wasm.d.ts" */

export class BlobHandle {
    static __wrap(ptr) {
        const obj = Object.create(BlobHandle.prototype);
        obj.__wbg_ptr = ptr;
        BlobHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BlobHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_blobhandle_free(ptr, 0);
    }
    /**
     * Hull particle indices as a typed array.
     * @returns {Uint32Array}
     */
    get hullIndices() {
        const ret = wasm.blobhandle_hullIndices(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {number}
     */
    get blob_id() {
        const ret = wasm.__wbg_get_blobhandle_blob_id(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get center_idx() {
        const ret = wasm.__wbg_get_blobhandle_center_idx(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get shape_idx() {
        const ret = wasm.__wbg_get_blobhandle_shape_idx(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) BlobHandle.prototype[Symbol.dispose] = BlobHandle.prototype.free;

export class SoftBodyWorldHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SoftBodyWorldHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_softbodyworldhandle_free(ptr, 0);
    }
    /**
     * Add a blob from a hull (flat x,y,x,y,... rest-local coords).
     * `static_hull_indices` lists hull-local indices that should be
     * anchored (mass=0, immovable) — used by soft platforms to fix
     * corners/edges in place while the body deforms. Pass an empty
     * array for a fully-dynamic blob.
     * Returns a BlobHandle with the blob id + key particle indices.
     * @param {Float64Array} hull_rest_local
     * @param {number} center_local_x
     * @param {number} center_local_y
     * @param {number} center_mass
     * @param {number} hull_mass
     * @param {number} spring_k
     * @param {number} spring_damp
     * @param {number} radial_k
     * @param {number} radial_damp
     * @param {number} pressure_k
     * @param {number} shape_match_k
     * @param {number} shape_match_damp
     * @param {number} world_origin_x
     * @param {number} world_origin_y
     * @param {string} sort_key
     * @param {Uint32Array} static_hull_indices
     * @param {boolean} static_center
     * @returns {BlobHandle}
     */
    addBlobFromHull(hull_rest_local, center_local_x, center_local_y, center_mass, hull_mass, spring_k, spring_damp, radial_k, radial_damp, pressure_k, shape_match_k, shape_match_damp, world_origin_x, world_origin_y, sort_key, static_hull_indices, static_center) {
        const ptr0 = passArrayF64ToWasm0(hull_rest_local, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(sort_key, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(static_hull_indices, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.softbodyworldhandle_addBlobFromHull(this.__wbg_ptr, ptr0, len0, center_local_x, center_local_y, center_mass, hull_mass, spring_k, spring_damp, radial_k, radial_damp, pressure_k, shape_match_k, shape_match_damp, world_origin_x, world_origin_y, ptr1, len1, ptr2, len2, static_center);
        return BlobHandle.__wrap(ret);
    }
    /**
     * @param {number} i
     * @param {number} j
     * @param {number} rest
     * @param {number} k
     * @param {number} damp
     */
    addExtraSpring(i, j, rest, k, damp) {
        wasm.softbodyworldhandle_addExtraSpring(this.__wbg_ptr, i, j, rest, k, damp);
    }
    /**
     * @param {number} idx
     * @param {number} home_x
     * @param {number} home_y
     * @param {number} k
     * @param {number} damp
     */
    addHomeAnchor(idx, home_x, home_y, k, damp) {
        wasm.softbodyworldhandle_addHomeAnchor(this.__wbg_ptr, idx, home_x, home_y, k, damp);
    }
    /**
     * Add a free particle (level loader uses this for ropes / point shapes).
     * Returns the new particle's index.
     * @param {number} px
     * @param {number} py
     * @param {number} vx
     * @param {number} vy
     * @param {number} mass
     * @param {number} radius
     * @returns {number}
     */
    addParticle(px, py, vx, vy, mass, radius) {
        const ret = wasm.softbodyworldhandle_addParticle(this.__wbg_ptr, px, py, vx, vy, mass, radius);
        return ret >>> 0;
    }
    /**
     * Build a rope between two existing particles. Returns the indices
     * of the newly-created interior segment particles (Uint32Array). See
     * the core `add_rope_chain` for parameter semantics.
     * @param {number} idx_a
     * @param {number} idx_b
     * @param {number} total_length
     * @param {number} max_segment_length
     * @param {number} segment_mass
     * @param {number} segment_radius
     * @param {number} layer
     * @param {number} mask
     * @param {number} iterations
     * @returns {Uint32Array}
     */
    addRopeChain(idx_a, idx_b, total_length, max_segment_length, segment_mass, segment_radius, layer, mask, iterations) {
        const ret = wasm.softbodyworldhandle_addRopeChain(this.__wbg_ptr, idx_a, idx_b, total_length, max_segment_length, segment_mass, segment_radius, layer, mask, iterations);
        return takeObject(ret);
    }
    /**
     * @param {number} blob_id
     * @param {number} dvx
     * @param {number} dvy
     */
    applyBlobLinearVelocityDelta(blob_id, dvx, dvy) {
        wasm.softbodyworldhandle_applyBlobLinearVelocityDelta(this.__wbg_ptr, blob_id, dvx, dvy);
    }
    /**
     * @param {number} blob_id
     * @param {number} move_x
     * @param {number} move_y
     * @param {number} force
     * @param {number} dt
     */
    applyBlobMoveForce(blob_id, move_x, move_y, force, dt) {
        wasm.softbodyworldhandle_applyBlobMoveForce(this.__wbg_ptr, blob_id, move_x, move_y, force, dt);
    }
    /**
     * @param {number} i
     * @param {number} fx
     * @param {number} fy
     */
    applyExternalForcePoint(i, fx, fy) {
        wasm.softbodyworldhandle_applyExternalForcePoint(this.__wbg_ptr, i, fx, fy);
    }
    /**
     * @param {number} blob_id
     * @returns {number}
     */
    blobCenterIdx(blob_id) {
        const ret = wasm.softbodyworldhandle_blobCenterIdx(this.__wbg_ptr, blob_id);
        return ret;
    }
    /**
     * Number of registered blobs.
     * @returns {number}
     */
    blobCount() {
        const ret = wasm.softbodyworldhandle_blobCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} idx
     * @returns {number}
     */
    blobIdForParticle(idx) {
        const ret = wasm.softbodyworldhandle_blobIdForParticle(this.__wbg_ptr, idx);
        return ret;
    }
    clearStaticPolygons() {
        wasm.softbodyworldhandle_clearStaticPolygons(this.__wbg_ptr);
    }
    /**
     * @param {number} blob_id
     * @returns {Float64Array}
     */
    getBlobEffectiveGravity(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobEffectiveGravity(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Returns null if no contact this step, else a Float64Array [px,py,nx,ny].
     * @param {number} blob_id
     * @returns {Float64Array | undefined}
     */
    getBlobGroundContact(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobGroundContact(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * @param {number} blob_id
     * @returns {number}
     */
    getBlobGroundContacts(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobGroundContacts(this.__wbg_ptr, blob_id);
        return ret;
    }
    /**
     * @param {number} blob_id
     * @returns {Float64Array | undefined}
     */
    getBlobImpactContact(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobImpactContact(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Returns [start, end, hullLen, hull0, hull1, ...] as a Uint32Array.
     * Empty array if blob_id is out of bounds.
     * @param {number} blob_id
     * @returns {Uint32Array}
     */
    getBlobRange(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobRange(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Flat (x,y,x,y,...) buffer of the shape-match target positions for
     * the blob's hull. Empty array if no shape matching active.
     * @param {number} blob_id
     * @returns {Float64Array}
     */
    getBlobShapeMatchTargetHull(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobShapeMatchTargetHull(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Returns [count, normalX, normalY].
     * @param {number} blob_id
     * @returns {Float64Array}
     */
    getBlobStickyContact(blob_id) {
        const ret = wasm.softbodyworldhandle_getBlobStickyContact(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Flat (x,y,x,y,...) buffer of the blob's hull polygon in CCW order.
     * @param {number} blob_id
     * @returns {Float64Array}
     */
    getHullPolygon(blob_id) {
        const ret = wasm.softbodyworldhandle_getHullPolygon(this.__wbg_ptr, blob_id);
        return takeObject(ret);
    }
    /**
     * Read a single particle position as (x, y) into a 2-element f64 array.
     * @param {number} i
     * @returns {Float64Array}
     */
    getParticlePos(i) {
        const ret = wasm.softbodyworldhandle_getParticlePos(this.__wbg_ptr, i);
        return takeObject(ret);
    }
    /**
     * @param {number} i
     * @returns {Float64Array}
     */
    getParticleVel(i) {
        const ret = wasm.softbodyworldhandle_getParticleVel(this.__wbg_ptr, i);
        return takeObject(ret);
    }
    /**
     * Flat (x0,y0,x1,y1,...) buffer of all particle positions.
     * @returns {Float64Array}
     */
    getPositions() {
        const ret = wasm.softbodyworldhandle_getPositions(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Flat (i,j,i,j,...) buffer of spring index pairs (debug viz).
     * @returns {Uint32Array}
     */
    getSpringIndexPairs() {
        const ret = wasm.softbodyworldhandle_getSpringIndexPairs(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {Float64Array}
     */
    getVelocities() {
        const ret = wasm.softbodyworldhandle_getVelocities(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Construct a new world.
     *
     * `gravity_y` is positive-down (matches the rest of the engine).
     * All scalars are passed as `f64` and rounded into Fx at the boundary.
     * @param {number} rng_seed
     * @param {number} gravity_x
     * @param {number} gravity_y
     * @param {number} substeps
     */
    constructor(rng_seed, gravity_x, gravity_y, substeps) {
        const ret = wasm.softbodyworldhandle_new(rng_seed, gravity_x, gravity_y, substeps);
        this.__wbg_ptr = ret;
        SoftBodyWorldHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} blob_id
     * @param {number} dx
     * @param {number} dy
     */
    nudgeBlob(blob_id, dx, dy) {
        wasm.softbodyworldhandle_nudgeBlob(this.__wbg_ptr, blob_id, dx, dy);
    }
    /**
     * Total particle count (across all blobs + extras).
     * @returns {number}
     */
    particleCount() {
        const ret = wasm.softbodyworldhandle_particleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} blob_id
     */
    pinBlobToCurrentPose(blob_id) {
        wasm.softbodyworldhandle_pinBlobToCurrentPose(this.__wbg_ptr, blob_id);
    }
    /**
     * Register a static (immovable) collision polygon. `points` is a
     * flat (x0,y0,x1,y1,...) buffer in world units. `material_id`:
     * 0 default, 1 ice, 2 sticky, 3 bouncy.
     * @param {Float64Array} points
     * @param {number} material_id
     * @returns {number}
     */
    registerStaticPolygon(points, material_id) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.softbodyworldhandle_registerStaticPolygon(this.__wbg_ptr, ptr0, len0, material_id);
        return ret >>> 0;
    }
    /**
     * Register a point-attractor trigger.
     * @param {Float64Array} points
     * @param {number} center_x
     * @param {number} center_y
     * @param {number} strength
     * @param {boolean} inverse_square
     * @returns {number}
     */
    registerTriggerPointGravity(points, center_x, center_y, strength, inverse_square) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.softbodyworldhandle_registerTriggerPointGravity(this.__wbg_ptr, ptr0, len0, center_x, center_y, strength, inverse_square);
        return ret >>> 0;
    }
    /**
     * Register a trigger zone. `gravity_x`/`gravity_y` of NaN means no
     * gravity override (just an enter/exit sensor).
     * @param {Float64Array} points
     * @param {number} gravity_x
     * @param {number} gravity_y
     * @returns {number}
     */
    registerTriggerPolygon(points, gravity_x, gravity_y) {
        const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.softbodyworldhandle_registerTriggerPolygon(this.__wbg_ptr, ptr0, len0, gravity_x, gravity_y);
        return ret >>> 0;
    }
    /**
     * @param {number} blob_id
     */
    removeBlob(blob_id) {
        wasm.softbodyworldhandle_removeBlob(this.__wbg_ptr, blob_id);
    }
    /**
     * @param {number} idx
     */
    removeStaticSurface(idx) {
        wasm.softbodyworldhandle_removeStaticSurface(this.__wbg_ptr, idx);
    }
    /**
     * @param {number} blob_id
     */
    resetBlobMassScale(blob_id) {
        wasm.softbodyworldhandle_resetBlobMassScale(this.__wbg_ptr, blob_id);
    }
    /**
     * Mirrors the TS `rng.next()` — uniform in [0, 1). Consumes one RNG draw.
     * @returns {number}
     */
    rngNextUnit() {
        const ret = wasm.softbodyworldhandle_rngNextUnit(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    rngState() {
        const ret = wasm.softbodyworldhandle_rngState(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} blob_id
     * @param {number} gx
     * @param {number} gy
     * @param {boolean} clear
     */
    setBlobGravityOverride(blob_id, gx, gy, clear) {
        wasm.softbodyworldhandle_setBlobGravityOverride(this.__wbg_ptr, blob_id, gx, gy, clear);
    }
    /**
     * @param {number} blob_id
     * @param {number} count
     */
    setBlobGroundContacts(blob_id, count) {
        wasm.softbodyworldhandle_setBlobGroundContacts(this.__wbg_ptr, blob_id, count);
    }
    /**
     * @param {number} blob_id
     * @param {number} scale
     */
    setBlobMassScale(blob_id, scale) {
        wasm.softbodyworldhandle_setBlobMassScale(this.__wbg_ptr, blob_id, scale);
    }
    /**
     * @param {number} blob_id
     * @param {Float64Array} rest_local
     */
    setBlobRestLocal(blob_id, rest_local) {
        const ptr0 = passArrayF64ToWasm0(rest_local, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.softbodyworldhandle_setBlobRestLocal(this.__wbg_ptr, blob_id, ptr0, len0);
    }
    /**
     * @param {number} blob_id
     * @param {number} s
     */
    setBlobShapeMatchRestScale(blob_id, s) {
        wasm.softbodyworldhandle_setBlobShapeMatchRestScale(this.__wbg_ptr, blob_id, s);
    }
    /**
     * @param {number} blob_id
     * @param {number} stiffness
     * @param {number} damp
     */
    setBlobSpringStiffnessScale(blob_id, stiffness, damp) {
        wasm.softbodyworldhandle_setBlobSpringStiffnessScale(this.__wbg_ptr, blob_id, stiffness, damp);
    }
    /**
     * @param {number} i
     * @param {number} x
     * @param {number} y
     */
    setParticlePos(i, x, y) {
        wasm.softbodyworldhandle_setParticlePos(this.__wbg_ptr, i, x, y);
    }
    /**
     * @param {number} i
     * @param {number} x
     * @param {number} y
     */
    setParticleVel(i, x, y) {
        wasm.softbodyworldhandle_setParticleVel(this.__wbg_ptr, i, x, y);
    }
    /**
     * Bulk-replace positions from a flat (x0,y0,...) f64 buffer. Used by
     * the action-manager rewind path — one wasm call per rewind instead
     * of one per particle.
     * @param {Float64Array} buf
     */
    setPositionsBulk(buf) {
        const ptr0 = passArrayF64ToWasm0(buf, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.softbodyworldhandle_setPositionsBulk(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Override the world's RNG seed mid-flight. Should only be called
     * before any step() — changing the seed mid-sim diverges immediately.
     * @param {number} seed
     */
    setRngSeed(seed) {
        wasm.softbodyworldhandle_setRngSeed(this.__wbg_ptr, seed);
    }
    /**
     * @param {number} s
     */
    setRngState(s) {
        wasm.softbodyworldhandle_setRngState(this.__wbg_ptr, s);
    }
    /**
     * Override the logical tick — used by the guest's keyframe restore
     * path to align local sim time with the host's authoritative tick.
     * @param {number} t
     */
    setTick(t) {
        wasm.softbodyworldhandle_setTick(this.__wbg_ptr, t);
    }
    /**
     * @param {Float64Array} buf
     */
    setVelocitiesBulk(buf) {
        const ptr0 = passArrayF64ToWasm0(buf, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.softbodyworldhandle_setVelocitiesBulk(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Returns a packed buffer of shapes. Format per shape:
     *   [shape_idx, flags, gravKind, gx_or_cx, gy_or_cy, strength, point_count, x0, y0, ...]
     * flags: bit0=is_trigger, bit1=is_static, bit2=inactive
     * gravKind: 0=none, 1=uniform, 2=point-linear, 3=point-inverse-square
     * For uniform: gx_or_cx/gy_or_cy = vector; strength ignored.
     * For point: gx_or_cx/gy_or_cy = center; strength = strength.
     * @param {boolean} include_triggers
     * @returns {Float64Array}
     */
    shapesSnapshot(include_triggers) {
        const ret = wasm.softbodyworldhandle_shapesSnapshot(this.__wbg_ptr, include_triggers);
        return takeObject(ret);
    }
    /**
     * FNV-1a 64-bit hash of every (pos.raw, vel.raw) i64 in the sim.
     * Two clients with the same state arrays produce the same hash.
     * Useful for cheap divergence checks in netplay.
     * @returns {bigint}
     */
    stateHash() {
        const ret = wasm.softbodyworldhandle_stateHash(this.__wbg_ptr);
        return BigInt.asUintN(64, ret);
    }
    /**
     * Returns a packed buffer of static surfaces. Format:
     *   for each surface: [material_id, point_count, x0, y0, x1, y1, ...]
     * Caller walks the buffer using `point_count` to find surface boundaries.
     * @returns {Float64Array}
     */
    staticSurfacesSnapshot() {
        const ret = wasm.softbodyworldhandle_staticSurfacesSnapshot(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Advance the simulation by `delta_seconds`. Internally clamped to
     * [1/240, 1/20] and run for `substeps` substeps.
     * @param {number} delta_seconds
     */
    step(delta_seconds) {
        wasm.softbodyworldhandle_step(this.__wbg_ptr, delta_seconds);
    }
    /**
     * Drain pending trigger-entered events. Returns flat (shape_idx, blob_id) pairs.
     * @returns {Uint32Array}
     */
    takeTriggerEntered() {
        const ret = wasm.softbodyworldhandle_takeTriggerEntered(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {Uint32Array}
     */
    takeTriggerExited() {
        const ret = wasm.softbodyworldhandle_takeTriggerExited(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @param {number} blob_id
     * @param {number} x
     * @param {number} y
     */
    teleportBlob(blob_id, x, y) {
        wasm.softbodyworldhandle_teleportBlob(this.__wbg_ptr, blob_id, x, y);
    }
    /**
     * Logical tick counter — increments once per `step()`.
     * @returns {number}
     */
    get tick() {
        const ret = wasm.softbodyworldhandle_tick(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} blob_id
     */
    unpinBlob(blob_id) {
        wasm.softbodyworldhandle_unpinBlob(this.__wbg_ptr, blob_id);
    }
    /**
     * Replace a static surface's polygon. `velocity_x` / `velocity_y` are
     * the kinematic carry velocity (used by PlatformMover so blobs sitting
     * on the platform get pushed along); pass `has_velocity = false` to
     * clear the velocity slot.
     * @param {number} idx
     * @param {Float64Array} new_poly
     * @param {number} velocity_x
     * @param {number} velocity_y
     * @param {boolean} has_velocity
     */
    updateStaticSurface(idx, new_poly, velocity_x, velocity_y, has_velocity) {
        const ptr0 = passArrayF64ToWasm0(new_poly, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.softbodyworldhandle_updateStaticSurface(this.__wbg_ptr, idx, ptr0, len0, velocity_x, velocity_y, has_velocity);
    }
    /**
     * @param {number} blob_id
     */
    zeroBlobVelocity(blob_id) {
        wasm.softbodyworldhandle_zeroBlobVelocity(this.__wbg_ptr, blob_id);
    }
}
if (Symbol.dispose) SoftBodyWorldHandle.prototype[Symbol.dispose] = SoftBodyWorldHandle.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_from_slice_3c93d0bc613de8f0: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_47be4219028de35d: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
    };
    return {
        __proto__: null,
        "./softbody_wasm_bg.js": import0,
    };
}

const BlobHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_blobhandle_free(ptr, 1));
const SoftBodyWorldHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_softbodyworldhandle_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('softbody_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
