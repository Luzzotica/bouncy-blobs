//! The cave backdrop, ported from v2's `backgroundRenderer.ts`: a deep
//! vertical gradient, a soft back-wall haze, five parallax layers of
//! stalactites, stalagmites and full-height columns (fBm-perturbed spike
//! silhouettes, far = lighter and slower, near = darker and faster), and a
//! vignette. It lives in screen space (follows the camera, scrolls by a
//! fraction of camera x) so every view reads as the inside of a cave.
//!
//! On top of v2's rock, the cave is alive: the mid layers carry slow,
//! breathing bioluminescence — fungus clumps on stalagmite tips, glow-worm
//! threads under stalactites and veins up the columns.
//!
//! Also here: the foreground layer, the same idea in front of the play
//! area — sparse dark silhouettes along the top and bottom edges of the
//! screen that scroll *faster* than the world, plus a few drifting spores.

use std::collections::HashMap;

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::crag::hash1;
use crate::level_view::LevelEntity;
use crate::palette::{ThemeColors, hex, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, la, z};
use crate::sim::Game;

pub struct BackdropPlugin;

impl Plugin for BackdropPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, (update_backdrop, update_foreground).after(crate::camera::follow).before(bevy::transform::TransformSystems::Propagate).run_if(resource_exists::<Game>));
    }
}

/// v2's authoring height: shapes are in "screen px" for a view this tall.
const REF_H: f32 = 900.0;

// ------------------------------------------------------------------ noise

/// v2's `hash2`: stable pseudo-random in [0,1) from two integers.
fn hash2(a: i32, b: i32) -> f32 {
    let mut h = a.wrapping_mul(374_761_393).wrapping_add(b.wrapping_mul(668_265_263));
    h = (h ^ ((h as u32) >> 13) as i32).wrapping_mul(1_274_126_177);
    ((h ^ ((h as u32) >> 16) as i32) as u32) as f32 / 4_294_967_296.0
}

fn vnoise1(x: f32) -> f32 {
    let i = x.floor();
    let f = x - i;
    let u = f * f * (3.0 - 2.0 * f);
    let i = i as i32;
    hash2(i, 7) * (1.0 - u) + hash2(i + 1, 7) * u
}

/// v2's fBm: five octaves of value noise, ~[0,1).
pub fn fbm(x: f32) -> f32 {
    let (mut sum, mut amp, mut freq) = (0.0, 0.5, 1.0);
    for _ in 0..5 {
        sum += amp * vnoise1(x * freq);
        freq *= 2.0;
        amp *= 0.5;
    }
    sum
}

// ------------------------------------------------------------- rock shapes

/// A spike or column outline as matched left/right edge points. For a
/// spike, `y` is a 0..1 fraction of its length from the root; for a
/// column, a 0..1 fraction of the view height from the top.
#[derive(Clone)]
struct Shape {
    left: Vec<PVec2>,
    right: Vec<PVec2>,
}

/// v2's `drawRockSpike`, centred on x = 0: width tapers as a power law of
/// the distance from the root, fBm jitter on the centre line and edges.
fn spike_shape(half_w: f32, lean: f32, seed: f32) -> Shape {
    const N: usize = 12;
    let mut s = Shape { left: Vec::with_capacity(N + 1), right: Vec::with_capacity(N + 1) };
    for i in 0..=N {
        let t = i as f32 / N as f32;
        let w = half_w * (1.0 - t).powf(1.22);
        let centre = lean * t + (fbm(seed + t * 3.0) - 0.48) * half_w * 0.7;
        let el = 0.72 + 0.55 * fbm(seed + 11.0 + t * 6.0);
        let er = 0.72 + 0.55 * fbm(seed + 23.0 + t * 6.0);
        s.left.push(PVec2::new(centre - w * el, t));
        s.right.push(PVec2::new(centre + w * er, t));
    }
    s
}

/// v2's `drawRockColumn`: a stalactite and stalagmite that met — fat at
/// both ends, a thin waist with a collar bulge where the drips joined.
fn column_shape(half_w: f32, seed: f32) -> Shape {
    const N: usize = 22;
    let width_at = |t: f32| {
        let waist = 0.30 + 0.70 * (2.0 * t - 1.0).abs().powf(1.4);
        let collar = 1.0 + 0.22 * (-((t - 0.5) * (t - 0.5)) / 0.004).exp();
        half_w * waist * collar
    };
    let mut s = Shape { left: Vec::with_capacity(N + 1), right: Vec::with_capacity(N + 1) };
    for i in 0..=N {
        let t = i as f32 / N as f32;
        let w = width_at(t);
        let centre = (fbm(seed + t * 2.2) - 0.5) * half_w * 0.45;
        s.left.push(PVec2::new(centre - w * (0.80 + 0.40 * fbm(seed + 5.0 + t * 5.0)), t));
        s.right.push(PVec2::new(centre + w * (0.80 + 0.40 * fbm(seed + 9.0 + t * 5.0)), t));
    }
    s
}

/// Fill a shape (already mapped to local space) as a strip.
fn fill_strip(buf: &mut MeshBuf, left: &[PVec2], right: &[PVec2], zz: f32, col: impl Fn(usize) -> [f32; 4]) {
    let base = buf.pos.len() as u32;
    for i in 0..left.len() {
        buf.vert(left[i], zz, col(i));
        buf.vert(right[i], zz, col(i));
    }
    for i in 0..left.len().saturating_sub(1) as u32 {
        let (l0, r0, l1, r1) = (base + i * 2, base + i * 2 + 1, base + i * 2 + 2, base + i * 2 + 3);
        buf.tri(l0, r0, l1);
        buf.tri(r0, r1, l1);
    }
}

struct Layer {
    spacing: f32,
    /// Fraction of camera x this layer scrolls by (v2 units).
    parallax: f32,
    len_base: f32,
    len_var: f32,
    width: f32,
    column_chance: f32,
    skip_chance: f32,
    /// Brightness of the rock (fraction of the cave hue).
    k: f32,
    /// How much bioluminescence lives on this layer (0 = none).
    life: f32,
}

const LAYERS: [Layer; 5] = [
    // Deepest spikes behind the columns: long, slow, lightest.
    Layer { spacing: 300.0, parallax: 0.018, len_base: 210.0, len_var: 300.0, width: 200.0, column_chance: 0.0, skip_chance: 0.08, k: 0.25, life: 0.0 },
    // Big pillars.
    Layer { spacing: 380.0, parallax: 0.040, len_base: 160.0, len_var: 250.0, width: 240.0, column_chance: 0.55, skip_chance: 0.22, k: 0.19, life: 0.55 },
    // Smaller pillars.
    Layer { spacing: 280.0, parallax: 0.075, len_base: 130.0, len_var: 215.0, width: 175.0, column_chance: 0.45, skip_chance: 0.20, k: 0.13, life: 0.8 },
    // Mid spikes.
    Layer { spacing: 175.0, parallax: 0.120, len_base: 100.0, len_var: 175.0, width: 120.0, column_chance: 0.05, skip_chance: 0.18, k: 0.08, life: 1.0 },
    // Near spikes.
    Layer { spacing: 130.0, parallax: 0.190, len_base: 75.0, len_var: 140.0, width: 96.0, column_chance: 0.02, skip_chance: 0.22, k: 0.04, life: 0.0 },
];

/// One backdrop column's rock, cached in normalised form.
struct Col {
    top: Option<(Shape, f32)>,
    bot: Option<(Shape, f32, f32)>,
    column: Option<Shape>,
    cx_top: f32,
}

fn build_col(l: usize, col: i32) -> Col {
    let layer = &LAYERS[l];
    let li = l as i32;
    let mut c = Col { top: None, bot: None, column: None, cx_top: 0.0 };
    if hash2(col, li + 90) < layer.skip_chance {
        return c;
    }
    c.cx_top = (hash2(col, li + 3) - 0.5) * layer.spacing * 0.8;
    let half_w = layer.width * (0.28 + 0.34 * hash2(col, li + 31));
    let seed = col as f32 * 13.13 + l as f32 * 7.7;
    if hash2(col, li + 57) < layer.column_chance {
        c.column = Some(column_shape(half_w * 1.05, seed));
        return c;
    }
    let len_t = layer.len_base + layer.len_var * fbm(col as f32 * 1.7 + l as f32 + 0.5);
    let lean_t = (hash2(col, li + 41) - 0.5) * half_w * 0.9;
    c.top = Some((spike_shape(half_w, lean_t, seed + 0.3), len_t));
    let cx_bot = layer.spacing * 0.5 + (hash2(col, li + 71) - 0.5) * layer.spacing * 0.6;
    let half_wb = layer.width * (0.28 + 0.34 * hash2(col, li + 97));
    let len_b = layer.len_base + layer.len_var * fbm(col as f32 * 2.3 + l as f32 + 9.1);
    let lean_b = (hash2(col, li + 19) - 0.5) * half_wb * 0.9;
    c.bot = Some((spike_shape(half_wb, lean_b, seed + 5.1), len_b, cx_bot));
    c
}

/// The screen-space backdrop mesh.
#[derive(Component)]
pub struct Backdrop {
    mesh: Handle<Mesh>,
    theme: ThemeColors,
    cols: HashMap<(usize, i32), Col>,
}

/// The screen-space foreground mesh.
#[derive(Component)]
pub struct Foreground {
    mesh: Handle<Mesh>,
    theme: ThemeColors,
}

/// Spawn the backdrop and foreground for a dark level.
pub fn spawn(commands: &mut Commands, meshes: &mut Assets<Mesh>, shared: &Shared, theme: &ThemeColors) {
    let mesh = meshes.add(crate::render::empty_mesh());
    commands.spawn((
        Mesh2d(mesh.clone()),
        MeshMaterial2d(shared.blend.clone()),
        Transform::from_xyz(0.0, 0.0, z::FAR - 20.0),
        Backdrop { mesh, theme: *theme, cols: HashMap::new() },
        LevelEntity,
    ));
    let mesh = meshes.add(crate::render::empty_mesh());
    commands.spawn((
        Mesh2d(mesh.clone()),
        MeshMaterial2d(shared.blend.clone()),
        Transform::from_xyz(0.0, 0.0, z::DECOR_FRONT + 3.0),
        Foreground { mesh, theme: *theme },
        LevelEntity,
    ));
}

/// The cave's hue: v2's deep blue leaning toward the chapter's colour.
fn cave_hue(theme: &ThemeColors) -> Color {
    mix(hex(0x4f8fe0), theme.jelly, 0.5)
}

/// The camera's centre and visible half-extents (world units) and zoom.
fn view(cam: &Query<(&Transform, &Projection), With<crate::camera::MainCamera>>) -> Option<(PVec2, PVec2, f32)> {
    let (tf, proj) = cam.single().ok()?;
    let Projection::Orthographic(o) = proj else { return None };
    let half = PVec2::new(o.area.width(), o.area.height()) * 0.5;
    if half.x <= 1.0 || half.y <= 1.0 {
        return None;
    }
    Some((PVec2::new(tf.translation.x, tf.translation.y), half, o.scale.max(0.01)))
}

#[allow(clippy::type_complexity)]
fn update_backdrop(
    time: Res<Time>,
    cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>,
    mut q: Query<(&mut Backdrop, &mut Transform), Without<crate::camera::MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    let Some((c, half, _)) = view(&cam) else { return };
    let t = time.elapsed_secs();
    for (mut bd, mut tf) in q.iter_mut() {
        tf.translation.x = c.x;
        tf.translation.y = c.y;
        // Screen px -> local units, so the composition holds at any zoom.
        let u = half.y * 2.0 / REF_H;
        let (w, h) = (half.x * 2.0 / u, REF_H);
        let to = |x: f32, y: f32| PVec2::new((x - w * 0.5) * u, (h * 0.5 - y) * u);
        let theme = bd.theme;
        let hue = cave_hue(&theme);
        let mut buf = MeshBuf::default();

        // Gradient: three stops, top / mid / bottom.
        let stops = [(0.0, mix(Color::BLACK, hue, 0.06)), (0.5, mix(Color::BLACK, hue, 0.14)), (1.0, mix(Color::BLACK, hue, 0.04))];
        for k in 0..2 {
            let (y0, c0) = stops[k];
            let (y1, c1) = stops[k + 1];
            let i0 = buf.vert(to(-10.0, y0 * h - if k == 0 { 10.0 } else { 0.0 }), 0.0, lin(c0));
            let i1 = buf.vert(to(w + 10.0, y0 * h - if k == 0 { 10.0 } else { 0.0 }), 0.0, lin(c0));
            let i2 = buf.vert(to(w + 10.0, y1 * h + if k == 1 { 10.0 } else { 0.0 }), 0.0, lin(c1));
            let i3 = buf.vert(to(-10.0, y1 * h + if k == 1 { 10.0 } else { 0.0 }), 0.0, lin(c1));
            buf.tri(i0, i1, i2);
            buf.tri(i0, i2, i3);
        }
        // Back-wall haze.
        buf.halo(to(w * 0.5, h * 0.42), PVec2::new(w.max(h) * 0.7, w.max(h) * 0.55) * u, 0.0005, la(lighten(hue, 0.1), 0.16));

        // Rock layers, far to near, each followed by its own glows so
        // nearer rock overlaps them.
        let mut glows = MeshBuf::default();
        for (l, layer) in LAYERS.iter().enumerate() {
            let zz = 0.001 + l as f32 * 0.002;
            let off_x = c.x * layer.parallax;
            let margin = layer.width * 1.5;
            let first = ((off_x - margin) / layer.spacing).floor() as i32;
            let last = ((off_x + w + margin) / layer.spacing).ceil() as i32;
            let rock = mix(Color::BLACK, hue, layer.k);
            // Roots get a touch darker so edges settle into the vignette.
            let root = mix(Color::BLACK, hue, layer.k * 0.75);
            let ext = 40.0;
            for col in first..=last {
                let cc = bd.cols.entry((l, col)).or_insert_with(|| build_col(l, col));
                let base_x = col as f32 * layer.spacing - off_x;
                let grad = |i: usize, n: usize| {
                    let s = i as f32 / (n.max(2) - 1) as f32;
                    lin(mix(root, rock, (s * 2.5).min(1.0)))
                };
                if let Some(s) = &cc.column {
                    let cx = base_x + cc.cx_top;
                    let left: Vec<PVec2> = s.left.iter().map(|p| to(cx + p.x, -ext + p.y * (h + 2.0 * ext))).collect();
                    let right: Vec<PVec2> = s.right.iter().map(|p| to(cx + p.x, -ext + p.y * (h + 2.0 * ext))).collect();
                    let n = left.len();
                    fill_strip(&mut buf, &left, &right, zz, |i| {
                        let e = (i as f32 / (n - 1) as f32 * 2.0 - 1.0).abs();
                        lin(mix(rock, root, (e - 0.6).max(0.0) * 2.0))
                    });
                    if layer.life > 0.0 && hash2(col, l as i32 + 401) < 0.45 {
                        let path: Vec<PVec2> = left.iter().zip(&right).map(|(a, b)| (*a + *b) * 0.5).collect();
                        let ph = pulse(t, col, l);
                        vein(&mut glows, &path, u, glow_col(&theme, col, l), layer.life * ph, zz + 0.0015, col);
                    }
                }
                if let Some((s, len)) = &cc.top {
                    let cx = base_x + cc.cx_top;
                    let left: Vec<PVec2> = s.left.iter().map(|p| to(cx + p.x, -ext + p.y * (len + ext))).collect();
                    let right: Vec<PVec2> = s.right.iter().map(|p| to(cx + p.x, -ext + p.y * (len + ext))).collect();
                    let n = left.len();
                    fill_strip(&mut buf, &left, &right, zz, |i| grad(i, n));
                    if layer.life > 0.0 && hash2(col, l as i32 + 211) < 0.4 {
                        let tip = (left[n - 1] + right[n - 1]) * 0.5;
                        let ph = pulse(t, col, l);
                        threads(&mut glows, tip, u, glow_col(&theme, col + 5, l), layer.life * ph, zz + 0.0015, col, t);
                    }
                }
                if let Some((s, len, cx_off)) = &cc.bot {
                    let cx = base_x + cx_off;
                    let left: Vec<PVec2> = s.left.iter().map(|p| to(cx + p.x, h + ext - p.y * (len + ext))).collect();
                    let right: Vec<PVec2> = s.right.iter().map(|p| to(cx + p.x, h + ext - p.y * (len + ext))).collect();
                    let n = left.len();
                    fill_strip(&mut buf, &left, &right, zz, |i| grad(i, n));
                    if layer.life > 0.0 && hash2(col, l as i32 + 307) < 0.4 {
                        // Fungus a little below the tip, where the spike is wide enough.
                        let k = n * 6 / 10;
                        let at = (left[k] + right[k]) * 0.5;
                        let wdt = (right[k].x - left[k].x).abs();
                        let ph = pulse(t, col + 3, l);
                        fungus(&mut glows, at, wdt, u, glow_col(&theme, col + 2, l), layer.life * ph, zz + 0.0015, col);
                    }
                }
            }
            // This layer's glows sit just in front of it.
            append(&mut buf, std::mem::take(&mut glows));
        }
        // Forget columns far from view.
        if bd.cols.len() > 600 {
            let keep: Vec<(usize, i32)> = LAYERS
                .iter()
                .enumerate()
                .flat_map(|(l, layer)| {
                    let off_x = c.x * layer.parallax;
                    let first = ((off_x - layer.width * 1.5) / layer.spacing).floor() as i32;
                    let last = ((off_x + w + layer.width * 1.5) / layer.spacing).ceil() as i32;
                    (first..=last).map(move |c| (l, c))
                })
                .collect();
            bd.cols.retain(|k, _| keep.contains(k));
        }

        // Vignette: settle the edges, push the play area forward.
        vignette(&mut buf, to(w * 0.5, h * 0.5), PVec2::new(w, h) * 0.5 * u, 0.02);

        if let Some(mut m) = meshes.get_mut(&bd.mesh) {
            buf.write(&mut m);
        }
    }
}

fn append(dst: &mut MeshBuf, src: MeshBuf) {
    let base = dst.pos.len() as u32;
    dst.pos.extend(src.pos);
    dst.col.extend(src.col);
    dst.idx.extend(src.idx.into_iter().map(|i| i + base));
}

/// Slow breathing for backdrop life: mostly dim, swelling to a gentle
/// flare once a period, each column on its own phase.
fn pulse(t: f32, col: i32, l: usize) -> f32 {
    let period = 7.0 + 5.0 * hash2(col, l as i32 + 500);
    let phase = hash2(col, l as i32 + 501) * std::f32::consts::TAU;
    let s = (t / period * std::f32::consts::TAU + phase).sin() * 0.5 + 0.5;
    0.3 + 0.7 * s * s * s
}

fn glow_col(theme: &ThemeColors, col: i32, l: usize) -> Color {
    match (hash2(col, l as i32 + 600) * 3.0) as u32 {
        0 => theme.crystal,
        1 => theme.mush,
        _ => theme.jelly,
    }
}

/// A glowing vein running up a column.
fn vein(buf: &mut MeshBuf, path: &[PVec2], u: f32, col: Color, a: f32, zz: f32, seed: i32) {
    // Only the middle stretch, wandering a little.
    let n = path.len();
    let (i0, i1) = (n / 5 + (hash1(seed, 3) * 3.0) as usize, n * 4 / 5);
    let pts: Vec<PVec2> = (i0..i1).map(|i| path[i] + PVec2::new((fbm(seed as f32 + i as f32 * 0.7) - 0.5) * 30.0 * u, 0.0)).collect();
    if pts.len() < 2 {
        return;
    }
    buf.halo(pts[pts.len() / 2], PVec2::new(110.0, 260.0) * u, zz, la(col, 0.07 * a));
    buf.stroke(&pts, 7.0 * u, zz, la(col, 0.12 * a));
    buf.stroke(&pts, 1.8 * u, zz + 0.0001, la(lighten(col, 0.4), 0.55 * a));
    for p in pts.iter().step_by(3) {
        buf.ellipse(*p, PVec2::splat(2.0 * u), 0.0, zz + 0.0002, la(lighten(col, 0.7), 0.7 * a));
    }
}

/// Glow-worm threads hanging from a stalactite tip.
#[allow(clippy::too_many_arguments)]
fn threads(buf: &mut MeshBuf, tip: PVec2, u: f32, col: Color, a: f32, zz: f32, seed: i32, t: f32) {
    buf.halo(tip - PVec2::new(0.0, 40.0 * u), PVec2::new(80.0, 90.0) * u, zz, la(col, 0.09 * a));
    let n = 2 + (hash1(seed, 7) * 4.0) as i32;
    for k in 0..n {
        let x = (hash1(seed * 31 + k, 8) - 0.5) * 30.0 * u;
        let len = (25.0 + 70.0 * hash1(seed * 17 + k, 9)) * u;
        let sway = (t * 0.6 + k as f32 * 1.3 + seed as f32).sin() * 2.0 * u;
        let a0 = tip + PVec2::new(x * 0.4, 6.0 * u);
        let b = tip + PVec2::new(x + sway, -len);
        buf.stroke(&[a0, b], 1.0 * u, zz, la(lighten(col, 0.3), 0.3 * a));
        buf.ellipse(b, PVec2::splat(2.6 * u), 0.0, zz + 0.0001, la(lighten(col, 0.6), 0.85 * a));
    }
}

/// A clump of tiny glowing caps on a stalagmite.
#[allow(clippy::too_many_arguments)]
fn fungus(buf: &mut MeshBuf, at: PVec2, wdt: f32, u: f32, col: Color, a: f32, zz: f32, seed: i32) {
    let w = wdt.min(60.0 * u).max(14.0 * u);
    buf.halo(at + PVec2::new(0.0, 10.0 * u), PVec2::new(w * 1.4 + 40.0 * u, w + 30.0 * u), zz, la(col, 0.16 * a));
    let n = 4 + (hash1(seed, 11) * 6.0) as i32;
    for k in 0..n {
        let x = (hash1(seed * 13 + k, 12) - 0.5) * w;
        let tall = (3.0 + 10.0 * hash1(seed * 7 + k, 13)) * u;
        let base = at + PVec2::new(x, -4.0 * u);
        let top = base + PVec2::new(0.0, tall);
        let r = (1.6 + 2.6 * hash1(seed * 5 + k, 14)) * u;
        buf.stroke(&[base, top], 1.0 * u, zz, la(mix(Color::BLACK, col, 0.5), 0.6 * a));
        buf.ellipse(top, PVec2::new(r * 1.3, r * 0.8), 0.0, zz + 0.0001, la(lighten(col, 0.35), 0.85 * a));
    }
}

/// Darken toward the edges of a centred rect.
fn vignette(buf: &mut MeshBuf, c: PVec2, half: PVec2, zz: f32) {
    let rings = [(0.0f32, 0.0f32), (0.55, 0.0), (0.8, 0.18), (1.05, 0.38), (1.6, 0.5)];
    const SEG: u32 = 32;
    let mut prev: Option<u32> = None;
    let r = half * 1.0;
    for (rad, a) in rings {
        let start = buf.pos.len() as u32;
        for i in 0..SEG {
            let ang = i as f32 / SEG as f32 * std::f32::consts::TAU;
            // Squircle-ish so the corners darken without overshooting.
            let d = PVec2::new(ang.cos(), ang.sin());
            let p = c + PVec2::new(d.x * r.x, d.y * r.y) * rad.max(0.001) * 1.15;
            buf.vert(p, zz, [0.0, 0.0, 0.0, a]);
        }
        if let Some(p) = prev {
            for i in 0..SEG {
                let j = (i + 1) % SEG;
                buf.tri(p + i, start + i, start + j);
                buf.tri(p + i, start + j, p + j);
            }
        }
        prev = Some(start);
    }
}

// --------------------------------------------------------------- foreground

/// How much faster than the world the foreground slides (screen px per
/// world unit of camera motion, relative to 1.0 for the play area).
const FG_SPEED: f32 = 1.5;
const FG_SPACING: f32 = 300.0;

#[allow(clippy::type_complexity)]
fn update_foreground(
    time: Res<Time>,
    cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>,
    mut q: Query<(&Foreground, &mut Transform, &mut Visibility), Without<crate::camera::MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
    game: Option<Res<crate::sim::Game>>,
) {
    let Some((c, half, _)) = view(&cam) else { return };
    let t = time.elapsed_secs();
    // The title screen is v2's clean menu: no foreground silhouettes.
    let title = game.as_ref().is_some_and(|g| g.sim.level.id == "title");
    for (fg, mut tf, mut vis) in q.iter_mut() {
        *vis = if title { Visibility::Hidden } else { Visibility::Inherited };
        if title {
            continue;
        }
        tf.translation.x = c.x;
        tf.translation.y = c.y;
        let u = half.y * 2.0 / REF_H;
        let (w, h) = (half.x * 2.0 / u, REF_H);
        let to = |x: f32, y: f32| PVec2::new((x - w * 0.5) * u, (h * 0.5 - y) * u);
        let theme = fg.theme;
        let hue = cave_hue(&theme);
        // Near-black with a breath of the cave hue; a faint rim of light.
        let body = mix(Color::BLACK, hue, 0.035);
        let rim = mix(Color::BLACK, hue, 0.2);
        let mut buf = MeshBuf::default();
        // Screen px of scroll: world motion in screen px times the speed-up.
        let off_x = c.x / u * FG_SPEED;
        let first = ((off_x - 300.0) / FG_SPACING).floor() as i32;
        let last = ((off_x + w + 300.0) / FG_SPACING).ceil() as i32;
        for col in first..=last {
            let bx = col as f32 * FG_SPACING - off_x;
            let hsh = |k: i32| hash2(col, 900 + k);
            // Top edge: a stalactite tip or hanging roots.
            let r = hsh(0);
            if r < 0.32 {
                let len = 110.0 + 150.0 * hsh(1);
                let hw = 50.0 + 45.0 * hsh(2);
                let s = spike_shape(hw, (hsh(3) - 0.5) * hw, col as f32 * 3.7 + 0.5);
                let cx = bx + hsh(4) * FG_SPACING * 0.6;
                fg_shape(&mut buf, &s, |p| to(cx + p.x, -30.0 + p.y * (len + 30.0)), body, rim, u);
            } else if r < 0.55 {
                let cx = bx + hsh(4) * FG_SPACING * 0.6;
                roots(&mut buf, |x, y| to(x, y), cx, col, t, body, theme.crystal, u);
            }
            // Bottom edge: rock lumps or a fungus stalk.
            let r = hsh(10);
            if r < 0.3 {
                let len = 60.0 + 90.0 * hsh(11);
                let hw = 70.0 + 70.0 * hsh(12);
                let s = spike_shape(hw, (hsh(13) - 0.5) * hw * 0.6, col as f32 * 5.3 + 2.0);
                let cx = bx + FG_SPACING * 0.5 + hsh(14) * FG_SPACING * 0.4;
                fg_shape(&mut buf, &s, |p| to(cx + p.x, h + 30.0 - p.y * (len + 30.0)), body, rim, u);
            } else if r < 0.48 {
                let cx = bx + FG_SPACING * 0.5 + hsh(14) * FG_SPACING * 0.4;
                stalk(&mut buf, |x, y| to(x, y), cx, h, col, t, body, theme.mush, u);
            }
        }
        // Drifting spores, 1.5x parallax in both axes, wrapping the view.
        for k in 0..16 {
            let hs = |n: i32| hash2(k, 1200 + n);
            let wx = w + 200.0;
            let wy = h + 200.0;
            let x = (hs(0) * wx - c.x / u * FG_SPEED + t * (6.0 + 10.0 * hs(2)) + (t * 0.4 + k as f32).sin() * 20.0).rem_euclid(wx) - 100.0;
            let y = (hs(1) * wy + c.y / u * FG_SPEED - t * (4.0 + 6.0 * hs(3))).rem_euclid(wy) - 100.0;
            // Keep them out of the middle band mostly: fade there.
            let mid = 1.0 - (-(((y / h) - 0.5) / 0.22).powi(2)).exp() * 0.7;
            let col = if k % 3 == 0 { theme.crystal } else { theme.mush };
            let r = (5.0 + 9.0 * hs(4)) * u;
            let a = (0.10 + 0.08 * (t * 1.1 + k as f32).sin()) * mid;
            buf.halo(to(x, y), PVec2::splat(r * 3.0), 0.002, la(col, a));
            buf.ellipse(to(x, y), PVec2::splat(r * 0.35), 0.0, 0.0021, la(lighten(col, 0.4), a * 1.6));
        }
        if let Some(mut m) = meshes.get_mut(&fg.mesh) {
            buf.write(&mut m);
        }
    }
}

/// A soft-edged dark silhouette: solid body plus a feathered rim (reads as
/// slightly out of focus).
fn fg_shape(buf: &mut MeshBuf, s: &Shape, map: impl Fn(PVec2) -> PVec2, body: Color, rim: Color, u: f32) {
    let left: Vec<PVec2> = s.left.iter().map(|p| map(*p)).collect();
    let right: Vec<PVec2> = s.right.iter().map(|p| map(*p)).collect();
    fill_strip(buf, &left, &right, 0.0, |_| la(body, 0.93));
    // Feather: outline loop root→tip→root, pushed outward with alpha → 0.
    let mut outline: Vec<PVec2> = left.clone();
    outline.extend(right.iter().rev().copied());
    let nrm = |i: usize| {
        let n = outline.len();
        let d = outline[(i + 1).min(n - 1)] - outline[i.saturating_sub(1)];
        PVec2::new(d.y, -d.x).normalize_or_zero()
    };
    let nrms: Vec<PVec2> = (0..outline.len()).map(nrm).collect();
    // Orientation: make normals point away from the shape's centre.
    let centre = outline.iter().copied().fold(PVec2::ZERO, |a, b| a + b) / outline.len() as f32;
    let flip = if (outline[outline.len() / 4] - centre).dot(nrms[outline.len() / 4]) < 0.0 { -1.0 } else { 1.0 };
    let nrms: Vec<PVec2> = nrms.iter().map(|n| *n * flip).collect();
    let n = outline.len();
    // A thin rim of cave light just inside the edge…
    let rim_in: Vec<[f32; 4]> = (0..n).map(|_| la(rim, 0.0)).collect();
    let rim_out: Vec<[f32; 4]> = (0..n).map(|_| la(rim, 0.55)).collect();
    buf.band(&outline, &nrms, 5.0 * u, 0.0, 0.0006, &rim_in, &rim_out);
    // …and a wide feather outside it: out of focus, close to the lens.
    let inner: Vec<[f32; 4]> = (0..n).map(|_| la(body, 0.85)).collect();
    let outer: Vec<[f32; 4]> = (0..n).map(|_| la(body, 0.0)).collect();
    buf.band(&outline, &nrms, 0.0, -22.0 * u, 0.0005, &inner, &outer);
}

/// Hanging roots from the top edge, swaying slowly, with tiny glowing
/// beads at their tips.
#[allow(clippy::too_many_arguments)]
fn roots(buf: &mut MeshBuf, to: impl Fn(f32, f32) -> PVec2, cx: f32, col: i32, t: f32, body: Color, glow: Color, u: f32) {
    let n = 2 + (hash2(col, 950) * 3.0) as i32;
    for k in 0..n {
        let x0 = cx + (hash2(col * 7 + k, 951) - 0.5) * 70.0;
        let len = 110.0 + 200.0 * hash2(col * 5 + k, 952);
        let ph = hash2(col, 953 + k) * 6.0;
        let pts: Vec<PVec2> = (0..=10)
            .map(|i| {
                let s = i as f32 / 10.0;
                let sway = (t * 0.7 + ph).sin() * 10.0 * s * s + (s * 5.0 + ph).sin() * 6.0 * s;
                to(x0 + sway, -10.0 + s * len)
            })
            .collect();
        let wd = (9.0 + 9.0 * hash2(col + k, 954)) * u;
        let cols: Vec<[f32; 4]> = (0..=10).map(|i| la(body, 0.92 - 0.25 * i as f32 / 10.0)).collect();
        let pts_w: Vec<f32> = (0..=10).map(|i| wd * (1.0 - 0.75 * i as f32 / 10.0)).collect();
        for i in 0..10 {
            buf.stroke(&[pts[i], pts[i + 1]], pts_w[i], 0.0, cols[i]);
        }
        let tip = pts[10];
        // Soft edge, then a bead of light at the tip.
        for i in 0..10 {
            buf.stroke(&[pts[i], pts[i + 1]], pts_w[i] + 10.0 * u, -0.0002, la(body, 0.25 * (1.0 - i as f32 / 10.0)));
        }
        buf.halo(tip, PVec2::splat(22.0 * u), 0.001, la(glow, 0.15));
        buf.ellipse(tip, PVec2::splat(3.2 * u), 0.0, 0.0012, la(lighten(glow, 0.5), 0.65));
    }
}

/// A tall dark fungus stalk rising from the bottom edge, its cap rimmed
/// with dim light.
#[allow(clippy::too_many_arguments)]
fn stalk(buf: &mut MeshBuf, to: impl Fn(f32, f32) -> PVec2, cx: f32, h: f32, col: i32, t: f32, body: Color, glow: Color, u: f32) {
    let tall = 120.0 + 110.0 * hash2(col, 960);
    let ph = hash2(col, 961) * 6.0;
    let lean = (hash2(col, 962) - 0.5) * 30.0 + (t * 0.5 + ph).sin() * 3.0;
    let pts: Vec<PVec2> = (0..=8).map(|i| {
        let s = i as f32 / 8.0;
        to(cx + lean * s * s, h + 20.0 - s * tall)
    }).collect();
    buf.stroke(&pts, 30.0 * u, -0.0002, la(body, 0.3));
    buf.stroke(&pts, 18.0 * u, 0.0, la(body, 0.93));
    let top = pts[8];
    let cw = (60.0 + 35.0 * hash2(col, 963)) * u;
    buf.halo(top + PVec2::new(0.0, 6.0 * u), PVec2::new(cw * 1.6, cw), 0.0008, la(glow, 0.14));
    let dome: Vec<PVec2> = (0..=14)
        .map(|i| {
            let a = std::f32::consts::PI * i as f32 / 14.0;
            top + PVec2::new(a.cos() * cw, a.sin() * cw * 0.55)
        })
        .collect();
    buf.fan(&dome, top + PVec2::new(0.0, cw * 0.2), 0.001, la(body, 0.95), la(body, 0.95));
    buf.stroke(&dome, 3.0 * u, 0.0012, la(mix(Color::BLACK, glow, 0.5), 0.7));
    // Gill glow under the cap.
    buf.stroke(&[top + PVec2::new(-cw * 0.85, 0.0), top + PVec2::new(cw * 0.85, 0.0)], 3.0 * u, 0.0013, la(mix(Color::BLACK, glow, 0.6), 0.6));
}
