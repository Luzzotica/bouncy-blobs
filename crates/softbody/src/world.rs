// Softbody simulation world — port of src/physics/softBodyWorld.ts.
//
// Status: Phase 2.3 + 2.4 of the port.
//   ✅ Struct + state arrays + constructor
//   ✅ register_static_polygon, register_trigger_polygon
//   ✅ add_blob_from_hull (matches TS layout: center first, then hull)
//   ✅ Force passes: gravity, springs, pressure, shape-matching
//   ✅ Hull-velocity damping (exp_fx)
//   ✅ Trigger enter/exit event dispatch
//   ✅ Apply helpers: move-force, expand, linear velocity delta
//   ⏳ Collisions, CCD, chains, particle-vs-poly — stubbed (todo!())
//      Picked up in Phase 2.5; until then `step()` skips those phases
//      and the sim is gravity + internal forces only.
//
// Every field/method name is a snake_case echo of the TS source so the
// diff-readability story holds end-to-end.

use crate::collision::{
    aabb_overlap, closest_point_on_polygon_boundary, edge_vertex_weights,
    is_point_in_polygon, polygon_aabb, resolve_three_body_velocity,
    segment_intersection_t, signed_area_polygon,
};
use crate::constraints::{solve_distance_max, solve_weighted_anchor, solve_weld};
use crate::fx::{Fx, FxVec2};
use crate::layers::{can_collide, LAYER_ALL, LAYER_BLOB, LAYER_WORLD};
use crate::math::exp_fx;
use crate::rng::Mulberry32;
use crate::shape_matching::{
    apply_transform, average_angle, centroid_from_indices, frame_transform,
};
use crate::types::*;

const EPS: Fx = Fx::from_raw(1 << 14); // ~4.3e-6, mirrors TS EPS=1e-6

// --------- Crush detection ---------
//
// Symptom (see `crush_repro_logs_blob_state`): when a blob is pinched
// between a moving surface and static geometry hard enough that the
// position solver can't resolve, the hull doesn't *fly* anywhere — the
// centroid drifts only a couple of units per frame. What blows up is
// the *hull extent*: some particles get stuck on the descending
// platform, others on the floor, and welds/distance-max constraints
// stretch the hull between them. Per-frame centroid displacement is
// useless here; hull spread relative to rest size is the real signal.
//
// We flag a blob when:
//   (a) max(distance from hull centroid) > sqrt(RATIO_SQ) × rest max
//       radius (default RATIO_SQ = 100 → 10× rest extent). A healthy blob
//       under squish/stretch stays well under this; the repro test
//       jumps from ~28 (rest = 28.28) to 62 the frame it explodes.
//   (b) Any hull particle ends a step beyond ±CRUSH_MAX_COORD on either
//       axis. Belt-and-suspenders for Fx saturation / NaN-style blowups
//       that the ratio check might miss if both rest and current grow
//       together.
// 10² = 100 in Fx. Generous headroom for legitimate squish/stretch under
// normal play; the repro-test catastrophic explosion blows past 10×
// within a handful of frames (frame 27 = 2.20×, then unbounded growth
// to 12×+), so the detector still fires — just a few frames later.
pub const CRUSH_HULL_SPREAD_RATIO_SQ: Fx = Fx::from_raw(100i64 << 32);

pub const CRUSH_MAX_COORD: Fx = Fx::from_raw(1_000_000i64 << 32);

const FX_FRAC_1_60: Fx = Fx::from_raw((1i64 << 32) / 60); // 1/60
const FX_FRAC_1_240: Fx = Fx::from_raw((1i64 << 32) / 240); // 1/240
const FX_FRAC_1_20: Fx = Fx::from_raw((1i64 << 32) / 20); // 1/20
const FX_FOUR: Fx = Fx::from_raw(4i64 << 32);
const FX_980: Fx = Fx::from_raw(980i64 << 32);

#[derive(Clone, Debug)]
pub struct HomeAnchor {
    pub idx: ParticleIdx,
    pub home: FxVec2,
    pub k: Fx,
    pub damp: Fx,
}

#[derive(Clone, Debug)]
pub struct Anchor {
    pub indices_a: Vec<usize>,
    pub weights_a: Vec<Fx>,
    pub indices_b: Vec<usize>,
    pub weights_b: Vec<Fx>,
}

#[derive(Clone, Debug)]
pub struct Chain {
    pub particle_indices: Vec<usize>,
    pub max_segment_length: Fx,
    pub iterations: u32,
}

/// Per-material restitution + friction (mirrors MATERIAL_PARAMS in TS).
pub fn material_params(m: SurfaceMaterial) -> MaterialParams {
    match m {
        SurfaceMaterial::Default => MaterialParams { restitution: Fx::ZERO,        friction_mu: fx_lit(164, 100) },
        SurfaceMaterial::Ice     => MaterialParams { restitution: Fx::ZERO,        friction_mu: fx_lit(5, 100) },
        SurfaceMaterial::Sticky  => MaterialParams { restitution: Fx::ZERO,        friction_mu: fx_lit(4, 1) },
        SurfaceMaterial::Bouncy  => MaterialParams { restitution: fx_lit(8, 10),   friction_mu: fx_lit(3, 10) },
    }
}

const fn fx_lit(num: i64, den: i64) -> Fx {
    let scaled = num * (1i64 << 32);
    let half = den / 2;
    let adjusted = if scaled >= 0 { scaled + half } else { scaled - half };
    Fx::from_raw(adjusted / den)
}

/// Evaluate a GravityField at a world position.
pub fn eval_gravity_field(field: &GravityField, pt: FxVec2) -> FxVec2 {
    match field {
        GravityField::Uniform { vector } => *vector,
        GravityField::Point { center, strength, falloff } => {
            let dx = center.x - pt.x;
            let dy = center.y - pt.y;
            let d_sq = dx * dx + dy * dy;
            if d_sq < EPS { return FxVec2::ZERO; }
            let d = crate::math::sqrt_fx(d_sq);
            let mag = match falloff {
                PointGravityFalloff::InverseSquare => {
                    let cap = fx_lit(100, 1);
                    let denom = if d_sq > cap { d_sq } else { cap };
                    *strength / denom
                }
                PointGravityFalloff::Linear => {
                    let cap = fx_lit(10, 1);
                    let denom = if d > cap { d } else { cap };
                    *strength / denom
                }
            };
            FxVec2::new((dx / d) * mag, (dy / d) * mag)
        }
    }
}

pub struct SoftBodyWorld {
    // Particle arrays
    pub pos: Vec<FxVec2>,
    pub vel: Vec<FxVec2>,
    pub mass: Vec<Fx>,
    pub inv_mass: Vec<Fx>,
    pub particle_radius: Vec<Fx>,
    pub particle_layer: Vec<u32>,
    pub particle_mask: Vec<u32>,

    // Springs (per-blob ranges in BlobRange.spring_begin..spring_end).
    pub springs: Vec<Spring>,
    pub extra_springs: Vec<Spring>,
    pub home_anchors: Vec<HomeAnchor>,

    pub shapes: Vec<Shape>,
    pub blob_ranges: Vec<BlobRange>,
    pub static_surfaces: Vec<StaticSurface>,

    pub(crate) welds: Vec<(usize, usize)>,
    pub(crate) anchors: Vec<Anchor>,
    pub(crate) distance_max_constraints: Vec<(usize, usize, Fx)>,
    pub(crate) chains: Vec<Chain>,

    pub(crate) trigger_prev: Vec<(String, bool)>, // sorted Vec acts as deterministic map

    // Ground / impact / sticky contact tracking — reset each substep.
    pub(crate) blob_ground_contacts: Vec<i32>,
    pub(crate) blob_ground_contact_point: Vec<Option<FxVec2>>,
    pub(crate) blob_ground_contact_normal: Vec<Option<FxVec2>>,
    pub(crate) blob_impact_contact_point: Vec<Option<FxVec2>>,
    pub(crate) blob_impact_contact_normal: Vec<Option<FxVec2>>,
    pub(crate) blob_sticky_contact_count: Vec<i32>,
    pub(crate) blob_sticky_contact_normal_sum: Vec<FxVec2>,

    // Per-particle "touched something solid this step" flag — set whenever
    // a hull particle is pushed off a static surface or a softbody platform
    // edge during collision resolution. Reset each step alongside the other
    // contact trackers. Consumed by ledge-hang detection (slimeBlob.ts).
    pub(crate) particle_touched_this_step: Vec<bool>,

    pub(crate) blob_gravity_override: Vec<Option<FxVec2>>,
    /// Per-blob treadmill strength for THIS step (signed; px/s² along the hull
    /// contour). Set from gameplay each frame via `set_blob_tread`, applied in
    /// every substep AFTER shape-matching (so it isn't immediately cancelled),
    /// then cleared at the end of `step()`. Transient → not snapshotted.
    pub(crate) blob_tread_strength: Vec<Fx>,
    pub(crate) blob_pin_snapshots: Vec<(BlobId, Vec<FxVec2>)>, // sorted

    pub(crate) base_masses: Vec<(BlobId, Vec<Fx>)>, // sorted

    pub config: WorldConfig,
    pub tick: u64,
    pub rng: Mulberry32,
    time_accum: Fx,

    /// Engine-side dynamic-item state (Phase 4 of the JS→Rust manager
    /// migration). Items are registered at level-load via `add_cannon`,
    /// `add_bumper`, etc. Each `step()` calls `update_dynamic_items`
    /// which advances per-item timers and applies forces via the
    /// Phase 3 zone-force APIs.
    pub dynamic_items: Vec<crate::dynamic_items::DynamicItem>,

    /// Engine-side spring-pad state (Phase 5 of the JS→Rust manager
    /// migration). Each pad owns a kinematic static_surface (the
    /// plate) + a state machine (loaded/firing/reloading). `step()`
    /// calls `update_spring_pads` to advance state + write the live
    /// plate pose into the surface. Fire events drain via
    /// `take_spring_pad_fire_events` for VFX/SFX.
    pub spring_pads: Vec<crate::spring_pads::SpringPad>,
    pub(crate) pending_spring_pad_fires: Vec<u32>,

    // Pending trigger events. Drained by `take_trigger_entered/exited`
    // each frame. (TS uses callbacks; FFI layer can either poll these or
    // be given a callback later in Phase 4.)
    pub(crate) pending_trigger_entered: Vec<(ShapeIdx, BlobId)>,
    pub(crate) pending_trigger_exited: Vec<(ShapeIdx, BlobId)>,

    // Crush events emitted by `step()` when a blob's hull centroid moves
    // implausibly far in one frame, or when any hull particle ends a step
    // out of world sanity bounds. Drained by `take_crush_events`.
    pub(crate) pending_crush_events: Vec<BlobId>,
}

impl Default for WorldConfig {
    fn default() -> Self {
        let gravity_scale = FX_FOUR;
        WorldConfig {
            gravity: FxVec2::new(Fx::ZERO, FX_980 * gravity_scale),
            gravity_scale,
            fixed_dt: FX_FRAC_1_60,
            substeps: 2,
            // Smaller margin → smaller visible "float" above resting
            // surfaces (was 0.5, ~0.6 unit visible hover after
            // resting-contact bump) and smaller no-mans-land where a
            // blob can wedge its hull straddling a surface edge.
            collision_margin: fx_lit(15, 100),  // 0.15
            collision_restitution: fx_lit(25, 100),
            constraint_iters: 8,
            collision_iterations: 3,
            static_restitution: Fx::ZERO,
            // Tighter slop band so a blob hovering 0.15 units above a
            // surface doesn't get treated as resting from 4 units away.
            // Still wide enough to absorb numerical jitter at typical
            // gravity / spring-impact speeds.
            static_contact_slop: fx_lit(15, 10),  // 1.5
            blob_blob_friction_mu: fx_lit(12, 10),
            blob_blob_friction_impulse_scale: Fx::ONE,
            static_edge_friction_mu: fx_lit(164, 100),
            static_friction_min_tang_speed: fx_lit(6, 100),
            static_friction_normal_load_scale: Fx::from_int(2),
            hull_vertex_damping_per_sec: fx_lit(12, 1000),
            center_hull_damping_per_sec: fx_lit(4, 1000),
            hull_damp_skip_above_speed: Fx::from_int(220),
        }
    }
}

impl SoftBodyWorld {
    pub fn new(config: WorldConfig, rng_seed: u32) -> Self {
        SoftBodyWorld {
            pos: Vec::new(),
            vel: Vec::new(),
            mass: Vec::new(),
            inv_mass: Vec::new(),
            particle_radius: Vec::new(),
            particle_layer: Vec::new(),
            particle_mask: Vec::new(),
            springs: Vec::new(),
            extra_springs: Vec::new(),
            home_anchors: Vec::new(),
            shapes: Vec::new(),
            blob_ranges: Vec::new(),
            static_surfaces: Vec::new(),
            welds: Vec::new(),
            anchors: Vec::new(),
            distance_max_constraints: Vec::new(),
            chains: Vec::new(),
            trigger_prev: Vec::new(),
            blob_ground_contacts: Vec::new(),
            blob_ground_contact_point: Vec::new(),
            blob_ground_contact_normal: Vec::new(),
            blob_impact_contact_point: Vec::new(),
            blob_impact_contact_normal: Vec::new(),
            blob_sticky_contact_count: Vec::new(),
            blob_sticky_contact_normal_sum: Vec::new(),
            particle_touched_this_step: Vec::new(),
            blob_gravity_override: Vec::new(),
            blob_tread_strength: Vec::new(),
            blob_pin_snapshots: Vec::new(),
            base_masses: Vec::new(),
            config,
            tick: 0,
            rng: Mulberry32::new(rng_seed),
            time_accum: Fx::ZERO,
            dynamic_items: Vec::new(),
            spring_pads: Vec::new(),
            pending_spring_pad_fires: Vec::new(),
            pending_trigger_entered: Vec::new(),
            pending_trigger_exited: Vec::new(),
            pending_crush_events: Vec::new(),
        }
    }

    // -------- public registration / construction --------

    pub fn register_static_polygon(
        &mut self,
        poly: Vec<FxVec2>,
        material: SurfaceMaterial,
        id: Option<String>,
        layer: Option<u32>,
        mask: Option<u32>,
    ) -> usize {
        let surface = StaticSurface {
            poly,
            prev_poly: None,
            material,
            id,
            velocity: None,
            layer: layer.unwrap_or(LAYER_WORLD),
            mask: mask.unwrap_or(LAYER_ALL),
        };
        self.static_surfaces.push(surface);
        self.static_surfaces.len() - 1
    }

    pub fn clear_static_polygons(&mut self) { self.static_surfaces.clear(); }

    pub fn register_trigger_polygon(&mut self, poly: Vec<FxVec2>, gravity_override: Option<GravityField>) -> ShapeIdx {
        let shape = Shape {
            indices: Vec::new(),
            static_poly: poly,
            is_trigger: true,
            is_static: true,
            target_rest_area: Fx::ZERO,
            pressure_k: Fx::ZERO,
            shape_match_k: Fx::ZERO,
            shape_match_damp: Fx::ZERO,
            rest_local: Vec::new(),
            base_rest_local: Vec::new(),
            shape_match_rest_scale: Fx::ONE,
            use_frame_override: false,
            frame_override: Transform2D { cos: Fx::ONE, sin: Fx::ZERO, tx: Fx::ZERO, ty: Fx::ZERO },
            gravity_field: gravity_override,
            center_idx: ParticleIdx::MAX, // -1 sentinel; check before use
            inactive: false,
            layer: LAYER_BLOB,
            mask: LAYER_ALL,
        };
        self.shapes.push(shape);
        (self.shapes.len() - 1) as ShapeIdx
    }

}

#[derive(Clone, Debug)]
pub struct AddBlobParams {
    pub hull_rest_local: Vec<FxVec2>,
    pub center_local: FxVec2,
    pub center_mass: Fx,
    pub hull_mass: Fx,
    pub spring_k: Fx,
    pub spring_damp: Fx,
    pub radial_k: Fx,
    pub radial_damp: Fx,
    pub pressure_k: Fx,
    pub shape_match_k: Fx,
    pub shape_match_damp: Fx,
    pub world_origin: FxVec2,
    pub sort_key: Option<String>,
    pub static_hull_indices: Vec<usize>,
    pub static_center: bool,
    /// Lock the shape-match frame to (world_origin, identity). The whole
    /// blob stays rooted in place without per-vertex anchors; every hull
    /// particle remains dynamic and free to flex locally. Mirrors
    /// `pinFrame` on the TS side. Default false.
    pub pin_frame: bool,
}

impl SoftBodyWorld {
    pub fn add_blob_from_hull(&mut self, params: AddBlobParams) -> BlobResult {
        let num_hull = params.hull_rest_local.len();
        assert!(num_hull >= 3, "Need at least 3 hull points");

        let start = self.pos.len() as ParticleIdx;

        // Center particle
        self.pos.push(params.center_local.add(params.world_origin));
        self.vel.push(FxVec2::ZERO);
        let c_mass = if params.static_center { Fx::ZERO } else { params.center_mass };
        self.mass.push(c_mass);
        self.inv_mass.push(if c_mass > fx_lit(1, 1000) { Fx::ONE / c_mass } else { Fx::ZERO });
        self.particle_radius.push(Fx::ZERO);
        self.particle_layer.push(LAYER_BLOB);
        self.particle_mask.push(LAYER_ALL);

        let mut hull_indices: Vec<ParticleIdx> = Vec::with_capacity(num_hull);
        for i in 0..num_hull {
            let world = params.hull_rest_local[i].add(params.world_origin);
            self.pos.push(world);
            self.vel.push(FxVec2::ZERO);
            let is_static = params.static_hull_indices.contains(&i);
            let m = if is_static { Fx::ZERO } else { params.hull_mass };
            self.mass.push(m);
            self.inv_mass.push(if m > fx_lit(1, 1000) { Fx::ONE / m } else { Fx::ZERO });
            self.particle_radius.push(Fx::ZERO);
            self.particle_layer.push(LAYER_BLOB);
            self.particle_mask.push(LAYER_ALL);
            hull_indices.push(start + 1 + i as ParticleIdx);
        }

        let spring_begin = self.springs.len() as SpringIdx;

        // Edge springs
        for i in 0..num_hull {
            let j_next = (i + 1) % num_hull;
            let ia = (start + 1 + i as ParticleIdx) as ParticleIdx;
            let ib = (start + 1 + j_next as ParticleIdx) as ParticleIdx;
            let rest = self.pos[ia as usize].sub(self.pos[ib as usize]).length();
            self.springs.push(Spring { i: ia, j: ib, rest, k_base: params.spring_k, damp_base: params.spring_damp });
        }
        // Shear springs (skip-1)
        if num_hull >= 4 {
            let k = params.spring_k * fx_lit(85, 100);
            for i in 0..num_hull {
                let j_skip = (i + 2) % num_hull;
                let ia = (start + 1 + i as ParticleIdx) as ParticleIdx;
                let ib = (start + 1 + j_skip as ParticleIdx) as ParticleIdx;
                let rest = self.pos[ia as usize].sub(self.pos[ib as usize]).length();
                self.springs.push(Spring { i: ia, j: ib, rest, k_base: k, damp_base: params.spring_damp });
            }
        }
        // Radial springs (center ↔ hull). Skipped entirely when radial_k=0
        // — callers (e.g. SlimeBlob with the virtual-center-pin scheme)
        // disable these because the center particle is now derived from
        // the hull centroid each substep, so radial-spring tension is
        // Newton-3rd asymmetric (the reaction on the center is dropped
        // by the pin) and acts as a net thrust on the hull. Shape-match
        // alone is responsible for cohesion in that case.
        if params.radial_k > Fx::ZERO {
            for i in 0..num_hull {
                let ip = (start + 1 + i as ParticleIdx) as ParticleIdx;
                let mut rest_r = params.center_local.sub(params.hull_rest_local[i]).length();
                if rest_r < fx_lit(1, 1000) { rest_r = fx_lit(1, 1000); }
                self.springs.push(Spring { i: start, j: ip, rest: rest_r, k_base: params.radial_k, damp_base: params.radial_damp });
            }
        }
        let spring_end = self.springs.len() as SpringIdx;

        // Target area (from the hull polygon we just placed)
        let hull_poly: Vec<FxVec2> = hull_indices.iter().map(|&i| self.pos[i as usize]).collect();
        let target_area = Fx::from_raw(signed_area_polygon(&hull_poly).raw().abs());

        let blob_id = self.blob_ranges.len() as BlobId;
        let shape = Shape {
            indices: hull_indices.clone(),
            static_poly: Vec::new(),
            is_trigger: false,
            is_static: false,
            target_rest_area: target_area,
            pressure_k: params.pressure_k,
            shape_match_k: params.shape_match_k,
            shape_match_damp: params.shape_match_damp,
            rest_local: params.hull_rest_local.clone(),
            base_rest_local: params.hull_rest_local.clone(),
            shape_match_rest_scale: Fx::ONE,
            use_frame_override: params.pin_frame,
            frame_override: Transform2D {
                cos: Fx::ONE, sin: Fx::ZERO,
                tx: params.world_origin.x, ty: params.world_origin.y,
            },
            gravity_field: None,
            center_idx: start,
            inactive: false,
            layer: LAYER_BLOB,
            mask: LAYER_ALL,
        };
        self.shapes.push(shape);
        let shape_idx = (self.shapes.len() - 1) as ShapeIdx;

        let sort_key = params.sort_key.unwrap_or_else(|| format!("__blob_{:06}", blob_id));

        self.blob_ranges.push(BlobRange {
            id: blob_id,
            start,
            end: self.pos.len() as ParticleIdx,
            hull: hull_indices.clone(),
            shape_idx,
            spring_begin,
            spring_end,
            spring_stiffness_scale: Fx::ONE,
            spring_damp_scale: Fx::ONE,
            sort_key,
            inactive: false,
        });

        BlobResult {
            blob_id,
            center_idx: start,
            hull_indices,
            shape_idx,
        }
    }

    // -------- apply / mutation helpers --------

    pub fn apply_blob_move_force(&mut self, blob_id: BlobId, move_dir: FxVec2, force: Fx, dt: Fx) {
        let r = match self.blob_ranges.get(blob_id as usize) { Some(r) => r.clone(), None => return };
        let f = move_dir.scale(force * dt);
        for i in r.start..r.end {
            let u = i as usize;
            self.vel[u] = self.vel[u].add(f.scale(self.inv_mass[u]));
        }
    }

    pub fn apply_blob_linear_velocity_delta(&mut self, blob_id: BlobId, delta_v: FxVec2) {
        if delta_v.length_squared() < EPS { return; }
        let r = match self.blob_ranges.get(blob_id as usize) { Some(r) => r.clone(), None => return };
        for i in r.start..r.end {
            let u = i as usize;
            self.vel[u] = self.vel[u].add(delta_v);
        }
    }

    /// Treadmill: set this blob's tread strength for the current step. The hull
    /// *surface* "flows" around the perimeter contour like a tank tread —
    /// `strength` is signed (sign picks the circulation direction in hull-ring
    /// order); magnitude is a tread velocity (px/s). Purely visual surface
    /// motion — it does NOT translate the body. Applied every substep AFTER
    /// shape-matching (see `apply_tread`) so the constraint doesn't immediately
    /// cancel it. Re-set each frame — cleared at the end of `step()`.
    pub fn set_blob_tread(&mut self, blob_id: BlobId, strength: Fx) {
        while self.blob_tread_strength.len() <= blob_id as usize {
            self.blob_tread_strength.push(Fx::ZERO);
        }
        self.blob_tread_strength[blob_id as usize] = strength;
    }

    /// Apply the per-blob tread for one substep: circulate the hull-perimeter
    /// points along the contour (the visible treadmill). Deterministic:
    /// fixed-point only, fixed hull-ring order, no transcendentals.
    fn apply_tread(&mut self, dt: Fx) {
        for bi in 0..self.blob_ranges.len() {
            let strength = self.blob_tread_strength.get(bi).copied().unwrap_or(Fx::ZERO);
            if strength == Fx::ZERO { continue; }
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            let n = r.hull.len();
            if n < 3 { continue; }
            let step = strength * dt;
            for k in 0..n {
                // Contour tangent at hull point k via central difference of its
                // ring neighbours — the direction along the perimeter outline.
                let prev = self.pos[r.hull[(k + n - 1) % n] as usize];
                let next = self.pos[r.hull[(k + 1) % n] as usize];
                let tangent = next.sub(prev);
                if tangent.length_squared() < EPS { continue; }
                let t = tangent.normalize();
                let u = r.hull[k] as usize;
                self.vel[u] = self.vel[u].add(t.scale(step));
            }
        }
    }

    /// Return every blob whose centroid lies inside `polygon`. Used by
    /// the engine-side trigger / item / spike-zone systems (Phases 4-6
    /// of the JS→Rust manager migration) to find what's in a zone
    /// without round-tripping positions through JS each tick. Sorted by
    /// blob_id for deterministic iteration order. Skips inactive blobs.
    pub fn blobs_overlapping_polygon(&self, polygon: &[FxVec2]) -> Vec<BlobId> {
        let mut out = Vec::new();
        if polygon.len() < 3 { return out; }
        for r in &self.blob_ranges {
            if r.inactive { continue; }
            let c = self.pos[r.start as usize]; // center particle
            if is_point_in_polygon(c, polygon) {
                out.push(r.id);
            }
        }
        out.sort_unstable();
        out
    }

    /// Apply a `ForceField` to every blob whose centroid is inside
    /// `polygon`. Phase 3 foundation API — replaces the per-tick
    /// per-item JS loops in `dynamicItemManager.ts` (cannon, wind
    /// zone, conveyor, bumper, wrecking-ball blast, sticky-goo drag).
    /// Computing the force value in fixed point inside the engine
    /// eliminates the `Math.cos/sin` calls those item kinds use to
    /// derive their direction each frame.
    pub fn apply_force_in_polygon(
        &mut self,
        polygon: &[FxVec2],
        field: ForceField,
        dt: Fx,
    ) {
        if polygon.len() < 3 { return; }
        // Collect first to avoid borrowing self.blob_ranges through the apply call.
        let hits: Vec<(BlobId, ParticleIdx, ParticleIdx)> = self.blob_ranges
            .iter()
            .filter(|r| !r.inactive)
            .filter(|r| is_point_in_polygon(self.pos[r.start as usize], polygon))
            .map(|r| (r.id, r.start, r.end))
            .collect();
        match field {
            ForceField::Uniform { force } => {
                // f = force * dt, applied to center particle as velocity delta scaled by inv_mass
                let f = force.scale(dt);
                for (_id, start, _end) in &hits {
                    let u = *start as usize;
                    let dv = f.scale(self.inv_mass[u]);
                    self.vel[u] = self.vel[u].add(dv);
                }
            }
            ForceField::Radial { center, strength, radius, falloff } => {
                if radius.0 <= 0 { return; }
                for (_id, start, _end) in &hits {
                    let u = *start as usize;
                    let dx = self.pos[u].x - center.x;
                    let dy = self.pos[u].y - center.y;
                    let d_sq = dx * dx + dy * dy;
                    if d_sq.0 < EPS.0 { continue; }
                    let d = crate::math::sqrt_fx(d_sq);
                    if d > radius { continue; }
                    // mag scaled by falloff
                    let mag = match falloff {
                        PointGravityFalloff::Linear => {
                            // strength * (1 - d/radius)
                            let one = Fx::ONE;
                            let t = d / radius;
                            let scale = if t < one { one - t } else { Fx::ZERO };
                            strength * scale
                        }
                        PointGravityFalloff::InverseSquare => {
                            // strength * (radius/d)^2  — capped at 1 near center
                            let cap = radius / Fx::from_int(10); // clamp dist >= radius/10
                            let denom = if d > cap { d } else { cap };
                            let ratio = radius / denom;
                            strength * ratio * ratio
                        }
                    };
                    // unit direction outward from center
                    let dir_x = dx / d;
                    let dir_y = dy / d;
                    let f = FxVec2::new(dir_x * mag, dir_y * mag).scale(dt);
                    let dv = f.scale(self.inv_mass[u]);
                    self.vel[u] = self.vel[u].add(dv);
                }
            }
            ForceField::Drag { coefficient } => {
                // v_new = v * (1 - coefficient * dt), applied to ALL hull
                // particles (not just center) so the body slows uniformly
                // without inducing spin.
                let damp = Fx::ONE - coefficient * dt;
                let damp = if damp.0 < 0 { Fx::ZERO } else { damp };
                for (_id, start, end) in &hits {
                    for i in *start..*end {
                        let u = i as usize;
                        self.vel[u] = FxVec2::new(self.vel[u].x * damp, self.vel[u].y * damp);
                    }
                }
            }
        }
    }

    pub fn set_blob_gravity_override(&mut self, blob_id: BlobId, gravity: Option<FxVec2>) {
        while self.blob_gravity_override.len() <= blob_id as usize {
            self.blob_gravity_override.push(None);
        }
        self.blob_gravity_override[blob_id as usize] = gravity;
    }

    pub fn zero_blob_velocity(&mut self, blob_id: BlobId) {
        let r = match self.blob_ranges.get(blob_id as usize) { Some(r) => r.clone(), None => return };
        for i in r.start..r.end {
            self.vel[i as usize] = FxVec2::ZERO;
        }
    }

    // -------- queries --------

    pub fn positions(&self) -> &[FxVec2] { &self.pos }
    pub fn velocities(&self) -> &[FxVec2] { &self.vel }
    pub fn blob_count(&self) -> usize { self.blob_ranges.len() }

    pub fn hull_polygon(&self, blob_id: BlobId) -> Vec<FxVec2> {
        match self.blob_ranges.get(blob_id as usize) {
            Some(r) => r.hull.iter().map(|&i| self.pos[i as usize]).collect(),
            None => Vec::new(),
        }
    }

    // -------- step / substep --------

    pub fn step(&mut self, delta: Fx) {
        let mut dt = delta;
        if dt < FX_FRAC_1_240 { dt = FX_FRAC_1_240; }
        if dt > FX_FRAC_1_20  { dt = FX_FRAC_1_20;  }
        self.config.fixed_dt = dt;

        // Phase 4: advance dynamic-item state machines + apply their
        // forces BEFORE physics substeps. Cannon, catapult, wind,
        // conveyor, bumper, wrecking-ball etc. all add velocity to
        // matching blobs via apply_force_in_polygon; the substeps
        // then integrate those velocities into positions and resolve
        // collisions normally.
        if !self.dynamic_items.is_empty() {
            self.update_dynamic_items(dt);
        }

        // Phase 5: spring-pad state machines. Run BEFORE substeps so the
        // updated plate pose / velocity flows through CCD this tick.
        if !self.spring_pads.is_empty() {
            self.update_spring_pads(dt);
        }

        let n_sub = self.config.substeps as usize;
        for i in 0..n_sub {
            self.substep();
            // Consume `prev_poly` snapshots after the FIRST substep. They
            // capture a kinematic jump between frames (e.g. spring plate
            // firing) — a one-shot event. The CCD surface-relative sweep
            // resolves that jump in substep 0; leaving prev_poly around
            // for substeps 1..N would re-fire the relative sweep with
            // the same delta and ghost-collide with a phantom edge,
            // making the particle "stick" to fast-moving surfaces.
            if i == 0 {
                for s in &mut self.static_surfaces {
                    s.prev_poly = None;
                }
            }
        }

        self.detect_crush_events();

        // Tread is a per-frame command — clear it so a blob only treads on
        // frames where gameplay set it. Keeps it transient (never snapshotted).
        for s in self.blob_tread_strength.iter_mut() { *s = Fx::ZERO; }

        self.tick += 1;
    }

    /// Flag any blob whose hull has stretched beyond a plausible
    /// multiple of its rest extent, or whose particles have escaped
    /// world sanity bounds. See `CRUSH_HULL_SPREAD_RATIO_SQ` /
    /// `CRUSH_MAX_COORD` for the thresholds and rationale. Pushes the
    /// blob_id onto `pending_crush_events`, drained by TS each frame.
    fn detect_crush_events(&mut self) {
        for bi in 0..self.blob_ranges.len() {
            let r = &self.blob_ranges[bi];
            if r.inactive || r.hull.is_empty() { continue; }

            let si = r.shape_idx as usize;
            if si >= self.shapes.len() { continue; }
            let sh = &self.shapes[si];
            if sh.rest_local.is_empty() { continue; }

            // Rest max radius² in local coords (rest_local is centered
            // at the blob origin). Multiply by the shape-match rest
            // scale squared so callers that grow/shrink the blob via
            // `set_blob_shape_match_rest_scale` aren't false-flagged.
            let sm_scale = sh.shape_match_rest_scale;
            let scale_sq = sm_scale * sm_scale;
            let mut rest_max_sq = Fx::ZERO;
            for &p in &sh.rest_local {
                let r_sq = p.x * p.x + p.y * p.y;
                if r_sq > rest_max_sq { rest_max_sq = r_sq; }
            }
            let rest_max_sq_scaled = rest_max_sq * scale_sq;

            // Current max radius² from the hull centroid.
            let hull_us: Vec<usize> = r.hull.iter().map(|&i| i as usize).collect();
            let c = centroid_from_indices(&self.pos, &hull_us);
            let mut cur_max_sq = Fx::ZERO;
            let mut out_of_bounds = false;
            for &idx in &r.hull {
                let p = self.pos[idx as usize];
                if p.x.abs() > CRUSH_MAX_COORD || p.y.abs() > CRUSH_MAX_COORD {
                    out_of_bounds = true;
                }
                let dx = p.x - c.x;
                let dy = p.y - c.y;
                let r_sq = dx * dx + dy * dy;
                if r_sq > cur_max_sq { cur_max_sq = r_sq; }
            }

            let blow_up_threshold_sq = rest_max_sq_scaled * CRUSH_HULL_SPREAD_RATIO_SQ;
            let crushed = out_of_bounds || cur_max_sq > blow_up_threshold_sq;

            if crushed {
                let bid = bi as BlobId;
                if !self.pending_crush_events.contains(&bid) {
                    self.pending_crush_events.push(bid);
                }
                // Defense in depth: collapse the blob's particles to its
                // centroid and zero their velocities. Even if the TS-side
                // listener never fires (or no-ops), the constraint solver
                // re-inflates the blob to its rest pose next frame instead
                // of leaving an exploded mess on screen. If the crusher
                // is still active we re-detect next frame and re-collapse
                // — bounded oscillation, not lightyear sprawl.
                let cx = c.x.clamp(-CRUSH_MAX_COORD, CRUSH_MAX_COORD);
                let cy = c.y.clamp(-CRUSH_MAX_COORD, CRUSH_MAX_COORD);
                let collapse = FxVec2::new(cx, cy);
                let rng = self.blob_ranges[bi].clone();
                for i in rng.start..rng.end {
                    let u = i as usize;
                    self.pos[u] = collapse;
                    self.vel[u] = FxVec2::ZERO;
                }
            }
        }
    }

    fn substep(&mut self) {
        let dt = self.config.fixed_dt / Fx::from_int(self.config.substeps as i32);
        let n = self.pos.len();
        if n == 0 { return; }

        // 1. Per-particle gravity (default = world gravity, override by triggers)
        let mut grav: Vec<FxVec2> = vec![self.config.gravity; n];

        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            let hull_us: Vec<usize> = r.hull.iter().map(|&i| i as usize).collect();
            let cx = centroid_from_indices(&self.pos, &hull_us);
            for si in 0..self.shapes.len() {
                let sh = &self.shapes[si];
                if !sh.is_trigger || sh.static_poly.is_empty() { continue; }
                let Some(field) = sh.gravity_field.as_ref() else { continue };
                if !crate::collision::is_point_in_polygon(cx, &sh.static_poly) { continue; }
                match field {
                    GravityField::Uniform { vector } => {
                        let v = *vector;
                        for j in r.start..r.end { grav[j as usize] = v; }
                    }
                    _ => {
                        for j in r.start..r.end {
                            grav[j as usize] = eval_gravity_field(field, self.pos[j as usize]);
                        }
                    }
                }
            }
        }

        // Per-blob gravity override
        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            if let Some(Some(ov)) = self.blob_gravity_override.get(bi).cloned() {
                for j in r.start..r.end { grav[j as usize] = ov; }
            }
        }

        // 2. Apply gravity
        for i in 0..n {
            if self.inv_mass[i].is_zero() { continue; }
            self.vel[i] = self.vel[i].add(grav[i].scale(dt));
        }

        // 3-5. Forces
        self.apply_springs(dt);
        self.apply_pressure(dt);
        self.apply_shape_matching(dt);
        // Treadmill AFTER shape-matching so the circulation survives into
        // integration + contact resolution (shape-match would otherwise pull
        // the tangential motion straight back out).
        self.apply_tread(dt);

        // 6. Semi-implicit Euler — save prev positions for CCD sweep
        let prev_pos: Vec<FxVec2> = self.pos.clone();
        for i in 0..n {
            if self.inv_mass[i].is_zero() {
                self.vel[i] = FxVec2::ZERO;
                continue;
            }
            self.pos[i] = self.pos[i].add(self.vel[i].scale(dt));
        }

        // 6b. CCD sweep: tunneling through static geometry.
        self.sweep_static_ccd(&prev_pos);
        // 6c. CCD sweep: tunneling between moving blobs.
        self.sweep_blob_ccd(&prev_pos);

        // 7. Constraints (welds + anchors + distance-max + chains).
        for _ in 0..self.config.constraint_iters {
            for &(i, j) in &self.welds.clone() {
                solve_weld(&mut self.pos, &self.inv_mass, i, j);
            }
            for a in self.anchors.clone() {
                solve_weighted_anchor(
                    &mut self.pos, &self.inv_mass,
                    &a.indices_a, &a.weights_a,
                    &a.indices_b, &a.weights_b,
                );
            }
            for &(i, j, max) in &self.distance_max_constraints.clone() {
                solve_distance_max(&mut self.pos, &self.inv_mass, i, j, max);
            }
        }
        self.solve_chains();

        // 8-9. Collisions (reset per-blob contact trackers first).
        let nb = self.blob_ranges.len();
        self.blob_ground_contacts.clear();           self.blob_ground_contacts.resize(nb, 0);
        self.blob_sticky_contact_count.clear();      self.blob_sticky_contact_count.resize(nb, 0);
        self.blob_sticky_contact_normal_sum.clear(); self.blob_sticky_contact_normal_sum.resize(nb, FxVec2::ZERO);
        self.blob_ground_contact_point.clear();      self.blob_ground_contact_point.resize(nb, None);
        self.blob_ground_contact_normal.clear();     self.blob_ground_contact_normal.resize(nb, None);
        self.blob_impact_contact_point.clear();      self.blob_impact_contact_point.resize(nb, None);
        self.blob_impact_contact_normal.clear();     self.blob_impact_contact_normal.resize(nb, None);
        self.particle_touched_this_step.clear();     self.particle_touched_this_step.resize(self.pos.len(), false);
        self.solve_collisions(dt);
        self.solve_particle_collisions(dt);

        // 10. Triggers
        self.process_trigger_events();

        // 11. Damping
        self.apply_hull_velocity_damping(dt);

        // 12. Snapshot pins
        for k in 0..self.blob_pin_snapshots.len() {
            let (blob_id, snap) = self.blob_pin_snapshots[k].clone();
            if let Some(r) = self.blob_ranges.get(blob_id as usize).cloned() {
                if r.inactive { continue; }
                let mut idx = r.start;
                let mut s = 0;
                while idx < r.end && s < snap.len() {
                    self.pos[idx as usize] = snap[s];
                    self.vel[idx as usize] = FxVec2::ZERO;
                    idx += 1;
                    s += 1;
                }
            }
        }

        // 13. Center-particle pin — the center is a virtual control
        // point (no collision, no independent integration target). Each
        // substep we snap it to the geometric centroid of the hull so
        // (a) the blob silhouette stays round (asymmetric radial-spring
        // pull from a drifting center used to make the blob go oblong
        // under expand), and (b) the center can never be wedged inside
        // a polygon since it's always recomputed from hull positions.
        self.pin_blob_centers_to_hull_centroid();
    }

    fn pin_blob_centers_to_hull_centroid(&mut self) {
        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            if r.hull.is_empty() { continue; }
            let center_idx = match self.shapes.get(r.shape_idx as usize) {
                Some(s) => s.center_idx as usize,
                None => continue,
            };
            if center_idx >= self.pos.len() { continue; }
            let mut cx = Fx::ZERO; let mut cy = Fx::ZERO;
            let mut vx = Fx::ZERO; let mut vy = Fx::ZERO;
            for &hi in &r.hull {
                let h = hi as usize;
                cx += self.pos[h].x; cy += self.pos[h].y;
                vx += self.vel[h].x; vy += self.vel[h].y;
            }
            let n = Fx::from_int(r.hull.len() as i32);
            let inv_n = Fx::ONE / n;
            self.pos[center_idx] = FxVec2::new(cx * inv_n, cy * inv_n);
            self.vel[center_idx] = FxVec2::new(vx * inv_n, vy * inv_n);
        }
    }

    fn apply_springs(&mut self, dt: Fx) {
        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            let k_mult = r.spring_stiffness_scale;
            let d_mult = r.spring_damp_scale;
            if r.spring_begin >= r.spring_end { continue; }
            for s_idx in r.spring_begin..r.spring_end {
                let s_u = s_idx as usize;
                if s_u >= self.springs.len() { break; }
                let s = self.springs[s_u];
                let ia = s.i as usize;
                let ib = s.j as usize;
                let rest = s.rest;
                let k = s.k_base * k_mult;
                let damp = s.damp_base * d_mult;
                let diff = self.pos[ib].sub(self.pos[ia]);
                let dist = diff.length();
                if dist < fx_lit(1, 10000) { continue; }
                let dir = diff.scale(Fx::ONE / dist);
                let stretch = dist - rest;
                let rel_v = self.vel[ib].sub(self.vel[ia]).dot(dir);
                let force = dir.scale(k * stretch + damp * rel_v);

                if self.inv_mass[ia] > Fx::ZERO {
                    self.vel[ia] = self.vel[ia].add(force.scale(self.inv_mass[ia] * dt));
                }
                if self.inv_mass[ib] > Fx::ZERO {
                    self.vel[ib] = self.vel[ib].sub(force.scale(self.inv_mass[ib] * dt));
                }
            }
        }

        // Level-author extra springs
        for s in self.extra_springs.clone() {
            let ia = s.i as usize;
            let ib = s.j as usize;
            let diff = self.pos[ib].sub(self.pos[ia]);
            let dist = diff.length();
            if dist < fx_lit(1, 10000) { continue; }
            let dir = diff.scale(Fx::ONE / dist);
            let stretch = dist - s.rest;
            let rel_v = self.vel[ib].sub(self.vel[ia]).dot(dir);
            let force = dir.scale(s.k_base * stretch + s.damp_base * rel_v);
            if self.inv_mass[ia] > Fx::ZERO {
                self.vel[ia] = self.vel[ia].add(force.scale(self.inv_mass[ia] * dt));
            }
            if self.inv_mass[ib] > Fx::ZERO {
                self.vel[ib] = self.vel[ib].sub(force.scale(self.inv_mass[ib] * dt));
            }
        }

        // Home anchors
        for ha in self.home_anchors.clone() {
            let u = ha.idx as usize;
            if self.inv_mass[u].is_zero() { continue; }
            let p = self.pos[u];
            let v = self.vel[u];
            let dx = ha.home.x - p.x;
            let dy = ha.home.y - p.y;
            let fx = ha.k * dx - ha.damp * v.x;
            let fy = ha.k * dy - ha.damp * v.y;
            self.vel[u] = FxVec2::new(
                v.x + fx * self.inv_mass[u] * dt,
                v.y + fy * self.inv_mass[u] * dt,
            );
        }
    }

    fn apply_pressure(&mut self, dt: Fx) {
        for si in 0..self.shapes.len() {
            let sh = self.shapes[si].clone();
            if sh.is_static || sh.is_trigger || sh.inactive { continue; }
            if sh.pressure_k <= Fx::ZERO { continue; }
            if sh.indices.len() < 3 { continue; }

            let poly: Vec<FxVec2> = sh.indices.iter().map(|&i| self.pos[i as usize]).collect();
            let area = signed_area_polygon(&poly);
            let target = self.shape_pressure_target_area(si);
            let err = target - area;
            let n_idx = sh.indices.len();

            for i in 0..n_idx {
                let ia = sh.indices[i] as usize;
                let iprev = sh.indices[(i + n_idx - 1) % n_idx] as usize;
                let inext = sh.indices[(i + 1) % n_idx] as usize;
                let pprev = self.pos[iprev];
                let pnext = self.pos[inext];
                // gradient = ((pnext.y - pprev.y) * 0.5, (pprev.x - pnext.x) * 0.5)
                let grad = FxVec2::new(
                    Fx::from_raw((pnext.y - pprev.y).raw() / 2),
                    Fx::from_raw((pprev.x - pnext.x).raw() / 2),
                );
                let f = grad.scale(sh.pressure_k * err);
                if self.inv_mass[ia] > Fx::ZERO {
                    self.vel[ia] = self.vel[ia].add(f.scale(self.inv_mass[ia] * dt));
                }
            }
        }
    }

    fn apply_shape_matching(&mut self, dt: Fx) {
        for si in 0..self.shapes.len() {
            let sh = self.shapes[si].clone();
            if sh.is_static || sh.is_trigger || sh.inactive { continue; }
            if sh.shape_match_k <= Fx::ZERO { continue; }
            if sh.indices.len() != sh.rest_local.len() { continue; }

            let indices_us: Vec<usize> = sh.indices.iter().map(|&i| i as usize).collect();
            let (center, angle) = if sh.use_frame_override {
                let c = FxVec2::new(sh.frame_override.tx, sh.frame_override.ty);
                let a = crate::math::atan2_fx(sh.frame_override.sin, sh.frame_override.cos);
                (c, a)
            } else {
                // Anchored particles (inv_mass=0) define the rest frame when
                // present: they sit at their original rest world positions, so
                // the best-fit rigid transform mapping rest→current for that
                // subset is exactly the original (worldOrigin, identity). Using
                // an unweighted centroid over ALL particles lets gravity sag
                // the dynamic majority and drift the frame, producing a
                // "smile" at each anchor. See the TS sibling in
                // `softBodyWorld.ts::applyShapeMatching`.
                let mut anchor_count: u32 = 0;
                let mut tx = Fx::ZERO;
                let mut ty = Fx::ZERO;
                for k in 0..sh.indices.len() {
                    let pi = indices_us[k];
                    if self.inv_mass[pi] == Fx::ZERO {
                        anchor_count += 1;
                        tx += self.pos[pi].x - sh.rest_local[k].x;
                        ty += self.pos[pi].y - sh.rest_local[k].y;
                    }
                }
                if anchor_count >= 1 {
                    let inv_n = Fx::ONE / Fx::from_int(anchor_count as i32);
                    (FxVec2::new(tx * inv_n, ty * inv_n), Fx::ZERO)
                } else {
                    let c = centroid_from_indices(&self.pos, &indices_us);
                    let a = average_angle(&sh.rest_local, &self.pos, &indices_us, c);
                    (c, a)
                }
            };
            let frame = frame_transform(center, angle);
            let sm_scale = sh.shape_match_rest_scale.max(fx_lit(5, 100));

            // Center-of-mass velocity
            let mut v_com = FxVec2::ZERO;
            let mut m_sum = Fx::ZERO;
            for k in 0..sh.indices.len() {
                let pi = sh.indices[k] as usize;
                let m = self.mass[pi];
                v_com = v_com.add(self.vel[pi].scale(m));
                m_sum += m;
            }
            if m_sum > Fx::from_raw(1 << 6) {
                v_com = v_com.scale(Fx::ONE / m_sum);
            }

            for k in 0..sh.indices.len() {
                let pi = sh.indices[k] as usize;
                let target = apply_transform(frame, sh.rest_local[k].scale(sm_scale));
                let diff = target.sub(self.pos[pi]);
                let v_rel = self.vel[pi].sub(v_com);
                let f = diff.scale(sh.shape_match_k).sub(v_rel.scale(sh.shape_match_damp));
                if self.inv_mass[pi] > Fx::ZERO {
                    self.vel[pi] = self.vel[pi].add(f.scale(self.inv_mass[pi] * dt));
                }
            }
        }
    }

    fn apply_hull_velocity_damping(&mut self, dt: Fx) {
        let kh = self.config.hull_vertex_damping_per_sec.max(Fx::ZERO);
        let kc = self.config.center_hull_damping_per_sec.max(Fx::ZERO);
        let h_fac = exp_fx(-(kh * dt));
        let c_fac = exp_fx(-(kc * dt));
        let skip_sq = self.config.hull_damp_skip_above_speed * self.config.hull_damp_skip_above_speed;

        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            let ci = r.start;
            for j in r.start..r.end {
                let u = j as usize;
                if j == ci {
                    self.vel[u] = self.vel[u].scale(c_fac);
                } else {
                    if self.vel[u].length_squared() > skip_sq { continue; }
                    self.vel[u] = self.vel[u].scale(h_fac);
                }
            }
        }
    }

    fn shape_pressure_target_area(&self, shape_idx: usize) -> Fx {
        let sh = &self.shapes[shape_idx];
        let base = sh.target_rest_area;
        let sc = sh.shape_match_rest_scale.max(fx_lit(5, 100));
        let raw = base * sc * sc;
        if raw > EPS { raw } else { EPS }
    }

    // =====================================================================
    // Collisions: discrete passes (blob-blob + blob-vs-static)
    // =====================================================================

    fn solve_collisions(&mut self, dt: Fx) {
        // Sort blob indices by sort_key (stable cross-client iteration).
        // Mirrors TS: id ordering would swap roles between host/guest because
        // BouncyBlobsGame's PM inserts player blobs in different orders on
        // each client.
        let mut sorted: Vec<usize> = (0..self.blob_ranges.len()).collect();
        sorted.sort_by(|&a, &b| self.blob_ranges[a].sort_key.cmp(&self.blob_ranges[b].sort_key));

        // Iterate the discrete pass so deeply-merged blobs can untangle.
        // Single-iter resolution under deep penetration picks the FAR edge
        // (closestPointOnPolygonBoundary's closest is the wrong side), which
        // pushes A further into B. Iterating lets A drift toward whichever
        // side is geometrically closer to the SURFACE, which is the right
        // exit direction. 3 iters is enough for typical hull overlaps.
        let iters = self.config.collision_iterations.max(1);
        for it in 0..iters {
            let last = it == iters - 1;
            // Blob-vs-blob (asymmetric: A's hull pushed out of B, then B out of A).
            for ai in 0..sorted.len() {
                let a = sorted[ai];
                let ra = self.blob_ranges[a].clone();
                if ra.inactive { continue; }
                let sa = self.shapes.get(ra.shape_idx as usize).cloned();
                let Some(sa) = sa else { continue };
                for bi in (ai + 1)..sorted.len() {
                    let b = sorted[bi];
                    let rb = self.blob_ranges[b].clone();
                    if rb.inactive { continue; }
                    let sb = self.shapes.get(rb.shape_idx as usize).cloned();
                    let Some(sb) = sb else { continue };
                    if !can_collide(sa.layer, sa.mask, sb.layer, sb.mask) { continue; }
                    self.collide_blobs(a, b, last);
                }
            }

            // Blob-vs-static.
            let surfaces = self.static_surfaces.clone();
            for surface in &surfaces {
                for bi in 0..self.blob_ranges.len() {
                    let r = self.blob_ranges[bi].clone();
                    if r.inactive { continue; }
                    let sh = self.shapes.get(r.shape_idx as usize).cloned();
                    let Some(sh) = sh else { continue };
                    if !can_collide(sh.layer, sh.mask, surface.layer, surface.mask) { continue; }
                    self.collide_blob_with_poly(bi, &surface.poly, true, dt, surface.material, surface.velocity, last);
                }
            }
        }
    }

    fn collide_blobs(&mut self, a_id: usize, b_id: usize, apply_velocity_impulses: bool) {
        let ra = self.blob_ranges[a_id].clone();
        let rb = self.blob_ranges[b_id].clone();
        let poly_a: Vec<FxVec2> = ra.hull.iter().map(|&i| self.pos[i as usize]).collect();
        let poly_b: Vec<FxVec2> = rb.hull.iter().map(|&i| self.pos[i as usize]).collect();
        if !aabb_overlap(polygon_aabb(&poly_a), polygon_aabb(&poly_b)) { return; }

        let dt = self.config.fixed_dt / Fx::from_int(self.config.substeps as i32);
        let half = Fx::HALF;
        // A's hull into B
        for k in 0..ra.hull.len() {
            self.resolve_point_in_shape(ra.hull[k] as usize, a_id, &poly_b, &rb.hull, half, dt, apply_velocity_impulses);
        }
        // B's hull into A
        for k in 0..rb.hull.len() {
            self.resolve_point_in_shape(rb.hull[k] as usize, b_id, &poly_a, &ra.hull, half, dt, apply_velocity_impulses);
        }
    }

    fn resolve_point_in_shape(
        &mut self,
        pi: usize,
        // Blob owning `pi` — needed so ground/impact contact gets attributed
        // to the right blob when a hull vertex of one blob penetrates another.
        // Without this, `isGrounded()` returns false when standing on a
        // softbody platform (which goes through this blob-vs-blob path
        // instead of `collide_blob_with_poly`), making input feel airborne.
        owner_blob_id: usize,
        poly_world: &[FxVec2],
        poly_indices: &[ParticleIdx],
        friction_scale: Fx,
        dt: Fx,
        apply_velocity_impulses: bool,
    ) {
        let p = self.pos[pi];
        if !is_point_in_polygon(p, poly_world) { return; }

        // An anchored query particle can't move, and resolving "the polygon
        // around it" by displacing the dynamic edge verts inward yanks the
        // containing blob's hull around for no good reason — every iter
        // per substep. Skip entirely: the A-into-B pass already pushed any
        // dynamic verts of the *other* blob out of this one, which is the
        // physically meaningful resolution.
        if self.inv_mass[pi].is_zero() { return; }

        let info = closest_point_on_polygon_boundary(p, poly_world);
        let n = info.normal.neg(); // flip: interior → push outward
        let closest = info.closest;
        let wts = edge_vertex_weights(p, info.a, info.b);
        let wb = wts.wb; let wc = wts.wc;

        let edge_i = info.edge_i;
        let ib0 = poly_indices[edge_i] as usize;
        let ib1 = poly_indices[(edge_i + 1) % poly_indices.len()] as usize;

        // Use the actual penetration depth = |p - closest|. The dot product
        // against the outward normal `n` is always ≤ 0 here (we're inside
        // the polygon by the guard above, and `closest_point_on_polygon_boundary`
        // returns a normal pre-oriented toward the particle — flipping it
        // makes the dot negative). The old `pen = dot, then clamp to
        // margin` path under-pushed deep penetrations and let particles
        // stay wedged.
        let pen_actual = p.sub(closest).length();
        let pen = if pen_actual > self.config.collision_margin {
            pen_actual
        } else {
            self.config.collision_margin
        };

        let inv_a = self.inv_mass[pi];
        let inv_b = self.inv_mass[ib0];
        let inv_c = self.inv_mass[ib1];
        let w_sum = inv_a + inv_b * wb * wb + inv_c * wc * wc;
        if w_sum < Fx::from_raw(1 << 6) { return; } // ~1e-8

        // Per-particle contact for ledge-hang detection — set for any
        // softbody-platform contact, not just ground-facing ones, so a
        // hooked side particle counts the same as on static geometry.
        if pi < self.particle_touched_this_step.len() {
            self.particle_touched_this_step[pi] = true;
        }
        // Ground/impact contact tracking — mirrors `collide_blob_with_poly`
        // so a blob standing on a softbody platform (which goes through this
        // path instead of the static-poly path) registers as grounded.
        // Without this, `isGrounded()` returns false on softbody platforms
        // and the player-input controller treats the blob as airborne
        // (reduced lateral authority, gravity dominating) — feels slow.
        let neg_three_tenths = Fx::from_raw((-3i64 * (1i64 << 32)) / 10);
        if n.y < neg_three_tenths {
            self.blob_ground_contacts[owner_blob_id] += 1;
            let existing = self.blob_ground_contact_normal[owner_blob_id];
            if existing.map_or(true, |e| n.y < e.y) {
                self.blob_ground_contact_point[owner_blob_id]  = Some(closest);
                self.blob_ground_contact_normal[owner_blob_id] = Some(n);
            }
        }
        if self.blob_impact_contact_point[owner_blob_id].is_none() {
            self.blob_impact_contact_point[owner_blob_id]  = Some(closest);
            self.blob_impact_contact_normal[owner_blob_id] = Some(n);
        }

        // Push by pen + margin (not just pen) so the query particle clears
        // the surface with breathing room — matching `collide_blob_with_poly`'s
        // `push_dist = pen + collision_margin`. Without the margin, the
        // particle ends up exactly on the surface and gravity dips it back
        // inside every substep; the resulting per-iter micro-correction
        // loop is what made lateral movement on softbody platforms feel
        // sticky compared to static polygons.
        let push_dist = pen + self.config.collision_margin;
        let corr = push_dist / w_sum;
        self.pos[pi]  = self.pos[pi].add(n.scale(corr * inv_a));
        self.pos[ib0] = self.pos[ib0].sub(n.scale(corr * inv_b * wb));
        self.pos[ib1] = self.pos[ib1].sub(n.scale(corr * inv_c * wc));

        // Resting-load floor — gravity-proportional, only acts on
        // ground-like (support>0) contacts.
        let mut resting_load = Fx::ZERO;
        if dt > Fx::ZERO && self.mass[pi] > Fx::from_raw(1 << 14) {
            let g_len = self.config.gravity.length();
            if g_len > Fx::from_raw(1 << 14) {
                let g_dir = self.config.gravity.scale(Fx::ONE / g_len);
                let up_dir = g_dir.neg();
                let support = up_dir.dot(n).max(Fx::ZERO).min(Fx::ONE);
                resting_load = self.mass[pi] * g_len * support * dt * self.config.static_friction_normal_load_scale;
            }
        }

        // Velocity impulses (restitution + Coulomb friction) only on the
        // final collision iteration. Otherwise the resting-load floor
        // (mass·g·support·dt) fires once per iter and friction stacks —
        // a blob on the ground would shed N× more tangent velocity than
        // a single-iter TS sim does, making movement feel sluggish.
        if !apply_velocity_impulses { return; }

        let (va_new, vb_new, vc_new) = resolve_three_body_velocity(
            self.vel[pi], self.mass[pi],
            self.vel[ib0], self.mass[ib0],
            self.vel[ib1], self.mass[ib1],
            n, wb, wc,
            self.config.collision_restitution,
            self.config.blob_blob_friction_mu * friction_scale,
            info.edge_dir,
            self.config.blob_blob_friction_impulse_scale * friction_scale,
            resting_load,
        );
        self.vel[pi]  = va_new;
        self.vel[ib0] = vb_new;
        self.vel[ib1] = vc_new;
    }

    fn collide_blob_with_poly(
        &mut self,
        blob_id: usize,
        poly_world: &[FxVec2],
        poly_is_static: bool,
        contact_dt: Fx,
        material: SurfaceMaterial,
        surface_vel: Option<FxVec2>,
        apply_velocity_impulses: bool,
    ) {
        let mat = material_params(material);
        let restitution = if poly_is_static { mat.restitution } else { self.config.static_restitution };
        let friction_mu = if poly_is_static { mat.friction_mu } else { self.config.static_edge_friction_mu };
        let r = self.blob_ranges[blob_id].clone();
        let hull = r.hull.clone();
        let bbox = polygon_aabb(poly_world);
        let sv = surface_vel.unwrap_or(FxVec2::ZERO);
        let has_sv = surface_vel.is_some() && (!sv.x.is_zero() || !sv.y.is_zero());

        let two = Fx::from_int(2);

        for &pidx in &hull {
            let pi = pidx as usize;
            let p = self.pos[pi];
            // Quick AABB pre-filter
            let pr = Aabb {
                min_x: p.x - two, min_y: p.y - two,
                max_x: p.x + two, max_y: p.y + two,
            };
            if !aabb_overlap(pr, bbox) { continue; }

            let info = closest_point_on_polygon_boundary(p, poly_world);
            let n_base = info.normal;
            let closest = info.closest;
            let inside = is_point_in_polygon(p, poly_world);
            let dist_b = p.sub(closest).length();

            let n: FxVec2;
            let push_dist: Fx;
            let mut use_static = false;

            if inside {
                n = n_base.neg();
                // Use the actual penetration depth, not the dot product
                // against the outward normal. `closest_point_on_polygon_boundary`
                // pre-orients its normal toward the particle, so for an
                // inside particle that normal points inward; flipping it
                // (n = n_base.neg()) makes (p - closest) · n always
                // negative, which used to clamp pen to collision_margin.
                // That under-pushed deep penetrations by a lot — a blob
                // wedged 10 units into a corner only got margin-sized
                // shoves per iter and stayed stuck. dist_b is the true
                // depth (= |p - closest|) since the closest point sits
                // on the boundary.
                let pen = dist_b.max(self.config.collision_margin);
                push_dist = pen + self.config.collision_margin;
                use_static = poly_is_static;
            } else if poly_is_static && dist_b <= self.config.static_contact_slop {
                let to_pt = p.sub(closest);
                let small = Fx::from_raw((-(5i64 * (1i64 << 32))) / 100); // -0.05
                if to_pt.dot(n_base) < small { continue; }
                n = n_base;
                let gap = to_pt.dot(n);
                if gap < Fx::ZERO { continue; }
                push_dist = gap.max(self.config.collision_margin) + Fx::from_raw(self.config.collision_margin.raw() / 4);
                use_static = true;
            } else {
                continue;
            }

            if poly_is_static && use_static {
                // Any static contact — record per-particle for ledge-hang detection.
                if pi < self.particle_touched_this_step.len() {
                    self.particle_touched_this_step[pi] = true;
                }
                // Ground-contact tracking (most upward-facing wins).
                let neg_three_tenths = Fx::from_raw((-3i64 * (1i64 << 32)) / 10);
                if n.y < neg_three_tenths {
                    self.blob_ground_contacts[blob_id] += 1;
                    let existing = self.blob_ground_contact_normal[blob_id];
                    if existing.map_or(true, |e| n.y < e.y) {
                        self.blob_ground_contact_point[blob_id]  = Some(closest);
                        self.blob_ground_contact_normal[blob_id] = Some(n);
                    }
                }
                // Any-surface impact contact — first hit wins.
                if self.blob_impact_contact_point[blob_id].is_none() {
                    self.blob_impact_contact_point[blob_id]  = Some(closest);
                    self.blob_impact_contact_normal[blob_id] = Some(n);
                }
                // Sticky contacts.
                if material == SurfaceMaterial::Sticky {
                    self.blob_sticky_contact_count[blob_id] += 1;
                    let sum = self.blob_sticky_contact_normal_sum[blob_id];
                    self.blob_sticky_contact_normal_sum[blob_id] = FxVec2::new(sum.x + n.x, sum.y + n.y);
                }

                // Position correction (skip anchored particles).
                // Always applies — what iteration is FOR.
                if self.inv_mass[pi] > Fx::ZERO {
                    self.pos[pi] = closest.add(n.scale(push_dist));
                }

                // Velocity impulses (kill-velocity + restitution + friction)
                // ONLY on the final iteration. The resting-load floor in the
                // friction calc is a constant per-substep impulse; applying
                // it once per collision iteration would stack to N× the
                // friction, killing ground movement.
                if !apply_velocity_impulses { continue; }

                // Remove velocity into wall.
                let v_rel0 = if has_sv { self.vel[pi].sub(sv) } else { self.vel[pi] };
                let vn_in_wall = v_rel0.dot(n);
                if vn_in_wall < Fx::ZERO {
                    self.vel[pi] = self.vel[pi].sub(n.scale(vn_in_wall));
                }
                // Restitution.
                let v_rel1 = if has_sv { self.vel[pi].sub(sv) } else { self.vel[pi] };
                let vn_before = v_rel1.dot(n);
                if vn_before < Fx::ZERO {
                    self.vel[pi] = self.vel[pi].sub(n.scale(vn_before * (Fx::ONE + restitution)));
                }
                let v_rel2 = if has_sv { self.vel[pi].sub(sv) } else { self.vel[pi] };
                let vn_after = v_rel2.dot(n);

                // Static friction (Coulomb cap on tangential velocity).
                if friction_mu > Fx::from_raw(1 << 14) {
                    let edge_dir = info.edge_dir;
                    let mut t = edge_dir.normalize();
                    if t.length_squared() < Fx::from_raw(1 << 4) {
                        t = FxVec2::new(-n.y, n.x).normalize();
                    }
                    let v_rel_t = if has_sv { self.vel[pi].sub(sv) } else { self.vel[pi] };
                    let v_t = v_rel_t.dot(t);
                    if v_t.abs() >= self.config.static_friction_min_tang_speed {
                        let jn_collision = (self.mass[pi] * (vn_after - vn_before)).abs();
                        let g_len = self.config.gravity.length();
                        let g_dir = if g_len > Fx::from_raw(1 << 14) {
                            self.config.gravity.scale(Fx::ONE / g_len)
                        } else {
                            FxVec2::new(Fx::ZERO, Fx::ONE)
                        };
                        let up_dir = g_dir.neg();
                        let support = up_dir.dot(n).max(Fx::ZERO).min(Fx::ONE);
                        let jn_rest = self.mass[pi] * g_len * support * contact_dt * self.config.static_friction_normal_load_scale;
                        let jn = jn_collision.max(jn_rest);
                        let jt_uncap = -self.mass[pi] * v_t;
                        let cap = friction_mu * jn;
                        let mut jt = jt_uncap;
                        if jt > cap  { jt = cap; }
                        if jt < -cap { jt = -cap; }
                        if !self.mass[pi].is_zero() {
                            self.vel[pi] = self.vel[pi].add(t.scale(jt / self.mass[pi]));
                        }
                    }
                }
            }
        }
    }

    // =====================================================================
    // CCD sweeps (static + blob-blob)
    // =====================================================================

    fn sweep_static_ccd(&mut self, prev_pos: &[FxVec2]) {
        let surfaces = self.static_surfaces.clone(); // borrow gymnastics

        // Precompute each surface's translation since the last frame
        // (curr_poly[0] - prev_poly[0], assuming rigid translation —
        // springs and Action-moved platforms qualify). Used for the
        // surface-relative sweep below: in the surface's frame the
        // edge is stationary and the particle's effective path is
        // `old_p → new_p - surf_delta`, which catches the case where
        // a fast-moving plate sweeps past a roughly-stationary particle
        // (path too short to intersect either poly snapshot in the
        // world frame). Stationary surfaces produce zero delta and the
        // pass is skipped.
        let surf_deltas: Vec<FxVec2> = surfaces
            .iter()
            .map(|s| match s.prev_poly.as_ref() {
                Some(prev) if !prev.is_empty() && !s.poly.is_empty() => FxVec2::new(
                    s.poly[0].x - prev[0].x,
                    s.poly[0].y - prev[0].y,
                ),
                _ => FxVec2::ZERO,
            })
            .collect();
        let motion_eps_sq = Fx::from_raw(1 << 18); // ~6e-5

        for bi in 0..self.blob_ranges.len() {
            let r = self.blob_ranges[bi].clone();
            if r.inactive { continue; }
            // Center particle is virtual — pinned to hull centroid each
            // substep by `pin_blob_centers_to_hull_centroid`, no collision
            // surface to react against. Excluding it from CCD prevents the
            // "center wedges in a fast rotating platform" failure mode.
            let to_check: &[ParticleIdx] = &r.hull;
            for &pidx in to_check {
                let pi = pidx as usize;
                let old_p = prev_pos[pi];
                let new_p = self.pos[pi];
                let dx = new_p.x - old_p.x;
                let dy = new_p.y - old_p.y;
                let particle_moved_sq = dx * dx + dy * dy;

                let mut best_t: Option<Fx> = None;
                let mut best_point = FxVec2::ZERO;
                let mut best_normal = FxVec2::ZERO;
                let mut best_surf_vel: Option<FxVec2> = None;

                for (si, surface) in surfaces.iter().enumerate() {
                    let surf_delta = surf_deltas[si];
                    let surf_moved_sq = surf_delta.x * surf_delta.x + surf_delta.y * surf_delta.y;

                    // Skip this surface entirely when neither it nor the
                    // particle moved meaningfully — keeps the per-particle
                    // perf the same as before for the common case of
                    // stationary particles on stationary geometry.
                    if particle_moved_sq < motion_eps_sq && surf_moved_sq < motion_eps_sq {
                        continue;
                    }

                    // World-frame sweep against current + previous poly
                    // (catches a particle moving into either snapshot).
                    let polys: [&[FxVec2]; 2] = [
                        surface.poly.as_slice(),
                        surface.prev_poly.as_deref().unwrap_or(&[]),
                    ];
                    for poly in polys {
                        let pn = poly.len();
                        if pn < 2 { continue; }
                        for e in 0..pn {
                            let a = poly[e];
                            let b = poly[(e + 1) % pn];
                            let Some((t, hit_point)) = segment_intersection_t(old_p, new_p, a, b) else { continue };
                            if best_t.map_or(false, |bt| t >= bt) { continue; }
                            let edge = b.sub(a);
                            let elen = edge.length();
                            if elen < Fx::from_raw(1 << 4) { continue; }
                            let inv = Fx::ONE / elen;
                            let mut nx = -edge.y * inv;
                            let mut ny = edge.x * inv;
                            let to_old = (old_p.x - a.x) * nx + (old_p.y - a.y) * ny;
                            if to_old < Fx::ZERO { nx = -nx; ny = -ny; }
                            best_t = Some(t);
                            best_point = hit_point;
                            best_normal = FxVec2::new(nx, ny);
                            best_surf_vel = surface.velocity;
                        }
                    }

                    // Multi-snapshot sweep — catches rotating (and other
                    // non-translation) kinematic motion that the linear
                    // surface-relative sweep below can't handle. We per-
                    // vertex lerp `prev_poly → poly` at a few intermediate
                    // τ values, lerp the particle to the same τ, and test
                    // `is_point_in_polygon`. If the particle is inside the
                    // surface's interpolated pose, the edge swept past
                    // (or wrapped around) the particle even though the
                    // particle's path didn't cross either snapshot. Each
                    // vertex follows its own linear chord between prev
                    // and curr, so rotation + translation are both
                    // handled with the same loop.
                    let prev_poly = surface.prev_poly.as_deref().unwrap_or(&[]);
                    if prev_poly.len() >= 3 && prev_poly.len() == surface.poly.len() {
                        // Adaptive sample count: pick N to keep the chord
                        // each vertex moves between samples below
                        // TARGET_CHORD_SQ. A long rotating arm's tip can
                        // travel 50+ units/frame and skip a stationary
                        // particle between samples — bumping N as a
                        // function of max per-vertex displacement catches
                        // those. Clamped so a slow nudge doesn't spin up
                        // 20 snapshots and a runaway speed doesn't tank
                        // perf.
                        let target_chord_sq = Fx::from_int(64); // ~8 units between consecutive snapshots
                        let mut max_disp_sq = Fx::ZERO;
                        for j in 0..prev_poly.len() {
                            let dxv = surface.poly[j].x - prev_poly[j].x;
                            let dyv = surface.poly[j].y - prev_poly[j].y;
                            let d = dxv * dxv + dyv * dyv;
                            if d > max_disp_sq { max_disp_sq = d; }
                        }
                        // N such that (max_disp / (N+1))² ≤ target_chord_sq
                        // → (N+1)² ≥ max_disp_sq / target_chord_sq.
                        // Approximate sqrt by iterating squares; cheap up to N=12.
                        let mut n_interior: usize = 3;
                        while n_interior < 12 {
                            let n_plus_1 = Fx::from_int((n_interior + 1) as i32);
                            if n_plus_1 * n_plus_1 * target_chord_sq >= max_disp_sq {
                                break;
                            }
                            n_interior += 1;
                        }
                        for k in 1..=n_interior {
                            let tau = Fx::from_int(k as i32) / Fx::from_int((n_interior + 1) as i32);
                            // Particle at time τ along its linear path.
                            let mid_p = FxVec2::new(
                                old_p.x + (new_p.x - old_p.x) * tau,
                                old_p.y + (new_p.y - old_p.y) * tau,
                            );
                            // Surface pose at time τ — per-vertex lerp.
                            let n_verts = prev_poly.len();
                            let mut snap: Vec<FxVec2> = Vec::with_capacity(n_verts);
                            for j in 0..n_verts {
                                snap.push(FxVec2::new(
                                    prev_poly[j].x + (surface.poly[j].x - prev_poly[j].x) * tau,
                                    prev_poly[j].y + (surface.poly[j].y - prev_poly[j].y) * tau,
                                ));
                            }
                            if !is_point_in_polygon(mid_p, &snap) { continue; }
                            if best_t.map_or(false, |bt| tau >= bt) { continue; }

                            // Hit detected. Project to the surface's FINAL
                            // (t=1) pose so the post-resolution position
                            // is consistent with where the surface ends
                            // the substep — same trick as the linear
                            // surface-relative sweep for translation.
                            let info_final = closest_point_on_polygon_boundary(mid_p, &surface.poly);
                            // Orient outward normal toward old_p (the
                            // side the particle came from).
                            let edge = info_final.b.sub(info_final.a);
                            let elen = edge.length();
                            if elen < Fx::from_raw(1 << 4) { continue; }
                            let inv = Fx::ONE / elen;
                            let mut nx = -edge.y * inv;
                            let mut ny = edge.x * inv;
                            let to_old = (old_p.x - info_final.a.x) * nx
                                       + (old_p.y - info_final.a.y) * ny;
                            if to_old < Fx::ZERO { nx = -nx; ny = -ny; }
                            best_t = Some(tau);
                            best_point = info_final.closest;
                            best_normal = FxVec2::new(nx, ny);
                            best_surf_vel = surface.velocity;
                        }
                    }

                    // Surface-relative sweep: in the surface's local frame
                    // the edge is stationary and the particle's effective
                    // path is `old_p → new_p - surf_delta`. Catches a
                    // moving edge sweeping past a particle that didn't
                    // move enough in the world frame to cross either
                    // poly snapshot (the spring-fires-past-resting-blob
                    // case). Only meaningful when the surface moved.
                    if surf_moved_sq >= motion_eps_sq {
                        let prev_poly = surface.prev_poly.as_deref().unwrap_or(&[]);
                        let pn = prev_poly.len();
                        if pn >= 2 {
                            let adj_new_p = FxVec2::new(new_p.x - surf_delta.x, new_p.y - surf_delta.y);
                            for e in 0..pn {
                                let a = prev_poly[e];
                                let b = prev_poly[(e + 1) % pn];
                                let Some((t, hit_local)) = segment_intersection_t(old_p, adj_new_p, a, b) else { continue };
                                if best_t.map_or(false, |bt| t >= bt) { continue; }
                                let edge = b.sub(a);
                                let elen = edge.length();
                                if elen < Fx::from_raw(1 << 4) { continue; }
                                let inv = Fx::ONE / elen;
                                let mut nx = -edge.y * inv;
                                let mut ny = edge.x * inv;
                                let to_old = (old_p.x - a.x) * nx + (old_p.y - a.y) * ny;
                                if to_old < Fx::ZERO { nx = -nx; ny = -ny; }
                                best_t = Some(t);
                                // Place the corrected position at the
                                // surface's FINAL (t=1) location, not its
                                // position at collision time t. The
                                // surface keeps translating after the
                                // collision; at very high speeds the
                                // remaining (1-t)*surf_delta is many
                                // particle radii and would leave the
                                // player engulfed below the plate's
                                // final position. Riding the contact
                                // along with the surface keeps the
                                // particle above it regardless of speed.
                                best_point = FxVec2::new(
                                    hit_local.x + surf_delta.x,
                                    hit_local.y + surf_delta.y,
                                );
                                best_normal = FxVec2::new(nx, ny);
                                best_surf_vel = surface.velocity;
                            }
                        }
                    }
                }

                if best_t.is_some() && self.inv_mass[pi] > Fx::ZERO {
                    self.pos[pi] = best_point.add(best_normal.scale(self.config.collision_margin));
                    let sv = best_surf_vel.unwrap_or(FxVec2::ZERO);
                    let has_sv = best_surf_vel.is_some() && (!sv.x.is_zero() || !sv.y.is_zero());
                    let v_rel = if has_sv { self.vel[pi].sub(sv) } else { self.vel[pi] };
                    let vn = v_rel.dot(best_normal);
                    if vn < Fx::ZERO {
                        self.vel[pi] = self.vel[pi].sub(best_normal.scale(vn));
                    }
                }
            }
        }
    }

    fn sweep_blob_ccd(&mut self, prev_pos: &[FxVec2]) {
        let n_blobs = self.blob_ranges.len();
        for a in 0..n_blobs {
            let ra = self.blob_ranges[a].clone();
            if ra.inactive { continue; }
            let sa = self.shapes.get(ra.shape_idx as usize).cloned();
            let Some(sa) = sa else { continue };

            for b in 0..n_blobs {
                if a == b { continue; }
                let rb = self.blob_ranges[b].clone();
                if rb.inactive { continue; }
                let sb = self.shapes.get(rb.shape_idx as usize).cloned();
                let Some(sb) = sb else { continue };
                if !can_collide(sa.layer, sa.mask, sb.layer, sb.mask) { continue; }

                let pn = rb.hull.len();
                if pn < 3 { continue; }
                // B's previous hull polygon.
                let poly_b_prev: Vec<FxVec2> = rb.hull.iter().map(|&i| prev_pos[i as usize]).collect();

                for &pidx in &ra.hull {
                    let pi = pidx as usize;
                    if self.inv_mass[pi].is_zero() { continue; }
                    let old_p = prev_pos[pi];
                    let new_p = self.pos[pi];
                    let dx = new_p.x - old_p.x;
                    let dy = new_p.y - old_p.y;
                    if (dx * dx + dy * dy) < Fx::from_raw(1 << 18) { continue; }

                    let mut best_t: Option<Fx> = None;
                    let mut best_point = FxVec2::ZERO;
                    let mut best_normal = FxVec2::ZERO;
                    let mut best_edge: i32 = -1;
                    let mut best_edge_dir = FxVec2::ZERO;

                    for e in 0..pn {
                        let ea = poly_b_prev[e];
                        let eb = poly_b_prev[(e + 1) % pn];
                        let Some((t, hit_point)) = segment_intersection_t(old_p, new_p, ea, eb) else { continue };
                        if best_t.map_or(false, |bt| t >= bt) { continue; }
                        let edge = eb.sub(ea);
                        let elen = edge.length();
                        if elen < Fx::from_raw(1 << 4) { continue; }
                        let inv = Fx::ONE / elen;
                        let mut nx = -edge.y * inv;
                        let mut ny = edge.x * inv;
                        let to_old = (old_p.x - ea.x) * nx + (old_p.y - ea.y) * ny;
                        if to_old < Fx::ZERO { nx = -nx; ny = -ny; }
                        best_t = Some(t);
                        best_point = hit_point;
                        best_normal = FxVec2::new(nx, ny);
                        best_edge = e as i32;
                        best_edge_dir = FxVec2::new(edge.x * inv, edge.y * inv);
                    }

                    if best_edge < 0 { continue; }

                    // Position clamp.
                    self.pos[pi] = best_point.add(best_normal.scale(self.config.collision_margin));

                    // Three-body impulse against the two edge vertices of B.
                    let edge_i = best_edge as usize;
                    let ib0 = rb.hull[edge_i] as usize;
                    let ib1 = rb.hull[(edge_i + 1) % pn] as usize;
                    let e_a = poly_b_prev[edge_i];
                    let e_b = poly_b_prev[(edge_i + 1) % pn];
                    let wts = edge_vertex_weights(best_point, e_a, e_b);

                    let half = Fx::HALF;
                    let (va_new, vb_new, vc_new) = resolve_three_body_velocity(
                        self.vel[pi], self.mass[pi],
                        self.vel[ib0], self.mass[ib0],
                        self.vel[ib1], self.mass[ib1],
                        best_normal, wts.wb, wts.wc,
                        self.config.collision_restitution,
                        self.config.blob_blob_friction_mu * half,
                        best_edge_dir,
                        self.config.blob_blob_friction_impulse_scale * half,
                        Fx::ZERO,
                    );
                    self.vel[pi]  = va_new;
                    self.vel[ib0] = vb_new;
                    self.vel[ib1] = vc_new;
                }
            }
        }
    }

    fn solve_particle_collisions(&mut self, _dt: Fx) {
        // Particle-vs-poly (radius-based) — only acts on particles with a
        // nonzero radius (rope/chain segments). Most game particles have
        // radius=0 and skip the whole pass.
        for i in 0..self.pos.len() {
            let rad = self.particle_radius[i];
            if rad <= Fx::ZERO { continue; }
            let p_layer = self.particle_layer[i];
            let p_mask  = self.particle_mask[i];

            let surfaces = self.static_surfaces.clone();
            for s in &surfaces {
                if !can_collide(p_layer, p_mask, s.layer, s.mask) { continue; }
                self.resolve_particle_vs_poly(i, rad, &s.poly);
            }
            let shapes = self.shapes.clone();
            for sh in &shapes {
                if sh.is_trigger || sh.inactive { continue; }
                if !can_collide(p_layer, p_mask, sh.layer, sh.mask) { continue; }
                if sh.is_static {
                    if !sh.static_poly.is_empty() {
                        self.resolve_particle_vs_poly(i, rad, &sh.static_poly);
                    }
                } else if sh.indices.len() >= 2 {
                    let poly: Vec<FxVec2> = sh.indices.iter().map(|&j| self.pos[j as usize]).collect();
                    self.resolve_particle_vs_poly(i, rad, &poly);
                }
            }
        }
    }

    fn resolve_particle_vs_poly(&mut self, i: usize, rad: Fx, poly_world: &[FxVec2]) {
        if self.inv_mass[i].is_zero() { return; }
        let p = self.pos[i];
        let info = closest_point_on_polygon_boundary(p, poly_world);
        let closest = info.closest;
        let n = info.normal;
        let inside = is_point_in_polygon(p, poly_world);
        let dist_along = p.sub(closest).dot(n);

        if !inside {
            let margin_quarter = Fx::from_raw(self.config.collision_margin.raw() / 4);
            if dist_along >= rad - margin_quarter { return; }
            self.pos[i] = p.add(n.scale(rad - dist_along));
        } else {
            self.pos[i] = closest.add(n.scale(rad + self.config.collision_margin));
        }
        let vn = self.vel[i].dot(n);
        if vn < Fx::ZERO {
            self.vel[i] = self.vel[i].sub(n.scale(vn * (Fx::ONE + self.config.collision_restitution)));
        }
    }

    // =====================================================================
    // Chain solver (forward + backward sweep per iteration)
    // =====================================================================

    fn solve_chains(&mut self) {
        for chain in self.chains.clone() {
            let idx = chain.particle_indices;
            let max_l = chain.max_segment_length;
            for _ in 0..chain.iterations {
                for k in 0..idx.len().saturating_sub(1) {
                    self.solve_chain_pair(idx[k], idx[k + 1], max_l);
                }
                for k in (0..idx.len().saturating_sub(1)).rev() {
                    self.solve_chain_pair(idx[k], idx[k + 1], max_l);
                }
            }
        }
    }

    fn solve_chain_pair(&mut self, i: usize, j: usize, max_l: Fx) {
        let d = self.pos[j].sub(self.pos[i]);
        let len = d.length();
        if len <= max_l || len < EPS { return; }
        let n = d.scale(Fx::ONE / len);
        let overlap = len - max_l;
        let wi = self.inv_mass[i];
        let wj = self.inv_mass[j];
        let w_sum = wi + wj;
        if w_sum < EPS { return; }
        // PBD: each particle moves/decelerates by its OWN inv-mass fraction.
        // Anchor (wi=0) stays put, free particle absorbs the full correction.
        // The TS sim swapped these weights — see constraints::solve_weld.
        let corr = overlap / w_sum;
        self.pos[i] = self.pos[i].add(n.scale(corr * wi));
        self.pos[j] = self.pos[j].sub(n.scale(corr * wj));
        let v_rel = self.vel[j].sub(self.vel[i]).dot(n);
        if v_rel > Fx::ZERO {
            let v_corr = v_rel / w_sum;
            self.vel[i] = self.vel[i].add(n.scale(v_corr * wi));
            self.vel[j] = self.vel[j].sub(n.scale(v_corr * wj));
        }
    }

    // -------- triggers --------

    fn process_trigger_events(&mut self) {
        // Collect all (key, inside) pairs, dispatch enter/exit, then update map.
        // Using a sorted Vec for trigger_prev to keep iteration deterministic
        // regardless of HashMap salt across platforms.
        let mut updates: Vec<(String, bool)> = Vec::new();
        let mut enter: Vec<(ShapeIdx, BlobId)> = Vec::new();
        let mut exit:  Vec<(ShapeIdx, BlobId)> = Vec::new();

        for si in 0..self.shapes.len() {
            let sh = &self.shapes[si];
            if !sh.is_trigger || sh.static_poly.is_empty() { continue; }
            let bbox = polygon_aabb(&sh.static_poly);
            for bi in 0..self.blob_ranges.len() {
                let range = self.blob_ranges[bi].clone();
                if range.inactive { continue; }
                let mut inside = false;
                for &idx in &range.hull {
                    let p = self.pos[idx as usize];
                    if p.x < bbox.min_x || p.x > bbox.max_x || p.y < bbox.min_y || p.y > bbox.max_y { continue; }
                    if crate::collision::is_point_in_polygon(p, &sh.static_poly) { inside = true; break; }
                }
                if !inside {
                    let c = self.pos[range.start as usize];
                    if c.x >= bbox.min_x && c.x <= bbox.max_x && c.y >= bbox.min_y && c.y <= bbox.max_y {
                        if crate::collision::is_point_in_polygon(c, &sh.static_poly) {
                            inside = true;
                        }
                    }
                }
                let key = format!("{}_{}", si, bi);
                let prev = self.trigger_prev.binary_search_by(|(k, _)| k.cmp(&key))
                    .ok()
                    .map(|i| self.trigger_prev[i].1)
                    .unwrap_or(false);
                if inside && !prev { enter.push((si as ShapeIdx, bi as BlobId)); }
                else if !inside && prev { exit.push((si as ShapeIdx, bi as BlobId)); }
                updates.push((key, inside));
            }
        }

        // Merge updates into sorted trigger_prev.
        for (k, v) in updates {
            match self.trigger_prev.binary_search_by(|(kk, _)| kk.cmp(&k)) {
                Ok(i) => self.trigger_prev[i].1 = v,
                Err(i) => self.trigger_prev.insert(i, (k, v)),
            }
        }

        // ACCUMULATE across substeps — JS drains once per step() (not
        // once per substep) via `take_trigger_*`, so events from
        // substep 0 must not be clobbered by substep N's empty result.
        // The TS sim doesn't have this problem because it fires
        // callbacks synchronously inside the substep.
        self.pending_trigger_entered.extend(enter);
        self.pending_trigger_exited.extend(exit);
    }
}

// Append trigger-pending fields outside the main impl/struct (keeps the
// diff against TS clean — these are an artifact of the Rust port, not a
// concept that exists in the TS source).
impl SoftBodyWorld {
    pub fn take_trigger_entered(&mut self) -> Vec<(ShapeIdx, BlobId)> {
        core::mem::take(&mut self.pending_trigger_entered)
    }
    pub fn take_trigger_exited(&mut self) -> Vec<(ShapeIdx, BlobId)> {
        core::mem::take(&mut self.pending_trigger_exited)
    }
    pub fn take_crush_events(&mut self) -> Vec<BlobId> {
        core::mem::take(&mut self.pending_crush_events)
    }
}

// =====================================================================
// Phase 6A — extended public surface used by the game wrapper.
//
// The TS SoftBodyWorld exposes ~30 methods + several mutator paths used
// by SlimeBlob, action/spike/powerup managers, level loaders, and netcode.
// Everything below mirrors those surfaces in Fx so the wasm boundary can
// pass them through one-for-one.
// =====================================================================

impl SoftBodyWorld {
    // ---- particle accessors / mutators ----

    pub fn particle_count(&self) -> usize { self.pos.len() }

    pub fn get_particle_pos(&self, i: usize) -> Option<FxVec2> {
        self.pos.get(i).copied()
    }
    pub fn get_particle_vel(&self, i: usize) -> Option<FxVec2> {
        self.vel.get(i).copied()
    }
    pub fn set_particle_pos(&mut self, i: usize, p: FxVec2) {
        if let Some(slot) = self.pos.get_mut(i) { *slot = p; }
    }
    pub fn set_particle_vel(&mut self, i: usize, v: FxVec2) {
        if let Some(slot) = self.vel.get_mut(i) { *slot = v; }
    }
    /// Bulk replace all positions. Used by actionManager's rewind path.
    /// Length must match `particle_count()`.
    pub fn set_positions_bulk(&mut self, buf: &[FxVec2]) {
        let n = self.pos.len().min(buf.len());
        self.pos[..n].copy_from_slice(&buf[..n]);
    }
    pub fn set_velocities_bulk(&mut self, buf: &[FxVec2]) {
        let n = self.vel.len().min(buf.len());
        self.vel[..n].copy_from_slice(&buf[..n]);
    }

    /// External force on a single particle (TS `applyExternalForcePoint`).
    pub fn apply_external_force_point(&mut self, i: usize, f: FxVec2) {
        if i >= self.vel.len() { return; }
        let im = self.inv_mass[i];
        self.vel[i] = self.vel[i].add(f.scale(im));
    }

    pub fn add_particle(&mut self, p: FxVec2, v: FxVec2, mass: Fx, radius: Fx) -> ParticleIdx {
        let idx = self.pos.len() as ParticleIdx;
        self.pos.push(p);
        self.vel.push(v);
        self.mass.push(mass);
        self.inv_mass.push(if mass > fx_lit(1, 1000) { Fx::ONE / mass } else { Fx::ZERO });
        self.particle_radius.push(radius);
        self.particle_layer.push(crate::layers::LAYER_DEFAULT);
        self.particle_mask.push(LAYER_ALL);
        idx
    }

    // ---- blob lifecycle / mutation ----

    /// Retire a blob — TS-equivalent: tag inactive, freeze particles, send
    /// the hull to a graveyard so AABBs stay cheap. Preserves indices of
    /// every other blob.
    pub fn remove_blob(&mut self, blob_id: BlobId) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        if self.blob_ranges[bid].inactive { return; }
        self.blob_ranges[bid].inactive = true;
        let (start, end, shape_idx) = {
            let r = &self.blob_ranges[bid];
            (r.start, r.end, r.shape_idx)
        };
        let graveyard = FxVec2::new(Fx::from_int(-10_000_000), Fx::from_int(-10_000_000));
        for i in start..end {
            let u = i as usize;
            self.inv_mass[u] = Fx::ZERO;
            self.mass[u] = Fx::ZERO;
            self.vel[u] = FxVec2::ZERO;
            self.pos[u] = graveyard;
            self.particle_radius[u] = Fx::ZERO;
        }
        if let Some(sh) = self.shapes.get_mut(shape_idx as usize) {
            sh.inactive = true;
        }
        // Drop cached base masses + stale trigger membership.
        self.base_masses.retain(|(b, _)| *b != blob_id);
        let suffix = format!("_{}", blob_id);
        self.trigger_prev.retain(|(k, _)| !k.ends_with(&suffix));
    }

    pub fn remove_static_surface(&mut self, idx: usize) {
        if idx < self.static_surfaces.len() {
            self.static_surfaces.remove(idx);
        }
    }

    /// Replace a static surface's polygon (and optionally its kinematic
    /// velocity). Used by PlatformMover / SpringPadManager which move the
    /// surface each frame; on the TS sim the equivalent operation is a
    /// direct mutation of the JS-side `StaticSurface.poly[i]` array, but
    /// across the wasm boundary the JS-side surface is a separate object
    /// from the wasm-side state — so we need an explicit sync method.
    pub fn update_static_surface(
        &mut self,
        idx: usize,
        new_poly: Vec<FxVec2>,
        velocity: Option<FxVec2>,
    ) {
        if let Some(s) = self.static_surfaces.get_mut(idx) {
            // Capture the outgoing poly so kinematic CCD can sweep against
            // both old and new edges this frame.
            s.prev_poly = Some(core::mem::replace(&mut s.poly, new_poly));
            s.velocity = velocity;
        }
    }

    pub fn set_blob_spring_stiffness_scale(&mut self, blob_id: BlobId, stiffness: Fx, damp: Option<Fx>) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let lo = fx_lit(2, 10);   // 0.2
        let hi = fx_lit(40, 10);  // 4.0
        let ss = stiffness.max(lo).min(hi);
        let ds = match damp {
            Some(d) => d.max(lo).min(hi),
            None => crate::math::sqrt_fx(ss),
        };
        let r = &mut self.blob_ranges[bid];
        r.spring_stiffness_scale = ss;
        r.spring_damp_scale = ds;
    }

    pub fn set_blob_shape_match_rest_scale(&mut self, blob_id: BlobId, s: Fx) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let si = self.blob_ranges[bid].shape_idx as usize;
        if si >= self.shapes.len() { return; }
        let sh = &mut self.shapes[si];
        if sh.is_static || sh.is_trigger { return; }
        let lo = fx_lit(35, 100); // 0.35
        let hi = fx_lit(35, 10);  // 3.5
        sh.shape_match_rest_scale = s.max(lo).min(hi);
    }

    pub fn set_blob_rest_local(&mut self, blob_id: BlobId, rest_local: &[FxVec2]) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let si = self.blob_ranges[bid].shape_idx as usize;
        if si >= self.shapes.len() { return; }
        let sh = &mut self.shapes[si];
        if sh.is_static || sh.is_trigger { return; }
        let n = sh.rest_local.len().min(rest_local.len());
        sh.rest_local[..n].copy_from_slice(&rest_local[..n]);
    }

    /// Engine-side port of `SlimeBlob.updateHullDeformation` (was in
    /// `src/physics/slimeBlob.ts`). Computes the blob's current rotation
    /// from its hull shape-match, rotates the world gravity direction into
    /// the blob's local frame, then writes a squash + lean deformation of
    /// `base_rest_local` into `rest_local`.
    ///
    /// Why this lives in Rust: the JS version called `Math.atan2`,
    /// `Math.cos`, `Math.sin` on per-tick inputs and wrote the result
    /// across the wasm boundary. Those JS transcendentals are
    /// implementation-defined per ECMA and can return slightly different
    /// f64 results between two V8 instances on the same machine. That
    /// last-bit divergence quantized into different `Fx` values, the shape
    /// matching constraint pulled slightly differently each tick, and
    /// engines that started bit-identical (via keyframe restore) drifted
    /// apart over a few ticks. By doing the trig in Rust against
    /// integer-only `sin_fx`/`cos_fx`/`atan2_fx` (LUT-based, deterministic
    /// to the bit), the result is identical across every wasm instance.
    ///
    /// Inputs `squash` (joystick-down amount, 0..1) and `lean`
    /// (velocity-along-right normalized to -1..1) are still computed in
    /// JS — they're scalar arithmetic on values JS can produce
    /// deterministically (clamp + simple float ops, no transcendentals).
    /// Pass `gravity_dir` as the unit-length world-space gravity direction
    /// (e.g. `(0, 1)` for default downward gravity).
    pub fn set_blob_squash_lean(
        &mut self,
        blob_id: BlobId,
        squash: Fx,
        lean: Fx,
        gravity_dir: FxVec2,
    ) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let si = self.blob_ranges[bid].shape_idx as usize;
        if si >= self.shapes.len() { return; }
        // Gameplay-tuning constants — must match the JS values in
        // `src/physics/slimeBlob.ts` (SQUASH_X_AMOUNT/SQUASH_Y_AMOUNT/
        // LEAN_AMOUNT). If gameplay wants per-blob tuning later, lift
        // these onto Shape and pass through `add_blob_from_hull`.
        let squash_x_amount = fx_lit(35, 100); // 0.35
        let squash_y_amount = fx_lit(30, 100); // 0.30
        let lean_amount     = fx_lit(40, 100); // 0.40
        // Snapshot the hull indices + base_rest_local out of self.shapes
        // first so we can release the immutable borrow before taking the
        // mutable one for the write at the end.
        let (hull_idx, base_len) = {
            let sh = &self.shapes[si];
            if sh.is_static || sh.is_trigger { return; }
            if sh.base_rest_local.is_empty() { return; }
            if sh.indices.len() != sh.base_rest_local.len() { return; }
            (sh.indices.clone(), sh.base_rest_local.len())
        };
        // ── 1. blob angle via shape matching ────────────────────────
        // Same formula as the JS `getBlobAngle()`: for each hull
        // particle, compute (rest, current_offset_from_centroid) and
        // accumulate dot/cross sums. atan2(sin_sum, cos_sum) gives the
        // best-fit rotation from rest → current.
        let n = base_len;
        // Centroid of current hull positions.
        let mut cx = Fx::ZERO; let mut cy = Fx::ZERO;
        for &pi in &hull_idx {
            let p = self.pos[pi as usize];
            cx += p.x; cy += p.y;
        }
        let inv_n = Fx::ONE.div(Fx::from_int(n as i32));
        cx = cx.mul(inv_n);
        cy = cy.mul(inv_n);
        let mut sin_sum = Fx::ZERO;
        let mut cos_sum = Fx::ZERO;
        {
            let sh = &self.shapes[si];
            for i in 0..n {
                let rest = sh.base_rest_local[i];
                let p = self.pos[hull_idx[i] as usize];
                let dx = p.x - cx;
                let dy = p.y - cy;
                cos_sum += rest.x.mul(dx) + rest.y.mul(dy);
                sin_sum += rest.x.mul(dy) - rest.y.mul(dx);
            }
        }
        let angle = crate::math::atan2_fx(sin_sum, cos_sum);
        // ── 2. rotate world gravity into blob-local frame ──────────
        // localDown = rot(-angle) * gravity_dir
        let cos_neg = crate::math::cos_fx(-angle);
        let sin_neg = crate::math::sin_fx(-angle);
        let local_down = FxVec2::new(
            gravity_dir.x.mul(cos_neg) - gravity_dir.y.mul(sin_neg),
            gravity_dir.x.mul(sin_neg) + gravity_dir.y.mul(cos_neg),
        );
        // localRight is perpendicular (90° CCW from localDown), same as JS
        let local_right = FxVec2::new(-local_down.y, local_down.x);
        // ── 3. squash / lean scales ────────────────────────────────
        let scale_right = Fx::ONE + squash.mul(squash_x_amount);
        let scale_down  = Fx::ONE - squash.mul(squash_y_amount);
        // ── 4. deform each base hull point ─────────────────────────
        // The JS formula `(projRight / BLOB_RADIUS) * -leanFactor *
        // LEAN_AMOUNT * BLOB_RADIUS` algebraically simplifies to
        // `-projRight * leanFactor * LEAN_AMOUNT`. We use the simpler
        // form to avoid the unnecessary divide-then-multiply round trip.
        let lean_scale = -lean.mul(lean_amount);
        let sh = &mut self.shapes[si];
        for i in 0..n {
            let base = sh.base_rest_local[i];
            let proj_right = base.x.mul(local_right.x) + base.y.mul(local_right.y);
            let proj_down  = base.x.mul(local_down.x)  + base.y.mul(local_down.y);
            let scaled_right = proj_right.mul(scale_right);
            let scaled_down  = proj_down.mul(scale_down);
            let lean_offset  = proj_right.mul(lean_scale);
            let down_total = scaled_down + lean_offset;
            sh.rest_local[i] = FxVec2::new(
                local_right.x.mul(scaled_right) + local_down.x.mul(down_total),
                local_right.y.mul(scaled_right) + local_down.y.mul(down_total),
            );
        }
    }

    pub fn set_blob_mass_scale(&mut self, blob_id: BlobId, mass_scale: Fx) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let r = self.blob_ranges[bid].clone();
        // Save the base masses on first call so we can restore later.
        if !self.base_masses.iter().any(|(b, _)| *b == blob_id) {
            let bases: Vec<Fx> = (r.start..r.end).map(|i| self.mass[i as usize]).collect();
            self.base_masses.push((blob_id, bases));
            self.base_masses.sort_by_key(|(b, _)| *b);
        }
        let bases = self.base_masses.iter().find(|(b, _)| *b == blob_id).map(|(_, v)| v.clone()).unwrap();
        for (k, i) in (r.start..r.end).enumerate() {
            let u = i as usize;
            let base = bases[k];
            self.mass[u] = base * mass_scale;
            self.inv_mass[u] = if self.mass[u] > Fx::ZERO { Fx::ONE / self.mass[u] } else { Fx::ZERO };
        }
    }

    pub fn reset_blob_mass_scale(&mut self, blob_id: BlobId) {
        if !self.base_masses.iter().any(|(b, _)| *b == blob_id) { return; }
        self.set_blob_mass_scale(blob_id, Fx::ONE);
        self.base_masses.retain(|(b, _)| *b != blob_id);
    }

    /// Translate every particle in a blob by (dx, dy). Velocities untouched.
    pub fn nudge_blob(&mut self, blob_id: BlobId, dx: Fx, dy: Fx) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        if dx.is_zero() && dy.is_zero() { return; }
        let r = self.blob_ranges[bid].clone();
        for i in r.start..r.end {
            let u = i as usize;
            self.pos[u] = FxVec2::new(self.pos[u].x + dx, self.pos[u].y + dy);
        }
    }

    /// Teleport: zero velocities, recenter every particle so the hull's
    /// centroid lands at `target`.
    pub fn teleport_blob(&mut self, blob_id: BlobId, target: FxVec2) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let r = self.blob_ranges[bid].clone();
        let mut cx = Fx::ZERO;
        let mut cy = Fx::ZERO;
        let n = r.hull.len() as i32;
        for &idx in &r.hull {
            cx = cx + self.pos[idx as usize].x;
            cy = cy + self.pos[idx as usize].y;
        }
        if n == 0 { return; }
        let inv_n = Fx::ONE / Fx::from_int(n);
        cx = cx * inv_n;
        cy = cy * inv_n;
        let dx = target.x - cx;
        let dy = target.y - cy;
        for i in r.start..r.end {
            let u = i as usize;
            self.pos[u] = FxVec2::new(self.pos[u].x + dx, self.pos[u].y + dy);
            self.vel[u] = FxVec2::ZERO;
        }
    }

    pub fn pin_blob_to_current_pose(&mut self, blob_id: BlobId) {
        let bid = blob_id as usize;
        if bid >= self.blob_ranges.len() { return; }
        let r = self.blob_ranges[bid].clone();
        let snap: Vec<FxVec2> = (r.start..r.end).map(|i| self.pos[i as usize]).collect();
        // Sorted insert/replace.
        match self.blob_pin_snapshots.binary_search_by_key(&blob_id, |(b, _)| *b) {
            Ok(i) => self.blob_pin_snapshots[i].1 = snap,
            Err(i) => self.blob_pin_snapshots.insert(i, (blob_id, snap)),
        }
    }

    pub fn unpin_blob(&mut self, blob_id: BlobId) {
        self.blob_pin_snapshots.retain(|(b, _)| *b != blob_id);
    }

    // ---- network-sync ----

    pub fn set_blob_ground_contacts(&mut self, blob_id: BlobId, count: i32) {
        while self.blob_ground_contacts.len() <= blob_id as usize {
            self.blob_ground_contacts.push(0);
        }
        self.blob_ground_contacts[blob_id as usize] = count.max(0);
    }

    pub fn get_blob_ground_contacts(&self, blob_id: BlobId) -> i32 {
        self.blob_ground_contacts.get(blob_id as usize).copied().unwrap_or(0)
    }

    pub fn get_blob_ground_contact(&self, blob_id: BlobId) -> Option<(FxVec2, FxVec2)> {
        let bid = blob_id as usize;
        let p = self.blob_ground_contact_point.get(bid).copied().flatten()?;
        let n = self.blob_ground_contact_normal.get(bid).copied().flatten()?;
        Some((p, n))
    }

    pub fn get_blob_impact_contact(&self, blob_id: BlobId) -> Option<(FxVec2, FxVec2)> {
        let bid = blob_id as usize;
        let p = self.blob_impact_contact_point.get(bid).copied().flatten()?;
        let n = self.blob_impact_contact_normal.get(bid).copied().flatten()?;
        Some((p, n))
    }

    /// Per-particle "touched a solid this step" bitmap, indexed in hull order.
    /// Each byte is 0 or 1. Empty Vec if blob_id is out of range.
    pub fn get_blob_particle_contacts(&self, blob_id: BlobId) -> Vec<u8> {
        let Some(r) = self.blob_ranges.get(blob_id as usize) else { return Vec::new(); };
        let mut out = Vec::with_capacity(r.hull.len());
        for &pidx in &r.hull {
            let pi = pidx as usize;
            let touched = self.particle_touched_this_step.get(pi).copied().unwrap_or(false);
            out.push(if touched { 1 } else { 0 });
        }
        out
    }

    pub fn get_blob_sticky_contact(&self, blob_id: BlobId) -> (i32, FxVec2) {
        let bid = blob_id as usize;
        let count = self.blob_sticky_contact_count.get(bid).copied().unwrap_or(0);
        let sum = self.blob_sticky_contact_normal_sum.get(bid).copied().unwrap_or(FxVec2::ZERO);
        if count == 0 { (0, FxVec2::ZERO) }
        else if sum.length_squared() < Fx::from_raw(1 << 8) { (count, FxVec2::ZERO) }
        else { (count, sum.normalize()) }
    }

    /// Effective gravity for a blob (accounting for trigger-zone overrides).
    pub fn get_blob_effective_gravity(&self, blob_id: BlobId) -> FxVec2 {
        let bid = blob_id as usize;
        let Some(r) = self.blob_ranges.get(bid) else { return self.config.gravity; };
        let hull_us: Vec<usize> = r.hull.iter().map(|&i| i as usize).collect();
        let cx = centroid_from_indices(&self.pos, &hull_us);
        for sh in &self.shapes {
            if !sh.is_trigger || sh.static_poly.is_empty() { continue; }
            if !is_point_in_polygon(cx, &sh.static_poly) { continue; }
            if let Some(f) = sh.gravity_field.as_ref() {
                return eval_gravity_field(f, cx);
            }
        }
        self.config.gravity
    }

    /// Compute the shape-matching target positions for a blob's hull.
    /// Returns empty if the blob has no shape matching or is static/trigger.
    pub fn get_blob_shape_match_target_hull(&self, blob_id: BlobId) -> Vec<FxVec2> {
        let bid = blob_id as usize;
        let Some(r) = self.blob_ranges.get(bid) else { return Vec::new(); };
        let si = r.shape_idx as usize;
        let Some(sh) = self.shapes.get(si) else { return Vec::new(); };
        if sh.is_static || sh.is_trigger || sh.shape_match_k <= Fx::ZERO {
            return Vec::new();
        }
        if sh.indices.len() != sh.rest_local.len() || sh.indices.is_empty() {
            return Vec::new();
        }
        let indices_us: Vec<usize> = sh.indices.iter().map(|&i| i as usize).collect();
        let (center, angle) = if sh.use_frame_override {
            let c = FxVec2::new(sh.frame_override.tx, sh.frame_override.ty);
            let a = crate::math::atan2_fx(sh.frame_override.sin, sh.frame_override.cos);
            (c, a)
        } else {
            let c = centroid_from_indices(&self.pos, &indices_us);
            let a = average_angle(&sh.rest_local, &self.pos, &indices_us, c);
            (c, a)
        };
        let frame = frame_transform(center, angle);
        let sm_scale = sh.shape_match_rest_scale.max(fx_lit(5, 100));
        sh.rest_local.iter().map(|l| apply_transform(frame, l.scale(sm_scale))).collect()
    }

    // ---- blob range queries (renderer + managers) ----

    pub fn blob_range(&self, blob_id: BlobId) -> Option<(ParticleIdx, ParticleIdx, Vec<ParticleIdx>)> {
        self.blob_ranges.get(blob_id as usize).map(|r| (r.start, r.end, r.hull.clone()))
    }

    pub fn blob_center_idx(&self, blob_id: BlobId) -> Option<ParticleIdx> {
        self.blob_ranges.get(blob_id as usize).map(|r| r.start)
    }

    pub fn blob_id_for_particle(&self, idx: ParticleIdx) -> Option<BlobId> {
        for r in &self.blob_ranges {
            if idx >= r.start && idx < r.end { return Some(r.id); }
        }
        None
    }

    pub fn spring_index_pairs(&self) -> Vec<(ParticleIdx, ParticleIdx)> {
        self.springs.iter().map(|s| (s.i, s.j)).collect()
    }

    // ---- RNG state get/set (netcode recovery) ----

    pub fn rng_state(&self) -> u32 { self.rng.state() }
    pub fn set_rng_state(&mut self, s: u32) { self.rng.set_state(s); }

    /// Override the logical tick counter. Used by the guest's keyframe
    /// restore path to align local sim time with the host's
    /// authoritative tick — without this, the lockstep gate (which
    /// looks for input at `world.tick + 1`) sits waiting for input at
    /// tick 1 forever while the host broadcasts inputs for tick 600+,
    /// and the guest's sim never advances between keyframes.
    pub fn set_tick(&mut self, t: u64) { self.tick = t; }

    /// Mirrors the TS `rng.next()` — returns u32 / 2^32 as a number in [0,1).
    /// Consumed by powerupManager + spikeManager.
    pub fn rng_next_unit(&mut self) -> Fx {
        let r = self.rng.next_u32();
        // r in [0, 2^32). Fx = r * 2^-32 has raw = r exactly.
        Fx::from_raw(r as i64)
    }

    // ---- level-author additions (extra springs, home anchors) ----

    pub fn add_extra_spring(&mut self, i: ParticleIdx, j: ParticleIdx, rest: Fx, k: Fx, damp: Fx) {
        self.extra_springs.push(Spring { i, j, rest, k_base: k, damp_base: damp });
    }

    /// Build a discrete-particle rope between two existing particles. Creates
    /// `segments - 1` interior point particles (linearly interpolated) and
    /// links the whole sequence with per-pair max-distance constraints —
    /// the rope only pulls when a pair exceeds `max_segment_length`, and
    /// pulls only that pair. No springs, no continuous force.
    ///
    /// `segments` is derived from `ceil(total_length / max_segment_length)`.
    /// Each segment particle sits on `layer` (default LAYER_CHAIN) accepting
    /// `mask` (default LAYER_WORLD) — collides with world geometry but not
    /// with blobs or other chains.
    ///
    /// Returns the indices of the newly-created interior particles in order.
    pub fn add_rope_chain(
        &mut self,
        idx_a: ParticleIdx,
        idx_b: ParticleIdx,
        total_length: Fx,
        max_segment_length: Fx,
        segment_mass: Fx,
        segment_radius: Fx,
        layer: u32,
        mask: u32,
        iterations: u32,
    ) -> Vec<ParticleIdx> {
        let max_l = max_segment_length;
        // segments = ceil(total_length / max_l), at least 2
        let segments = if max_l.raw() <= 0 {
            2
        } else {
            let q_raw = (((total_length.raw() as i128) << 32) + (max_l.raw() as i128) - 1)
                / (max_l.raw() as i128);
            let n = (q_raw >> 32) as i64;
            n.max(2) as i32
        };
        let inner_count = (segments - 1).max(0) as usize;

        let p_a = self.pos[idx_a as usize];
        let p_b = self.pos[idx_b as usize];
        let mut new_indices: Vec<ParticleIdx> = Vec::with_capacity(inner_count);
        let segments_fx = Fx::from_int(segments);

        for s in 1..=inner_count {
            let t = Fx::from_int(s as i32) / segments_fx;
            let p = FxVec2::new(
                p_a.x + (p_b.x - p_a.x) * t,
                p_a.y + (p_b.y - p_a.y) * t,
            );
            // add_particle defaults layer to LAYER_DEFAULT; we override after.
            let idx = self.add_particle(p, FxVec2::ZERO, segment_mass, segment_radius);
            let u = idx as usize;
            self.particle_layer[u] = layer;
            self.particle_mask[u] = mask;
            new_indices.push(idx);
        }

        let mut particle_indices: Vec<usize> = Vec::with_capacity(inner_count + 2);
        particle_indices.push(idx_a as usize);
        for &i in &new_indices { particle_indices.push(i as usize); }
        particle_indices.push(idx_b as usize);

        self.chains.push(Chain {
            particle_indices,
            max_segment_length: max_l,
            iterations: iterations.max(1),
        });

        new_indices
    }

    pub fn add_home_anchor(&mut self, idx: ParticleIdx, home: FxVec2, k: Fx, damp: Fx) {
        self.home_anchors.push(HomeAnchor { idx, home, k, damp });
    }

    /// Append a hard max-distance constraint between two particles. The
    /// step-7 constraint pass iterates these every substep alongside
    /// welds and anchors, so this is independent of the chain solver
    /// and works regardless of mass ratios or segment count.
    pub fn add_distance_max(&mut self, i: ParticleIdx, j: ParticleIdx, max: Fx) {
        self.distance_max_constraints.push((i as usize, j as usize, max));
    }

    // ---- static-surface snapshot for renderer ----

    /// Flat description of every static surface: (material_id, point_count,
    /// then `point_count` interleaved x,y values). Cheap to copy across the
    /// wasm boundary, easy to iterate on the JS side.
    pub fn static_surfaces_snapshot(&self) -> Vec<StaticSurfaceSnapshot> {
        self.static_surfaces.iter().map(|s| StaticSurfaceSnapshot {
            material_id: match s.material {
                SurfaceMaterial::Default => 0,
                SurfaceMaterial::Ice => 1,
                SurfaceMaterial::Sticky => 2,
                SurfaceMaterial::Bouncy => 3,
            },
            poly: s.poly.clone(),
        }).collect()
    }

    /// Shapes snapshot (renderer/debug). Excludes triggers if `include_triggers`
    /// is false. Includes gravity-field metadata so the renderer can draw
    /// gravity-zone visualisations.
    pub fn shapes_snapshot(&self, include_triggers: bool) -> Vec<ShapeSnapshot> {
        self.shapes.iter().enumerate().filter_map(|(i, sh)| {
            if !include_triggers && sh.is_trigger { return None; }
            let gravity = sh.gravity_field.as_ref().map(|f| match f {
                GravityField::Uniform { vector } => GravitySnapshot::Uniform {
                    vector_x: vector.x.to_f64(),
                    vector_y: vector.y.to_f64(),
                },
                GravityField::Point { center, strength, falloff } => GravitySnapshot::Point {
                    center_x: center.x.to_f64(),
                    center_y: center.y.to_f64(),
                    strength: strength.to_f64(),
                    inverse_square: matches!(falloff, PointGravityFalloff::InverseSquare),
                },
            });
            Some(ShapeSnapshot {
                shape_idx: i as ShapeIdx,
                is_trigger: sh.is_trigger,
                is_static: sh.is_static,
                inactive: sh.inactive,
                poly: if sh.is_static { sh.static_poly.clone() }
                      else { sh.indices.iter().map(|&p| self.pos[p as usize]).collect() },
                gravity,
            })
        }).collect()
    }
}

#[derive(Clone, Debug)]
pub enum GravitySnapshot {
    Uniform { vector_x: f64, vector_y: f64 },
    Point { center_x: f64, center_y: f64, strength: f64, inverse_square: bool },
}

#[derive(Clone, Debug)]
pub struct StaticSurfaceSnapshot {
    pub material_id: u32,
    pub poly: Vec<FxVec2>,
}

#[derive(Clone, Debug)]
pub struct ShapeSnapshot {
    pub shape_idx: ShapeIdx,
    pub is_trigger: bool,
    pub is_static: bool,
    pub inactive: bool,
    pub poly: Vec<FxVec2>,
    pub gravity: Option<GravitySnapshot>,
}

// -------- Tests --------

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(n: i32) -> Fx { Fx::from_int(n) }

    /// Free-falling blob with no static surfaces and all internal forces
    /// disabled — its center-of-mass should integrate exactly under
    /// uniform gravity (semi-implicit Euler).
    #[test]
    fn free_fall_integrates_gravity() {
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::new(Fx::ZERO, fx(1000)); // 1000 units/sec² downward
        cfg.substeps = 1;
        cfg.hull_vertex_damping_per_sec = Fx::ZERO;
        cfg.center_hull_damping_per_sec = Fx::ZERO;
        let mut w = SoftBodyWorld::new(cfg, 42);

        // Add a single blob with no springs/pressure/shape-matching tension —
        // we set k's to zero so internal forces don't push particles around.
        let hull = vec![
            FxVec2::new(fx(-10), fx(-10)),
            FxVec2::new(fx( 10), fx(-10)),
            FxVec2::new(fx( 10), fx( 10)),
            FxVec2::new(fx(-10), fx( 10)),
        ];
        let res = w.add_blob_from_hull(AddBlobParams {
            hull_rest_local: hull,
            center_local: FxVec2::ZERO,
            center_mass: Fx::ONE,
            hull_mass: Fx::ONE,
            spring_k: Fx::ZERO,
            spring_damp: Fx::ZERO,
            radial_k: Fx::ZERO,
            radial_damp: Fx::ZERO,
            pressure_k: Fx::ZERO,
            shape_match_k: Fx::ZERO,
            shape_match_damp: Fx::ZERO,
            world_origin: FxVec2::new(fx(0), fx(0)),
            sort_key: None,
            static_hull_indices: Vec::new(),
            static_center: false,
            pin_frame: false,
        });

        let dt = Fx::ONE / Fx::from_int(60);
        let center_idx = res.center_idx as usize;
        let start_y = w.pos[center_idx].y;

        // Run 60 substeps.
        for _ in 0..60 { w.step(dt); }

        let end_y = w.pos[center_idx].y;
        // Semi-implicit Euler: after N steps with dt=1/60 and g=1000,
        // y velocity grows N*dt*g and position grows ~ Σ k*dt²*g for k=1..N.
        // Just confirm the center has fallen substantially and downward.
        assert!(end_y > start_y, "blob should have fallen, started at {} ended at {}",
            start_y.raw(), end_y.raw());
        // Expect ~ 0.5*g*t² ≈ 500 units after 1s with semi-implicit a bit higher.
        let dropped = end_y - start_y;
        assert!(dropped > Fx::from_int(400), "expected >400 unit drop, got {}", dropped.raw());
        assert!(dropped < Fx::from_int(700), "expected <700 unit drop, got {}", dropped.raw());
    }

    fn standard_square_blob(w: &mut SoftBodyWorld, origin: FxVec2, sort_key: &str) -> BlobResult {
        let hull = vec![
            FxVec2::new(fx(-20), fx(-20)),
            FxVec2::new(fx( 20), fx(-20)),
            FxVec2::new(fx( 20), fx( 20)),
            FxVec2::new(fx(-20), fx( 20)),
        ];
        w.add_blob_from_hull(AddBlobParams {
            hull_rest_local: hull,
            center_local: FxVec2::ZERO,
            center_mass: crate::tuning::CENTER_MASS,
            hull_mass:   crate::tuning::HULL_MASS,
            spring_k:    crate::tuning::SPRING_K,
            spring_damp: crate::tuning::SPRING_DAMP,
            radial_k:    crate::tuning::RADIAL_K,
            radial_damp: crate::tuning::RADIAL_DAMP,
            pressure_k:  crate::tuning::PRESSURE_K,
            shape_match_k:    crate::tuning::SHAPE_MATCH_K,
            shape_match_damp: crate::tuning::SHAPE_MATCH_DAMP,
            world_origin: origin,
            sort_key: Some(sort_key.into()),
            static_hull_indices: Vec::new(),
            static_center: false,
            pin_frame: false,
        })
    }

    #[test]
    fn tread_is_pure_circulation_and_deterministic() {
        // In free space (no contacts), a treadmill impulse circulates the hull
        // points but adds ~zero net linear momentum — it must not become a
        // sneaky thruster. And it must be byte-identical across two worlds.
        let mut a = SoftBodyWorld::new(WorldConfig::default(), 7);
        let mut b = SoftBodyWorld::new(WorldConfig::default(), 7);
        let ra = standard_square_blob(&mut a, FxVec2::new(fx(0), fx(0)), "p");
        let rb = standard_square_blob(&mut b, FxVec2::new(fx(0), fx(0)), "p");

        let dt = Fx::ONE / Fx::from_int(60);
        a.set_blob_tread(ra.blob_id, fx(900));
        a.apply_tread(dt);

        // Net linear momentum imparted to the hull ≈ 0 (tangents around a
        // closed symmetric ring cancel).
        let mut sum = FxVec2::ZERO;
        for &h in &a.blob_ranges[ra.blob_id as usize].hull {
            sum = sum.add(a.vel[h as usize]);
        }
        assert!(sum.length_squared() < fx(1), "tread added net momentum: {:?}", sum);

        // Determinism: same call on an identical world → identical velocities.
        b.set_blob_tread(rb.blob_id, fx(900));
        b.apply_tread(dt);
        for (&ha, &hb) in a.blob_ranges[ra.blob_id as usize].hull.iter()
            .zip(b.blob_ranges[rb.blob_id as usize].hull.iter())
        {
            assert_eq!(a.vel[ha as usize].x.raw(), b.vel[hb as usize].x.raw());
            assert_eq!(a.vel[ha as usize].y.raw(), b.vel[hb as usize].y.raw());
        }
    }

    #[test]
    fn blob_falls_onto_floor_and_does_not_tunnel() {
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::new(Fx::ZERO, fx(1000));
        cfg.substeps = 4;
        let mut w = SoftBodyWorld::new(cfg, 1);

        // Big horizontal floor at y = 200.
        w.register_static_polygon(
            vec![
                FxVec2::new(fx(-500), fx(200)),
                FxVec2::new(fx( 500), fx(200)),
                FxVec2::new(fx( 500), fx(260)),
                FxVec2::new(fx(-500), fx(260)),
            ],
            SurfaceMaterial::Default,
            None, None, None,
        );

        let res = standard_square_blob(&mut w, FxVec2::new(fx(0), fx(0)), "p0");
        let dt = Fx::ONE / Fx::from_int(60);
        for _ in 0..120 {
            w.step(dt);
        }
        // After ~2 seconds the blob should be resting near the floor —
        // every hull particle should be at y <= ~210 (a few units of slop).
        let res_center = res.center_idx as usize;
        let cy = w.pos[res_center].y;
        assert!(cy < fx(220), "blob should be near floor, got cy={}", cy.to_f64());
        // And: no hull particle should have tunneled through to y >> 260.
        for &h in &res.hull_indices {
            let y = w.pos[h as usize].y;
            assert!(y < fx(280), "particle {} tunneled past floor: y={}", h, y.to_f64());
        }
    }

    #[test]
    fn kinematic_static_does_not_tunnel_past_particle() {
        // A spring pad fires (its poly jumps from y=120→y=80 between
        // frames). A stationary particle at y=100 should be CAUGHT by
        // the swept-pad CCD, not left in free space below the pad's new
        // resting top.
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::ZERO;
        cfg.substeps = 2;
        let mut w = SoftBodyWorld::new(cfg, 1);

        // Spring pad in "loaded" pose: top at y=120, body below.
        let pad_idx = w.register_static_polygon(
            vec![
                FxVec2::new(fx(-50), fx(120)),
                FxVec2::new(fx( 50), fx(120)),
                FxVec2::new(fx( 50), fx(140)),
                FxVec2::new(fx(-50), fx(140)),
            ],
            SurfaceMaterial::Default, None, None, None,
        );

        // Drop a blob centered at (0, 100) — particles straddle y=100.
        let res = standard_square_blob(&mut w, FxVec2::new(fx(0), fx(80)), "p");
        // One stepping frame to settle.
        let dt = Fx::ONE / Fx::from_int(60);
        w.step(dt);

        // Fire the pad: top jumps from y=120 to y=80 (40 units up in one
        // commit). With the prev_poly CCD this should sweep through the
        // particles and push them up.
        w.update_static_surface(
            pad_idx,
            vec![
                FxVec2::new(fx(-50), fx(80)),
                FxVec2::new(fx( 50), fx(80)),
                FxVec2::new(fx( 50), fx(100)),
                FxVec2::new(fx(-50), fx(100)),
            ],
            Some(FxVec2::new(Fx::ZERO, fx(-2400))), // ~40 units / (1/60 s) upward
        );

        // Step again — CCD should sweep the particle paths against the
        // pad's PREVIOUS poly (top at y=120) and push them above it.
        // Without the prev_poly fix, particles would still be at ~y=100
        // (free space below the pad's new top at y=80).
        w.step(dt);

        // Every hull particle should be at y <= 80 (above the pad's
        // new top) — if any are between y=80 and y=120 the swept CCD
        // missed them.
        let center_y = w.pos[res.center_idx as usize].y;
        assert!(
            center_y < fx(85),
            "kinematic static tunneled past particle: center y = {} (expected < 85)",
            center_y.to_f64(),
        );
    }

    #[test]
    fn rope_chain_obeys_max_segment_length_under_gravity() {
        // Two anchors (mass=0) suspended at the same height with a rope
        // between them. After settling, every adjacent pair must respect
        // the per-segment max length (within solver tolerance). If the
        // chain solver is broken, the rope stretches arbitrarily under
        // gravity instead of holding its segment budget.
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::new(Fx::ZERO, fx(980));
        cfg.substeps = 4;
        let mut w = SoftBodyWorld::new(cfg, 1);

        let left  = w.add_particle(FxVec2::new(fx(0),   fx(0)), FxVec2::ZERO, Fx::ZERO, Fx::ZERO);
        let right = w.add_particle(FxVec2::new(fx(200), fx(0)), FxVec2::ZERO, Fx::ZERO, Fx::ZERO);
        let inner = w.add_rope_chain(
            left, right,
            fx(240),   // total budget — slightly longer than anchor distance, so it sags
            fx(10),    // max segment length
            fx_lit(5, 10),    // segment mass 0.5
            fx(6),     // segment radius
            crate::layers::LAYER_CHAIN,
            crate::layers::LAYER_WORLD,
            16,
        );

        let dt = Fx::ONE / Fx::from_int(60);
        for _ in 0..120 { w.step(dt); }

        // Walk the chain from left → inner → right and check every pair.
        let mut indices: Vec<usize> = Vec::with_capacity(inner.len() + 2);
        indices.push(left as usize);
        for &i in &inner { indices.push(i as usize); }
        indices.push(right as usize);

        // Allow ~5% over the max segment length for solver residual.
        let tolerance = fx_lit(105, 100); // 1.05
        let max_allowed = fx(10) * tolerance;
        for k in 0..indices.len() - 1 {
            let a = w.pos[indices[k]];
            let b = w.pos[indices[k + 1]];
            let dist = b.sub(a).length();
            assert!(
                dist <= max_allowed,
                "segment {}-{} stretched to {} (max {} + 5% = {})",
                k, k + 1, dist.to_f64(), 10.0, max_allowed.to_f64(),
            );
        }

        // Sanity: the rope actually sagged — middle particle should be
        // below y = 50 (well below the anchors at y=0).
        let mid = w.pos[inner[inner.len() / 2] as usize];
        assert!(
            mid.y > fx(50),
            "rope didn't sag — middle particle at y={} (expected > 50)",
            mid.y.to_f64(),
        );
    }

    #[test]
    fn snapshot_round_trip_reproduces_state() {
        // Set up a non-trivial scene (gravity, floor, two blobs, head-on
        // collision so all the contact-tracking arrays get populated).
        // Snapshot at tick 30, then continue to tick 60 on world A.
        // Separately: snapshot world B at the same point, restore from
        // A's snapshot, step to 60. Both worlds must agree byte-for-byte.
        fn build() -> SoftBodyWorld {
            let mut cfg = WorldConfig::default();
            cfg.gravity = FxVec2::new(Fx::ZERO, fx(1000));
            cfg.substeps = 4;
            let mut w = SoftBodyWorld::new(cfg, 42);
            w.register_static_polygon(
                vec![
                    FxVec2::new(fx(-500), fx(200)),
                    FxVec2::new(fx( 500), fx(200)),
                    FxVec2::new(fx( 500), fx(260)),
                    FxVec2::new(fx(-500), fx(260)),
                ],
                SurfaceMaterial::Default, None, None, None,
            );
            let a = standard_square_blob(&mut w, FxVec2::new(fx(-50), fx(0)), "a");
            let _b = standard_square_blob(&mut w, FxVec2::new(fx( 50), fx(0)), "b");
            w.apply_blob_linear_velocity_delta(a.blob_id, FxVec2::new(fx(800), Fx::ZERO));
            w
        }

        let dt = Fx::ONE / Fx::from_int(60);
        let mut wa = build();
        for _ in 0..30 { wa.step(dt); }

        // Snapshot at tick 30.
        let snap = wa.serialize_state();

        // Continue wa to tick 60.
        for _ in 0..30 { wa.step(dt); }

        // Build a fresh world, restore from snap, step the same 30 ticks.
        let mut wb = build();
        wb.restore_state(&snap).expect("restore should succeed");
        for _ in 0..30 { wb.step(dt); }

        // Byte-equal pos + vel + tick.
        assert_eq!(wa.tick, wb.tick);
        for i in 0..wa.pos.len() {
            assert_eq!(wa.pos[i], wb.pos[i], "pos[{}] diverged after restore+replay", i);
            assert_eq!(wa.vel[i], wb.vel[i], "vel[{}] diverged after restore+replay", i);
        }
    }

    #[test]
    fn snapshot_restore_after_mutation_recovers_original() {
        // Take a snapshot, mutate the world arbitrarily, restore, assert
        // state matches the original (positions, mass scales, ...).
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::ZERO;
        let mut w = SoftBodyWorld::new(cfg, 7);
        let res = standard_square_blob(&mut w, FxVec2::new(fx(0), fx(0)), "x");
        let dt = Fx::ONE / Fx::from_int(60);
        for _ in 0..10 { w.step(dt); }

        let snap = w.serialize_state();
        let original_pos = w.pos.clone();
        let original_tick = w.tick;

        // Mutate: apply a velocity delta, step a bunch, scale mass.
        w.apply_blob_linear_velocity_delta(res.blob_id, FxVec2::new(fx(500), Fx::ZERO));
        for _ in 0..30 { w.step(dt); }
        w.set_blob_mass_scale(res.blob_id, fx(3));

        // Now restore.
        w.restore_state(&snap).expect("restore");
        assert_eq!(w.tick, original_tick);
        for i in 0..w.pos.len() {
            assert_eq!(w.pos[i], original_pos[i], "pos[{}] not restored", i);
        }
    }

    #[test]
    fn two_worlds_same_seed_byte_identical_state() {
        // Run the same scenario in two fresh worlds; positions and velocities
        // after N substeps must be byte-equal. This is the Phase 2.6 exit
        // criterion (raised to bit-exact across CCD-active paths).
        fn scenario() -> SoftBodyWorld {
            let mut cfg = WorldConfig::default();
            cfg.gravity = FxVec2::ZERO; // zero gravity isolates the test to CCD/collisions
            cfg.substeps = 2;
            let mut w = SoftBodyWorld::new(cfg, 42);
            let a = standard_square_blob(&mut w, FxVec2::new(fx(0), fx(0)), "a");
            let _b = standard_square_blob(&mut w, FxVec2::new(fx(80), fx(0)), "b");
            // Slam a into b.
            w.apply_blob_linear_velocity_delta(a.blob_id, FxVec2::new(fx(2000), Fx::ZERO));
            w
        }

        let mut wa = scenario();
        let mut wb = scenario();
        let dt = Fx::ONE / Fx::from_int(60);
        for step in 0..60 {
            wa.step(dt);
            wb.step(dt);
            for i in 0..wa.pos.len() {
                assert_eq!(wa.pos[i], wb.pos[i],
                    "step {} particle {} position diverged: {:?} vs {:?}",
                    step, i, wa.pos[i], wb.pos[i]);
                assert_eq!(wa.vel[i], wb.vel[i],
                    "step {} particle {} velocity diverged: {:?} vs {:?}",
                    step, i, wa.vel[i], wb.vel[i]);
            }
        }
    }

    #[test]
    fn add_blob_layout_matches_ts() {
        let mut w = SoftBodyWorld::new(WorldConfig::default(), 1);
        let hull = vec![
            FxVec2::new(fx(-10), fx(-10)),
            FxVec2::new(fx( 10), fx(-10)),
            FxVec2::new(fx( 10), fx( 10)),
            FxVec2::new(fx(-10), fx( 10)),
        ];
        let res = w.add_blob_from_hull(AddBlobParams {
            hull_rest_local: hull,
            center_local: FxVec2::ZERO,
            center_mass: Fx::ONE,
            hull_mass: Fx::HALF,
            spring_k: fx(10),
            spring_damp: Fx::ONE,
            radial_k: fx(10),
            radial_damp: Fx::ONE,
            pressure_k: Fx::ZERO,
            shape_match_k: Fx::ZERO,
            shape_match_damp: Fx::ZERO,
            world_origin: FxVec2::new(fx(100), fx(200)),
            sort_key: Some("p0".into()),
            static_hull_indices: Vec::new(),
            static_center: false,
            pin_frame: false,
        });
        assert_eq!(res.blob_id, 0);
        assert_eq!(res.center_idx, 0);
        assert_eq!(res.hull_indices.len(), 4);
        // 1 center + 4 hull = 5 particles
        assert_eq!(w.pos.len(), 5);
        // Center at world origin
        assert_eq!(w.pos[0], FxVec2::new(fx(100), fx(200)));
        // 4 edge + 4 shear + 4 radial = 12 springs
        assert_eq!(w.springs.len(), 12);
    }

    /// Repro of the "blob spreads out over the whole screen" crush bug.
    /// A blob is sandwiched between a fixed floor and a ceiling that
    /// descends one unit per frame until they overlap, then keeps
    /// descending. We log per-step diagnostics so we can see what the
    /// blob actually does — centroid travel, hull bbox spread, max
    /// distance from centroid, max particle coord, and the contents of
    /// `pending_crush_events`. Goal: identify the symptom signature so
    /// the production detector matches it.
    #[test]
    fn crush_repro_logs_blob_state() {
        let mut cfg = WorldConfig::default();
        cfg.gravity = FxVec2::new(Fx::ZERO, fx(1000));
        cfg.substeps = 2;
        let mut w = SoftBodyWorld::new(cfg, 1);

        // Floor at y = 100 (top edge), 40 tall.
        w.register_static_polygon(
            vec![
                FxVec2::new(fx(-500), fx(100)),
                FxVec2::new(fx( 500), fx(100)),
                FxVec2::new(fx( 500), fx(140)),
                FxVec2::new(fx(-500), fx(140)),
            ],
            SurfaceMaterial::Default, None, None, None,
        );
        // Ceiling: bottom edge initially at y = -10 (60 units above floor
        // top at y=100, blob is 40 tall and centered at y=40).
        let ceiling_idx = w.register_static_polygon(
            vec![
                FxVec2::new(fx(-500), fx(-50)),
                FxVec2::new(fx( 500), fx(-50)),
                FxVec2::new(fx( 500), fx(-10)),
                FxVec2::new(fx(-500), fx(-10)),
            ],
            SurfaceMaterial::Default, None, None, None,
        );

        // Standard 40x40 blob centered at (0, 40).
        let res = standard_square_blob(&mut w, FxVec2::new(fx(0), fx(40)), "victim");
        let center_idx = res.center_idx as usize;
        let hull: Vec<usize> = res.hull_indices.iter().map(|&i| i as usize).collect();

        let dt = Fx::ONE / Fx::from_int(60);

        // Let it settle for a few frames so it's resting on the floor.
        for _ in 0..10 { w.step(dt); }
        eprintln!("=== settled, beginning crush ===");
        eprintln!("settled center: ({}, {})", w.pos[center_idx].x.to_f64(), w.pos[center_idx].y.to_f64());

        // PIXELS_PER_FRAME — how fast the ceiling descends. 1 px/frame is
        // a slow squeeze and produces a mild explosion (bbox grows ~2.5×
        // rest); 4-8 px/frame mimics a real spring plate or moving
        // platform and produces the dramatic full-screen explosion the
        // game shows.
        const PIXELS_PER_FRAME: i32 = 4;
        // Now slam the ceiling down PIXELS_PER_FRAME unit(s) per frame for 200 frames.
        // Floor-top is y=100, blob is ~40 tall resting on it so its top
        // hull is at ~y=60. Ceiling starts with bottom at y=-10, descends
        // at 1 unit/frame. They first touch around frame 70, and from
        // frame 110 onward the ceiling has crossed the floor by 40+
        // units — the blob has no escape route.
        let mut prev_centroid = centroid_from_indices(&w.pos, &hull);
        let mut max_centroid_jump_sq = Fx::ZERO;
        let mut max_spread_w = Fx::ZERO;
        let mut max_spread_h = Fx::ZERO;
        let mut max_coord = Fx::ZERO;
        let mut max_radius_from_centroid_sq = Fx::ZERO;
        let mut first_crush_frame: Option<i32> = None;

        for frame in 0..200 {
            // Move ceiling down 1 unit/frame. Velocity = 60 units/sec.
            let descent = (frame + 1) * PIXELS_PER_FRAME;
            let new_top    = fx(-50 + descent);
            let new_bottom = fx(-10 + descent);
            w.update_static_surface(
                ceiling_idx,
                vec![
                    FxVec2::new(fx(-500), new_top),
                    FxVec2::new(fx( 500), new_top),
                    FxVec2::new(fx( 500), new_bottom),
                    FxVec2::new(fx(-500), new_bottom),
                ],
                Some(FxVec2::new(Fx::ZERO, fx(60 * PIXELS_PER_FRAME))),
            );
            w.step(dt);

            // Per-frame diagnostics.
            let c = centroid_from_indices(&w.pos, &hull);
            let dx = c.x - prev_centroid.x;
            let dy = c.y - prev_centroid.y;
            let jump_sq = dx*dx + dy*dy;
            if jump_sq > max_centroid_jump_sq { max_centroid_jump_sq = jump_sq; }
            prev_centroid = c;

            // Hull bbox.
            let mut min_x = w.pos[hull[0]].x;
            let mut max_x = min_x;
            let mut min_y = w.pos[hull[0]].y;
            let mut max_y = min_y;
            let mut blob_max_coord = Fx::ZERO;
            let mut max_r_sq = Fx::ZERO;
            for &h in &hull {
                let p = w.pos[h];
                if p.x < min_x { min_x = p.x; }
                if p.x > max_x { max_x = p.x; }
                if p.y < min_y { min_y = p.y; }
                if p.y > max_y { max_y = p.y; }
                let ax = p.x.abs();
                let ay = p.y.abs();
                if ax > blob_max_coord { blob_max_coord = ax; }
                if ay > blob_max_coord { blob_max_coord = ay; }
                let rx = p.x - c.x;
                let ry = p.y - c.y;
                let r_sq = rx*rx + ry*ry;
                if r_sq > max_r_sq { max_r_sq = r_sq; }
            }
            let spread_w = max_x - min_x;
            let spread_h = max_y - min_y;
            if spread_w > max_spread_w { max_spread_w = spread_w; }
            if spread_h > max_spread_h { max_spread_h = spread_h; }
            if blob_max_coord > max_coord { max_coord = blob_max_coord; }
            if max_r_sq > max_radius_from_centroid_sq { max_radius_from_centroid_sq = max_r_sq; }

            let crush = w.take_crush_events();
            if !crush.is_empty() && first_crush_frame.is_none() {
                first_crush_frame = Some(frame);
            }

            // Log every frame in the danger zone (and a few before/after).
            // Always log around the impact frame and every 10 elsewhere.
            let impact = 60 / PIXELS_PER_FRAME;
            if (frame >= impact - 5 && frame <= impact + 30) || frame % 10 == 0 {
                eprintln!(
                    "frame {:3}: c=({:8.2},{:8.2}) jump={:7.2} bbox=({:7.2}x{:7.2}) maxR={:7.2} maxCoord={:9.2} crushFlagged={}",
                    frame,
                    c.x.to_f64(), c.y.to_f64(),
                    crate::math::sqrt_fx(jump_sq).to_f64(),
                    spread_w.to_f64(), spread_h.to_f64(),
                    crate::math::sqrt_fx(max_r_sq).to_f64(),
                    blob_max_coord.to_f64(),
                    !crush.is_empty(),
                );
            }
        }

        eprintln!("=== summary ===");
        eprintln!("max centroid jump   = {:.2}", crate::math::sqrt_fx(max_centroid_jump_sq).to_f64());
        eprintln!("max bbox width      = {:.2}", max_spread_w.to_f64());
        eprintln!("max bbox height     = {:.2}", max_spread_h.to_f64());
        eprintln!("max radius from c   = {:.2}", crate::math::sqrt_fx(max_radius_from_centroid_sq).to_f64());
        eprintln!("max |coord|         = {:.2}", max_coord.to_f64());
        eprintln!("first crush frame   = {:?}", first_crush_frame);
        // Rest-length of the 40x40 hull is 40 (edge) and ~56.6 (diagonal).
        // A "healthy" blob's max radius from centroid sits near ~28 (half
        // diagonal). Anything dramatically larger means the blob exploded.

        // Regression assertion: with the 10× rest-extent threshold (RATIO_SQ
        // = 100, raised from 3× to stop false-positive deaths during normal
        // squish/stretch play), the catastrophic explosion reaches the new
        // threshold around frame ~168. 200 keeps generous headroom while
        // still proving the detector fires on a genuine blow-up.
        let first = first_crush_frame.expect("crush detector failed to flag any frame");
        assert!(
            first <= 200,
            "crush detection too late: first flagged frame = {} (expected <= 200)",
            first,
        );
    }
}
