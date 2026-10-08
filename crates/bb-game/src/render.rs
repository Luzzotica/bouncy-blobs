//! Softbody rendering: one dynamic mesh per body, rebuilt from particles
//! every frame, plus cartoon faces.
//!
//! In the black-cave themes the look splits by material so it reads at a
//! glance: sturdy things are black stone; soft things (jelly ground lips,
//! bridges, slabs) are luminous translucent jelly with a halo and a wobbling
//! highlight; bouncy mushroom caps glow and brighten when someone is near.

use std::collections::HashMap;

use bb_physics::{Body, BodyId, BodyKind, Vec2 as PVec2, geom};
use bb_sim::BodyTag;
use bevy::asset::RenderAssetUsages;
use bevy::mesh::{Indices, PrimitiveTopology};
use bevy::prelude::*;

use crate::palette::{self, ThemeColors, darken, hex, lighten, lin, mix};
use crate::sim::Game;

pub mod z {
    pub const SKY: f32 = -100.0;
    pub const FAR: f32 = -50.0;
    pub const DECOR_BACK: f32 = -10.0;
    pub const ZONES: f32 = -5.0;
    pub const TERRAIN: f32 = 0.0;
    /// Light spilling from glowing things onto the black stone.
    pub const SPILL: f32 = 0.3;
    pub const JELLY: f32 = 1.0;
    pub const PLATFORM: f32 = 2.0;
    pub const ITEMS: f32 = 3.0;
    pub const ROPE: f32 = 4.0;
    pub const PROP: f32 = 5.0;
    pub const NPC: f32 = 6.0;
    pub const PLAYER: f32 = 7.0;
    pub const EYES: f32 = 8.0;
    pub const FX: f32 = 9.0;
    pub const DECOR_FRONT: f32 = 12.0;
}

#[derive(Clone, Copy, Debug)]
pub struct Style {
    pub fill: Color,
    pub rim: Color,
    pub rim_w: f32,
    pub highlight: bool,
    pub z: f32,
    /// Jelly ground: draw a glossy lip on top edges only (no tile seams).
    pub top_rim_only: bool,
}

/// How a body is drawn beyond its colours (chosen from its role at spawn).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Look {
    /// The classic candy body (menus, UI, ropes, bright themes).
    Plain,
    /// A character or prop: candy body plus a soft light pool of `halo`
    /// opacity in the dark.
    Blob { halo: f32 },
    /// The thin jelly skin on top of ground: a dim lip that lights up
    /// where blobs land and roll. `trim_l`/`trim_r` shorten the lip where
    /// the tile overlaps its neighbours, so overlapping lips never double up.
    Skin { trim_l: f32, trim_r: f32 },
    /// Floating slabs, lily pads and free jelly blocks: a rounded jelly
    /// fungus shelf with a soft inner glow and drifting bubbles.
    SoftJelly,
    /// A soft bridge (grid `nx` × `ny` particles): a sagging jelly rope
    /// bridge, membrane slung between glowing strands.
    Bridge { nx: u16, ny: u16 },
    /// A bouncy mushroom cap: glows, spots, brightens when someone's near.
    Cap,
    /// Grabbable vines: a faint glow so they read on black.
    Vine,
}

#[derive(Component)]
pub struct BodyVisual {
    pub id: BodyId,
    pub mesh: Handle<Mesh>,
    pub style: Style,
    pub look: Look,
    /// 0..~1.5 proximity / touch glow (mushroom caps).
    pub react: f32,
    pub cooldown: f32,
}

/// A cartoon face drawn over a player or NPC body.
#[derive(Component)]
pub struct Face {
    pub body: BodyId,
    pub mesh: Handle<Mesh>,
    pub kind: FaceKind,
    pub blink: f32,
    pub look: Vec2,
    pub mood: Mood,
    hold: f32,
    /// Eases mouth shapes in (0..1).
    open: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FaceKind {
    Pip,
    /// Granny Gloop: heavy, sleepy lids.
    Granny,
    /// Glimmer: two glowing dots.
    Glimmer,
    /// Reg the sock: a royal moustache.
    Reg,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mood {
    Idle,
    /// Expanding / puffing: wide eyes, "O" mouth.
    Puff,
    /// Squashed or crouching: `> <` eyes, flat mouth.
    Squash,
    /// Falling fast.
    Worried,
    /// Hanging on a vine.
    Determined,
}

#[derive(Resource, Default)]
pub struct BodyEntities(pub HashMap<BodyId, Entity>);

/// Cutscene direction for a character's face.
#[derive(Clone, Copy, Debug, Default)]
pub struct FaceCue {
    /// Eyes shut (asleep / not yet awake).
    pub closed: bool,
    /// Seconds left of an eye-roll: pupils spin in wide circles that
    /// settle into place (waking up for the first time).
    pub roll: f32,
    /// Forced gaze, -1..1 each axis.
    pub look: Option<Vec2>,
    pub mood: Option<Mood>,
}

#[derive(Resource, Default)]
pub struct FaceCues(pub HashMap<BodyId, FaceCue>);

/// Per-body style overrides (menu focus highlights, kids colour changes).
#[derive(Resource, Default)]
pub struct StyleOverrides(pub HashMap<BodyId, Style>);

/// Shared handles for simple shapes.
#[derive(Resource)]
pub struct Shared {
    pub circle: Handle<Mesh>,
    pub white: Handle<ColorMaterial>,
    pub vertex: Handle<ColorMaterial>,
    pub ink: Handle<ColorMaterial>,
    pub blend: Handle<ColorMaterial>,
    /// Unit radial glow (white centre fading to transparent at radius 1);
    /// pair with a blended material to tint it.
    pub halo: Handle<Mesh>,
}

pub struct RenderPlugin;

impl Plugin for RenderPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BodyEntities>()
            .init_resource::<StyleOverrides>()
            .init_resource::<FaceCues>()
            .init_resource::<crate::cave::Spores>()
            .init_resource::<LipGlow>()
            .add_systems(Startup, setup_shared)
            .add_systems(PostUpdate, (track_lip_glow, sync_bodies, update_faces).chain().run_if(resource_exists::<Game>))
            .add_systems(PostUpdate, (cleanup_bodies, clear_lip_glow).run_if(resource_removed::<Game>));
    }
}

fn setup_shared(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    let mut halo = MeshBuf::default();
    halo.halo(PVec2::ZERO, PVec2::ONE, 0.0, [1.0; 4]);
    commands.insert_resource(Shared {
        circle: meshes.add(Circle::new(1.0).mesh().resolution(24)),
        white: mats.add(ColorMaterial::from(Color::WHITE)),
        vertex: mats.add(ColorMaterial::from(Color::WHITE)),
        ink: mats.add(ColorMaterial::from(hex(0x2b2135))),
        blend: mats.add(ColorMaterial { color: Color::WHITE, alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() }),
        halo: meshes.add(halo.into_mesh()),
    });
}

/// Linear RGBA with an explicit alpha.
pub fn la(c: Color, a: f32) -> [f32; 4] {
    let mut l = lin(c);
    l[3] = a;
    l
}

/// Counter-clockwise copy of a loop (so ring normals point outward).
pub fn ccw(mut pts: Vec<PVec2>) -> Vec<PVec2> {
    if geom::signed_area_slice(&pts) < 0.0 {
        pts.reverse();
    }
    pts
}

/// Outward normal of the CCW edge a→b.
fn edge_normal(a: PVec2, b: PVec2) -> PVec2 {
    let d = b - a;
    PVec2::new(d.y, -d.x).normalize_or_zero()
}

/// A placeholder mesh: one invisible degenerate triangle far off-screen.
/// (Zero-sized vertex buffers upset Bevy's slab allocator.)
pub fn empty_mesh() -> Mesh {
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, vec![[0.0, -1.0e6, 0.0]; 3])
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, vec![[0.0f32; 4]; 3])
        .with_inserted_indices(Indices::U32(vec![0, 1, 2]))
}

/// Accumulates triangles with per-vertex colours.
#[derive(Default)]
pub struct MeshBuf {
    pub pos: Vec<[f32; 3]>,
    pub col: Vec<[f32; 4]>,
    pub idx: Vec<u32>,
}

impl MeshBuf {
    pub fn vert(&mut self, p: PVec2, z: f32, c: [f32; 4]) -> u32 {
        self.pos.push([p.x, p.y, z]);
        self.col.push(c);
        self.pos.len() as u32 - 1
    }

    pub fn tri(&mut self, a: u32, b: u32, c: u32) {
        self.idx.extend_from_slice(&[a, b, c]);
    }

    /// Filled convex-ish polygon fanned from its centroid.
    pub fn fan(&mut self, pts: &[PVec2], centre: PVec2, z: f32, inner: [f32; 4], outer: [f32; 4]) {
        let c = self.vert(centre, z, inner);
        let start = self.pos.len() as u32;
        for p in pts {
            self.vert(*p, z, outer);
        }
        let n = pts.len() as u32;
        for k in 0..n {
            self.tri(c, start + k, start + (k + 1) % n);
        }
    }

    /// Closed stroke along a loop. `inset`/`outset` are distances inside
    /// and outside the outline.
    pub fn ring(&mut self, pts: &[PVec2], inset: f32, outset: f32, z: f32, c: [f32; 4]) {
        let n = pts.len();
        if n < 3 {
            return;
        }
        let start = self.pos.len() as u32;
        for i in 0..n {
            let prev = pts[(i + n - 1) % n];
            let next = pts[(i + 1) % n];
            // Mitered join: offset along the bisector, lengthened by the
            // corner angle so the band keeps its width (capped for very
            // sharp points). Without it, sharp corners thin the rim and the
            // fill peeks out past it.
            let n1 = { let e = pts[i] - prev; PVec2::new(e.y, -e.x).normalize_or_zero() };
            let n2 = { let e = next - pts[i]; PVec2::new(e.y, -e.x).normalize_or_zero() };
            let m = (n1 + n2).normalize_or(n1);
            let k = 1.0 / m.dot(n1).max(0.4);
            let nrm = m * k;
            self.vert(pts[i] - nrm * inset, z, c);
            self.vert(pts[i] + nrm * outset, z, c);
        }
        for i in 0..n as u32 {
            let j = (i + 1) % n as u32;
            let (a, b, c2, d) = (start + i * 2, start + i * 2 + 1, start + j * 2, start + j * 2 + 1);
            self.tri(a, b, d);
            self.tri(a, d, c2);
        }
    }

    /// Open stroke along a polyline.
    pub fn stroke(&mut self, pts: &[PVec2], width: f32, z: f32, c: [f32; 4]) {
        let n = pts.len();
        if n < 2 {
            return;
        }
        let start = self.pos.len() as u32;
        for i in 0..n {
            let prev = pts[i.saturating_sub(1)];
            let next = pts[(i + 1).min(n - 1)];
            let d = next - prev;
            let nrm = PVec2::new(-d.y, d.x).normalize_or_zero() * width * 0.5;
            self.vert(pts[i] + nrm, z, c);
            self.vert(pts[i] - nrm, z, c);
        }
        for i in 0..(n - 1) as u32 {
            let (a, b, c2, d) = (start + i * 2, start + i * 2 + 1, start + i * 2 + 2, start + i * 2 + 3);
            self.tri(a, b, d);
            self.tri(a, d, c2);
        }
    }

    pub fn ellipse(&mut self, c: PVec2, r: PVec2, angle: f32, z: f32, col: [f32; 4]) {
        let rot = PVec2::from_angle(angle);
        let pts: Vec<PVec2> = (0..14)
            .map(|i| {
                let a = i as f32 / 14.0 * std::f32::consts::TAU;
                c + rot.rotate(PVec2::new(a.cos() * r.x, a.sin() * r.y))
            })
            .collect();
        self.fan(&pts, c, z, col, col);
    }

    pub fn write(mut self, mesh: &mut Mesh) {
        if self.idx.is_empty() {
            for _ in 0..3 {
                self.vert(PVec2::new(0.0, -1.0e6), 0.0, [0.0; 4]);
            }
            self.tri(0, 1, 2);
        }
        mesh.insert_attribute(Mesh::ATTRIBUTE_POSITION, self.pos);
        mesh.insert_attribute(Mesh::ATTRIBUTE_COLOR, self.col);
        mesh.insert_indices(Indices::U32(self.idx));
    }

    pub fn into_mesh(self) -> Mesh {
        let mut m = empty_mesh();
        self.write(&mut m);
        m
    }
}

impl MeshBuf {
    /// Closed band along a CCW loop with separate inner and outer colours
    /// (soft halos that hug a body's outline).
    pub fn ring2(&mut self, pts: &[PVec2], inset: f32, outset: f32, z: f32, c_in: [f32; 4], c_out: [f32; 4]) {
        let n = pts.len();
        if n < 3 {
            return;
        }
        let start = self.pos.len() as u32;
        for i in 0..n {
            let prev = pts[(i + n - 1) % n];
            let next = pts[(i + 1) % n];
            let d = next - prev;
            let nrm = PVec2::new(d.y, -d.x).normalize_or_zero();
            self.vert(pts[i] - nrm * inset, z, c_in);
            self.vert(pts[i] + nrm * outset, z, c_out);
        }
        for i in 0..n as u32 {
            let j = (i + 1) % n as u32;
            let (a, b, c2, d) = (start + i * 2, start + i * 2 + 1, start + j * 2, start + j * 2 + 1);
            self.tri(a, b, d);
            self.tri(a, d, c2);
        }
    }

    /// Soft radial glow: `col` at the centre fading smoothly to transparent
    /// at radius `r`.
    pub fn halo(&mut self, c: PVec2, r: PVec2, z: f32, col: [f32; 4]) {
        const SEG: u32 = 28;
        // Gaussian-ish falloff that reaches exactly zero at the edge, so
        // halos never show a disc outline.
        let prof = |t: f32| {
            let e = (-4.5f32).exp();
            (((-4.5 * t * t).exp() - e) / (1.0 - e)).max(0.0)
        };
        let rings: Vec<(f32, f32)> = (1..=9).map(|i| {
            let t = i as f32 / 9.0;
            (t, prof(t))
        }).collect();
        let centre = self.vert(c, z, col);
        let mut prev_start = None;
        for (rad, k) in rings {
            let start = self.pos.len() as u32;
            for i in 0..SEG {
                let a = i as f32 / SEG as f32 * std::f32::consts::TAU;
                self.vert(c + PVec2::new(a.cos() * r.x, a.sin() * r.y) * rad, z, [col[0], col[1], col[2], col[3] * k]);
            }
            for i in 0..SEG {
                let j = (i + 1) % SEG;
                match prev_start {
                    None => self.tri(centre, start + i, start + j),
                    Some(p) => {
                        self.tri(p + i, start + i, start + j);
                        self.tri(p + i, start + j, p + j);
                    }
                }
            }
            prev_start = Some(start);
        }
    }

    /// Stroke along an arc (angles in radians, counter-clockwise from +x),
    /// squashed by `scale`.
    pub fn arc(&mut self, c: PVec2, r: PVec2, a0: f32, a1: f32, width: f32, z: f32, col: [f32; 4]) {
        let pts: Vec<PVec2> = (0..=10)
            .map(|i| {
                let a = a0 + (a1 - a0) * i as f32 / 10.0;
                c + PVec2::new(a.cos() * r.x, a.sin() * r.y)
            })
            .collect();
        self.stroke(&pts, width, z, col);
        // Round caps.
        self.ellipse(pts[0], PVec2::splat(width * 0.5), 0.0, z, col);
        self.ellipse(pts[10], PVec2::splat(width * 0.5), 0.0, z, col);
    }

    /// Open band along a polyline with per-vertex normals and colours: one
    /// side `a` px inside the line (colour `ca`), the other `b` px inside
    /// (`cb`). Negative values go outward.
    #[allow(clippy::too_many_arguments)]
    pub fn band(&mut self, pts: &[PVec2], nrm: &[PVec2], a: f32, b: f32, z: f32, ca: &[[f32; 4]], cb: &[[f32; 4]]) {
        let n = pts.len();
        if n < 2 {
            return;
        }
        let start = self.pos.len() as u32;
        for i in 0..n {
            self.vert(pts[i] - nrm[i] * a, z, ca[i]);
            self.vert(pts[i] - nrm[i] * b, z, cb[i]);
        }
        for i in 0..(n - 1) as u32 {
            let (p, q, r, s) = (start + i * 2, start + i * 2 + 1, start + i * 2 + 2, start + i * 2 + 3);
            self.tri(p, q, s);
            self.tri(p, s, r);
        }
    }

    /// Open stroke with a colour per point.
    pub fn stroke_cols(&mut self, pts: &[PVec2], width: f32, z: f32, cols: &[[f32; 4]]) {
        let n = pts.len();
        if n < 2 {
            return;
        }
        let nrm: Vec<PVec2> = (0..n)
            .map(|i| {
                let d = pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)];
                PVec2::new(d.y, -d.x).normalize_or_zero()
            })
            .collect();
        self.band(pts, &nrm, -width * 0.5, width * 0.5, z, cols, cols);
    }

    /// A soft glow strip on the outward side of the CCW edge a→b.
    pub fn edge_glow(&mut self, a: PVec2, b: PVec2, h: f32, z: f32, col: [f32; 4]) {
        let n = edge_normal(a, b) * h;
        let c0 = [col[0], col[1], col[2], 0.0];
        let i0 = self.vert(a, z, col);
        let i1 = self.vert(b, z, col);
        let i2 = self.vert(b + n, z, c0);
        let i3 = self.vert(a + n, z, c0);
        self.tri(i0, i1, i2);
        self.tri(i0, i2, i3);
    }
}

/// A closed ring drawn as a smooth curve through its points (uniform
/// Catmull-Rom, `sub` samples per edge), so a 16-point blob reads round even
/// when it swells to 3×.
pub fn smooth_ring(p: &[PVec2], sub: usize) -> Vec<PVec2> {
    let n = p.len();
    if n < 4 || sub < 2 {
        return p.to_vec();
    }
    let mut out = Vec::with_capacity(n * sub);
    for i in 0..n {
        let (p0, p1, p2, p3) = (p[(i + n - 1) % n], p[i], p[(i + 1) % n], p[(i + 2) % n]);
        for k in 0..sub {
            let t = k as f32 / sub as f32;
            let (t2, t3) = (t * t, t * t * t);
            out.push(0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t3));
        }
    }
    out
}

/// The outline to draw: ring blobs are smoothed, everything else as is.
fn draw_outline(b: &Body) -> Vec<PVec2> {
    let raw: Vec<PVec2> = b.outline().collect();
    if b.closed && b.tris.is_empty() && b.kind != BodyKind::Rope { smooth_ring(&raw, 4) } else { raw }
}

pub fn body_mesh(b: &Body, s: &Style, buf: &mut MeshBuf) {
    let outline: Vec<PVec2> = draw_outline(b);
    match b.kind {
        BodyKind::Rope => {
            buf.stroke(&b.x, b.params.radius * 2.4, 0.0, lin(s.rim));
            buf.stroke(&b.x, b.params.radius * 1.4, 0.001, lin(s.fill));
        }
        BodyKind::Mesh if !b.tris.is_empty() => {
            let (lo, hi) = b.rest.iter().fold((f32::MAX, f32::MIN), |(lo, hi), r| (lo.min(r.y), hi.max(r.y)));
            let span = (hi - lo).max(1.0);
            let base = buf.pos.len() as u32;
            for (p, r) in b.x.iter().zip(&b.rest) {
                let t = (r.y - lo) / span;
                let c = mix(darken(s.fill, 0.12), lighten(s.fill, 0.12), t);
                buf.vert(*p, 0.0, lin(c));
            }
            for t in &b.tris {
                buf.tri(base + t.i[0], base + t.i[1], base + t.i[2]);
            }
            if s.top_rim_only {
                let n = outline.len();
                for k in 0..n {
                    let (a, c) = (outline[k], outline[(k + 1) % n]);
                    let d = c - a;
                    if PVec2::new(d.y, -d.x).normalize_or_zero().y > 0.5 {
                        buf.stroke(&[a, c], s.rim_w * 1.6, 0.001, lin(lighten(s.fill, 0.25)));
                    }
                }
            } else {
                buf.ring(&outline, s.rim_w, s.rim_w * 0.25, 0.001, lin(s.rim));
            }
        }
        _ => {
            let c = geom::centroid(&outline);
            buf.fan(&outline, c, 0.0, lin(lighten(s.fill, 0.18)), lin(s.fill));
            buf.ring(&outline, s.rim_w, s.rim_w * 0.25, 0.001, lin(s.rim));
        }
    }
    if s.highlight && b.closed {
        let c = geom::centroid(&outline);
        let r = (b.area().abs() / std::f32::consts::PI).sqrt();
        let (w, h) = extents(&outline);
        let squash = PVec2::new((w / h).sqrt(), (h / w).sqrt());
        buf.ellipse(c + PVec2::new(-0.32, 0.4) * r * squash, PVec2::new(0.26, 0.14) * r, 0.45, 0.002, lin(lighten(s.fill, 0.6)));
    }
}

/// Context for the themed looks.
pub struct LookCtx<'a> {
    pub dark: bool,
    pub react: f32,
    pub time: f32,
    /// Where blobs have landed / rolled on jelly ground lately.
    pub lip: Option<&'a LipGlow>,
}

/// Draw a body with its role-specific look.
pub fn body_mesh_look(b: &Body, s: &Style, look: Look, ctx: &LookCtx, buf: &mut MeshBuf) {
    match look {
        Look::Cap => cap_mesh(b, s, ctx, buf),
        Look::Skin { trim_l, trim_r } if ctx.dark => skin_mesh(b, s, ctx, trim_l, trim_r, buf),
        Look::SoftJelly if ctx.dark => soft_mesh(b, s, ctx, buf),
        Look::Bridge { nx, ny } if ctx.dark => bridge_mesh(b, s, ctx, nx as usize, ny as usize, buf),
        Look::Vine if ctx.dark => {
            buf.stroke(&b.x, b.params.radius * 6.0, -0.002, la(s.fill, 0.05));
            body_mesh(b, s, buf);
        }
        Look::Blob { halo } if ctx.dark && halo > 0.0 && b.closed => {
            let outline = ccw(draw_outline(b));
            let r = (b.area().abs() / std::f32::consts::PI).sqrt();
            buf.ring2(&outline, r * 0.15, r * 0.75, -0.004, la(s.fill, halo), la(s.fill, 0.0));
            body_mesh(b, s, buf);
        }
        _ => body_mesh(b, s, buf),
    }
}

fn rest_span(b: &Body) -> (f32, f32) {
    let (lo, hi) = b.rest.iter().fold((f32::MAX, f32::MIN), |(lo, hi), r| (lo.min(r.y), hi.max(r.y)));
    (lo, (hi - lo).max(1.0))
}

/// Per-vertex coloured fill (triangulated meshes) or a fan (rings).
fn fill_by_height(b: &Body, outline: &[PVec2], buf: &mut MeshBuf, col: impl Fn(f32) -> [f32; 4]) {
    if b.kind == BodyKind::Mesh && !b.tris.is_empty() {
        let (lo, span) = rest_span(b);
        let base = buf.pos.len() as u32;
        for (p, r) in b.x.iter().zip(&b.rest) {
            buf.vert(*p, 0.0, col(((r.y - lo) / span).clamp(0.0, 1.0)));
        }
        for t in &b.tris {
            buf.tri(base + t.i[0], base + t.i[1], base + t.i[2]);
        }
    } else {
        let c = geom::centroid(outline);
        buf.fan(outline, c, 0.0, col(0.7), col(0.3));
    }
}

/// Where a point given in the body's home (rest-in-world) frame is now,
/// following the nearest particle so it jiggles with the jelly.
fn follow_home(b: &Body, p: PVec2) -> PVec2 {
    let home = b.home.as_deref().unwrap_or(&b.rest);
    let mut best = (f32::MAX, 0usize);
    for (i, h) in home.iter().enumerate() {
        let d = h.distance_squared(p);
        if d < best.0 {
            best = (d, i);
        }
    }
    b.x.get(best.1).copied().unwrap_or(p) + (p - home.get(best.1).copied().unwrap_or(p))
}

// ------------------------------------------------------------ lip glow

/// One place a blob touched jelly ground.
#[derive(Clone, Copy, Debug)]
pub struct LipMark {
    pub pos: PVec2,
    pub t0: f32,
    pub strength: f32,
    /// A landing: a ring of light spreading along the surface. Otherwise a
    /// rolling-trail spot that just fades.
    pub ring: bool,
}

/// Recent landings and rolling trails on jelly ground. Lips are dim by
/// default and light up around these.
#[derive(Resource, Default)]
pub struct LipGlow {
    pub marks: Vec<LipMark>,
    last: HashMap<BodyId, PVec2>,
}

/// How long a mark lights the ground (s).
pub const LIP_LIFE: f32 = 1.15;

impl LipGlow {
    pub fn land(&mut self, pos: PVec2, t: f32, strength: f32) {
        self.marks.push(LipMark { pos, t0: t, strength, ring: true });
    }

    pub fn trail(&mut self, pos: PVec2, t: f32, strength: f32) {
        self.marks.push(LipMark { pos, t0: t, strength, ring: false });
    }

    /// Glow 0..~1.5 at a lip point.
    pub fn at(&self, p: PVec2, t: f32) -> f32 {
        let mut g = 0.0;
        for m in &self.marks {
            let a = t - m.t0;
            if !(0.0..LIP_LIFE).contains(&a) {
                continue;
            }
            let d = p.distance(m.pos);
            if d > 520.0 {
                continue;
            }
            let fade = (1.0 - a / LIP_LIFE).powi(2);
            if m.ring {
                // A bright splash where it landed, and a ripple running out
                // along the surface both ways.
                let front = 24.0 + 420.0 * a;
                let ring = (-((d - front) / 34.0).powi(2)).exp() * fade;
                let core = (-(d / 46.0).powi(2)).exp() * (1.0 - a / 0.75).max(0.0).powi(2) * 1.2;
                g += m.strength * (ring * 0.8 + core);
            } else {
                g += m.strength * (-(d / 30.0).powi(2)).exp() * fade;
            }
        }
        g.min(1.5)
    }

    fn near(&self, lo: PVec2, hi: PVec2) -> bool {
        self.marks.iter().any(|m| m.pos.x > lo.x - 520.0 && m.pos.x < hi.x + 520.0 && m.pos.y > lo.y - 120.0 && m.pos.y < hi.y + 120.0)
    }
}

/// Turn landings (impacts) and rolling contacts on jelly ground into lip
/// glow marks.
fn track_lip_glow(game: Res<Game>, time: Res<Time>, mut lip: ResMut<LipGlow>, mut msgs: MessageReader<crate::sim::SimMsg>) {
    let t = time.elapsed_secs();
    lip.marks.retain(|m| t - m.t0 < LIP_LIFE);
    let sim = &game.sim;
    let blob = |id: BodyId| matches!(sim.tag(id), Some(BodyTag::Player(_) | BodyTag::Npc(_) | BodyTag::Prop));
    let ground = |id: BodyId| sim.jelly.iter().any(|j| j.0 == id);
    for m in msgs.read() {
        if let bb_sim::SimEvent::Impact { body, pos, speed } = m.0 {
            if blob(body) && speed > 140.0 {
                let landed_on_jelly = sim.world.contacts_of(body).any(|c| matches!(c.other, bb_physics::Collider::Body(o) if ground(o)));
                if landed_on_jelly {
                    lip.land(pos, t, ((speed - 60.0) / 450.0).clamp(0.5, 1.2));
                }
            }
        }
    }
    // Rolling: a faint trail wherever a blob is moving along jelly ground.
    let movers: Vec<BodyId> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| p.ctl.body)
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| n.ctl.body))
        .collect();
    for id in movers {
        let Some(b) = sim.world.body(id) else { continue };
        let speed = b.velocity().x.abs();
        let touch = sim.world.contacts_of(id).filter(|c| matches!(c.other, bb_physics::Collider::Body(o) if ground(o))).map(|c| c.point).next();
        let Some(p) = touch else {
            lip.last.remove(&id);
            continue;
        };
        if speed < 40.0 {
            continue;
        }
        let far = lip.last.get(&id).is_none_or(|q| q.distance(p) > 14.0);
        if far {
            lip.trail(p, t, (speed / 600.0).clamp(0.22, 0.6));
            lip.last.insert(id, p);
        }
    }
    if lip.marks.len() > 400 {
        let extra = lip.marks.len() - 400;
        lip.marks.drain(0..extra);
    }
}

fn clear_lip_glow(mut lip: ResMut<LipGlow>) {
    lip.marks.clear();
    lip.last.clear();
}

/// How far to shorten a ground skin's lip at each end where it overlaps the
/// neighbouring tile (`LevelBuilder::ground` overlaps tiles by a few px so
/// the jelly has no seams; drawing both lips there would double up).
pub fn skin_trims(level: &bb_level::Level, j: usize) -> (f32, f32) {
    let top = |k: usize| match level.jelly.get(k).map(|d| &d.shape) {
        Some(bb_level::Shape::Poly { points }) if points.len() == 4 => Some((points[3], points[2])),
        _ => None,
    };
    let Some((a, b)) = top(j) else { return (0.0, 0.0) };
    let ab = b - a;
    let len2 = ab.length_squared().max(1e-6);
    let on = |p: PVec2| {
        let t = (p - a).dot(ab) / len2;
        let off = (a + ab * t).distance(p);
        (t > 0.0 && t < 1.0 && off < 2.0).then_some(t)
    };
    let (mut l, mut r) = (0.0f32, 0.0f32);
    for k in 0..level.jelly.len() {
        if k == j {
            continue;
        }
        let Some((c, d)) = top(k) else { continue };
        if on(c).is_some() {
            r = r.max(b.distance(c) * 0.5);
        }
        if on(d).is_some() {
            l = l.max(d.distance(a) * 0.5);
        }
    }
    (l, r)
}

/// A tiny deterministic per-body z offset so bodies that share a layer
/// (overlapping jelly tiles, props, platforms) never z-fight. Characters
/// already have unique z per slot.
pub fn z_jitter(game: &Game, id: BodyId) -> f32 {
    match game.sim.tag(id) {
        Some(BodyTag::Player(_) | BodyTag::Npc(_)) => 0.0,
        _ => (id.index % 199) as f32 * 0.0004,
    }
}

/// Cut `l` px of arc length off the start of a polyline and `r` off the end.
fn trim_polyline(pts: &[PVec2], l: f32, r: f32) -> Vec<PVec2> {
    fn cut_front(pts: &[PVec2], mut l: f32) -> Vec<PVec2> {
        for i in 0..pts.len().saturating_sub(1) {
            let d = pts[i].distance(pts[i + 1]);
            if l < d {
                let mut out = vec![pts[i].lerp(pts[i + 1], l / d.max(1e-6))];
                out.extend_from_slice(&pts[i + 1..]);
                return out;
            }
            l -= d;
        }
        pts.last().map(|p| vec![*p]).unwrap_or_default()
    }
    let a = if l > 0.0 { cut_front(pts, l) } else { pts.to_vec() };
    if r <= 0.0 {
        return a;
    }
    let mut rev: Vec<PVec2> = a.into_iter().rev().collect();
    rev = cut_front(&rev, r);
    rev.reverse();
    rev
}

/// Subdivide a polyline so no segment is longer than `step`.
fn densify(pts: &[PVec2], step: f32) -> Vec<PVec2> {
    let mut out = Vec::new();
    for w in pts.windows(2) {
        let n = (w[0].distance(w[1]) / step).ceil().max(1.0) as usize;
        for k in 0..n {
            out.push(w[0].lerp(w[1], k as f32 / n as f32));
        }
    }
    if let Some(l) = pts.last() {
        out.push(*l);
    }
    out
}

/// The walkable top of a CCW outline as one left-to-right polyline (the
/// longest run of up-facing edges).
fn top_run(outline: &[PVec2], min_ny: f32) -> Vec<PVec2> {
    let n = outline.len();
    if n < 2 {
        return Vec::new();
    }
    let up: Vec<bool> = (0..n).map(|k| edge_normal(outline[k], outline[(k + 1) % n]).y > min_ny).collect();
    let start = (0..n).find(|&k| up[k] && !up[(k + n - 1) % n]);
    let Some(start) = start else {
        return if up.iter().all(|u| *u) { outline.to_vec() } else { Vec::new() };
    };
    let mut best: Vec<PVec2> = Vec::new();
    let mut cur: Vec<PVec2> = Vec::new();
    for k in 0..=n {
        let i = (start + k) % n;
        if up[i] && k < n {
            if cur.is_empty() {
                cur.push(outline[i]);
            }
            cur.push(outline[(i + 1) % n]);
        } else if !cur.is_empty() {
            if cur.len() > best.len() {
                best = std::mem::take(&mut cur);
            }
            cur.clear();
        }
    }
    // CCW tops run right → left.
    best.reverse();
    best
}

/// Jelly skin on ground: deep jelly with a dim lip that lights up in a
/// spreading ripple where blobs land, and in a faint trail where they roll.
fn skin_mesh(b: &Body, s: &Style, ctx: &LookCtx, trim_l: f32, trim_r: f32, buf: &mut MeshBuf) {
    let outline = ccw(b.outline().collect());
    let j = s.fill;
    fill_by_height(b, &outline, buf, |t| la(mix(mix(Color::BLACK, j, 0.1), mix(Color::BLACK, j, 0.5), t * t), 1.0));
    let top = trim_polyline(&top_run(&outline, 0.5), trim_l, trim_r);
    if top.len() < 2 {
        return;
    }
    let dim = mix(mix(Color::BLACK, j, 0.5), lighten(j, 0.3), 0.42);
    let bright = lighten(j, 0.5);
    let lit = ctx.lip.filter(|l| l.near(b.aabb.min, b.aabb.max));
    let pts = if lit.is_some() { densify(&top, 7.0) } else { top };
    let n = pts.len();
    let nrm: Vec<PVec2> = (0..n)
        .map(|i| {
            let d = pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)];
            PVec2::new(-d.y, d.x).normalize_or(PVec2::Y)
        })
        .collect();
    let g: Vec<f32> = pts.iter().map(|p| lit.map_or(0.0, |l| l.at(*p, ctx.time))).collect();
    // Soft light strip above the lip (faint at rest).
    let glow_in: Vec<[f32; 4]> = g.iter().map(|g| la(j, 0.03 + 0.4 * g.min(1.2))).collect();
    let glow_out: Vec<[f32; 4]> = g.iter().map(|_| la(j, 0.0)).collect();
    let up: Vec<PVec2> = nrm.iter().map(|v| -*v).collect();
    buf.band(&pts, &up, 0.0, 14.0 + 10.0 * g.iter().cloned().fold(0.0, f32::max).min(1.0), -0.001, &glow_in, &glow_out);
    // The lip itself, drawn just under the surface.
    let lip: Vec<PVec2> = pts.iter().zip(&nrm).map(|(p, n)| *p - *n * 1.5).collect();
    let cols: Vec<[f32; 4]> = g.iter().map(|g| lin(mix(mix(dim, bright, g.min(1.0)), Color::WHITE, (g - 1.0).max(0.0) * 0.5))).collect();
    buf.stroke_cols(&lip, 3.0, 0.002, &cols);
}

/// Chaikin corner cutting on a closed loop, then a few passes of gentle
/// smoothing, for soft rounded corners.
fn soften(pts: &[PVec2], iters: usize, relax: usize) -> Vec<PVec2> {
    let mut p = pts.to_vec();
    for _ in 0..iters {
        let n = p.len();
        let mut q = Vec::with_capacity(n * 2);
        for i in 0..n {
            let (a, b) = (p[i], p[(i + 1) % n]);
            q.push(a * 0.75 + b * 0.25);
            q.push(a * 0.25 + b * 0.75);
        }
        p = q;
    }
    for _ in 0..relax {
        let n = p.len();
        p = (0..n).map(|i| p[i] * 0.5 + (p[(i + n - 1) % n] + p[(i + 1) % n]) * 0.25).collect();
    }
    p
}

/// A small hollow bubble with a glint.
fn bubble(buf: &mut MeshBuf, c: PVec2, r: f32, col: Color, a: f32) {
    let pts: Vec<PVec2> = (0..12).map(|i| c + PVec2::from_angle(i as f32 / 12.0 * std::f32::consts::TAU) * r).collect();
    buf.ring(&pts, 0.5, 0.5, 0.003, la(col, a));
    buf.ellipse(c + PVec2::new(-0.35, 0.35) * r, PVec2::splat(r * 0.28), 0.0, 0.003, la(Color::WHITE, a * 0.8));
}

/// Floating slabs, lily pads and free jelly: a jelly fungus shelf. Rounded
/// soft outline, deep-to-pale inner gradient, a soft inner glow instead of a
/// hard rim, a gloss riding the top, droplets under it and bubbles drifting
/// up inside.
fn soft_mesh(b: &Body, s: &Style, ctx: &LookCtx, buf: &mut MeshBuf) {
    let raw = ccw(b.outline().collect());
    if raw.len() < 3 {
        return body_mesh(b, s, buf);
    }
    let j = s.fill;
    let mut o = soften(&raw, 2, 4);
    // Fungus-shelf profile: the underside (never stood on) bellies down a
    // few px, so the slab reads as a soft pad rather than a box.
    {
        let rb = bb_physics::Aabb::from_points(o.iter().copied());
        let (w, cx) = ((rb.max.x - rb.min.x).max(1.0), (rb.min.x + rb.max.x) * 0.5);
        let n = o.len();
        let nr: Vec<PVec2> = (0..n).map(|i| edge_normal(o[(i + n - 1) % n], o[(i + 1) % n])).collect();
        for i in 0..n {
            if nr[i].y < -0.3 {
                let u = ((o[i].x - cx) / (w * 0.5)).clamp(-1.0, 1.0);
                o[i].y -= 6.0 * (1.0 - u * u) * (-nr[i].y);
            }
        }
    }
    let c = geom::centroid(&o);
    let bb = bb_physics::Aabb::from_points(o.iter().copied());
    let span = (bb.max.y - bb.min.y).max(1.0);
    let seed = (b.rest.first().map_or(0.0, |p| p.x * 0.013 + p.y * 0.007)).fract().abs();
    // Faint halo.
    buf.ring2(&o, 0.0, 16.0, -0.004, la(j, 0.07), la(j, 0.0));
    // Fill: deep at the bottom, pale at the top (fan; fall back to the mesh
    // triangles if the shape is too bent for one).
    let col = |p: PVec2| {
        let t = ((p.y - bb.min.y) / span).clamp(0.0, 1.0);
        la(mix(mix(Color::BLACK, j, 0.3), mix(j, Color::WHITE, 0.1), t.powf(1.3)), 0.93)
    };
    let star = (0..o.len()).all(|i| (o[i] - c).perp_dot(o[(i + 1) % o.len()] - c) > 0.0);
    if star {
        let ci = buf.vert(c, 0.0, la(mix(Color::BLACK, j, 0.58), 0.93));
        let start = buf.pos.len() as u32;
        for p in &o {
            buf.vert(*p, 0.0, col(*p));
        }
        let n = o.len() as u32;
        for k in 0..n {
            buf.tri(ci, start + k, start + (k + 1) % n);
        }
    } else {
        fill_by_height(b, &raw, buf, |t| la(mix(mix(Color::BLACK, j, 0.3), mix(j, Color::WHITE, 0.1), t), 0.93));
    }
    // Inner glow hugging the edge, and a soft thin skin.
    buf.ring2(&o, 9.0, 0.0, 0.001, la(lighten(j, 0.3), 0.0), la(lighten(j, 0.3), 0.32));
    buf.ring(&o, 0.8, 0.6, 0.0015, la(lighten(j, 0.45), 0.55));
    // Gloss along the (deforming) top, fading at both ends.
    let top = top_run(&o, 0.6);
    if top.len() > 2 {
        let n = top.len();
        let nrm: Vec<PVec2> = (0..n)
            .map(|i| {
                let d = top[(i + 1).min(n - 1)] - top[i.saturating_sub(1)];
                PVec2::new(-d.y, d.x).normalize_or(PVec2::Y)
            })
            .collect();
        let g: Vec<PVec2> = top.iter().zip(&nrm).map(|(p, n)| *p - *n * 5.0).collect();
        let cols: Vec<[f32; 4]> = (0..n)
            .map(|i| {
                let u = i as f32 / (n - 1) as f32;
                la(lighten(j, 0.8), 0.5 * ((u - 0.08).max(0.0) / 0.84).min(1.0).mul_add(std::f32::consts::PI, 0.0).sin().max(0.0))
            })
            .collect();
        buf.stroke_cols(&g, 2.4, 0.002, &cols);
    }
    // Droplets hanging under the shelf, swaying.
    let bottom: Vec<PVec2> = {
        let flipped: Vec<PVec2> = o.iter().map(|p| PVec2::new(p.x, -p.y)).collect();
        top_run(&ccw(flipped), 0.6).into_iter().map(|p| PVec2::new(p.x, -p.y)).collect()
    };
    if bottom.len() > 4 {
        for k in 0..2 {
            let f = 0.25 + 0.45 * k as f32 + 0.1 * seed;
            let p = bottom[((bottom.len() - 1) as f32 * f) as usize];
            let len = 4.0 + 3.0 * (ctx.time * (1.7 + k as f32 * 0.6) + seed * 9.0).sin();
            let tip = p - PVec2::new(0.0, len);
            buf.stroke(&[p + PVec2::new(0.0, 2.0), tip], 3.0, -0.001, la(mix(Color::BLACK, j, 0.5), 0.9));
            buf.ellipse(tip, PVec2::new(2.6, 3.0), 0.0, -0.001, la(mix(Color::BLACK, j, 0.62), 0.95));
            buf.ellipse(tip + PVec2::new(-0.8, 0.6), PVec2::splat(0.9), 0.0, -0.0009, la(lighten(j, 0.6), 0.7));
        }
    }
    // Bubbles rising through the jelly (they ride its wobble).
    let home = b.home.as_deref().unwrap_or(&b.rest);
    let hb = bb_physics::Aabb::from_points(home.iter().copied());
    let (hw, hh) = (hb.max.x - hb.min.x, hb.max.y - hb.min.y);
    let count = ((hw * hh) / 2200.0).clamp(3.0, 8.0) as usize;
    for k in 0..count {
        let h = |q: u32| crate::crag::hash(k as i32, q as i32, (seed * 1000.0) as u32);
        let period = 2.6 + 2.4 * h(1);
        let ph = (ctx.time / period + h(2)).fract();
        let x = hb.min.x + 10.0 + (hw - 20.0).max(0.0) * h(3);
        let y = hb.min.y + 5.0 + (hh - 12.0).max(0.0) * ph;
        let p = follow_home(b, PVec2::new(x + (ph * 6.0 + h(4) * 6.0).sin() * 2.0, y));
        let r = 1.4 + 2.0 * h(5);
        bubble(buf, p, r, lighten(j, 0.75), 0.55 * (ph * std::f32::consts::PI).sin());
    }
}

/// A soft bridge: a translucent jelly membrane slung between two glowing
/// strands, with ribs, knots and a few hanging drips, sagging with the sim.
fn bridge_mesh(b: &Body, s: &Style, ctx: &LookCtx, nx: usize, ny: usize, buf: &mut MeshBuf) {
    if nx < 2 || ny < 2 || b.x.len() != nx * ny {
        return soft_mesh(b, s, ctx, buf);
    }
    let j = s.fill;
    let outline = ccw(b.outline().collect());
    let top: Vec<PVec2> = (0..nx).map(|x| b.x[(ny - 1) * nx + x]).collect();
    let bot: Vec<PVec2> = (0..nx).map(|x| b.x[x]).collect();
    buf.ring2(&outline, 0.0, 12.0, -0.004, la(j, 0.05), la(j, 0.0));
    // Membrane.
    fill_by_height(b, &outline, buf, |t| la(mix(mix(Color::BLACK, j, 0.22), mix(Color::BLACK, j, 0.5), t), 0.62));
    // Ribs every other column.
    for x in (1..nx - 1).step_by(2) {
        buf.stroke(&[bot[x], top[x]], 2.2, 0.001, la(mix(Color::BLACK, j, 0.7), 0.7));
    }
    // Strands: smooth curves through the rows.
    let smooth = |row: &[PVec2]| -> Vec<PVec2> {
        let mut p = row.to_vec();
        for _ in 0..2 {
            let mut q = vec![p[0]];
            for w in p.windows(2) {
                q.push(w[0] * 0.75 + w[1] * 0.25);
                q.push(w[0] * 0.25 + w[1] * 0.75);
            }
            q.push(*p.last().unwrap());
            p = q;
        }
        p
    };
    let ts = smooth(&top);
    let bs = smooth(&bot);
    buf.stroke(&bs, 2.6, 0.0015, la(mix(Color::BLACK, j, 0.75), 0.9));
    buf.stroke(&ts, 6.0, 0.0012, la(j, 0.18));
    buf.stroke(&ts, 3.2, 0.002, lin(lighten(j, 0.32)));
    // Knots where ribs meet the top strand.
    for x in (1..nx - 1).step_by(2) {
        buf.ellipse(top[x], PVec2::new(3.2, 2.6), 0.0, 0.0025, lin(lighten(j, 0.5)));
    }
    // Drips hanging from the underside.
    for x in 1..nx - 1 {
        let h = crate::crag::hash(x as i32, nx as i32, (b.rest[0].x.abs() as u32) ^ 0xb21d);
        if h > 0.3 {
            continue;
        }
        let len = 5.0 + 9.0 * h / 0.3 + 2.0 * (ctx.time * 2.1 + x as f32).sin();
        let tip = bot[x] - PVec2::new(0.0, len);
        buf.stroke(&[bot[x], tip], 2.4, 0.001, la(mix(Color::BLACK, j, 0.6), 0.85));
        buf.ellipse(tip, PVec2::new(2.4, 2.9), 0.0, 0.001, la(mix(Color::BLACK, j, 0.7), 0.9));
    }
}

/// A bouncy mushroom cap: glowing dome with spots, brighter when someone is
/// near (`ctx.react`).
fn cap_mesh(b: &Body, s: &Style, ctx: &LookCtx, buf: &mut MeshBuf) {
    let outline = ccw(b.outline().collect());
    if outline.len() < 3 {
        return body_mesh(b, s, buf);
    }
    let m = s.fill;
    let g = ctx.react.clamp(0.0, 1.6);
    let home = b.home.as_deref().unwrap_or(&b.rest);
    let hb = bb_physics::Aabb::from_points(home.iter().copied());
    let (w, h) = ((hb.max.x - hb.min.x).max(1.0), (hb.max.y - hb.min.y).max(1.0));
    let c = geom::centroid(&outline);
    let breathe = 1.0 + (ctx.time * 1.6 + hb.min.x * 0.01).sin() * 0.05;
    let halo_a = if ctx.dark { 0.1 + 0.18 * g } else { 0.05 + 0.12 * g };
    buf.halo(c, PVec2::new(w * 0.95, w * 0.8) * breathe * (1.0 + 0.15 * g), -0.004, la(m, halo_a));
    let lit = lighten(m, 0.55);
    fill_by_height(b, &outline, buf, |t| {
        let base = mix(mix(Color::BLACK, m, 0.5), lighten(m, 0.12), t.sqrt());
        la(mix(base, lit, 0.4 * g.min(1.0)), 1.0)
    });
    buf.ring(&outline, 3.0, 1.0, 0.001, lin(mix(lighten(m, 0.45), Color::WHITE, 0.3 * g.min(1.0))));
    // Gills: a darker band along the flat underside.
    let n = outline.len();
    for k in 0..n {
        let (a, e) = (outline[k], outline[(k + 1) % n]);
        let nr = edge_normal(a, e);
        if nr.y < -0.7 {
            buf.stroke(&[a - nr * 5.0, e - nr * 5.0], 5.0, 0.0015, lin(mix(Color::BLACK, m, 0.3)));
        }
    }
    // Spots ride the jelly.
    let base = PVec2::new((hb.min.x + hb.max.x) * 0.5, hb.min.y);
    let spot = la(mix(lighten(m, 0.8), Color::WHITE, 0.4 * g.min(1.0)), 0.95);
    for (fx, fy, fr) in [(-0.27f32, 0.42f32, 0.075f32), (0.06, 0.7, 0.09), (0.3, 0.38, 0.06), (-0.05, 0.3, 0.04)] {
        let p = follow_home(b, base + PVec2::new(fx * w, fy * h));
        let r = fr * w;
        buf.ellipse(p, PVec2::new(r, r * 0.8), 0.0, 0.002, spot);
    }
}

pub fn extents(pts: &[PVec2]) -> (f32, f32) {
    let bb = bb_physics::Aabb::from_points(pts.iter().copied());
    ((bb.max.x - bb.min.x).max(1.0), (bb.max.y - bb.min.y).max(1.0))
}

/// Jelly bodies that are bouncy mushroom caps (`LevelBuilder::mushroom`
/// pairs a Bouncy jelly dome with "mushroom_spots" decor at its base).
pub fn is_mushroom_cap(game: &Game, id: BodyId) -> bool {
    let sim = &game.sim;
    let Some(j) = sim.jelly.iter().position(|j| j.0 == id) else { return false };
    let Some(def) = sim.level.jelly.get(j) else { return false };
    if def.material != bb_level::Material::Bouncy {
        return false;
    }
    let (min, max) = def.shape.bounds();
    sim.level.decor.iter().any(|d| {
        d.kind == "mushroom_spots" && d.pos.x >= min.x - 12.0 && d.pos.x <= max.x + 12.0 && d.pos.y >= min.y - 12.0 && d.pos.y <= max.y + 12.0
    })
}

pub fn look_for(game: &Game, id: BodyId) -> Look {
    let sim = &game.sim;
    match sim.tag(id) {
        Some(BodyTag::Player(_)) => Look::Blob { halo: 0.1 },
        Some(BodyTag::Npc(i)) => match sim.npc_role(i) {
            Some(bb_level::NpcRole::Glimmer) => Look::Blob { halo: 0.3 },
            _ => Look::Blob { halo: 0.06 },
        },
        Some(BodyTag::Prop) => Look::Blob { halo: 0.05 },
        Some(BodyTag::Amoeba(_)) => Look::Blob { halo: 0.45 },
        Some(BodyTag::Droplet(_)) => Look::Blob { halo: 0.08 },
        Some(BodyTag::Jelly) => {
            if is_mushroom_cap(game, id) {
                return Look::Cap;
            }
            let thin = sim
                .jelly
                .iter()
                .position(|j| j.0 == id)
                .and_then(|j| sim.level.jelly.get(j))
                .map(|d| match &d.shape {
                    // `LevelBuilder::ground` skins: [p0-skin, p1-skin, p1, p0].
                    bb_level::Shape::Poly { points } if points.len() == 4 => {
                        let skin = bb_level::builder::metrics::SKIN;
                        let up = |a: usize, b: usize| (points[b] - points[a] - PVec2::new(0.0, skin)).length() < 1.0;
                        up(1, 2) && up(0, 3)
                    }
                    s => {
                        let (a, b) = s.bounds();
                        b.y - a.y <= bb_level::builder::metrics::SKIN + 4.0
                    }
                })
                .unwrap_or(false);
            if thin {
                let j = sim.jelly.iter().position(|j| j.0 == id).unwrap_or(usize::MAX);
                let (trim_l, trim_r) = skin_trims(&sim.level, j);
                Look::Skin { trim_l, trim_r }
            } else {
                Look::SoftJelly
            }
        }
        Some(BodyTag::Platform) => {
            let def = sim.platforms.iter().position(|p| *p == id).and_then(|i| sim.level.platforms.get(i));
            match def {
                Some(p) if matches!(p.pins, bb_level::Pins::Ends | bb_level::Pins::Left | bb_level::Pins::Right) => {
                    // Same grid as `bb_sim::load` builds.
                    let cols = (p.size.x / 20.0).ceil().max(2.0) as u16;
                    let rows = (p.size.y / 20.0).ceil().max(1.0) as u16;
                    Look::Bridge { nx: cols + 1, ny: rows + 1 }
                }
                _ => Look::SoftJelly,
            }
        }
        Some(BodyTag::Rope) if sim.ropes.iter().any(|r| r.grabbable && sim.world.rope(r.rope).is_some_and(|rr| rr.body == id)) => Look::Vine,
        _ => Look::Plain,
    }
}

pub fn style_for(game: &Game, id: BodyId, theme: &ThemeColors) -> Style {
    let sim = &game.sim;
    let dark = theme.dark;
    // Characters keep a bright outline so they pop on black.
    let rim_of = |c: Color| if dark { lighten(c, 0.55) } else { darken(c, 0.35) };
    let jelly_style = |m: bb_level::Material| Style {
        fill: palette::material_tint(m, theme.jelly),
        rim: palette::material_tint(m, theme.jelly_rim),
        rim_w: 4.0,
        highlight: false,
        z: z::JELLY,
        top_rim_only: true,
    };
    match sim.tag(id) {
        Some(BodyTag::Player(slot)) => {
            let c = sim.player(slot).map_or(0xffffff, |p| p.color);
            Style { fill: hex(c), rim: rim_of(hex(c)), rim_w: 4.5, highlight: true, z: z::PLAYER + slot as f32 * 0.01, top_rim_only: false }
        }
        Some(BodyTag::Npc(i)) => {
            let c = sim.npcs.get(i as usize).map_or(0xffffff, |n| n.color);
            Style { fill: hex(c), rim: rim_of(hex(c)), rim_w: 4.0, highlight: true, z: z::NPC + i as f32 * 0.001, top_rim_only: false }
        }
        Some(BodyTag::Prop) => {
            let idx = sim.props.iter().position(|p| *p == id).unwrap_or(0);
            let c = sim.level.props.get(idx).and_then(|p| bb_sim::parse_color(&p.color)).map(hex).unwrap_or(theme.accent);
            Style { fill: c, rim: rim_of(c), rim_w: 4.0, highlight: true, z: z::PROP, top_rim_only: false }
        }
        Some(BodyTag::Jelly) => {
            if is_mushroom_cap(game, id) {
                return Style { fill: theme.mush, rim: lighten(theme.mush, 0.4), rim_w: 3.0, highlight: false, z: z::JELLY + 0.1, top_rim_only: false };
            }
            let m = sim.jelly.iter().find(|j| j.0 == id).map_or(bb_level::Material::Ground, |j| j.1);
            jelly_style(m)
        }
        Some(BodyTag::Platform) => Style {
            fill: if dark { theme.jelly } else { lighten(theme.jelly, 0.15) },
            rim: theme.jelly_rim,
            rim_w: 4.0,
            highlight: false,
            z: z::PLATFORM,
            top_rim_only: false,
        },
        Some(BodyTag::Rope) => {
            let style = sim.ropes.iter().find(|r| sim.world.rope(r.rope).is_some_and(|rr| rr.body == id)).map(|r| r.style);
            let (fill, rim) = match style {
                Some(bb_level::RopeStyle::Rope) => (hex(0xd9b38c), hex(0x8a6a4a)),
                Some(bb_level::RopeStyle::Chain) => (hex(0xb0b6c0), hex(0x5d6370)),
                Some(bb_level::RopeStyle::Slinky) => (hex(0xff8fb1), hex(0xb34d72)),
                _ if dark => (hex(0x8fe66f), hex(0x3f8a45)),
                _ => (hex(0x7ccf6b), hex(0x2f6b3a)),
            };
            Style { fill, rim, rim_w: 2.0, highlight: false, z: z::ROPE, top_rim_only: false }
        }
        Some(BodyTag::Amoeba(i)) => {
            let c = hex(bb_sim::amoeba_color(i as usize));
            Style { fill: c, rim: lighten(c, 0.5), rim_w: 2.5, highlight: true, z: z::ITEMS + 0.2, top_rim_only: false }
        }
        Some(BodyTag::Droplet(c)) => {
            let c = hex(c);
            Style { fill: c, rim: darken(c, 0.35), rim_w: 2.5, highlight: true, z: z::PLAYER - 0.5, top_rim_only: false }
        }
        Some(BodyTag::Ui) | None => Style { fill: theme.accent, rim: darken(theme.accent, 0.3), rim_w: 4.0, highlight: true, z: z::PROP, top_rim_only: false },
    }
}

fn face_kind(game: &Game, id: BodyId) -> Option<FaceKind> {
    match game.sim.tag(id) {
        Some(BodyTag::Player(_)) => Some(FaceKind::Pip),
        Some(BodyTag::Npc(i)) => Some(match game.sim.npc_role(i) {
            Some(bb_level::NpcRole::Granny) => FaceKind::Granny,
            Some(bb_level::NpcRole::Glimmer) => FaceKind::Glimmer,
            Some(bb_level::NpcRole::Reg) => FaceKind::Reg,
            _ => FaceKind::Pip,
        }),
        _ => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn sync_bodies(
    mut commands: Commands,
    game: Res<Game>,
    time: Res<Time>,
    mut map: ResMut<BodyEntities>,
    mut meshes: ResMut<Assets<Mesh>>,
    shared: Res<Shared>,
    overrides: Res<StyleOverrides>,
    mut spores: ResMut<crate::cave::Spores>,
    lip: Res<LipGlow>,
    (interp, beat): (Res<crate::sim::Interp>, Res<crate::audio::MusicBeat>),
    mut visuals: Query<(&mut BodyVisual, &mut Transform)>,
) {
    let theme = palette::theme(game.sim.level.theme);
    let t = time.elapsed_secs();
    let dt = time.delta_secs();
    // Spawn / despawn.
    let mut alive = std::collections::HashSet::new();
    let mut fresh = std::collections::HashSet::new();
    for (id, _) in game.sim.world.bodies() {
        alive.insert(id);
        if !map.0.contains_key(&id) {
            let style = overrides.0.get(&id).copied().unwrap_or_else(|| style_for(&game, id, &theme));
            let look = look_for(&game, id);
            // Create the mesh already filled: mutating a mesh in the same
            // frame it was added trips Bevy's slab allocator.
            let mut buf = MeshBuf::default();
            if let Some(b) = game.sim.world.body(id).filter(|b| b.enabled) {
                body_mesh_look(b, &style, look, &LookCtx { dark: theme.dark, react: 0.0, time: t, lip: Some(&lip) }, &mut buf);
            }
            let mesh = meshes.add(buf.into_mesh());
            fresh.insert(id);
            let e = commands
                .spawn((
                    Mesh2d(mesh.clone()),
                    MeshMaterial2d(shared.blend.clone()),
                    Transform::from_xyz(0.0, 0.0, style.z + z_jitter(&game, id)),
                    BodyVisual { id, mesh, style, look, react: 0.0, cooldown: 0.0 },
                ))
                .id();
            if let Some(kind) = face_kind(&game, id) {
                let fm = meshes.add(empty_mesh());
                commands.spawn((
                    Mesh2d(fm.clone()),
                    MeshMaterial2d(shared.blend.clone()),
                    Transform::from_xyz(0.0, 0.0, style.z + 0.0005),
                    Face {
                        body: id,
                        mesh: fm,
                        kind,
                        blink: 1.0 + (id.index % 9) as f32 * 0.45,
                        look: Vec2::ZERO,
                        mood: Mood::Idle,
                        hold: 0.0,
                        open: 0.0,
                    },
                ));
            }
            map.0.insert(id, e);
        }
    }
    map.0.retain(|id, e| {
        if alive.contains(id) {
            true
        } else {
            commands.entity(*e).despawn();
            false
        }
    });
    // Where the players are (mushroom caps react to them).
    let players: Vec<(PVec2, f32)> = game
        .sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .filter_map(|p| game.sim.world.body(p.ctl.body).map(|b| (b.centroid(), p.ctl.radius)))
        .collect();
    // Rebuild meshes.
    for (mut v, mut tf) in visuals.iter_mut() {
        let off = interp.offset(&game, v.id);
        tf.translation.x = off.x;
        tf.translation.y = off.y;
        if let Some(s) = overrides.0.get(&v.id) {
            v.style = *s;
        } else if let Some(BodyTag::Player(slot)) = game.sim.tag(v.id) {
            // Players change colour (eating amoebas): keep the style live.
            let want = game.sim.player(slot).map_or(0xffffff, |p| p.color);
            if v.style.fill != hex(want) {
                v.style = style_for(&game, v.id, &theme);
            }
        }
        let Some(b) = game.sim.world.body(v.id) else { continue };
        if v.look == Look::Cap {
            let bb = b.aabb;
            let mut target: f32 = 0.0;
            let mut touched = false;
            for (p, r) in &players {
                let q = PVec2::new(p.x.clamp(bb.min.x, bb.max.x), p.y.clamp(bb.min.y, bb.max.y));
                let d = (q - *p).length() - r;
                target = target.max(1.0 - (d / 150.0).clamp(0.0, 1.0));
                touched |= d < 6.0;
            }
            v.cooldown = (v.cooldown - dt).max(0.0);
            if touched {
                target = 1.5;
                if v.cooldown <= 0.0 {
                    v.cooldown = 0.7;
                    let top = PVec2::new((bb.min.x + bb.max.x) * 0.5, bb.max.y);
                    spores.puff(top, (bb.max.x - bb.min.x) * 0.45, v.style.fill, 9);
                }
            }
            // Caps breathe with the music, each on its own beat.
            target = target.max(beat.pulse(crate::audio::Groove::of(v.id.index as usize)) * 0.45);
            let k = if target > v.react { 8.0 } else { 1.6 };
            v.react += (target - v.react) * (1.0 - (-k * dt).exp());
        }
        if fresh.contains(&v.id) {
            continue;
        }
        let Some(mut mesh) = meshes.get_mut(&v.mesh) else { continue };
        let mut buf = MeshBuf::default();
        if b.enabled {
            body_mesh_look(b, &v.style, v.look, &LookCtx { dark: theme.dark, react: v.react, time: t, lip: Some(&lip) }, &mut buf);
        }
        buf.write(&mut mesh);
    }
}

fn update_faces(
    mut commands: Commands,
    game: Res<Game>,
    time: Res<Time>,
    overrides: Res<StyleOverrides>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut faces: Query<(Entity, &mut Face, &mut Transform)>,
    mut cues: ResMut<FaceCues>,
    interp: Res<crate::sim::Interp>,
) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs();
    let theme = palette::theme(game.sim.level.theme);
    for (e, mut face, mut tf) in faces.iter_mut() {
        let Some(b) = game.sim.world.body(face.body) else {
            commands.entity(e).despawn();
            continue;
        };
        let Some(mut mesh) = meshes.get_mut(&face.mesh) else { continue };
        let mut buf = MeshBuf::default();
        if !b.enabled {
            buf.write(&mut mesh);
            continue;
        }
        let ctl = match game.sim.tag(face.body) {
            Some(BodyTag::Player(s)) => game.sim.player(s).map(|p| &p.ctl),
            Some(BodyTag::Npc(i)) => game.sim.npcs.get(i as usize).map(|n| &n.ctl),
            _ => None,
        };
        let outline: Vec<PVec2> = b.outline().collect();
        let c = geom::centroid(&outline);
        let (w, h) = extents(&outline);
        let aspect = w / h;
        let r = (b.area().abs() / std::f32::consts::PI).sqrt();
        let v = b.velocity();
        let cue = cues.0.get(&face.body).copied();
        let mut target = Vec2::new((v.x / 400.0).clamp(-1.0, 1.0), (v.y / 600.0).clamp(-1.0, 1.0));
        if let Some(l) = cue.and_then(|c| c.look) {
            target = l;
        }
        face.look = face.look.lerp(target, (dt * 8.0).min(1.0));
        // Waking up: pupils roll round in shrinking circles, then settle.
        if let Some(c) = cues.0.get_mut(&face.body).filter(|c| c.roll > 0.0) {
            c.roll = (c.roll - dt).max(0.0);
            let amp = (c.roll / 1.4).min(1.0);
            let a = t * 9.0;
            face.look = Vec2::new(a.cos(), a.sin()) * (0.25 + amp);
        }
        face.blink -= dt;
        if face.blink < -0.12 {
            face.blink = 2.0 + (c.x * 0.013).sin().abs() * 3.0;
        }
        // Expression from the controller state.
        let mood = match ctl {
            Some(k) if k.grab.is_some() => Mood::Determined,
            Some(k) if k.expand > 1.1 || k.input.button || k.puff.is_some() => Mood::Puff,
            Some(k) if aspect > 1.4 || (k.input.stick.y < -0.5 && k.grounded) => Mood::Squash,
            Some(k) if !k.grounded && v.y < -650.0 && k.in_water <= 0.0 => Mood::Worried,
            None if aspect > 1.4 => Mood::Squash,
            _ => Mood::Idle,
        };
        let mood = cue.and_then(|c| c.mood).unwrap_or(mood);
        face.hold -= dt;
        if mood != face.mood && face.hold <= 0.0 {
            face.mood = mood;
            face.hold = 0.12;
            face.open = 0.0;
        }
        face.open = (face.open + dt * 9.0).min(1.0);
        let style = overrides.0.get(&face.body).copied().unwrap_or_else(|| style_for(&game, face.body, &theme));
        tf.translation.z = style.z + 0.0005;
        let off = interp.offset(&game, face.body);
        tf.translation.x = off.x;
        tf.translation.y = off.y;
        let blinking = face.blink < 0.0 || cue.is_some_and(|c| c.closed);
        draw_face(&mut buf, &FaceParams {
            c,
            r,
            aspect,
            look: PVec2::new(face.look.x, face.look.y),
            mood: face.mood,
            kind: face.kind,
            blinking,
            open: face.open,
            fill: style.fill,
            time: t,
        });
        buf.write(&mut mesh);
    }
}

pub struct FaceParams {
    pub c: PVec2,
    pub r: f32,
    pub aspect: f32,
    pub look: PVec2,
    pub mood: Mood,
    pub kind: FaceKind,
    pub blinking: bool,
    /// 0..1 ease-in of the current mood.
    pub open: f32,
    pub fill: Color,
    pub time: f32,
}

/// A cartoon face in world space (y up), in the spirit of the 2.x
/// faceRenderer: white eyes with dark pupils and a glint, and a mouth that
/// follows the mood.
pub fn draw_face(buf: &mut MeshBuf, f: &FaceParams) {
    let r = f.r;
    let sx = f.aspect.sqrt().clamp(0.6, 1.7);
    let sy = 1.0 / sx;
    let fc = f.c + PVec2::new(f.look.x * r * 0.16, f.look.y * r * 0.07 + 0.06 * r * sy);
    let u = |x: f32, y: f32| fc + PVec2::new(x * r * sx, y * r * sy);
    let ink = la(hex(0x1b1224), 1.0);
    let white = la(hex(0xffffff), 1.0);
    let lw = (0.075 * r).max(2.0);
    let ease = 1.0 - (1.0 - f.open).powi(3);

    // ---- eyes
    for side in [-1.0f32, 1.0] {
        let ec = u(side * 0.34, 0.16);
        if f.kind == FaceKind::Glimmer {
            let k = if f.blinking { 0.25 } else { 1.0 };
            buf.halo(ec, PVec2::splat(0.32 * r), 0.0, la(hex(0xfff3b0), 0.55));
            buf.ellipse(ec, PVec2::new(0.1, 0.12 * k) * r, 0.0, 0.0, la(hex(0xfffdf0), 1.0));
            continue;
        }
        if f.mood == Mood::Squash && f.kind != FaceKind::Granny {
            // `> <`
            let tip = side * -0.1;
            let pts = [ec + PVec2::new(-tip * r * sx * 1.1, 0.11 * r), ec + PVec2::new(tip * r * sx, 0.0), ec + PVec2::new(-tip * r * sx * 1.1, -0.11 * r)];
            buf.stroke(&pts, lw * 1.1, 0.0, ink);
            for p in [pts[0], pts[1], pts[2]] {
                buf.ellipse(p, PVec2::splat(lw * 0.55), 0.0, 0.0, ink);
            }
            continue;
        }
        if f.blinking {
            buf.arc(ec + PVec2::new(0.0, 0.03 * r), PVec2::new(0.17 * r * sx, 0.07 * r), -2.9, -0.24, lw, 0.0, ink);
            continue;
        }
        let (mut ew, mut eh, mut pr) = (0.19, 0.23, 0.11);
        match f.mood {
            Mood::Puff => {
                ew += 0.05 * ease;
                eh += 0.07 * ease;
                pr = 0.085;
            }
            Mood::Determined => eh *= 0.78,
            Mood::Worried => {
                ew *= 1.06;
                eh *= 1.08;
                pr = 0.09;
            }
            _ => {}
        }
        if f.kind == FaceKind::Granny {
            eh = 0.2;
        }
        let (ew, eh, pr) = (ew * r * sx.sqrt(), eh * r * sy.sqrt(), pr * r);
        // A thin dark ring makes the whites read on pale blobs too.
        buf.ellipse(ec, PVec2::new(ew + lw * 0.35, eh + lw * 0.35), 0.0, 0.0, la(hex(0x1b1224), 0.35));
        buf.ellipse(ec, PVec2::new(ew, eh), 0.0, 0.0, white);
        let mut po = f.look * PVec2::new(ew - pr, eh - pr) * 0.8;
        if f.mood == Mood::Worried {
            po.y = po.y.max(0.0) + (eh - pr) * 0.35;
        }
        if f.kind == FaceKind::Granny {
            po.y = -(eh - pr) * 0.5;
        }
        let pc = ec + po;
        buf.ellipse(pc, PVec2::new(pr, (pr * 1.12).min(eh * 0.95)), 0.0, 0.0, ink);
        buf.ellipse(pc + PVec2::new(-0.38, 0.42) * pr, PVec2::splat(pr * 0.38), 0.0, 0.0, white);
        if f.kind == FaceKind::Granny {
            // Heavy sleepy lid over the top half.
            let lid = darken(f.fill, 0.18);
            let top: Vec<PVec2> = (0..=10).map(|i| {
                let a = std::f32::consts::PI * i as f32 / 10.0;
                ec + PVec2::new(a.cos() * (ew + lw * 0.6), a.sin() * (eh + lw * 0.6))
            }).collect();
            let mut pts = top.clone();
            pts.push(ec + PVec2::new(-(ew + lw * 0.6), -eh * 0.05));
            pts.push(ec + PVec2::new(ew + lw * 0.6, -eh * 0.05));
            let cut = ec + PVec2::new(0.0, eh * 0.4);
            buf.fan(&top, cut, 0.0, lin(lid), lin(lid));
            buf.ellipse(ec + PVec2::new(0.0, -eh * 0.02), PVec2::new(ew + lw * 0.6, eh * 0.42), 0.0, 0.0, lin(lid));
            buf.stroke(&[ec + PVec2::new(-(ew + lw * 0.3), -eh * 0.08), ec + PVec2::new(ew + lw * 0.3, -eh * 0.08)], lw, 0.0, ink);
            let _ = pts;
        }
    }
    if f.kind == FaceKind::Glimmer {
        return;
    }

    // ---- brows
    match f.mood {
        Mood::Determined => {
            for side in [-1.0f32, 1.0] {
                buf.stroke(&[u(side * 0.52, 0.5), u(side * 0.16, 0.38)], lw * 1.1, 0.0, ink);
            }
        }
        Mood::Worried => {
            for side in [-1.0f32, 1.0] {
                buf.stroke(&[u(side * 0.52, 0.44), u(side * 0.18, 0.56)], lw, 0.0, ink);
            }
            // Sweat drop.
            let d = u(0.66, 0.42);
            buf.ellipse(d, PVec2::new(0.07, 0.1) * r, 0.0, 0.0, la(hex(0xbfe8ff), 0.95));
        }
        _ => {}
    }

    // ---- mouth
    let m = u(0.0, -0.3);
    match f.mood {
        Mood::Idle => {
            buf.arc(m + PVec2::new(0.0, 0.14 * r * sy), PVec2::new(0.2 * r * sx, 0.18 * r * sy), -2.55, -0.59, lw, 0.0, ink);
        }
        Mood::Puff => {
            let k = 0.45 + 0.55 * ease;
            let mr = PVec2::new(0.13 * r * sx, 0.17 * r * sy) * k;
            buf.ellipse(m - PVec2::new(0.0, 0.03 * r), mr, 0.0, 0.0, ink);
            buf.ellipse(m - PVec2::new(0.0, 0.03 * r + mr.y * 0.45), PVec2::new(mr.x * 0.6, mr.y * 0.35), 0.0, 0.0, la(hex(0xff7a92), 1.0));
            for side in [-1.0f32, 1.0] {
                buf.ellipse(u(side * 0.56, -0.12), PVec2::new(0.13 * r, 0.075 * r), 0.0, 0.0, la(hex(0xff5c8a), 0.38));
            }
        }
        Mood::Squash => {
            buf.stroke(&[m + PVec2::new(-0.15 * r * sx, 0.02 * r), m + PVec2::new(0.15 * r * sx, 0.02 * r)], lw, 0.0, ink);
        }
        Mood::Worried => {
            // Wobbly little frown.
            let pts: Vec<PVec2> = (0..=8)
                .map(|i| {
                    let x = -0.15 + 0.3 * i as f32 / 8.0;
                    let y = 0.07 * (1.0 - (x / 0.15).powi(2)) + (f.time * 30.0 + i as f32 * 1.7).sin() * 0.012;
                    m + PVec2::new(x * r * sx, (y - 0.06) * r * sy)
                })
                .collect();
            buf.stroke(&pts, lw, 0.0, ink);
        }
        Mood::Determined => {
            buf.stroke(&[m + PVec2::new(-0.14 * r * sx, 0.03 * r), m + PVec2::new(0.15 * r * sx, 0.0)], lw * 1.1, 0.0, ink);
            buf.ellipse(m + PVec2::new(0.15 * r * sx, 0.0), PVec2::splat(lw * 0.55), 0.0, 0.0, ink);
        }
    }

    // ---- extras
    if f.kind == FaceKind::Reg {
        let brown = la(hex(0x5a3420), 1.0);
        for side in [-1.0f32, 1.0] {
            let pc = u(side * 0.17, -0.12);
            buf.ellipse(pc, PVec2::new(0.18 * r, 0.075 * r), side * -0.3, 0.0, brown);
            buf.ellipse(u(side * 0.36, -0.04), PVec2::splat(0.055 * r), 0.0, 0.0, brown);
        }
    }
}

fn cleanup_bodies(mut commands: Commands, mut map: ResMut<BodyEntities>, faces: Query<Entity, With<Face>>) {
    for (_, e) in map.0.drain() {
        commands.entity(e).despawn();
    }
    for e in faces.iter() {
        commands.entity(e).despawn();
    }
}
