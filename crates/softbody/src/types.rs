// Data model. Direct port of src/physics/types.ts.

use crate::fx::{Fx, FxVec2};

pub type ParticleIdx = u32;
pub type SpringIdx = u32;
pub type BlobId = u32;
pub type ShapeIdx = u32;

#[derive(Copy, Clone, Debug)]
pub struct Spring {
    pub i: ParticleIdx,
    pub j: ParticleIdx,
    pub rest: Fx,
    pub k_base: Fx,
    pub damp_base: Fx,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum SurfaceMaterial {
    Default,
    Ice,
    Sticky,
    Bouncy,
}

#[derive(Copy, Clone, Debug)]
pub struct MaterialParams {
    pub restitution: Fx,
    pub friction_mu: Fx,
}

#[derive(Clone, Debug)]
pub struct StaticSurface {
    pub poly: Vec<FxVec2>,
    /// Poly at the start of the current frame, before `update_static_surface`
    /// most recently overwrote `poly`. Used by `sweep_static_ccd` so a fast-
    /// moving kinematic surface (spring pads firing, moving platforms) can't
    /// tunnel past a stationary particle: we sweep the particle's path
    /// against BOTH the old and new polygon edges. None until the first
    /// `update_static_surface` call on this surface.
    pub prev_poly: Option<Vec<FxVec2>>,
    pub material: SurfaceMaterial,
    pub id: Option<String>,
    /// Kinematic surface velocity (world units per second). `None` ≡ stationary.
    pub velocity: Option<FxVec2>,
    pub layer: u32,
    pub mask: u32,
}

#[derive(Clone, Debug)]
pub enum GravityField {
    Uniform { vector: FxVec2 },
    Point {
        center: FxVec2,
        strength: Fx,
        falloff: PointGravityFalloff,
    },
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PointGravityFalloff {
    Linear,
    InverseSquare,
}

/// Layout-only counterpart to BlobRange in TS. `sort_key` is kept as a
/// String so iteration order matches the JS-side sort (ASCII / UTF-16
/// code-point order — kept identical by using only ASCII sort keys in
/// the level/PM code).
#[derive(Clone, Debug)]
pub struct BlobRange {
    pub id: BlobId,
    pub start: ParticleIdx,
    pub end: ParticleIdx,
    pub hull: Vec<ParticleIdx>,
    pub shape_idx: ShapeIdx,
    pub spring_begin: SpringIdx,
    pub spring_end: SpringIdx,
    pub spring_stiffness_scale: Fx,
    pub spring_damp_scale: Fx,
    pub sort_key: String,
    pub inactive: bool,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct Transform2D {
    pub cos: Fx,
    pub sin: Fx,
    pub tx: Fx,
    pub ty: Fx,
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub indices: Vec<ParticleIdx>,
    pub static_poly: Vec<FxVec2>,
    pub is_trigger: bool,
    pub is_static: bool,
    pub target_rest_area: Fx,
    pub pressure_k: Fx,
    pub shape_match_k: Fx,
    pub shape_match_damp: Fx,
    pub rest_local: Vec<FxVec2>,
    pub shape_match_rest_scale: Fx,
    pub use_frame_override: bool,
    pub frame_override: Transform2D,
    pub gravity_field: Option<GravityField>,
    pub center_idx: ParticleIdx,
    pub inactive: bool,
    pub layer: u32,
    pub mask: u32,
}

#[derive(Clone, Debug)]
pub struct WorldConfig {
    pub gravity: FxVec2,
    pub gravity_scale: Fx,
    pub fixed_dt: Fx,
    pub substeps: u32,
    pub collision_margin: Fx,
    pub collision_restitution: Fx,
    pub constraint_iters: u32,
    /// Inner iterations of the discrete collision pass per substep.
    /// `1` matches the TS sim; `≥2` lets deeply-merged blobs untangle
    /// (each iter pushes a bit, after a few iters they drift toward
    /// the shallower escape side). Cheap: O(iters · blobs² · hull²).
    pub collision_iterations: u32,
    pub static_restitution: Fx,
    pub static_contact_slop: Fx,
    pub blob_blob_friction_mu: Fx,
    pub blob_blob_friction_impulse_scale: Fx,
    pub static_edge_friction_mu: Fx,
    pub static_friction_min_tang_speed: Fx,
    pub static_friction_normal_load_scale: Fx,
    pub hull_vertex_damping_per_sec: Fx,
    pub center_hull_damping_per_sec: Fx,
    pub hull_damp_skip_above_speed: Fx,
}

#[derive(Clone, Debug)]
pub struct BlobResult {
    pub blob_id: BlobId,
    pub center_idx: ParticleIdx,
    pub hull_indices: Vec<ParticleIdx>,
    pub shape_idx: ShapeIdx,
}

#[derive(Copy, Clone, Debug)]
pub struct PumpEdge {
    pub i0: ParticleIdx,
    pub i1: ParticleIdx,
    pub mid: FxVec2,
    pub normal: FxVec2,
    pub impulse: Fx,
}

#[derive(Copy, Clone, Debug)]
pub struct RayHit {
    pub hit: bool,
    pub distance: Fx,
    pub position: FxVec2,
    pub normal: FxVec2,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct Aabb {
    pub min_x: Fx,
    pub min_y: Fx,
    pub max_x: Fx,
    pub max_y: Fx,
}
