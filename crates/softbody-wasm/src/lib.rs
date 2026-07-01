// wasm-bindgen surface for the softbody crate.
//
// Design: keep the boundary narrow. The renderer wants Float64Array of
// positions per frame; the input layer wants to push forces and impulses
// in by particle/blob id. Everything crosses as either:
//   - flat f64 typed arrays (point lists, position dumps)
//   - primitive numbers (ids, scalar forces)
// All numeric conversion to/from Fx happens at the boundary using
// `Fx::from_f64` (round-half-to-even). Sim state lives entirely in Fx.

#![cfg(target_arch = "wasm32")]

use wasm_bindgen::prelude::*;
use js_sys::Float64Array;

use softbody::fx::{Fx, FxVec2};
use softbody::world::{AddBlobParams, SoftBodyWorld};
use softbody::types::{SurfaceMaterial, GravityField, PointGravityFalloff, WorldConfig};

fn fv(x: f64, y: f64) -> FxVec2 { FxVec2::new(Fx::from_f64(x), Fx::from_f64(y)) }

fn poly_from_f64_pairs(pts: &[f64]) -> Vec<FxVec2> {
    assert!(pts.len() % 2 == 0, "polygon points must be flat (x,y) pairs");
    let mut out = Vec::with_capacity(pts.len() / 2);
    let mut i = 0;
    while i < pts.len() {
        out.push(fv(pts[i], pts[i + 1]));
        i += 2;
    }
    out
}

fn material_from_id(m: u32) -> SurfaceMaterial {
    match m {
        1 => SurfaceMaterial::Ice,
        2 => SurfaceMaterial::Sticky,
        3 => SurfaceMaterial::Bouncy,
        _ => SurfaceMaterial::Default,
    }
}

#[wasm_bindgen]
pub struct SoftBodyWorldHandle {
    inner: SoftBodyWorld,
}

#[wasm_bindgen]
pub struct BlobHandle {
    #[wasm_bindgen(readonly)] pub blob_id: u32,
    #[wasm_bindgen(readonly)] pub center_idx: u32,
    #[wasm_bindgen(readonly)] pub shape_idx: u32,
    hull_indices: Vec<u32>,
}

#[wasm_bindgen]
impl BlobHandle {
    /// Hull particle indices as a typed array.
    #[wasm_bindgen(getter, js_name = hullIndices)]
    pub fn hull_indices_js(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.hull_indices[..])
    }
}

#[wasm_bindgen]
impl SoftBodyWorldHandle {
    /// Construct a new world.
    ///
    /// `gravity_y` is positive-down (matches the rest of the engine).
    /// All scalars are passed as `f64` and rounded into Fx at the boundary.
    #[wasm_bindgen(constructor)]
    pub fn new(
        rng_seed: u32,
        gravity_x: f64, gravity_y: f64,
        substeps: u32,
    ) -> SoftBodyWorldHandle {
        let mut cfg = WorldConfig::default();
        cfg.gravity = fv(gravity_x, gravity_y);
        cfg.substeps = substeps.max(1);
        SoftBodyWorldHandle { inner: SoftBodyWorld::new(cfg, rng_seed) }
    }

    /// Override the world's RNG seed mid-flight. Should only be called
    /// before any step() — changing the seed mid-sim diverges immediately.
    #[wasm_bindgen(js_name = setRngSeed)]
    pub fn set_rng_seed(&mut self, seed: u32) {
        self.inner.rng = softbody::rng::Mulberry32::new(seed);
    }

    /// Logical tick counter — increments once per `step()`.
    #[wasm_bindgen(getter)]
    pub fn tick(&self) -> u32 { self.inner.tick as u32 }

    /// Override the logical tick — used by the guest's keyframe restore
    /// path to align local sim time with the host's authoritative tick.
    #[wasm_bindgen(js_name = setTick)]
    pub fn set_tick(&mut self, t: u32) { self.inner.set_tick(t as u64); }

    /// Total particle count (across all blobs + extras).
    #[wasm_bindgen(js_name = particleCount)]
    pub fn particle_count(&self) -> u32 { self.inner.pos.len() as u32 }

    /// Number of registered blobs.
    #[wasm_bindgen(js_name = blobCount)]
    pub fn blob_count(&self) -> u32 { self.inner.blob_count() as u32 }

    /// Register a static (immovable) collision polygon. `points` is a
    /// flat (x0,y0,x1,y1,...) buffer in world units. `material_id`:
    /// 0 default, 1 ice, 2 sticky, 3 bouncy.
    #[wasm_bindgen(js_name = registerStaticPolygon)]
    pub fn register_static_polygon(&mut self, points: &[f64], material_id: u32) -> u32 {
        let poly = poly_from_f64_pairs(points);
        self.inner.register_static_polygon(poly, material_from_id(material_id), None, None, None) as u32
    }

    /// Register a trigger zone. `gravity_x`/`gravity_y` of NaN means no
    /// gravity override (just an enter/exit sensor).
    #[wasm_bindgen(js_name = registerTriggerPolygon)]
    pub fn register_trigger_polygon(
        &mut self,
        points: &[f64],
        gravity_x: f64,
        gravity_y: f64,
    ) -> u32 {
        let poly = poly_from_f64_pairs(points);
        let field = if gravity_x.is_nan() || gravity_y.is_nan() {
            None
        } else {
            Some(GravityField::Uniform { vector: fv(gravity_x, gravity_y) })
        };
        self.inner.register_trigger_polygon(poly, field) as u32
    }

    /// Register a point-attractor trigger.
    #[wasm_bindgen(js_name = registerTriggerPointGravity)]
    pub fn register_trigger_point_gravity(
        &mut self,
        points: &[f64],
        center_x: f64, center_y: f64,
        strength: f64,
        inverse_square: bool,
    ) -> u32 {
        let poly = poly_from_f64_pairs(points);
        let falloff = if inverse_square { PointGravityFalloff::InverseSquare } else { PointGravityFalloff::Linear };
        let field = Some(GravityField::Point {
            center: fv(center_x, center_y),
            strength: Fx::from_f64(strength),
            falloff,
        });
        self.inner.register_trigger_polygon(poly, field) as u32
    }

    /// Add a blob from a hull (flat x,y,x,y,... rest-local coords).
    /// `static_hull_indices` lists hull-local indices that should be
    /// anchored (mass=0, immovable) — used by soft platforms to fix
    /// corners/edges in place while the body deforms. Pass an empty
    /// array for a fully-dynamic blob.
    /// Returns a BlobHandle with the blob id + key particle indices.
    #[wasm_bindgen(js_name = addBlobFromHull)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_blob_from_hull(
        &mut self,
        hull_rest_local: &[f64],
        center_local_x: f64, center_local_y: f64,
        center_mass: f64, hull_mass: f64,
        spring_k: f64, spring_damp: f64,
        radial_k: f64, radial_damp: f64,
        pressure_k: f64,
        shape_match_k: f64, shape_match_damp: f64,
        world_origin_x: f64, world_origin_y: f64,
        sort_key: &str,
        static_hull_indices: &[u32],
        static_center: bool,
        pin_frame: bool,
    ) -> BlobHandle {
        let hull = poly_from_f64_pairs(hull_rest_local);
        let res = self.inner.add_blob_from_hull(AddBlobParams {
            hull_rest_local: hull,
            center_local: fv(center_local_x, center_local_y),
            center_mass: Fx::from_f64(center_mass),
            hull_mass: Fx::from_f64(hull_mass),
            spring_k: Fx::from_f64(spring_k),
            spring_damp: Fx::from_f64(spring_damp),
            radial_k: Fx::from_f64(radial_k),
            radial_damp: Fx::from_f64(radial_damp),
            pressure_k: Fx::from_f64(pressure_k),
            shape_match_k: Fx::from_f64(shape_match_k),
            shape_match_damp: Fx::from_f64(shape_match_damp),
            world_origin: fv(world_origin_x, world_origin_y),
            sort_key: if sort_key.is_empty() { None } else { Some(sort_key.to_string()) },
            static_hull_indices: static_hull_indices.iter().map(|&i| i as usize).collect(),
            static_center,
            pin_frame,
        });
        BlobHandle {
            blob_id: res.blob_id,
            center_idx: res.center_idx,
            shape_idx: res.shape_idx,
            hull_indices: res.hull_indices,
        }
    }

    /// Advance the simulation by `delta_seconds`. Internally clamped to
    /// [1/240, 1/20] and run for `substeps` substeps.
    #[wasm_bindgen]
    pub fn step(&mut self, delta_seconds: f64) {
        self.inner.step(Fx::from_f64(delta_seconds));
    }

    // ---- input forces ----

    #[wasm_bindgen(js_name = applyBlobMoveForce)]
    pub fn apply_blob_move_force(
        &mut self, blob_id: u32,
        move_x: f64, move_y: f64,
        force: f64, dt: f64,
    ) {
        self.inner.apply_blob_move_force(
            blob_id,
            fv(move_x, move_y),
            Fx::from_f64(force),
            Fx::from_f64(dt),
        );
    }

    #[wasm_bindgen(js_name = applyBlobLinearVelocityDelta)]
    pub fn apply_blob_linear_velocity_delta(
        &mut self, blob_id: u32, dvx: f64, dvy: f64,
    ) {
        self.inner.apply_blob_linear_velocity_delta(blob_id, fv(dvx, dvy));
    }

    #[wasm_bindgen(js_name = setBlobTread)]
    pub fn set_blob_tread(&mut self, blob_id: u32, strength: f64) {
        self.inner.set_blob_tread(blob_id, Fx::from_f64(strength));
    }

    // ---- Phase 3 zone-force APIs (foundation for Phases 4-6) ----

    /// Find every blob whose centroid is inside `polygon`. Returns
    /// blob_ids in ascending order. Polygon is a flat
    /// `[x0,y0,x1,y1,…]` Float64Array.
    #[wasm_bindgen(js_name = blobsOverlappingPolygon)]
    pub fn blobs_overlapping_polygon(&self, polygon: &[f64]) -> Vec<u32> {
        let poly = poly_from_f64_pairs(polygon);
        self.inner.blobs_overlapping_polygon(&poly)
    }

    /// Apply a constant `(fx, fy)` force to every blob whose centroid
    /// is inside `polygon`. Force scales by dt internally. Use for
    /// wind zones, conveyors.
    #[wasm_bindgen(js_name = applyForceInPolygonUniform)]
    pub fn apply_force_in_polygon_uniform(
        &mut self, polygon: &[f64], fx: f64, fy: f64, dt: f64,
    ) {
        let poly = poly_from_f64_pairs(polygon);
        self.inner.apply_force_in_polygon(
            &poly,
            softbody::types::ForceField::Uniform { force: fv(fx, fy) },
            Fx::from_f64(dt),
        );
    }

    /// Apply a radial force (outward if `strength` > 0, inward if < 0)
    /// from `(cx,cy)` to every blob in `polygon` within `radius`.
    /// `falloff`: 0 = Linear (mag * (1 - d/radius)), 1 = InverseSquare
    /// ((radius/d)^2). Use for bumpers, wrecking-ball blasts, magnets.
    #[wasm_bindgen(js_name = applyForceInPolygonRadial)]
    pub fn apply_force_in_polygon_radial(
        &mut self,
        polygon: &[f64],
        cx: f64, cy: f64,
        strength: f64,
        radius: f64,
        falloff: u32,
        dt: f64,
    ) {
        let poly = poly_from_f64_pairs(polygon);
        let f = match falloff {
            0 => softbody::types::PointGravityFalloff::Linear,
            _ => softbody::types::PointGravityFalloff::InverseSquare,
        };
        self.inner.apply_force_in_polygon(
            &poly,
            softbody::types::ForceField::Radial {
                center: fv(cx, cy),
                strength: Fx::from_f64(strength),
                radius: Fx::from_f64(radius),
                falloff: f,
            },
            Fx::from_f64(dt),
        );
    }

    /// Velocity damping for every hull particle of every blob in
    /// `polygon`: v *= (1 - coefficient * dt). Use for sticky goo,
    /// underwater drag.
    #[wasm_bindgen(js_name = applyForceInPolygonDrag)]
    pub fn apply_force_in_polygon_drag(
        &mut self, polygon: &[f64], coefficient: f64, dt: f64,
    ) {
        let poly = poly_from_f64_pairs(polygon);
        self.inner.apply_force_in_polygon(
            &poly,
            softbody::types::ForceField::Drag { coefficient: Fx::from_f64(coefficient) },
            Fx::from_f64(dt),
        );
    }

    // ---- Phase 4 dynamic-item APIs ----
    // Register a dynamic-item zone at level-load time. Each call returns
    // the item's index in the engine's `dynamic_items` vec (sequential).
    // `update_dynamic_items` runs internally each step() to advance
    // timers + apply forces. JS-side dynamicItemManager is reduced to a
    // thin loader (calls these add_* methods at level start) + event
    // drainer (queries dynamicItemActive for VFX).

    #[wasm_bindgen(js_name = addCannon)]
    pub fn add_cannon(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64, rotation: f64) -> u32 {
        self.inner.add_cannon(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h), Fx::from_f64(rotation))
    }
    #[wasm_bindgen(js_name = addCatapult)]
    pub fn add_catapult(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> u32 {
        self.inner.add_catapult(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h))
    }
    #[wasm_bindgen(js_name = addBumper)]
    pub fn add_bumper(&mut self, id: u32, x: f64, y: f64, radius: f64) -> u32 {
        self.inner.add_bumper(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(radius))
    }
    #[wasm_bindgen(js_name = addWindZone)]
    pub fn add_wind_zone(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64, rotation: f64) -> u32 {
        self.inner.add_wind_zone(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h), Fx::from_f64(rotation))
    }
    #[wasm_bindgen(js_name = addGravityFlipper)]
    pub fn add_gravity_flipper(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> u32 {
        self.inner.add_gravity_flipper(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h))
    }
    #[wasm_bindgen(js_name = addConveyor)]
    pub fn add_conveyor(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64, direction: i32) -> u32 {
        self.inner.add_conveyor(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h), direction)
    }
    #[wasm_bindgen(js_name = addStickyGoo)]
    pub fn add_sticky_goo(&mut self, id: u32, x: f64, y: f64, w: f64, h: f64) -> u32 {
        self.inner.add_sticky_goo(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h))
    }
    #[wasm_bindgen(js_name = addWreckingBall)]
    pub fn add_wrecking_ball(&mut self, id: u32, x: f64, y: f64) -> u32 {
        self.inner.add_wrecking_ball(id, Fx::from_f64(x), Fx::from_f64(y))
    }
    #[wasm_bindgen(js_name = clearDynamicItems)]
    pub fn clear_dynamic_items(&mut self) { self.inner.clear_dynamic_items(); }
    #[wasm_bindgen(js_name = dynamicItemCount)]
    pub fn dynamic_item_count(&self) -> usize { self.inner.dynamic_item_count() }
    /// Read the visual `active` flag for item index `idx` — used by
    /// JS-side renderers/SFX to fire VFX when an item is currently
    /// firing (cannon mid-blast, bumper just-fired, etc.).
    #[wasm_bindgen(js_name = dynamicItemActive)]
    pub fn dynamic_item_active(&self, idx: usize) -> bool {
        self.inner.dynamic_item_active(idx)
    }

    // ---- Phase 5 spring-pad APIs ----
    /// Register a spring pad. The engine creates a kinematic
    /// static_surface for the plate and runs the state machine each
    /// step(). `fire_speed_override` of <=0 uses the default.
    #[wasm_bindgen(js_name = addSpringPad)]
    pub fn add_spring_pad(
        &mut self,
        id: u32,
        x: f64, y: f64,
        width: f64, height: f64,
        rotation: f64,
        fire_speed_override: f64,
    ) -> u32 {
        let fs = if fire_speed_override > 0.0 { Some(Fx::from_f64(fire_speed_override)) } else { None };
        self.inner.add_spring_pad(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(width), Fx::from_f64(height), Fx::from_f64(rotation), fs)
    }
    #[wasm_bindgen(js_name = clearSpringPads)]
    pub fn clear_spring_pads(&mut self) { self.inner.clear_spring_pads(); }
    #[wasm_bindgen(js_name = springPadCount)]
    pub fn spring_pad_count(&self) -> usize { self.inner.spring_pad_count() }
    /// Returns the spring pad's state: 0 = Loaded, 1 = Firing, 2 = Reloading.
    #[wasm_bindgen(js_name = springPadState)]
    pub fn spring_pad_state(&self, idx: usize) -> u32 { self.inner.spring_pad_state(idx) }
    /// Current plate retraction offset in world units. 0 = fully extended.
    #[wasm_bindgen(js_name = springPadOffset)]
    pub fn spring_pad_offset(&self, idx: usize) -> f64 { self.inner.spring_pad_offset(idx) }
    /// Drain pending fire events (gameplay IDs of pads that
    /// transitioned loaded→firing this step). JS uses these to spawn
    /// VFX/SFX.
    #[wasm_bindgen(js_name = takeSpringPadFireEvents)]
    pub fn take_spring_pad_fire_events(&mut self) -> Vec<u32> {
        self.inner.take_spring_pad_fire_events()
    }

    // ---- Phase 6: blob roles + trigger charge machines ----
    #[wasm_bindgen(js_name = setBlobRole)]
    pub fn set_blob_role(&mut self, blob_id: u32, role: u8, gameplay_id: u32) {
        self.inner.set_blob_role(blob_id, role, gameplay_id);
    }
    #[wasm_bindgen(js_name = addGameTrigger)]
    pub fn add_game_trigger(&mut self, id: u32, shape_idx: u32, charge_seconds: f64, ignore_npcs: bool) -> u32 {
        self.inner.add_game_trigger(id, shape_idx, Fx::from_f64(charge_seconds), ignore_npcs)
    }
    #[wasm_bindgen(js_name = clearGameTriggers)]
    pub fn clear_game_triggers(&mut self) { self.inner.clear_game_triggers(); }
    #[wasm_bindgen(js_name = triggerPressed)]
    pub fn trigger_pressed(&self, idx: usize) -> bool { self.inner.game_trigger_pressed(idx) }
    #[wasm_bindgen(js_name = triggerChargeProgress)]
    pub fn trigger_charge_progress(&self, idx: usize) -> f64 { self.inner.game_trigger_charge_progress(idx) }
    #[wasm_bindgen(js_name = triggerPressedById)]
    pub fn trigger_pressed_by_id(&self, id: u32) -> bool { self.inner.game_trigger_pressed_by_id(id) }
    #[wasm_bindgen(js_name = takeTriggerPressedEvents)]
    pub fn take_trigger_pressed_events(&mut self) -> Vec<u32> { self.inner.take_trigger_pressed_events() }
    #[wasm_bindgen(js_name = takeTriggerReleasedEvents)]
    pub fn take_trigger_released_events(&mut self) -> Vec<u32> { self.inner.take_trigger_released_events() }

    // ---- Phase 7: actions ----
    #[wasm_bindgen(js_name = addGameAction)]
    pub fn add_game_action(&mut self, id: u32, mode: u8, require_all: bool, easing: u8, delay: f64, duration: f64, interval: f64, source_trigger_ids: &[u32]) -> u32 {
        self.inner.add_game_action(id, mode, require_all, easing, Fx::from_f64(delay), Fx::from_f64(duration), Fx::from_f64(interval), source_trigger_ids.to_vec())
    }
    #[wasm_bindgen(js_name = actionAddTargetShapePoint)]
    pub fn action_add_target_shape_point(&mut self, action_idx: usize, particle: u32, end_x: f64, end_y: f64) {
        self.inner.action_add_target_shape_point(action_idx, particle as usize, Fx::from_f64(end_x), Fx::from_f64(end_y));
    }
    #[wasm_bindgen(js_name = actionAddTargetMoveShape)]
    pub fn action_add_target_move_shape(&mut self, action_idx: usize, particle_ids: &[u32], end_x: f64, end_y: f64) {
        let ids: Vec<usize> = particle_ids.iter().map(|&i| i as usize).collect();
        self.inner.action_add_target_move_shape(action_idx, ids, Fx::from_f64(end_x), Fx::from_f64(end_y));
    }
    #[wasm_bindgen(js_name = actionAddTargetRotateShape)]
    pub fn action_add_target_rotate_shape(&mut self, action_idx: usize, particle_ids: &[u32], end_rotation: f64) {
        let ids: Vec<usize> = particle_ids.iter().map(|&i| i as usize).collect();
        self.inner.action_add_target_rotate_shape(action_idx, ids, Fx::from_f64(end_rotation));
    }
    #[wasm_bindgen(js_name = actionAddTargetPlatform)]
    pub fn action_add_target_platform(&mut self, action_idx: usize, static_idx: u32, base_x: f64, base_y: f64, base_rot: f64, local_poly: &[f64], end_x: f64, end_y: f64, end_rot: f64) {
        self.inner.action_add_target_platform(action_idx, static_idx as usize, Fx::from_f64(base_x), Fx::from_f64(base_y), Fx::from_f64(base_rot), poly_from_f64_pairs(local_poly), Fx::from_f64(end_x), Fx::from_f64(end_y), Fx::from_f64(end_rot));
    }
    #[wasm_bindgen(js_name = actionAddTargetSpike)]
    pub fn action_add_target_spike(&mut self, action_idx: usize, spike_id: u32, base_x: f64, base_y: f64, base_rot: f64, end_x: f64, end_y: f64, end_rot: f64) {
        self.inner.action_add_target_spike(action_idx, spike_id, Fx::from_f64(base_x), Fx::from_f64(base_y), Fx::from_f64(base_rot), Fx::from_f64(end_x), Fx::from_f64(end_y), Fx::from_f64(end_rot));
    }
    #[wasm_bindgen(js_name = clearGameActions)]
    pub fn clear_game_actions(&mut self) { self.inner.clear_game_actions(); }
    #[wasm_bindgen(js_name = gameActionState)]
    pub fn game_action_state(&self, idx: usize) -> u32 { self.inner.game_action_state(idx) }
    #[wasm_bindgen(js_name = gameActionTargetPose)]
    pub fn game_action_target_pose(&self, action_idx: usize, target_idx: usize) -> Vec<f64> {
        self.inner.game_action_target_pose(action_idx, target_idx).map(|p| p.to_vec()).unwrap_or_default()
    }
    #[wasm_bindgen(js_name = takeActionFireEvents)]
    pub fn take_action_fire_events(&mut self) -> Vec<u32> { self.inner.take_action_fire_events() }

    // ---- Phase 8: spikes / death / respawn ----
    #[wasm_bindgen(js_name = setDeathMode)]
    pub fn set_death_mode(&mut self, mode: u8) { self.inner.set_death_mode(mode); }
    #[wasm_bindgen(js_name = addSpike)]
    pub fn add_spike(&mut self, id: u32, x: f64, y: f64, rot: f64, w: f64, h: f64) -> u32 {
        self.inner.add_spike(id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(rot), Fx::from_f64(w), Fx::from_f64(h))
    }
    #[wasm_bindgen(js_name = addDeathZone)]
    pub fn add_death_zone(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.inner.add_death_zone(Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h));
    }
    #[wasm_bindgen(js_name = setKillBelowY)]
    pub fn set_kill_below_y(&mut self, y: f64, enabled: bool) { self.inner.set_kill_below_y(Fx::from_f64(y), enabled); }
    #[wasm_bindgen(js_name = setSpawnPoints)]
    pub fn set_spawn_points(&mut self, flat: &[f64]) {
        let v: Vec<Fx> = flat.iter().map(|&x| Fx::from_f64(x)).collect();
        self.inner.set_spawn_points(&v);
    }
    #[wasm_bindgen(js_name = setSpikePose)]
    pub fn set_spike_pose(&mut self, spike_id: u32, x: f64, y: f64, rot: f64) {
        self.inner.set_spike_pose(spike_id, Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(rot));
    }
    #[wasm_bindgen(js_name = respawnAll)]
    pub fn respawn_all(&mut self) { self.inner.respawn_all(); }
    #[wasm_bindgen(js_name = spreadPlayersToSpawns)]
    pub fn spread_players_to_spawns(&mut self) { self.inner.spread_players_to_spawns(); }
    #[wasm_bindgen(js_name = killPlayerByBlobId)]
    pub fn kill_player_by_blob_id(&mut self, blob_id: u32) { self.inner.kill_player_by_blob_id(blob_id); }
    #[wasm_bindgen(js_name = clearSpikes)]
    pub fn clear_spikes(&mut self) { self.inner.clear_spikes(); }
    #[wasm_bindgen(js_name = takeKillEvents)]
    pub fn take_kill_events(&mut self) -> Vec<f64> { self.inner.take_kill_events() }
    #[wasm_bindgen(js_name = isInvulnerable)]
    pub fn is_invulnerable(&self, gameplay_id: u32) -> bool { self.inner.is_invulnerable(gameplay_id) }
    #[wasm_bindgen(js_name = isDead)]
    pub fn is_dead(&self, gameplay_id: u32) -> bool { self.inner.is_dead(gameplay_id) }
    #[wasm_bindgen(js_name = deadPlayerRespawnTimer)]
    pub fn dead_player_respawn_timer(&self, gameplay_id: u32) -> f64 { self.inner.dead_player_respawn_timer(gameplay_id) }
    #[wasm_bindgen(js_name = deadPlayerDeathPos)]
    pub fn dead_player_death_pos(&self, gameplay_id: u32) -> Vec<f64> {
        self.inner.dead_player_death_pos(gameplay_id).map(|p| p.to_vec()).unwrap_or_default()
    }
    #[wasm_bindgen(js_name = spikeLivePose)]
    pub fn spike_live_pose(&self, idx: usize) -> Vec<f64> {
        self.inner.spike_live_pose(idx).map(|p| p.to_vec()).unwrap_or_default()
    }

    // ---- Phase 9: game-mode rules ----
    #[wasm_bindgen(js_name = setGameMode)]
    pub fn set_game_mode(&mut self, kind: u8, time_limit: f64, target_score: f64) {
        self.inner.set_game_mode(kind, Fx::from_f64(time_limit), Fx::from_f64(target_score));
    }
    #[wasm_bindgen(js_name = setGoalZone)]
    pub fn set_goal_zone(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.inner.set_goal_zone(Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h));
    }
    #[wasm_bindgen(js_name = addHillZone)]
    pub fn add_hill_zone(&mut self, x: f64, y: f64, w: f64, h: f64) {
        self.inner.add_hill_zone(Fx::from_f64(x), Fx::from_f64(y), Fx::from_f64(w), Fx::from_f64(h));
    }
    #[wasm_bindgen(js_name = setHillRotation)]
    pub fn set_hill_rotation(&mut self, min: f64, max: f64) { self.inner.set_hill_rotation(Fx::from_f64(min), Fx::from_f64(max)); }
    #[wasm_bindgen(js_name = setModePlaying)]
    pub fn set_mode_playing(&mut self, playing: bool) { self.inner.set_mode_playing(playing); }
    #[wasm_bindgen(js_name = resetModeForRound)]
    pub fn reset_mode_for_round(&mut self) { self.inner.reset_mode_for_round(); }
    #[wasm_bindgen(js_name = modeWinner)]
    pub fn mode_winner(&self) -> i64 { self.inner.mode_winner() }
    #[wasm_bindgen(js_name = modeDecided)]
    pub fn mode_decided(&self) -> bool { self.inner.mode_decided() }
    #[wasm_bindgen(js_name = modeGameTime)]
    pub fn mode_game_time(&self) -> f64 { self.inner.mode_game_time() }
    #[wasm_bindgen(js_name = modeTimeRemaining)]
    pub fn mode_time_remaining(&self) -> f64 { self.inner.mode_time_remaining() }
    #[wasm_bindgen(js_name = modeScore)]
    pub fn mode_score(&self, gameplay_id: u32) -> f64 { self.inner.mode_score(gameplay_id) }
    #[wasm_bindgen(js_name = modeScores)]
    pub fn mode_scores(&self) -> Vec<f64> { self.inner.mode_scores() }
    #[wasm_bindgen(js_name = kothActiveHill)]
    pub fn koth_active_hill(&self) -> Vec<f64> { self.inner.koth_active_hill().map(|p| p.to_vec()).unwrap_or_default() }
    #[wasm_bindgen(js_name = kothLastMoveTime)]
    pub fn koth_last_move_time(&self) -> f64 { self.inner.koth_last_move_time() }
    #[wasm_bindgen(js_name = kothKingId)]
    pub fn koth_king_id(&self) -> i64 { self.inner.koth_king_id() }
    #[wasm_bindgen(js_name = chainedAllReached)]
    pub fn chained_all_reached(&self) -> bool { self.inner.chained_all_reached() }

    // ---- state readout (Float64Array — converted on demand from Fx) ----

    /// Flat (x0,y0,x1,y1,...) buffer of all particle positions.
    #[wasm_bindgen(js_name = getPositions)]
    pub fn get_positions(&self) -> Float64Array {
        let n = self.inner.pos.len();
        let mut buf = vec![0.0f64; n * 2];
        for (i, p) in self.inner.pos.iter().enumerate() {
            buf[i * 2] = p.x.to_f64();
            buf[i * 2 + 1] = p.y.to_f64();
        }
        Float64Array::from(&buf[..])
    }

    #[wasm_bindgen(js_name = getVelocities)]
    pub fn get_velocities(&self) -> Float64Array {
        let n = self.inner.vel.len();
        let mut buf = vec![0.0f64; n * 2];
        for (i, v) in self.inner.vel.iter().enumerate() {
            buf[i * 2] = v.x.to_f64();
            buf[i * 2 + 1] = v.y.to_f64();
        }
        Float64Array::from(&buf[..])
    }

    /// Per-particle inverse mass (0 = anchored / static). Managers read this
    /// to tell pinned points from dynamic ones (e.g. ActionManager skips
    /// anchored targets).
    #[wasm_bindgen(js_name = getInvMass)]
    pub fn get_inv_mass(&self) -> Float64Array {
        let mut buf = vec![0.0f64; self.inner.inv_mass.len()];
        for (i, m) in self.inner.inv_mass.iter().enumerate() {
            buf[i] = m.to_f64();
        }
        Float64Array::from(&buf[..])
    }

    /// Flat (x,y,x,y,...) buffer of the blob's hull polygon in CCW order.
    #[wasm_bindgen(js_name = getHullPolygon)]
    pub fn get_hull_polygon(&self, blob_id: u32) -> Float64Array {
        let poly = self.inner.hull_polygon(blob_id);
        let mut buf = vec![0.0f64; poly.len() * 2];
        for (i, p) in poly.iter().enumerate() {
            buf[i * 2] = p.x.to_f64();
            buf[i * 2 + 1] = p.y.to_f64();
        }
        Float64Array::from(&buf[..])
    }

    // ---- determinism aid: a stable hash of the full sim state ----

    /// Capture full mutable engine state to a binary buffer. Used by
    /// the rollback netcode controller to checkpoint each tick. See
    /// `softbody::snapshot` for the binary format.
    #[wasm_bindgen(js_name = serializeState)]
    pub fn serialize_state(&self) -> js_sys::Uint8Array {
        let buf = self.inner.serialize_state();
        js_sys::Uint8Array::from(&buf[..])
    }

    /// Restore state from a buffer produced by `serializeState`. Returns
    /// true on success; false if the buffer is malformed or world layout
    /// (particle/blob/shape/static-surface counts) doesn't match.
    #[wasm_bindgen(js_name = restoreState)]
    pub fn restore_state(&mut self, buf: &[u8]) -> bool {
        self.inner.restore_state(buf).is_ok()
    }

    /// FNV-1a 64-bit hash of every (pos.raw, vel.raw) i64 in the sim.
    /// Two clients with the same state arrays produce the same hash.
    /// Useful for cheap divergence checks in netplay.
    #[wasm_bindgen(js_name = stateHash)]
    pub fn state_hash(&self) -> u64 {
        let mut h: u64 = 0xcbf29ce484222325;
        let prime: u64 = 0x100000001b3;
        for p in &self.inner.pos {
            for b in p.x.raw().to_le_bytes() { h ^= b as u64; h = h.wrapping_mul(prime); }
            for b in p.y.raw().to_le_bytes() { h ^= b as u64; h = h.wrapping_mul(prime); }
        }
        for v in &self.inner.vel {
            for b in v.x.raw().to_le_bytes() { h ^= b as u64; h = h.wrapping_mul(prime); }
            for b in v.y.raw().to_le_bytes() { h ^= b as u64; h = h.wrapping_mul(prime); }
        }
        h
    }

    /// Drain pending trigger-entered events. Returns flat (shape_idx, blob_id) pairs.
    #[wasm_bindgen(js_name = takeTriggerEntered)]
    pub fn take_trigger_entered(&mut self) -> js_sys::Uint32Array {
        let events = self.inner.take_trigger_entered();
        let mut buf = Vec::with_capacity(events.len() * 2);
        for (s, b) in events { buf.push(s); buf.push(b); }
        js_sys::Uint32Array::from(&buf[..])
    }

    #[wasm_bindgen(js_name = takeTriggerExited)]
    pub fn take_trigger_exited(&mut self) -> js_sys::Uint32Array {
        let events = self.inner.take_trigger_exited();
        let mut buf = Vec::with_capacity(events.len() * 2);
        for (s, b) in events { buf.push(s); buf.push(b); }
        js_sys::Uint32Array::from(&buf[..])
    }

    /// Drain pending crush events. Returns a flat array of blob_ids
    /// whose physics state exploded during the most recent `step()` —
    /// typically a blob crushed between a moving platform and static
    /// geometry. The game wrapper turns each id into a player kill.
    #[wasm_bindgen(js_name = takeCrushEvents)]
    pub fn take_crush_events(&mut self) -> js_sys::Uint32Array {
        let events = self.inner.take_crush_events();
        js_sys::Uint32Array::from(&events[..])
    }

    // =================================================================
    // Phase 6A — surface extensions used by the game wrapper
    // =================================================================

    // ---- particle accessors / mutators ----

    /// Read a single particle position as (x, y) into a 2-element f64 array.
    #[wasm_bindgen(js_name = getParticlePos)]
    pub fn get_particle_pos(&self, i: u32) -> Float64Array {
        let p = self.inner.get_particle_pos(i as usize).unwrap_or(FxVec2::ZERO);
        Float64Array::from(&[p.x.to_f64(), p.y.to_f64()][..])
    }
    #[wasm_bindgen(js_name = getParticleVel)]
    pub fn get_particle_vel(&self, i: u32) -> Float64Array {
        let v = self.inner.get_particle_vel(i as usize).unwrap_or(FxVec2::ZERO);
        Float64Array::from(&[v.x.to_f64(), v.y.to_f64()][..])
    }
    #[wasm_bindgen(js_name = setParticlePos)]
    pub fn set_particle_pos(&mut self, i: u32, x: f64, y: f64) {
        self.inner.set_particle_pos(i as usize, fv(x, y));
    }
    #[wasm_bindgen(js_name = setParticleVel)]
    pub fn set_particle_vel(&mut self, i: u32, x: f64, y: f64) {
        self.inner.set_particle_vel(i as usize, fv(x, y));
    }

    /// Bulk-replace positions from a flat (x0,y0,...) f64 buffer. Used by
    /// the action-manager rewind path — one wasm call per rewind instead
    /// of one per particle.
    #[wasm_bindgen(js_name = setPositionsBulk)]
    pub fn set_positions_bulk(&mut self, buf: &[f64]) {
        let pts = poly_from_f64_pairs(buf);
        self.inner.set_positions_bulk(&pts);
    }
    #[wasm_bindgen(js_name = setVelocitiesBulk)]
    pub fn set_velocities_bulk(&mut self, buf: &[f64]) {
        let pts = poly_from_f64_pairs(buf);
        self.inner.set_velocities_bulk(&pts);
    }

    #[wasm_bindgen(js_name = applyExternalForcePoint)]
    pub fn apply_external_force_point(&mut self, i: u32, fx: f64, fy: f64) {
        self.inner.apply_external_force_point(i as usize, fv(fx, fy));
    }

    /// Add a free particle (level loader uses this for ropes / point shapes).
    /// Returns the new particle's index.
    #[wasm_bindgen(js_name = addParticle)]
    pub fn add_particle(&mut self, px: f64, py: f64, vx: f64, vy: f64, mass: f64, radius: f64) -> u32 {
        self.inner.add_particle(fv(px, py), fv(vx, vy), Fx::from_f64(mass), Fx::from_f64(radius))
    }

    // ---- blob lifecycle / mutation ----

    #[wasm_bindgen(js_name = removeBlob)]
    pub fn remove_blob(&mut self, blob_id: u32) { self.inner.remove_blob(blob_id); }

    #[wasm_bindgen(js_name = removeStaticSurface)]
    pub fn remove_static_surface(&mut self, idx: u32) { self.inner.remove_static_surface(idx as usize); }

    /// Replace a static surface's polygon. `velocity_x` / `velocity_y` are
    /// the kinematic carry velocity (used by PlatformMover so blobs sitting
    /// on the platform get pushed along); pass `has_velocity = false` to
    /// clear the velocity slot.
    #[wasm_bindgen(js_name = updateStaticSurface)]
    pub fn update_static_surface(
        &mut self,
        idx: u32,
        new_poly: &[f64],
        velocity_x: f64, velocity_y: f64, has_velocity: bool,
    ) {
        let poly = poly_from_f64_pairs(new_poly);
        let vel = if has_velocity { Some(fv(velocity_x, velocity_y)) } else { None };
        self.inner.update_static_surface(idx as usize, poly, vel);
    }

    #[wasm_bindgen(js_name = clearStaticPolygons)]
    pub fn clear_static_polygons(&mut self) { self.inner.clear_static_polygons(); }

    #[wasm_bindgen(js_name = setBlobSpringStiffnessScale)]
    pub fn set_blob_spring_stiffness_scale(&mut self, blob_id: u32, stiffness: f64, damp: f64) {
        // damp < 0 means "auto-derive from sqrt(stiffness)"
        let d = if damp < 0.0 { None } else { Some(Fx::from_f64(damp)) };
        self.inner.set_blob_spring_stiffness_scale(blob_id, Fx::from_f64(stiffness), d);
    }

    #[wasm_bindgen(js_name = setBlobShapeMatchRestScale)]
    pub fn set_blob_shape_match_rest_scale(&mut self, blob_id: u32, s: f64) {
        self.inner.set_blob_shape_match_rest_scale(blob_id, Fx::from_f64(s));
    }

    #[wasm_bindgen(js_name = setBlobRestLocal)]
    pub fn set_blob_rest_local(&mut self, blob_id: u32, rest_local: &[f64]) {
        let pts = poly_from_f64_pairs(rest_local);
        self.inner.set_blob_rest_local(blob_id, &pts);
    }

    /// Engine-side hull squash + lean deformation. Replaces the JS
    /// `SlimeBlob.updateHullDeformation` (which called Math.atan2 +
    /// Math.cos/sin per tick — implementation-defined floats that drift
    /// between V8 instances). All trig now runs against deterministic
    /// integer LUTs inside the engine.
    #[wasm_bindgen(js_name = setBlobSquashLean)]
    pub fn set_blob_squash_lean(
        &mut self,
        blob_id: u32,
        squash: f64,
        lean: f64,
        gravity_x: f64,
        gravity_y: f64,
    ) {
        let g = FxVec2::new(Fx::from_f64(gravity_x), Fx::from_f64(gravity_y));
        self.inner.set_blob_squash_lean(
            blob_id,
            Fx::from_f64(squash),
            Fx::from_f64(lean),
            g,
        );
    }

    #[wasm_bindgen(js_name = setBlobMassScale)]
    pub fn set_blob_mass_scale(&mut self, blob_id: u32, scale: f64) {
        self.inner.set_blob_mass_scale(blob_id, Fx::from_f64(scale));
    }

    #[wasm_bindgen(js_name = resetBlobMassScale)]
    pub fn reset_blob_mass_scale(&mut self, blob_id: u32) {
        self.inner.reset_blob_mass_scale(blob_id);
    }

    #[wasm_bindgen(js_name = nudgeBlob)]
    pub fn nudge_blob(&mut self, blob_id: u32, dx: f64, dy: f64) {
        self.inner.nudge_blob(blob_id, Fx::from_f64(dx), Fx::from_f64(dy));
    }

    #[wasm_bindgen(js_name = teleportBlob)]
    pub fn teleport_blob(&mut self, blob_id: u32, x: f64, y: f64) {
        self.inner.teleport_blob(blob_id, fv(x, y));
    }

    #[wasm_bindgen(js_name = resetBlobToRest)]
    pub fn reset_blob_to_rest(&mut self, blob_id: u32, x: f64, y: f64) {
        self.inner.reset_blob_to_rest(blob_id, fv(x, y));
    }

    #[wasm_bindgen(js_name = pinBlobToCurrentPose)]
    pub fn pin_blob_to_current_pose(&mut self, blob_id: u32) {
        self.inner.pin_blob_to_current_pose(blob_id);
    }

    #[wasm_bindgen(js_name = unpinBlob)]
    pub fn unpin_blob(&mut self, blob_id: u32) {
        self.inner.unpin_blob(blob_id);
    }

    #[wasm_bindgen(js_name = zeroBlobVelocity)]
    pub fn zero_blob_velocity(&mut self, blob_id: u32) {
        self.inner.zero_blob_velocity(blob_id);
    }

    #[wasm_bindgen(js_name = setBlobGravityOverride)]
    pub fn set_blob_gravity_override(&mut self, blob_id: u32, gx: f64, gy: f64, clear: bool) {
        if clear {
            self.inner.set_blob_gravity_override(blob_id, None);
        } else {
            self.inner.set_blob_gravity_override(blob_id, Some(fv(gx, gy)));
        }
    }

    // ---- network sync ----

    #[wasm_bindgen(js_name = setBlobGroundContacts)]
    pub fn set_blob_ground_contacts(&mut self, blob_id: u32, count: i32) {
        self.inner.set_blob_ground_contacts(blob_id, count);
    }

    #[wasm_bindgen(js_name = getBlobGroundContacts)]
    pub fn get_blob_ground_contacts(&self, blob_id: u32) -> i32 {
        self.inner.get_blob_ground_contacts(blob_id)
    }

    /// Returns null if no contact this step, else a Float64Array [px,py,nx,ny].
    #[wasm_bindgen(js_name = getBlobGroundContact)]
    pub fn get_blob_ground_contact(&self, blob_id: u32) -> Option<Float64Array> {
        self.inner.get_blob_ground_contact(blob_id).map(|(p, n)| {
            Float64Array::from(&[p.x.to_f64(), p.y.to_f64(), n.x.to_f64(), n.y.to_f64()][..])
        })
    }

    #[wasm_bindgen(js_name = getBlobImpactContact)]
    pub fn get_blob_impact_contact(&self, blob_id: u32) -> Option<Float64Array> {
        self.inner.get_blob_impact_contact(blob_id).map(|(p, n)| {
            Float64Array::from(&[p.x.to_f64(), p.y.to_f64(), n.x.to_f64(), n.y.to_f64()][..])
        })
    }

    /// Per-particle "touched solid this step" bitmap, indexed in hull order.
    /// Length equals the blob's hull length; each byte is 0 or 1.
    #[wasm_bindgen(js_name = getBlobParticleContacts)]
    pub fn get_blob_particle_contacts(&self, blob_id: u32) -> js_sys::Uint8Array {
        let buf = self.inner.get_blob_particle_contacts(blob_id);
        js_sys::Uint8Array::from(&buf[..])
    }

    /// STATIC-only per-particle "touched solid this step" bitmap, hull order.
    /// The contact kind the crush/sandwich check actually counts.
    #[wasm_bindgen(js_name = getBlobParticleStaticContacts)]
    pub fn get_blob_particle_static_contacts(&self, blob_id: u32) -> js_sys::Uint8Array {
        let buf = self.inner.get_blob_particle_static_contacts(blob_id);
        js_sys::Uint8Array::from(&buf[..])
    }

    /// Debug readout of the crush check:
    /// [sandwiched, compressed, staticContactCount, minOpposingDot, integrityViolations].
    #[wasm_bindgen(js_name = getBlobCrushDebug)]
    pub fn get_blob_crush_debug(&self, blob_id: u32) -> Float64Array {
        let v = self.inner.get_blob_crush_debug(blob_id);
        Float64Array::from(&v[..])
    }

    /// Returns [count, normalX, normalY].
    #[wasm_bindgen(js_name = getBlobStickyContact)]
    pub fn get_blob_sticky_contact(&self, blob_id: u32) -> Float64Array {
        let (c, n) = self.inner.get_blob_sticky_contact(blob_id);
        Float64Array::from(&[c as f64, n.x.to_f64(), n.y.to_f64()][..])
    }

    #[wasm_bindgen(js_name = getBlobEffectiveGravity)]
    pub fn get_blob_effective_gravity(&self, blob_id: u32) -> Float64Array {
        let g = self.inner.get_blob_effective_gravity(blob_id);
        Float64Array::from(&[g.x.to_f64(), g.y.to_f64()][..])
    }

    /// Flat (x,y,x,y,...) buffer of the shape-match target positions for
    /// the blob's hull. Empty array if no shape matching active.
    #[wasm_bindgen(js_name = getBlobShapeMatchTargetHull)]
    pub fn get_blob_shape_match_target_hull(&self, blob_id: u32) -> Float64Array {
        let pts = self.inner.get_blob_shape_match_target_hull(blob_id);
        let mut buf = Vec::with_capacity(pts.len() * 2);
        for p in pts { buf.push(p.x.to_f64()); buf.push(p.y.to_f64()); }
        Float64Array::from(&buf[..])
    }

    // ---- blob-range introspection ----

    /// Returns [start, end, hullLen, hull0, hull1, ...] as a Uint32Array.
    /// Empty array if blob_id is out of bounds.
    #[wasm_bindgen(js_name = getBlobRange)]
    pub fn get_blob_range(&self, blob_id: u32) -> js_sys::Uint32Array {
        let Some((start, end, hull)) = self.inner.blob_range(blob_id) else {
            return js_sys::Uint32Array::from(&[][..]);
        };
        let mut buf = vec![start, end, hull.len() as u32];
        buf.extend(hull);
        js_sys::Uint32Array::from(&buf[..])
    }

    #[wasm_bindgen(js_name = blobCenterIdx)]
    pub fn blob_center_idx(&self, blob_id: u32) -> i32 {
        self.inner.blob_center_idx(blob_id).map(|i| i as i32).unwrap_or(-1)
    }

    #[wasm_bindgen(js_name = blobIdForParticle)]
    pub fn blob_id_for_particle(&self, idx: u32) -> i32 {
        self.inner.blob_id_for_particle(idx).map(|i| i as i32).unwrap_or(-1)
    }

    /// Flat (i,j,i,j,...) buffer of spring index pairs (debug viz).
    #[wasm_bindgen(js_name = getSpringIndexPairs)]
    pub fn get_spring_index_pairs(&self) -> js_sys::Uint32Array {
        let pairs = self.inner.spring_index_pairs();
        let mut buf = Vec::with_capacity(pairs.len() * 2);
        for (i, j) in pairs { buf.push(i); buf.push(j); }
        js_sys::Uint32Array::from(&buf[..])
    }

    // ---- RNG state + draw (netcode recovery + powerups/spike) ----

    #[wasm_bindgen(js_name = rngState)]
    pub fn rng_state(&self) -> u32 { self.inner.rng_state() }

    #[wasm_bindgen(js_name = setRngState)]
    pub fn set_rng_state(&mut self, s: u32) { self.inner.set_rng_state(s); }

    /// Mirrors the TS `rng.next()` — uniform in [0, 1). Consumes one RNG draw.
    #[wasm_bindgen(js_name = rngNextUnit)]
    pub fn rng_next_unit(&mut self) -> f64 {
        self.inner.rng_next_unit().to_f64()
    }

    // ---- level-author additions ----

    #[wasm_bindgen(js_name = addExtraSpring)]
    pub fn add_extra_spring(&mut self, i: u32, j: u32, rest: f64, k: f64, damp: f64) {
        self.inner.add_extra_spring(i, j, Fx::from_f64(rest), Fx::from_f64(k), Fx::from_f64(damp));
    }

    /// Build a rope between two existing particles. Returns the indices
    /// of the newly-created interior segment particles (Uint32Array). See
    /// the core `add_rope_chain` for parameter semantics.
    #[wasm_bindgen(js_name = addRopeChain)]
    #[allow(clippy::too_many_arguments)]
    pub fn add_rope_chain(
        &mut self,
        idx_a: u32,
        idx_b: u32,
        total_length: f64,
        max_segment_length: f64,
        segment_mass: f64,
        segment_radius: f64,
        layer: u32,
        mask: u32,
        iterations: u32,
    ) -> js_sys::Uint32Array {
        let inner = self.inner.add_rope_chain(
            idx_a, idx_b,
            Fx::from_f64(total_length),
            Fx::from_f64(max_segment_length),
            Fx::from_f64(segment_mass),
            Fx::from_f64(segment_radius),
            layer, mask, iterations,
        );
        js_sys::Uint32Array::from(&inner[..])
    }

    /// Unilateral distance leash between two blobs. See core `add_blob_tether`.
    #[wasm_bindgen(js_name = addBlobTether)]
    pub fn add_blob_tether(&mut self, blob_a: u32, blob_b: u32, slack: f64, stiffness: f64, max_force: f64) {
        self.inner.add_blob_tether(blob_a, blob_b, Fx::from_f64(slack), Fx::from_f64(stiffness), Fx::from_f64(max_force));
    }

    #[wasm_bindgen(js_name = addHomeAnchor)]
    pub fn add_home_anchor(&mut self, idx: u32, home_x: f64, home_y: f64, k: f64, damp: f64) {
        self.inner.add_home_anchor(idx, fv(home_x, home_y), Fx::from_f64(k), Fx::from_f64(damp));
    }

    /// Hard max-distance constraint between two particles. Solved in
    /// step 7 alongside welds and anchors, repeated `constraint_iters`
    /// times. Use this for a real "rope length" cap that doesn't depend
    /// on PBD propagation through dozens of chain segments.
    #[wasm_bindgen(js_name = addDistanceMax)]
    pub fn add_distance_max(&mut self, idx_a: u32, idx_b: u32, max_dist: f64) {
        self.inner.add_distance_max(idx_a, idx_b, Fx::from_f64(max_dist));
    }

    // ---- snapshots for renderer ----

    /// Returns a packed buffer of static surfaces. Format:
    ///   for each surface: [material_id, point_count, x0, y0, x1, y1, ...]
    /// Caller walks the buffer using `point_count` to find surface boundaries.
    #[wasm_bindgen(js_name = staticSurfacesSnapshot)]
    pub fn static_surfaces_snapshot(&self) -> Float64Array {
        let mut buf: Vec<f64> = Vec::new();
        for s in self.inner.static_surfaces_snapshot() {
            buf.push(s.material_id as f64);
            buf.push(s.poly.len() as f64);
            for p in &s.poly { buf.push(p.x.to_f64()); buf.push(p.y.to_f64()); }
        }
        Float64Array::from(&buf[..])
    }

    /// Returns a packed buffer of shapes. Format per shape:
    ///   [shape_idx, flags, gravKind, gx_or_cx, gy_or_cy, strength, point_count, x0, y0, ...]
    /// flags: bit0=is_trigger, bit1=is_static, bit2=inactive
    /// gravKind: 0=none, 1=uniform, 2=point-linear, 3=point-inverse-square
    /// For uniform: gx_or_cx/gy_or_cy = vector; strength ignored.
    /// For point: gx_or_cx/gy_or_cy = center; strength = strength.
    #[wasm_bindgen(js_name = shapesSnapshot)]
    pub fn shapes_snapshot(&self, include_triggers: bool) -> Float64Array {
        use softbody::world::GravitySnapshot;
        let mut buf: Vec<f64> = Vec::new();
        for s in self.inner.shapes_snapshot(include_triggers) {
            let flags = (s.is_trigger as u32) | ((s.is_static as u32) << 1) | ((s.inactive as u32) << 2);
            buf.push(s.shape_idx as f64);
            buf.push(flags as f64);
            match s.gravity {
                None => { buf.push(0.0); buf.push(0.0); buf.push(0.0); buf.push(0.0); }
                Some(GravitySnapshot::Uniform { vector_x, vector_y }) => {
                    buf.push(1.0); buf.push(vector_x); buf.push(vector_y); buf.push(0.0);
                }
                Some(GravitySnapshot::Point { center_x, center_y, strength, inverse_square }) => {
                    buf.push(if inverse_square { 3.0 } else { 2.0 });
                    buf.push(center_x); buf.push(center_y); buf.push(strength);
                }
            }
            buf.push(s.poly.len() as f64);
            for p in &s.poly { buf.push(p.x.to_f64()); buf.push(p.y.to_f64()); }
        }
        Float64Array::from(&buf[..])
    }
}

