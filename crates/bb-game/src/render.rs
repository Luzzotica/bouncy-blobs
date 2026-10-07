//! Softbody rendering: one dynamic mesh per body, rebuilt from particles
//! every frame (fill gradient + rim + candy highlight), plus cartoon eyes.

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

#[derive(Component)]
pub struct BodyVisual {
    pub id: BodyId,
    pub mesh: Handle<Mesh>,
    pub style: Style,
}

#[derive(Component)]
pub struct Eyes {
    pub body: BodyId,
    pub blink: f32,
    pub look: Vec2,
    pub kind: EyeKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EyeKind {
    Normal,
    Sleepy,
    Glow,
}

#[derive(Component)]
pub struct EyePart {
    pub owner: Entity,
    pub index: u8,
}

#[derive(Resource, Default)]
pub struct BodyEntities(pub HashMap<BodyId, Entity>);

/// Shared handles for simple shapes.
#[derive(Resource)]
pub struct Shared {
    pub circle: Handle<Mesh>,
    pub white: Handle<ColorMaterial>,
    pub vertex: Handle<ColorMaterial>,
    pub ink: Handle<ColorMaterial>,
    pub blend: Handle<ColorMaterial>,
}

pub struct RenderPlugin;

impl Plugin for RenderPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<BodyEntities>()
            .add_systems(Startup, setup_shared)
            .add_systems(PostUpdate, (sync_bodies, update_eyes).chain().run_if(resource_exists::<Game>))
            .add_systems(PostUpdate, cleanup_bodies.run_if(resource_removed::<Game>));
    }
}

fn setup_shared(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, mut mats: ResMut<Assets<ColorMaterial>>) {
    commands.insert_resource(Shared {
        circle: meshes.add(Circle::new(1.0).mesh().resolution(24)),
        white: mats.add(ColorMaterial::from(Color::WHITE)),
        vertex: mats.add(ColorMaterial::from(Color::WHITE)),
        ink: mats.add(ColorMaterial::from(hex(0x2b2135))),
        blend: mats.add(ColorMaterial { color: Color::WHITE, alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() }),
    });
}

pub fn empty_mesh() -> Mesh {
    Mesh::new(PrimitiveTopology::TriangleList, RenderAssetUsages::default())
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, Vec::<[f32; 3]>::new())
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, Vec::<[f32; 4]>::new())
        .with_inserted_indices(Indices::U32(Vec::new()))
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
            let d = next - prev;
            let nrm = PVec2::new(d.y, -d.x).normalize_or_zero();
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

pub fn body_mesh(b: &Body, s: &Style, buf: &mut MeshBuf) {
    let outline: Vec<PVec2> = b.outline().collect();
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

pub fn extents(pts: &[PVec2]) -> (f32, f32) {
    let bb = bb_physics::Aabb::from_points(pts.iter().copied());
    ((bb.max.x - bb.min.x).max(1.0), (bb.max.y - bb.min.y).max(1.0))
}

pub fn style_for(game: &Game, id: BodyId, theme: &ThemeColors) -> Style {
    let sim = &game.sim;
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
            Style { fill: hex(c), rim: darken(hex(c), 0.35), rim_w: 4.5, highlight: true, z: z::PLAYER + slot as f32 * 0.01, top_rim_only: false }
        }
        Some(BodyTag::Npc(i)) => {
            let c = sim.npcs.get(i as usize).map_or(0xffffff, |n| n.color);
            Style { fill: hex(c), rim: darken(hex(c), 0.35), rim_w: 4.0, highlight: true, z: z::NPC + i as f32 * 0.001, top_rim_only: false }
        }
        Some(BodyTag::Prop) => {
            let idx = sim.props.iter().position(|p| *p == id).unwrap_or(0);
            let c = sim.level.props.get(idx).and_then(|p| bb_sim::parse_color(&p.color)).map(hex).unwrap_or(theme.accent);
            Style { fill: c, rim: darken(c, 0.35), rim_w: 4.0, highlight: true, z: z::PROP, top_rim_only: false }
        }
        Some(BodyTag::Jelly) => {
            let m = sim.jelly.iter().find(|j| j.0 == id).map_or(bb_level::Material::Ground, |j| j.1);
            jelly_style(m)
        }
        Some(BodyTag::Platform) => Style {
            fill: lighten(theme.jelly, 0.15),
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
                _ => (hex(0x7ccf6b), hex(0x2f6b3a)),
            };
            Style { fill, rim, rim_w: 2.0, highlight: false, z: z::ROPE, top_rim_only: false }
        }
        Some(BodyTag::Ui) | None => Style { fill: theme.accent, rim: darken(theme.accent, 0.3), rim_w: 4.0, highlight: true, z: z::PROP, top_rim_only: false },
    }
}

fn sync_bodies(
    mut commands: Commands,
    game: Res<Game>,
    mut map: ResMut<BodyEntities>,
    mut meshes: ResMut<Assets<Mesh>>,
    shared: Res<Shared>,
    visuals: Query<&BodyVisual>,
) {
    let theme = palette::theme(game.sim.level.theme);
    // Spawn / despawn.
    let mut alive = std::collections::HashSet::new();
    for (id, _) in game.sim.world.bodies() {
        alive.insert(id);
        if !map.0.contains_key(&id) {
            let style = style_for(&game, id, &theme);
            let mesh = meshes.add(empty_mesh());
            let e = commands
                .spawn((
                    Mesh2d(mesh.clone()),
                    MeshMaterial2d(shared.vertex.clone()),
                    Transform::from_xyz(0.0, 0.0, style.z),
                    BodyVisual { id, mesh, style },
                ))
                .id();
            let eyes = match game.sim.tag(id) {
                Some(BodyTag::Player(_)) => Some(EyeKind::Normal),
                Some(BodyTag::Npc(i)) => Some(match game.sim.npc_role(i) {
                    Some(bb_level::NpcRole::Granny) => EyeKind::Sleepy,
                    Some(bb_level::NpcRole::Glimmer) => EyeKind::Glow,
                    _ => EyeKind::Normal,
                }),
                _ => None,
            };
            if let Some(kind) = eyes {
                let owner = commands.spawn((Eyes { body: id, blink: 2.0, look: Vec2::ZERO, kind }, Transform::default())).id();
                for k in 0..4u8 {
                    let mat = if k < 2 { shared.white.clone() } else { shared.ink.clone() };
                    commands.spawn((
                        Mesh2d(shared.circle.clone()),
                        MeshMaterial2d(mat),
                        Transform::from_xyz(0.0, 0.0, z::EYES + k as f32 * 0.01),
                        EyePart { owner, index: k },
                        Visibility::Hidden,
                    ));
                }
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
    // Rebuild meshes.
    for v in visuals.iter() {
        let Some(b) = game.sim.world.body(v.id) else { continue };
        let Some(mut mesh) = meshes.get_mut(&v.mesh) else { continue };
        let mut buf = MeshBuf::default();
        if b.enabled {
            body_mesh(b, &v.style, &mut buf);
        }
        buf.write(&mut mesh);
    }
}

fn update_eyes(
    mut commands: Commands,
    game: Res<Game>,
    time: Res<Time>,
    mut eyes: Query<(Entity, &mut Eyes)>,
    mut parts: Query<(&EyePart, &mut Transform, &mut Visibility)>,
) {
    let dt = time.delta_secs();
    let mut state: HashMap<Entity, Option<(PVec2, f32, f32, f32, PVec2, EyeKind)>> = HashMap::new();
    for (e, mut eye) in eyes.iter_mut() {
        let Some(b) = game.sim.world.body(eye.body) else {
            commands.entity(e).despawn();
            state.insert(e, None);
            continue;
        };
        if !b.enabled {
            state.insert(e, None);
            continue;
        }
        let outline: Vec<PVec2> = b.outline().collect();
        let c = geom::centroid(&outline);
        let (w, h) = extents(&outline);
        let r = (b.area().abs() / std::f32::consts::PI).sqrt();
        let v = b.velocity();
        let target = Vec2::new((v.x / 400.0).clamp(-1.0, 1.0), (v.y / 600.0).clamp(-1.0, 1.0));
        eye.look = eye.look.lerp(target, (dt * 8.0).min(1.0));
        eye.blink -= dt;
        if eye.blink < -0.12 {
            eye.blink = 2.0 + (c.x * 0.013).sin().abs() * 3.0;
        }
        let open = if eye.blink < 0.0 { 0.12 } else { 1.0 };
        state.insert(e, Some((c, w / h, r, open, PVec2::new(eye.look.x, eye.look.y), eye.kind)));
    }
    for (part, mut tf, mut vis) in parts.iter_mut() {
        match state.get(&part.owner) {
            Some(Some((c, aspect, r, open, look, kind))) => {
                *vis = Visibility::Visible;
                let sx = aspect.sqrt();
                let sy = 1.0 / sx;
                let side = if part.index % 2 == 0 { -1.0 } else { 1.0 };
                let eye_c = *c + PVec2::new(side * 0.36 * r * sx + look.x * r * 0.12, 0.18 * r * sy + look.y * r * 0.08);
                let white = 0.22 * r;
                let (rx, ry, off) = if part.index < 2 {
                    let open = if *kind == EyeKind::Sleepy { open * 0.45 } else { *open };
                    (white, white * 1.15 * open, PVec2::ZERO)
                } else {
                    let pr = if *kind == EyeKind::Glow { 0.0 } else { white * 0.55 };
                    (pr, pr * 1.1 * open.max(0.1), *look * white * 0.4)
                };
                let p = eye_c + off;
                tf.translation.x = p.x;
                tf.translation.y = p.y;
                tf.scale = Vec3::new(rx.max(0.01), ry.max(0.01), 1.0);
            }
            _ => *vis = Visibility::Hidden,
        }
    }
    let _ = &mut commands;
}

fn cleanup_bodies(
    mut commands: Commands,
    mut map: ResMut<BodyEntities>,
    eyes: Query<Entity, Or<(With<Eyes>, With<EyePart>)>>,
) {
    for (_, e) in map.0.drain() {
        commands.entity(e).despawn();
    }
    for e in eyes.iter() {
        commands.entity(e).despawn();
    }
}
