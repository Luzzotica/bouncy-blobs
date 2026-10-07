//! The black-cave backdrop: two parallax layers of craggy rock silhouettes
//! (distant cave walls, columns and hanging crags, generated from a noise
//! field with marching squares) and, on the far wall, bioluminescent life:
//! fungus clusters, glowing veins and pools that light up in slow waves,
//! each on its own phase.

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::crag::{hash, smoothstep, snoise, vnoise};
use crate::level_view::{LevelEntity, Parallax};
use crate::palette::{ThemeColors, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, la, z};
use crate::sim::Game;

pub struct BackdropPlugin;

impl Plugin for BackdropPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, pulse.run_if(resource_exists::<Game>));
    }
}

/// A far glow that breathes: material alpha = `base + (1 - base) * wave`.
#[derive(Component)]
pub struct Pulse {
    pub phase: f32,
    pub period: f32,
    pub base: f32,
    pub mat: Handle<ColorMaterial>,
}

/// Parallax factors (fraction of camera motion followed; higher = farther).
const DEEP: f32 = 0.74;
const MID: f32 = 0.5;

/// One rock layer's noise field: > 0 is rock.
#[derive(Clone, Copy)]
struct Field {
    seed: u32,
    /// Feature scale (x, y): taller than wide makes columns and drips.
    scale: PVec2,
    threshold: f32,
    /// Fades rock out toward the middle band of the view (keeps the play
    /// area open): unused when 0.
    rough: f32,
}

impl Field {
    fn at(&self, p: PVec2) -> f32 {
        let s = self.seed;
        0.62 * snoise(p / self.scale, s) + 0.26 * snoise(p / (self.scale * 0.36), s ^ 0x33) + self.rough * vnoise(p / 38.0, s ^ 0x77)
            - self.threshold
    }
}

/// Spawn the backdrop layers for a dark level. `min`/`max` are the level
/// bounds in world space.
pub fn spawn(commands: &mut Commands, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, shared: &Shared, theme: &ThemeColors, min: PVec2, max: PVec2, seed: u32) {
    let tint = |k: f32| mix(Color::BLACK, theme.jelly, k);
    let deep = Field { seed: seed ^ 0xdee9, scale: PVec2::new(520.0, 1250.0), threshold: 0.12, rough: 0.1 };
    let mid = Field { seed: seed ^ 0x0a1d, scale: PVec2::new(360.0, 900.0), threshold: 0.34, rough: 0.12 };

    // Deep wall: faint, hazy, a soft rim where rock meets the void.
    let (lo, hi) = region(min, max, DEEP);
    let mut buf = MeshBuf::default();
    rock_layer(&mut buf, &deep, lo, hi, 52.0, tint(0.042), tint(0.08), tint(0.11));
    commands.spawn((Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FAR - 20.0), Parallax(DEEP), LevelEntity));

    // Life on the deep wall.
    spawn_glows(commands, meshes, mats, theme, &deep, lo, hi, seed);

    // Mid crags: near-black silhouettes in front of the glows, with a thin
    // rim of cave light on their up-facing edges.
    let (lo, hi) = region(min, max, MID);
    let mut buf = MeshBuf::default();
    rock_layer(&mut buf, &mid, lo, hi, 44.0, tint(0.018), tint(0.03), tint(0.13));
    commands.spawn((Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FAR), Parallax(MID), LevelEntity));
}

/// The part of a parallax layer's local space the camera can see while it
/// roams the level (plus a generous view margin for zoom-outs).
fn region(min: PVec2, max: PVec2, p: f32) -> (PVec2, PVec2) {
    let margin = PVec2::new(2800.0, 1700.0);
    (min * (1.0 - p) - margin, max * (1.0 - p) + margin)
}

/// Marching-squares fill of `f > 0`. Colour by depth into the rock: `rim`
/// right at the edge (brightened to `lit` on up-facing edges), easing into
/// `core`.
#[allow(clippy::too_many_arguments)]
fn rock_layer(buf: &mut MeshBuf, f: &Field, lo: PVec2, hi: PVec2, cell: f32, core: Color, rim: Color, lit: Color) {
    let nx = ((hi.x - lo.x) / cell).ceil() as usize + 1;
    let ny = ((hi.y - lo.y) / cell).ceil() as usize + 1;
    let at = |i: usize, j: usize| lo + PVec2::new(i as f32 * cell, j as f32 * cell);
    let vals: Vec<f32> = (0..ny).flat_map(|j| (0..nx).map(move |i| (i, j))).map(|(i, j)| f.at(at(i, j))).collect();
    let v = |i: usize, j: usize| vals[j * nx + i];
    let colour = |p: PVec2, val: f32| -> [f32; 4] {
        let edge = 1.0 - smoothstep(0.0, 0.16, val);
        // Up-facing edge: the field falls off upward.
        let up = ((f.at(p) - f.at(p + PVec2::new(0.0, 30.0))) * 6.0).clamp(0.0, 1.0);
        let c = mix(core, mix(rim, lit, up), edge);
        lin(c)
    };
    for j in 0..ny - 1 {
        for i in 0..nx - 1 {
            let cs = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)];
            let cv = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
            if cv.iter().all(|x| *x <= 0.0) {
                continue;
            }
            let mut poly: Vec<(PVec2, f32)> = Vec::with_capacity(8);
            for k in 0..4 {
                let (a, b) = (cs[k], cs[(k + 1) % 4]);
                let (va, vb) = (cv[k], cv[(k + 1) % 4]);
                if va > 0.0 {
                    poly.push((at(a.0, a.1), va));
                }
                if (va > 0.0) != (vb > 0.0) {
                    let t = va / (va - vb);
                    poly.push((at(a.0, a.1).lerp(at(b.0, b.1), t), 0.0));
                }
            }
            if poly.len() < 3 {
                continue;
            }
            let base = buf.pos.len() as u32;
            for (p, val) in &poly {
                buf.vert(*p, 0.0, colour(*p, *val));
            }
            for k in 1..poly.len() as u32 - 1 {
                buf.tri(base, base + k, base + k + 1);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum GlowKind {
    Fungus,
    Vein,
    Pool,
}

#[allow(clippy::too_many_arguments)]
fn spawn_glows(commands: &mut Commands, meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>, theme: &ThemeColors, f: &Field, lo: PVec2, hi: PVec2, seed: u32) {
    let cell = 430.0;
    let (gx0, gy0) = ((lo.x / cell).floor() as i32, (lo.y / cell).floor() as i32);
    let (gx1, gy1) = ((hi.x / cell).ceil() as i32, (hi.y / cell).ceil() as i32);
    for gy in gy0..gy1 {
        for gx in gx0..gx1 {
            let h = |k: u32| hash(gx, gy, seed.wrapping_mul(17).wrapping_add(k));
            if h(0) > 0.62 {
                continue;
            }
            let p = PVec2::new((gx as f32 + 0.15 + 0.7 * h(1)) * cell, (gy as f32 + 0.15 + 0.7 * h(2)) * cell);
            let col = match (h(3) * 3.0) as u32 {
                0 => theme.crystal,
                1 => theme.mush,
                _ => theme.jelly,
            };
            let mut buf = MeshBuf::default();
            let (kind, centre) = if f.at(p) > 0.12 {
                (GlowKind::Vein, p)
            } else {
                // Drop to the rock below: a ledge for fungus or a pool.
                let mut q = p;
                let mut found = false;
                for _ in 0..40 {
                    q.y -= 12.0;
                    if f.at(q) > 0.0 {
                        found = true;
                        break;
                    }
                }
                if !found {
                    continue;
                }
                (if h(4) < 0.55 { GlowKind::Fungus } else { GlowKind::Pool }, q)
            };
            let ok = match kind {
                GlowKind::Fungus => fungus(&mut buf, centre, col, &h),
                GlowKind::Vein => vein(&mut buf, centre, col, f, &h),
                GlowKind::Pool => pool(&mut buf, centre, col, f, &h),
            };
            if !ok {
                continue;
            }
            let mat = mats.add(ColorMaterial { color: Color::srgba(1.0, 1.0, 1.0, 0.3), alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() });
            // A slow wave rolls across the wall; each patch jitters its phase.
            let phase = h(5) * std::f32::consts::TAU * 0.6 - centre.x * 0.0011 + centre.y * 0.0004;
            commands.spawn((
                Mesh2d(meshes.add(buf.into_mesh())),
                MeshMaterial2d(mat.clone()),
                Transform::from_xyz(0.0, 0.0, z::FAR - 10.0 + (gx.rem_euclid(97) as f32) * 0.01),
                Parallax(DEEP),
                Pulse { phase, period: 7.0 + 5.0 * h(6), base: 0.3 + 0.15 * h(7), mat },
                LevelEntity,
            ));
        }
    }
}

/// A clump of tiny glowing caps on a ledge.
fn fungus(buf: &mut MeshBuf, at: PVec2, col: Color, h: &dyn Fn(u32) -> f32) -> bool {
    let w = 40.0 + 70.0 * h(10);
    buf.halo(at + PVec2::new(0.0, 18.0), PVec2::new(w * 1.6 + 60.0, w * 0.9 + 50.0), 0.0, la(col, 0.22));
    let n = 6 + (h(11) * 9.0) as u32;
    for k in 0..n {
        let u = (h(20 + k) - 0.5) * w;
        let tall = (3.0 + 13.0 * h(40 + k)) * (1.0 - (u.abs() / w) * 0.8);
        let base = at + PVec2::new(u, 0.0);
        let top = base + PVec2::new((h(60 + k) - 0.5) * 4.0, tall);
        let r = 1.8 + 3.2 * h(80 + k);
        buf.stroke(&[base, top], 1.1, 0.0, la(mix(Color::BLACK, col, 0.5), 0.7));
        buf.ellipse(top, PVec2::new(r * 1.3, r * 0.8), 0.0, 0.0, la(lighten(col, 0.35), 0.85));
        buf.ellipse(top + PVec2::new(0.0, r * 0.15), PVec2::new(r * 0.5, r * 0.3), 0.0, 0.0, la(lighten(col, 0.8), 0.9));
    }
    true
}

/// A branching glowing vein through the rock.
fn vein(buf: &mut MeshBuf, at: PVec2, col: Color, f: &Field, h: &dyn Fn(u32) -> f32) -> bool {
    let mut paths: Vec<Vec<PVec2>> = Vec::new();
    let mut dir = PVec2::from_angle(h(10) * std::f32::consts::TAU);
    let mut p = at;
    let mut main = vec![p];
    for s in 0..(6 + (h(11) * 8.0) as u32) {
        let q = p + dir * (22.0 + 22.0 * h(20 + s));
        if f.at(q) < 0.04 {
            break;
        }
        main.push(q);
        p = q;
        dir = dir.rotate(PVec2::from_angle((h(40 + s) - 0.5) * 1.1));
    }
    if main.len() < 3 {
        return false;
    }
    // One or two side branches.
    for b in 0..(1 + (h(12) * 2.0) as u32) {
        let from = main[1 + (h(13 + b) * (main.len() - 2) as f32) as usize];
        let mut d = PVec2::from_angle(h(15 + b) * std::f32::consts::TAU);
        let mut q = from;
        let mut br = vec![q];
        for s in 0..(2 + (h(17 + b) * 4.0) as u32) {
            let nq = q + d * (14.0 + 14.0 * h(60 + s + b * 10));
            if f.at(nq) < 0.04 {
                break;
            }
            br.push(nq);
            q = nq;
            d = d.rotate(PVec2::from_angle((h(80 + s) - 0.5) * 1.2));
        }
        if br.len() > 1 {
            paths.push(br);
        }
    }
    paths.insert(0, main);
    let mid = paths[0][paths[0].len() / 2];
    buf.halo(mid, PVec2::splat(120.0 + 60.0 * h(14)), 0.0, la(col, 0.07));
    for (k, path) in paths.iter().enumerate() {
        let w = if k == 0 { 1.0 } else { 0.65 };
        buf.stroke(path, 9.0 * w, 0.0, la(col, 0.07));
        buf.stroke(path, 2.2 * w, 0.0, la(lighten(col, 0.3), 0.6));
        for q in path.iter().step_by(2) {
            buf.ellipse(*q, PVec2::splat(2.2 * w), 0.0, 0.0, la(lighten(col, 0.7), 0.8));
        }
    }
    true
}

/// A glowing pool resting in a hollow of the rock.
fn pool(buf: &mut MeshBuf, at: PVec2, col: Color, f: &Field, h: &dyn Fn(u32) -> f32) -> bool {
    let w = 50.0 + 90.0 * h(10);
    // Only where the rock under both ends holds it.
    if f.at(at + PVec2::new(-w * 0.5, -10.0)) <= 0.0 || f.at(at + PVec2::new(w * 0.5, -10.0)) <= 0.0 {
        return fungus(buf, at, col, h);
    }
    let surf = at + PVec2::new(0.0, 2.0);
    buf.halo(surf + PVec2::new(0.0, 14.0), PVec2::new(w * 1.4 + 50.0, 70.0), 0.0, la(col, 0.16));
    let body: Vec<PVec2> = (0..=12)
        .map(|i| {
            let a = std::f32::consts::PI * (1.0 + i as f32 / 12.0);
            surf + PVec2::new(a.cos() * w * 0.5, a.sin() * 10.0)
        })
        .collect();
    buf.fan(&body, surf - PVec2::new(0.0, 3.0), 0.0, la(col, 0.5), la(mix(Color::BLACK, col, 0.4), 0.6));
    buf.stroke(&[surf - PVec2::new(w * 0.5, 0.0), surf + PVec2::new(w * 0.5, 0.0)], 2.0, 0.0, la(lighten(col, 0.6), 0.8));
    // A few drops above, falling in.
    for k in 0..3 {
        let x = (h(30 + k) - 0.5) * w * 0.7;
        buf.ellipse(surf + PVec2::new(x, 20.0 + 50.0 * h(40 + k)), PVec2::new(1.4, 2.2), 0.0, 0.0, la(lighten(col, 0.5), 0.6));
    }
    true
}

fn pulse(time: Res<Time>, q: Query<&Pulse>, mut mats: ResMut<Assets<ColorMaterial>>) {
    let t = time.elapsed_secs();
    for p in q.iter() {
        let s = (t / p.period * std::f32::consts::TAU + p.phase).sin() * 0.5 + 0.5;
        // Mostly dim, swelling to a bright flare once per period.
        let wave = s * s * s;
        if let Some(mut m) = mats.get_mut(&p.mat) {
            m.color = Color::srgba(1.0, 1.0, 1.0, p.base + (1.0 - p.base) * wave);
        }
    }
}
