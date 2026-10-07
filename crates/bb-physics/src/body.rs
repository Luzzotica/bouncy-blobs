//! Softbody data model and builders.
//!
//! Every dynamic thing in the game — player blobs, soft platforms, props, the
//! menu's buttons, rope segments — is a [`Body`]: a set of particles held
//! together by XPBD constraints, with an outline (`boundary`) used for
//! collision and rendering.

use glam::Vec2;

use crate::geom::{self, Aabb};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BodyId {
    pub index: u32,
    pub generation: u32,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BodyKind {
    /// Closed ring held by a volume (pressure) constraint + shape matching.
    Blob,
    /// Triangulated sheet (platforms, props, UI). Shape kept by per-triangle
    /// area constraints, edges and optional shape matching.
    Mesh,
    /// Open chain of particles. See [`crate::rope`].
    Rope,
}

#[derive(Copy, Clone, Debug)]
pub struct Edge {
    pub a: u32,
    pub b: u32,
    pub rest: f32,
}

#[derive(Copy, Clone, Debug)]
pub struct Tri {
    pub i: [u32; 3],
    pub rest_area: f32,
}

#[derive(Copy, Clone, Debug)]
pub struct Material {
    /// Static (sticking) friction coefficient.
    pub static_friction: f32,
    /// Kinetic (sliding) friction coefficient.
    pub dynamic_friction: f32,
    /// Normal-velocity restitution applied after contact (0 = absorb).
    pub restitution: f32,
}

impl Default for Material {
    fn default() -> Self {
        Material { static_friction: 0.6, dynamic_friction: 0.4, restitution: 0.0 }
    }
}

/// How far a body may squash or stretch, and when it pops.
///
/// The limits are enforced as *hard* constraints, so normal play (bumping
/// into other blobs, being stood on) can never exceed them. A body pops only
/// when something non-negotiable — static geometry, a kinematic platform,
/// a rope anchored to the world — keeps forcing it past a limit by more than
/// `tolerance` for `grace` seconds. Neighbours of a popped body get
/// `immunity` seconds so one crush never cascades into a chain of pops.
#[derive(Copy, Clone, Debug)]
pub struct StrainLimits {
    /// Minimum outline area as a fraction of rest area.
    pub min_area: f32,
    /// Maximum outline area as a fraction of rest area.
    pub max_area: f32,
    /// Maximum edge length as a multiple of its rest length.
    pub max_stretch: f32,
    /// Relative overshoot beyond a limit that counts as "being forced".
    pub tolerance: f32,
    /// Seconds a body must be forced past a limit before it pops.
    pub grace: f32,
    /// Seconds neighbours of a popped body are protected from popping.
    pub immunity: f32,
    pub poppable: bool,
}

impl Default for StrainLimits {
    fn default() -> Self {
        StrainLimits {
            min_area: 0.35,
            max_area: 2.6,
            max_stretch: 2.2,
            tolerance: 0.12,
            grace: 0.12,
            immunity: 0.6,
            poppable: false,
        }
    }
}

#[derive(Copy, Clone, Debug)]
pub struct BodyParams {
    /// XPBD compliance (inverse stiffness) of edges. 0 = inextensible.
    pub edge_compliance: f32,
    /// Compliance of per-triangle area constraints (meshes).
    pub tri_compliance: f32,
    /// Compliance of the whole-outline area ("pressure") constraint (blobs).
    pub volume_compliance: f32,
    /// Compliance of shape matching. `None` disables it.
    pub shape_compliance: Option<f32>,
    /// Per-second damping of particle velocity relative to the body's mean
    /// velocity: kills jelly wobble without slowing the body as a whole.
    pub internal_damping: f32,
    /// Per-second damping of absolute velocity.
    pub linear_damping: f32,
    /// Collision skin radius of every particle / outline edge.
    pub radius: f32,
    pub material: Material,
    pub limits: StrainLimits,
    /// Gravity multiplier for this body.
    pub gravity_scale: f32,
}

impl Default for BodyParams {
    fn default() -> Self {
        BodyParams {
            edge_compliance: 1e-6,
            tri_compliance: 1e-6,
            volume_compliance: 1e-7,
            shape_compliance: Some(2e-5),
            internal_damping: 2.0,
            linear_damping: 0.05,
            radius: 2.0,
            material: Material::default(),
            limits: StrainLimits::default(),
            gravity_scale: 1.0,
        }
    }
}

/// Everything needed to create a body. Built with the constructors below,
/// then customised by mutating `params` before `World::add_body`.
#[derive(Clone, Debug)]
pub struct BodyDesc {
    pub kind: BodyKind,
    pub positions: Vec<Vec2>,
    pub masses: Vec<f32>,
    pub edges: Vec<(u32, u32)>,
    pub tris: Vec<[u32; 3]>,
    pub boundary: Vec<u32>,
    pub closed: bool,
    pub params: BodyParams,
    pub velocity: Vec2,
    pub layer: u32,
    pub mask: u32,
    pub user_data: u64,
}

impl BodyDesc {
    /// A round blob: `segments` outline particles at `radius` around `center`.
    pub fn blob(center: Vec2, radius: f32, segments: usize, mass: f32) -> BodyDesc {
        let n = segments.max(3);
        let ring: Vec<Vec2> = (0..n)
            .map(|i| {
                let a = i as f32 / n as f32 * std::f32::consts::TAU;
                center + Vec2::new(a.cos(), a.sin()) * radius
            })
            .collect();
        Self::blob_from_outline(&ring, mass)
    }

    /// A blob with an arbitrary (simple) outline — stars, squares, hearts.
    pub fn blob_from_outline(outline: &[Vec2], mass: f32) -> BodyDesc {
        let mut pts = outline.to_vec();
        if geom::signed_area_slice(&pts) < 0.0 {
            pts.reverse();
        }
        let n = pts.len() as u32;
        let mut edges: Vec<(u32, u32)> = (0..n).map(|i| (i, (i + 1) % n)).collect();
        // Skip-one diagonals resist the outline crumpling at a single vertex.
        if n >= 6 {
            edges.extend((0..n).map(|i| (i, (i + 2) % n)));
        }
        BodyDesc {
            kind: BodyKind::Blob,
            masses: vec![mass / n as f32; n as usize],
            positions: pts,
            edges,
            tris: Vec::new(),
            boundary: (0..n).collect(),
            closed: true,
            params: BodyParams {
                limits: StrainLimits { poppable: true, ..Default::default() },
                ..Default::default()
            },
            velocity: Vec2::ZERO,
            layer: 1,
            mask: u32::MAX,
            user_data: 0,
        }
    }

    /// A triangulated rectangle sheet, `cols x rows` cells. Used for soft
    /// platforms, ground, and UI panels. Any number of cells is stable.
    pub fn grid(min: Vec2, max: Vec2, cols: usize, rows: usize, mass: f32) -> BodyDesc {
        let (cols, rows) = (cols.max(1), rows.max(1));
        let (nx, ny) = (cols + 1, rows + 1);
        let size = max - min;
        let mut positions = Vec::with_capacity(nx * ny);
        for y in 0..ny {
            for x in 0..nx {
                positions.push(min + Vec2::new(x as f32 / cols as f32 * size.x, y as f32 / rows as f32 * size.y));
            }
        }
        let id = |x: usize, y: usize| (y * nx + x) as u32;
        let mut tris = Vec::with_capacity(cols * rows * 2);
        for y in 0..rows {
            for x in 0..cols {
                // Alternate the diagonal so the sheet has no handedness bias.
                if (x + y) % 2 == 0 {
                    tris.push([id(x, y), id(x + 1, y), id(x + 1, y + 1)]);
                    tris.push([id(x, y), id(x + 1, y + 1), id(x, y + 1)]);
                } else {
                    tris.push([id(x, y), id(x + 1, y), id(x, y + 1)]);
                    tris.push([id(x + 1, y), id(x + 1, y + 1), id(x, y + 1)]);
                }
            }
        }
        let edges = edges_from_tris(&tris);
        let mut boundary = Vec::new();
        for x in 0..nx {
            boundary.push(id(x, 0));
        }
        for y in 1..ny {
            boundary.push(id(nx - 1, y));
        }
        for x in (0..nx - 1).rev() {
            boundary.push(id(x, ny - 1));
        }
        for y in (1..ny - 1).rev() {
            boundary.push(id(0, y));
        }
        let n = positions.len();
        BodyDesc {
            kind: BodyKind::Mesh,
            masses: vec![mass / n as f32; n],
            positions,
            edges,
            tris,
            boundary,
            closed: true,
            params: BodyParams::default(),
            velocity: Vec2::ZERO,
            layer: 1,
            mask: u32::MAX,
            user_data: 0,
        }
    }

    /// A soft mesh from any simple polygon outline. The outline is
    /// resampled so no edge is longer than `spacing`, then triangulated.
    pub fn mesh_from_outline(outline: &[Vec2], spacing: f32, mass: f32) -> BodyDesc {
        let mut pts = resample_loop(outline, spacing);
        if geom::signed_area_slice(&pts) < 0.0 {
            pts.reverse();
        }
        let tris = geom::triangulate(&pts);
        let mut edges = edges_from_tris(&tris);
        let n = pts.len() as u32;
        for i in 0..n {
            let e = ((i).min((i + 1) % n), (i).max((i + 1) % n));
            if !edges.contains(&e) {
                edges.push(e);
            }
        }
        BodyDesc {
            kind: BodyKind::Mesh,
            masses: vec![mass / n as f32; n as usize],
            positions: pts,
            edges,
            tris,
            boundary: (0..n).collect(),
            closed: true,
            params: BodyParams::default(),
            velocity: Vec2::ZERO,
            layer: 1,
            mask: u32::MAX,
            user_data: 0,
        }
    }

    /// An open chain through `points` (rope / chain).
    pub fn chain(points: &[Vec2], mass: f32) -> BodyDesc {
        let n = points.len() as u32;
        BodyDesc {
            kind: BodyKind::Rope,
            masses: vec![mass / n.max(1) as f32; n as usize],
            positions: points.to_vec(),
            edges: (0..n.saturating_sub(1)).map(|i| (i, i + 1)).collect(),
            tris: Vec::new(),
            boundary: (0..n).collect(),
            closed: false,
            params: BodyParams {
                edge_compliance: 0.0,
                shape_compliance: None,
                internal_damping: 0.5,
                radius: 3.0,
                ..Default::default()
            },
            velocity: Vec2::ZERO,
            layer: 1,
            mask: u32::MAX,
            user_data: 0,
        }
    }

    pub fn with_params(mut self, f: impl FnOnce(&mut BodyParams)) -> Self {
        f(&mut self.params);
        self
    }

    pub fn with_velocity(mut self, v: Vec2) -> Self {
        self.velocity = v;
        self
    }

    pub fn with_user_data(mut self, d: u64) -> Self {
        self.user_data = d;
        self
    }
}

fn edges_from_tris(tris: &[[u32; 3]]) -> Vec<(u32, u32)> {
    let mut edges: Vec<(u32, u32)> = tris
        .iter()
        .flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])])
        .map(|(a, b)| (a.min(b), a.max(b)))
        .collect();
    edges.sort_unstable();
    edges.dedup();
    edges
}

/// Insert points along a closed outline so no edge exceeds `spacing`.
pub fn resample_loop(outline: &[Vec2], spacing: f32) -> Vec<Vec2> {
    let mut out = Vec::new();
    let n = outline.len();
    for i in 0..n {
        let a = outline[i];
        let b = outline[(i + 1) % n];
        let k = ((b - a).length() / spacing.max(1e-3)).ceil().max(1.0) as usize;
        for s in 0..k {
            out.push(a.lerp(b, s as f32 / k as f32));
        }
    }
    out
}

/// Live simulated body.
#[derive(Clone, Debug)]
pub struct Body {
    pub kind: BodyKind,
    pub x: Vec<Vec2>,
    pub prev: Vec<Vec2>,
    pub v: Vec<Vec2>,
    /// Inverse mass per particle (0 = pinned / kinematic).
    pub w: Vec<f32>,
    /// Inverse mass as created, so pins can be released.
    pub base_w: Vec<f32>,
    /// Rest configuration centred on the rest centroid. Used for shape
    /// matching and as texture coordinates by the renderer.
    pub rest: Vec<Vec2>,
    pub edges: Vec<Edge>,
    pub tris: Vec<Tri>,
    pub boundary: Vec<u32>,
    pub closed: bool,
    pub rest_area: f32,
    pub params: BodyParams,
    /// Uniform scale applied to the rest shape (the "expand" mechanic).
    pub rest_scale: f32,
    /// Extra pressure on top of `rest_scale` (1 = neutral).
    pub inflate: f32,
    pub layer: u32,
    pub mask: u32,
    pub user_data: u64,
    pub enabled: bool,
    pub aabb: Aabb,
    /// Accumulated acceleration applied to every dynamic particle this step.
    pub(crate) accel: Vec2,
    /// Per-particle extra acceleration this step (tread, wind on a point…).
    pub(crate) point_accel: Vec<Vec2>,
    /// Kinematic targets for pinned particles: (particle, start, target).
    pub(crate) kinematic: Vec<(u32, Vec2, Vec2)>,
    /// Optional soft tether of every particle to a fixed world position —
    /// jelly terrain and soft platforms that wobble but stay put. Unlike a
    /// chain of edges this stiffness doesn't depend on mesh resolution.
    pub home: Option<Vec<Vec2>>,
    /// XPBD compliance of the home tethers (scaled by particle mass).
    pub home_compliance: f32,
    pub(crate) strain_time: f32,
    pub(crate) immunity: f32,
    /// Worst limit overshoot measured in the last step (0 = within limits).
    pub strain: f32,
    /// Fill ratio of outline area to rest area after the last step.
    pub area_ratio: f32,
}

impl Body {
    pub(crate) fn from_desc(d: BodyDesc) -> Body {
        let n = d.positions.len();
        let w: Vec<f32> = d.masses.iter().map(|&m| if m > 0.0 { 1.0 / m } else { 0.0 }).collect();
        let c = geom::centroid(&d.positions);
        let rest: Vec<Vec2> = d.positions.iter().map(|p| *p - c).collect();
        let edges = d
            .edges
            .iter()
            .map(|&(a, b)| Edge { a, b, rest: (d.positions[a as usize] - d.positions[b as usize]).length() })
            .collect();
        let tris = d
            .tris
            .iter()
            .map(|t| Tri {
                i: *t,
                rest_area: geom::signed_area_slice(&[
                    d.positions[t[0] as usize],
                    d.positions[t[1] as usize],
                    d.positions[t[2] as usize],
                ]),
            })
            .collect();
        let rest_area = if d.closed {
            geom::signed_area(d.boundary.iter().map(|&i| d.positions[i as usize])).abs()
        } else {
            0.0
        };
        let mut b = Body {
            kind: d.kind,
            prev: d.positions.clone(),
            v: vec![d.velocity; n],
            base_w: w.clone(),
            w,
            x: d.positions,
            rest,
            edges,
            tris,
            boundary: d.boundary,
            closed: d.closed,
            rest_area,
            params: d.params,
            rest_scale: 1.0,
            inflate: 1.0,
            layer: d.layer,
            mask: d.mask,
            user_data: d.user_data,
            enabled: true,
            aabb: Aabb::EMPTY,
            accel: Vec2::ZERO,
            point_accel: vec![Vec2::ZERO; n],
            kinematic: Vec::new(),
            home: None,
            home_compliance: 1e-4,
            strain_time: 0.0,
            immunity: 0.0,
            strain: 0.0,
            area_ratio: 1.0,
        };
        b.update_aabb();
        b
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    pub(crate) fn update_aabb(&mut self) {
        self.aabb = Aabb::from_points(self.x.iter().copied()).expand(self.params.radius);
    }

    /// Mass-weighted centroid of the dynamic particles (all particles if
    /// the body is fully pinned).
    pub fn centroid(&self) -> Vec2 {
        let mut sum = Vec2::ZERO;
        let mut m = 0.0;
        for (p, &w) in self.x.iter().zip(&self.w) {
            if w > 0.0 {
                sum += *p / w;
                m += 1.0 / w;
            }
        }
        if m > 0.0 { sum / m } else { geom::centroid(&self.x) }
    }

    pub fn velocity(&self) -> Vec2 {
        let mut sum = Vec2::ZERO;
        let mut m = 0.0;
        for (v, &w) in self.v.iter().zip(&self.w) {
            if w > 0.0 {
                sum += *v / w;
                m += 1.0 / w;
            }
        }
        if m > 0.0 { sum / m } else { Vec2::ZERO }
    }

    pub fn mass(&self) -> f32 {
        self.base_w.iter().map(|&w| if w > 0.0 { 1.0 / w } else { 0.0 }).sum()
    }

    /// Current outline area (0 for open chains).
    pub fn area(&self) -> f32 {
        if !self.closed {
            return 0.0;
        }
        geom::signed_area(self.boundary.iter().map(|&i| self.x[i as usize]))
    }

    /// Best-fit rotation of the body relative to its rest pose, in radians.
    pub fn angle(&self) -> f32 {
        let c = self.centroid();
        let cur: Vec<Vec2> = self.x.iter().map(|p| *p - c).collect();
        let wts: Vec<f32> = self.base_w.iter().map(|&w| if w > 0.0 { 1.0 / w } else { 1.0 }).collect();
        geom::best_fit_angle(&self.rest, &cur, &wts)
    }

    pub fn outline(&self) -> impl Iterator<Item = Vec2> + '_ {
        self.boundary.iter().map(|&i| self.x[i as usize])
    }

    pub fn contains_point(&self, p: Vec2) -> bool {
        self.closed && self.aabb.contains(p) && geom::point_in_loop(p, &self.x, &self.boundary)
    }

    /// Pin particle `i` in place (or move it kinematically with
    /// [`Body::drive_pinned`]).
    pub fn pin(&mut self, i: usize) {
        self.w[i] = 0.0;
        self.v[i] = Vec2::ZERO;
    }

    pub fn unpin(&mut self, i: usize) {
        self.w[i] = self.base_w[i];
        self.kinematic.retain(|k| k.0 as usize != i);
    }

    /// Tether every particle to where it is now (see [`Body::home`]).
    pub fn anchor_home(&mut self, compliance: f32) {
        self.home = Some(self.x.clone());
        self.home_compliance = compliance;
    }

    /// Move a pinned particle to `target` smoothly over the next step.
    pub fn drive_pinned(&mut self, i: usize, target: Vec2) {
        let start = self.x[i];
        if let Some(k) = self.kinematic.iter_mut().find(|k| k.0 as usize == i) {
            k.1 = start;
            k.2 = target;
        } else {
            self.kinematic.push((i as u32, start, target));
        }
    }

    /// Add an acceleration to every particle for the next step.
    pub fn add_accel(&mut self, a: Vec2) {
        self.accel += a;
    }

    /// Add an acceleration to one particle for the next step.
    pub fn add_point_accel(&mut self, i: usize, a: Vec2) {
        self.point_accel[i] += a;
    }

    /// Instantly change the velocity of every dynamic particle.
    pub fn add_velocity(&mut self, dv: Vec2) {
        for (v, &w) in self.v.iter_mut().zip(&self.w) {
            if w > 0.0 {
                *v += dv;
            }
        }
    }

    /// Instantly add angular velocity (radians/s) about the centroid.
    pub fn add_spin(&mut self, omega: f32) {
        let c = self.centroid();
        for ((v, p), &w) in self.v.iter_mut().zip(&self.x).zip(&self.w) {
            if w > 0.0 {
                *v += (*p - c).perp() * omega;
            }
        }
    }

    /// Teleport the body so its centroid lands on `to`, at rest shape,
    /// with zero velocity.
    pub fn reset_to(&mut self, to: Vec2) {
        for i in 0..self.x.len() {
            let p = to + self.rest[i] * self.rest_scale;
            self.x[i] = p;
            self.prev[i] = p;
            self.v[i] = Vec2::ZERO;
        }
        self.strain_time = 0.0;
        self.strain = 0.0;
        self.update_aabb();
    }

    /// Move the whole body by `d` without changing its velocity.
    pub fn translate(&mut self, d: Vec2) {
        for (p, q) in self.x.iter_mut().zip(self.prev.iter_mut()) {
            *p += d;
            *q += d;
        }
        self.update_aabb();
    }
}
