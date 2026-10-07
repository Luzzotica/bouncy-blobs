//! Kids Mode sparkles, puffs, floating glyphs, and the glyph meshes used by
//! the buttons (star, square, triangle, dot, music note).

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::palette::{hex, lin};
use crate::render::{MeshBuf, Shared, empty_mesh};

pub const INK: u32 = 0x1a0f2e;
pub const PAPER: u32 = 0xfffae6;
pub const LAVENDER: u32 = 0xc77dff;
pub const PINK: u32 = 0xe85d75;
pub const GREEN: u32 = 0x52b788;
pub const YELLOW: u32 = 0xfdd835;

/// Z of the kids chrome (above all gameplay layers).
pub const Z_UI: f32 = 20.0;
pub const Z_FX: f32 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    Letter(char),
    Text(&'static str),
    Note,
    Star,
    Square,
    Triangle,
    Dot,
}

/// Unit-sized glyph mesh (fits a ~1×1 box centred on 0), ink outlined.
pub fn glyph_mesh(g: Glyph, fill: Color, buf: &mut MeshBuf) {
    let ink = lin(hex(INK));
    let poly = |buf: &mut MeshBuf, pts: Vec<PVec2>| {
        let c = pts.iter().copied().sum::<PVec2>() / pts.len() as f32;
        buf.fan(&pts, c, 0.0, lin(fill), lin(fill));
        buf.ring(&pts, 0.03, 0.06, 0.001, ink);
    };
    let ring = |n: usize, r: f32, inner: Option<f32>, rot: f32| -> Vec<PVec2> {
        let k = if inner.is_some() { n * 2 } else { n };
        (0..k)
            .map(|i| {
                let a = rot + i as f32 / k as f32 * std::f32::consts::TAU;
                let rr = if i % 2 == 1 { inner.unwrap_or(r) } else { r };
                PVec2::new(a.cos(), a.sin()) * rr
            })
            .collect()
    };
    match g {
        Glyph::Star => poly(buf, ring(5, 0.5, Some(0.21), std::f32::consts::FRAC_PI_2)),
        Glyph::Square => poly(buf, ring(4, 0.48, None, std::f32::consts::FRAC_PI_4)),
        Glyph::Triangle => poly(buf, ring(3, 0.52, None, std::f32::consts::FRAC_PI_2).iter().map(|p| *p - PVec2::new(0.0, 0.1)).collect()),
        Glyph::Dot => poly(buf, ring(24, 0.42, None, 0.0)),
        Glyph::Note => {
            // Eighth note: tilted head, stem, flag.
            let head = PVec2::new(-0.12, -0.3);
            buf.ellipse(head, PVec2::new(0.24, 0.17), 0.45, 0.0, ink);
            buf.ellipse(head, PVec2::new(0.18, 0.11), 0.45, 0.001, lin(fill));
            buf.stroke(&[PVec2::new(0.1, -0.27), PVec2::new(0.1, 0.45)], 0.08, 0.002, ink);
            buf.stroke(&[PVec2::new(0.1, 0.45), PVec2::new(0.32, 0.25), PVec2::new(0.3, 0.05)], 0.08, 0.002, ink);
        }
        Glyph::Letter(_) | Glyph::Text(_) => {}
    }
}

pub fn glyph_text(g: Glyph) -> Option<String> {
    match g {
        Glyph::Letter(c) => Some(c.to_string()),
        Glyph::Text(t) => Some(t.into()),
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct Particle {
    pos: PVec2,
    vel: PVec2,
    age: f32,
    life: f32,
    size: f32,
    color: Color,
    sparkle: bool,
    spin: f32,
}

/// All live particles, drawn as one alpha-blended mesh.
#[derive(Resource, Default)]
pub struct Particles {
    list: Vec<Particle>,
    rng: u32,
    mesh: Option<Handle<Mesh>>,
}

impl Particles {
    fn rand(&mut self) -> f32 {
        let mut r = crate::audio::synth::Rng(self.rng | 1);
        let v = r.f();
        self.rng = r.0;
        v
    }

    /// Twinkly four-point stars bursting outward.
    pub fn sparkle(&mut self, at: PVec2, color: Color, n: usize) {
        for _ in 0..n {
            let a = self.rand() * std::f32::consts::TAU;
            let s = 120.0 + self.rand() * 320.0;
            let p = Particle {
                pos: at,
                vel: PVec2::new(a.cos(), a.sin()) * s + PVec2::new(0.0, 120.0),
                age: 0.0,
                life: 0.6 + self.rand() * 0.5,
                size: 13.0 + self.rand() * 12.0,
                color,
                sparkle: true,
                spin: self.rand() * 6.0 - 3.0,
            };
            self.list.push(p);
        }
    }

    /// Soft round puffs drifting up.
    pub fn puff(&mut self, at: PVec2, color: Color, n: usize) {
        for _ in 0..n {
            let a = self.rand() * std::f32::consts::TAU;
            let p = Particle {
                pos: at + PVec2::new(a.cos(), a.sin()) * 18.0,
                vel: PVec2::new(a.cos() * 90.0, a.sin() * 60.0 + 60.0),
                age: 0.0,
                life: 0.5 + self.rand() * 0.3,
                size: 14.0 + self.rand() * 10.0,
                color,
                sparkle: false,
                spin: 0.0,
            };
            self.list.push(p);
        }
    }
}

/// A glyph that pops up, grows and floats away (legacy `kids-floater-rise`).
#[derive(Component)]
pub struct Floater {
    pub age: f32,
    pub life: f32,
    pub at: Vec2,
    pub size: f32,
    pub color: Color,
}

pub fn spawn_floater(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    mats: &mut Assets<ColorMaterial>,
    g: Glyph,
    at: PVec2,
    size: f32,
    life: f32,
    color: Color,
) {
    let base = (Transform::from_xyz(at.x, at.y, Z_FX + 1.0), Floater { age: 0.0, life, at: Vec2::new(at.x, at.y), size, color }, super::KidsEntity);
    if let Some(t) = glyph_text(g) {
        let e = commands
            .spawn((base, Text2d::new(t), TextFont { font_size: FontSize::Px(size), weight: FontWeight::BOLD, ..default() }, TextColor(color)))
            .id();
        // Paper glow behind letters.
        commands.entity(e).insert(bevy::sprite::Text2dShadow { offset: Vec2::new(5.0, -5.0), color: hex(INK).with_alpha(0.85) });
    } else {
        let mut buf = MeshBuf::default();
        glyph_mesh(g, color, &mut buf);
        let mat = mats.add(ColorMaterial { color: Color::WHITE, alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() });
        commands.spawn((base, Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(mat)));
    }
}

pub(crate) fn spawn_particle_mesh(mut commands: Commands, mut meshes: ResMut<Assets<Mesh>>, shared: Res<Shared>, mut p: ResMut<Particles>) {
    let h = meshes.add(empty_mesh());
    p.mesh = Some(h.clone());
    p.list.clear();
    commands.spawn((Mesh2d(h), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, Z_FX), super::KidsEntity));
}

pub(crate) fn update(
    time: Res<Time>,
    mut p: ResMut<Particles>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut floaters: Query<(&mut Floater, &mut Transform, Option<&mut TextColor>, Option<&MeshMaterial2d<ColorMaterial>>, Entity)>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    mut commands: Commands,
) {
    let dt = time.delta_secs();
    let mut buf = MeshBuf::default();
    p.list.retain_mut(|q| {
        q.age += dt;
        q.vel *= 1.0 - (dt * if q.sparkle { 2.5 } else { 3.5 }).min(1.0);
        q.vel.y -= if q.sparkle { 300.0 } else { -40.0 } * dt;
        q.pos += q.vel * dt;
        q.age < q.life
    });
    for q in &p.list {
        let t = q.age / q.life;
        let a = if q.sparkle { 1.0 - t * t } else { 0.75 * (1.0 - t) };
        let col = lin(q.color.with_alpha(a));
        if q.sparkle {
            // Four-point twinkle star.
            let r = q.size * (1.0 - 0.5 * t);
            let rot = q.spin * q.age;
            let pts: Vec<PVec2> = (0..8)
                .map(|i| {
                    let ang = rot + i as f32 / 8.0 * std::f32::consts::TAU;
                    q.pos + PVec2::new(ang.cos(), ang.sin()) * if i % 2 == 0 { r } else { r * 0.3 }
                })
                .collect();
            let core = crate::palette::lighten(q.color, 0.55).with_alpha(a);
            buf.fan(&pts, q.pos, 0.0, lin(core), col);
        } else {
            buf.ellipse(q.pos, PVec2::splat(q.size * (0.6 + t)), 0.0, 0.0, col);
        }
    }
    if let Some(mut m) = p.mesh.clone().and_then(|h| meshes.get_mut(&h)) {
        buf.write(&mut m);
    }

    // Floaters: 0 → 18%: fade in, rise, overshoot to 1.25; then drift up
    // and fade out at 1.0 scale.
    for (mut f, mut tf, text, mat, e) in floaters.iter_mut() {
        f.age += dt;
        let t = (f.age / f.life).min(1.0);
        let (alpha, rise, scale) = if t < 0.18 {
            let k = t / 0.18;
            (k, -0.4 + (-0.7 + 0.4) * k, 0.5 + 0.75 * k)
        } else {
            let k = (t - 0.18) / 0.82;
            (1.0 - k, -0.7 - 0.9 * k, 1.25 - 0.25 * k)
        };
        tf.translation.x = f.at.x;
        tf.translation.y = f.at.y - rise * f.size;
        tf.scale = Vec3::splat(if text.is_some() { scale } else { scale * f.size });
        if let Some(mut c) = text {
            c.0 = f.color.with_alpha(alpha);
        }
        if let Some(mut m) = mat.and_then(|m| mats.get_mut(&m.0)) {
            m.color = Color::WHITE.with_alpha(alpha);
        }
        if f.age >= f.life {
            commands.entity(e).despawn();
        }
    }
}
