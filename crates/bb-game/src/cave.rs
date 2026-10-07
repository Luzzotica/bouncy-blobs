//! Living cave decor: glow mushrooms that notice you (brighten, wobble and
//! puff spores when a blob passes or touches them), and the spore particles.

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::level_view::LevelEntity;
use crate::palette::{self, ThemeColors, darken, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, la, z};
use crate::sim::Game;

pub struct CavePlugin;

impl Plugin for CavePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Spores>()
            .add_systems(PostUpdate, (react_decor, update_spores).run_if(resource_exists::<Game>))
            .add_systems(PostUpdate, clear_spores.run_if(resource_removed::<Game>));
    }
}

/// How near (px, edge to edge) a blob must be for decor to notice it.
pub const NOTICE: f32 = 150.0;

// ------------------------------------------------------------------ spores

struct Spore {
    p: PVec2,
    v: PVec2,
    age: f32,
    life: f32,
    r: f32,
    col: Color,
    seed: f32,
}

/// Glowing spores puffed by mushrooms. One mesh for all of them.
#[derive(Resource, Default)]
pub struct Spores {
    parts: Vec<Spore>,
    n: u32,
    mesh: Option<Handle<Mesh>>,
}

impl Spores {
    /// Puff `n` spores upward from `at`, spread across `width`.
    pub fn puff(&mut self, at: PVec2, width: f32, col: Color, n: usize) {
        for _ in 0..n {
            self.n = self.n.wrapping_add(1);
            let h = |k: f32| ((self.n as f32 * 12.9898 + k * 78.233).sin() * 43758.547).fract().abs();
            let x = (h(1.0) - 0.5) * width;
            self.parts.push(Spore {
                p: at + PVec2::new(x, 4.0 + h(2.0) * 10.0),
                v: PVec2::new(x * 0.9 + (h(3.0) - 0.5) * 60.0, 60.0 + h(4.0) * 110.0),
                age: 0.0,
                life: 1.4 + h(5.0) * 1.4,
                r: 2.2 + h(6.0) * 2.8,
                col: lighten(col, 0.25 + h(7.0) * 0.4),
                seed: h(8.0) * 100.0,
            });
        }
        if self.parts.len() > 400 {
            let extra = self.parts.len() - 400;
            self.parts.drain(0..extra);
        }
    }
}

fn update_spores(
    mut commands: Commands,
    time: Res<Time>,
    shared: Res<Shared>,
    mut spores: ResMut<Spores>,
    mut meshes: ResMut<Assets<Mesh>>,
    existing: Query<(), With<SporeMesh>>,
) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs();
    if existing.is_empty() {
        // (Re)create the shared mesh entity for this level.
        let mut buf = MeshBuf::default();
        draw_spores(&spores.parts, &mut buf);
        let h = meshes.add(buf.into_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FX - 0.6), SporeMesh, LevelEntity));
        spores.mesh = Some(h);
        return;
    }
    for s in spores.parts.iter_mut() {
        s.age += dt;
        s.v *= (-1.6 * dt).exp();
        s.v.y += 14.0 * dt;
        s.v.x += (t * 2.3 + s.seed).sin() * 40.0 * dt;
        s.p += s.v * dt;
    }
    spores.parts.retain(|s| s.age < s.life);
    let Some(h) = spores.mesh.clone() else { return };
    let Some(mut mesh) = meshes.get_mut(&h) else { return };
    let mut buf = MeshBuf::default();
    draw_spores(&spores.parts, &mut buf);
    buf.write(&mut mesh);
}

fn draw_spores(parts: &[Spore], buf: &mut MeshBuf) {
    for s in parts {
        let k = (s.age / 0.15).min(1.0) * (1.0 - s.age / s.life).clamp(0.0, 1.0);
        buf.halo(s.p, PVec2::splat(s.r * 3.5), 0.0, la(s.col, 0.35 * k));
        buf.ellipse(s.p, PVec2::splat(s.r * 0.7), 0.0, 0.001, la(lighten(s.col, 0.5), k));
    }
}

#[derive(Component)]
struct SporeMesh;

fn clear_spores(mut spores: ResMut<Spores>) {
    spores.parts.clear();
    spores.mesh = None;
}

// ---------------------------------------------------------- reactive decor

/// A decor mushroom with its own mesh so it can react.
#[derive(Component)]
pub struct ReactiveDecor {
    pub pos: PVec2,
    pub scale: f32,
    react: f32,
    wob: f32,
    wob_v: f32,
    cooldown: f32,
    phase: f32,
    mesh: Handle<Mesh>,
    spill: Handle<ColorMaterial>,
    dark: bool,
    col: Color,
}

pub fn is_reactive(kind: &str) -> bool {
    kind == "mushroom"
}

/// Spawn one entity (plus a light-spill halo) per reactive decor item.
pub fn spawn_reactive(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<ColorMaterial>,
    shared: &Shared,
    level: &bb_level::Level,
    theme: &ThemeColors,
) {
    for (i, d) in level.decor.iter().enumerate() {
        if !is_reactive(&d.kind) {
            continue;
        }
        // Vary the hue a touch per mushroom so a patch isn't a row of clones.
        let hue = ((i as f32 * 2.399).sin() * 0.5 + 0.5) * 0.35;
        let col = mix(theme.mush, if theme.dark { theme.crystal } else { theme.accent }, hue);
        let mut buf = MeshBuf::default();
        draw_mushroom(&mut buf, d.scale, 0.0, 0.0, 0.0, theme.dark, col);
        let mesh = meshes.add(buf.into_mesh());
        let zz = if d.depth < 0.0 { z::DECOR_BACK + (i % 50) as f32 * 0.001 } else { z::DECOR_FRONT };
        let spill = mats.add(ColorMaterial { color: spill_color(col, 0.0, theme.dark), alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() });
        let cap = d.pos + PVec2::new(0.0, 46.0 * d.scale);
        if theme.dark {
            commands.spawn((
                Mesh2d(shared.halo.clone()),
                MeshMaterial2d(spill.clone()),
                Transform::from_xyz(cap.x, cap.y, z::SPILL).with_scale(Vec3::splat(120.0 * d.scale)),
                LevelEntity,
            ));
        }
        commands.spawn((
            Mesh2d(mesh.clone()),
            MeshMaterial2d(shared.blend.clone()),
            Transform::from_xyz(d.pos.x, d.pos.y, zz),
            ReactiveDecor {
                pos: d.pos,
                scale: d.scale,
                react: 0.0,
                wob: 0.0,
                wob_v: 0.0,
                cooldown: 0.0,
                phase: i as f32 * 1.37,
                mesh,
                spill,
                dark: theme.dark,
                col,
            },
            LevelEntity,
        ));
    }
}

fn spill_color(col: Color, react: f32, dark: bool) -> Color {
    let a = if dark { 0.05 + 0.12 * react.min(1.5) } else { 0.0 };
    col.with_alpha(a)
}

fn react_decor(
    game: Res<Game>,
    time: Res<Time>,
    mut spores: ResMut<Spores>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    cam: Query<&Transform, (With<Camera2d>, Without<ReactiveDecor>)>,
    mut q: Query<&mut ReactiveDecor>,
) {
    let dt = time.delta_secs().min(0.05);
    let t = time.elapsed_secs();
    let view = cam.single().map(|c| c.translation.truncate()).unwrap_or(Vec2::ZERO);
    let players: Vec<(PVec2, PVec2, f32)> = game
        .sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .filter_map(|p| game.sim.world.body(p.ctl.body).map(|b| (b.centroid(), b.velocity(), p.ctl.radius)))
        .collect();
    for mut d in q.iter_mut() {
        let cap = d.pos + PVec2::new(0.0, 44.0 * d.scale);
        let mut target: f32 = 0.0;
        let mut push = 0.0;
        let mut touched = false;
        for (p, v, r) in &players {
            let dist = (p.distance(cap) - r - 26.0 * d.scale).max(0.0);
            target = target.max(1.0 - (dist / NOTICE).clamp(0.0, 1.0));
            if dist < 50.0 {
                push += v.x * (1.0 - dist / 50.0);
            }
            touched |= dist < 4.0;
        }
        d.cooldown = (d.cooldown - dt).max(0.0);
        if touched {
            target = 1.5;
            if d.cooldown <= 0.0 {
                d.cooldown = 0.9;
                let col = d.col;
                spores.puff(cap + PVec2::new(0.0, 8.0 * d.scale), 50.0 * d.scale, col, 7);
            }
        }
        let k = if target > d.react { 7.0 } else { 1.5 };
        d.react += (target - d.react) * (1.0 - (-k * dt).exp());
        // Damped spring wobble, kicked by blobs brushing past.
        let accel = -90.0 * d.wob - 5.0 * d.wob_v + push * 0.012;
        d.wob_v += accel * dt;
        d.wob = (d.wob + d.wob_v * dt).clamp(-0.6, 0.6);
        let near_view = (d.pos.x - view.x).abs() < 2600.0 && (d.pos.y - view.y).abs() < 1700.0;
        if !near_view {
            continue;
        }
        if let Some(mut mesh) = meshes.get_mut(&d.mesh) {
            let mut buf = MeshBuf::default();
            let breathe = (t * 1.3 + d.phase).sin();
            draw_mushroom(&mut buf, d.scale, d.react, d.wob, breathe, d.dark, d.col);
            buf.write(&mut mesh);
        }
        if let Some(mut m) = mats.get_mut(&d.spill) {
            m.color = spill_color(d.col, d.react, d.dark);
        }
    }
}

/// A glow mushroom in local space (base at the origin), `react` 0..1.5,
/// `wob` a shear in radians-ish, `breathe` -1..1 idle pulse.
pub fn draw_mushroom(buf: &mut MeshBuf, s: f32, react: f32, wob: f32, breathe: f32, dark: bool, col: Color) {
    let g = react.clamp(0.0, 1.5);
    let squash = 1.0 - 0.08 * (g - 1.0).max(0.0) * 2.0;
    // Shear by height so the cap sways on its stalk.
    let sh = |p: PVec2| PVec2::new(p.x + wob * p.y * 0.9, p.y * squash);
    let cap_c = PVec2::new(0.0, 44.0 * s);
    let pulse = 1.0 + breathe * 0.06;
    // Halo behind.
    let ha = if dark { 0.09 + 0.03 * breathe + 0.2 * g } else { 0.04 + 0.12 * g };
    buf.halo(sh(cap_c), PVec2::new(95.0, 80.0) * s * pulse * (1.0 + 0.2 * g), -0.004, la(col, ha));
    // Stalk: pale, faintly lit from the cap.
    let stalk = if dark { mix(Color::BLACK, lighten(col, 0.5), 0.35 + 0.2 * g) } else { lighten(col, 0.6) };
    let stalk_pts: Vec<PVec2> = (0..=6).map(|i| sh(PVec2::new((i as f32 * 0.9).sin() * 1.5 * s, 42.0 * s * i as f32 / 6.0))).collect();
    buf.stroke(&stalk_pts, 9.0 * s, -0.002, lin(stalk));
    buf.stroke(&stalk_pts[..5], 4.0 * s, -0.0015, la(lighten(stalk, 0.25), 0.8));
    // Cap: a dome, deep at the gills, bright on top.
    let (cw, ch) = (32.0 * s, 22.0 * s);
    let n = 16;
    let mut dome: Vec<PVec2> = (0..=n)
        .map(|i| {
            let a = std::f32::consts::PI * i as f32 / n as f32;
            sh(cap_c + PVec2::new(a.cos() * cw, a.sin() * ch))
        })
        .collect();
    // Slight curled lip underneath.
    dome.push(sh(cap_c + PVec2::new(-cw * 0.7, -5.0 * s)));
    dome.push(sh(cap_c + PVec2::new(cw * 0.7, -5.0 * s)));
    let lit = lighten(col, 0.55);
    let top = mix(lighten(col, 0.15), lit, 0.5 * g.min(1.0));
    let edge = mix(if dark { mix(Color::BLACK, col, 0.7) } else { col }, col, 0.6 * g.min(1.0));
    buf.fan(&dome, sh(cap_c + PVec2::new(0.0, ch * 0.55)), 0.0, lin(top), lin(edge));
    // Gills.
    buf.stroke(&[sh(cap_c + PVec2::new(-cw * 0.85, -1.0 * s)), sh(cap_c + PVec2::new(cw * 0.85, -1.0 * s))], 4.0 * s, 0.001, lin(darken(col, 0.45)));
    // Rim light along the top.
    let rim: Vec<PVec2> = dome[..=n].iter().copied().collect();
    buf.stroke(&rim, 2.2 * s, 0.001, la(lighten(col, 0.6), 0.9));
    // Spots.
    let spot = la(mix(lighten(col, 0.75), palette::hex(0xffffff), 0.5 * g.min(1.0)), 0.95);
    for (fx, fy, r) in [(-0.45f32, 0.45f32, 4.5f32), (0.05, 0.78, 5.5), (0.5, 0.4, 3.5)] {
        buf.ellipse(sh(cap_c + PVec2::new(fx * cw, fy * ch)), PVec2::new(r, r * 0.8) * s, 0.0, 0.002, spot);
    }
}
