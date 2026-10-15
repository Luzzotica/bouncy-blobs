//! The cave backdrop, ported from v2's `backgroundRenderer.ts`: a deep
//! vertical gradient, a soft back-wall haze, five parallax layers of
//! stalactites, stalagmites and full-height columns (fBm-perturbed spike
//! silhouettes, far = lighter and slower, near = darker and faster), and a
//! vignette. It lives in screen space (follows the camera, scrolls by a
//! fraction of camera x) so every view reads as the inside of a cave.
//!
//! On top of v2's rock, the cave is alive. Every piece of life is computed
//! from the outline of the rock it sits on (same layer, same parallax), so
//! nothing floats: a vein trunk inside the rock, branching into luminous
//! goop on its skin, small mushrooms of the layer's own rock growing off
//! flanks and column collars, and glow-worm silk or a drop under a tip.
//! It is all one network: pulses of light start somewhere (at random, and
//! now and then on a musical downbeat), pass from rock to rock along the
//! layer's roof and floor, run up each trunk as a visible front, fork into
//! the branches and light what they reach, then ease back to dark. Light
//! fades out completely; physical things (mushrooms, silk) stay, dimly.
//!
//! Also here: the foreground layer, the same idea in front of the play
//! area — sparse dark silhouettes along the top and bottom edges of the
//! screen that scroll *faster* than the world, plus a few drifting spores.

use std::collections::HashMap;

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::crag::hash1;
use crate::level_view::LevelEntity;
use crate::palette::{ThemeColors, glow_at, hex, lighten, lin, mix, pulse_env, screen_add};
use crate::render::{MeshBuf, Shared, la, z};
use crate::sim::Game;

pub struct BackdropPlugin;

/// The backdrop and foreground updates (they also set their own visibility
/// each frame; capture's transparent mode runs after them).
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct BackdropSystems;

impl Plugin for BackdropPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, (update_backdrop, update_foreground).in_set(BackdropSystems).after(crate::camera::CameraFraming).after(bevy::camera::CameraUpdateSystems).before(bevy::transform::TransformSystems::Propagate).run_if(resource_exists::<Game>));
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
    /// Chance a shape on this layer carries a glowing vein.
    vein: f32,
    /// How bright this layer's veins get.
    vein_glow: f32,
    /// How much goop / glow-worm silk / mushroom life the layer has (0 = none).
    goop: f32,
}

const LAYERS: [Layer; 5] = [
    // Deepest spikes behind the columns: long, slow, lightest.
    Layer { spacing: 300.0, parallax: 0.018, len_base: 210.0, len_var: 300.0, width: 200.0, column_chance: 0.0, skip_chance: 0.08, k: 0.25, vein: 0.55, vein_glow: 0.35, goop: 0.0 },
    // Big pillars.
    Layer { spacing: 380.0, parallax: 0.040, len_base: 160.0, len_var: 250.0, width: 240.0, column_chance: 0.55, skip_chance: 0.22, k: 0.19, vein: 0.75, vein_glow: 0.6, goop: 0.6 },
    // Smaller pillars.
    Layer { spacing: 280.0, parallax: 0.075, len_base: 130.0, len_var: 215.0, width: 175.0, column_chance: 0.45, skip_chance: 0.20, k: 0.13, vein: 0.85, vein_glow: 0.8, goop: 0.85 },
    // Mid spikes.
    Layer { spacing: 175.0, parallax: 0.120, len_base: 100.0, len_var: 175.0, width: 120.0, column_chance: 0.05, skip_chance: 0.18, k: 0.08, vein: 0.85, vein_glow: 0.9, goop: 1.0 },
    // Near spikes.
    Layer { spacing: 130.0, parallax: 0.190, len_base: 75.0, len_var: 140.0, width: 96.0, column_chance: 0.02, skip_chance: 0.22, k: 0.04, vein: 0.4, vein_glow: 0.3, goop: 0.0 },
];

/// One backdrop column's rock, cached in normalised form.
struct Col {
    top: Option<(Shape, f32)>,
    bot: Option<(Shape, f32, f32)>,
    column: Option<Shape>,
    cx_top: f32,
}

/// A level's own cave: every level shifts the rock pattern to a different
/// stretch of the noise and leans the layer proportions its own way, so
/// each chapter's backdrop has its own silhouette, not just its own hue.
#[derive(Clone, Copy)]
pub struct CaveSeed {
    /// Column index offset into the noise.
    off: i32,
    /// Spike length, width, lean and column-chance multipliers.
    len_k: f32,
    width_k: f32,
    lean_k: f32,
    column_k: f32,
    skip_k: f32,
    /// Ceiling vs floor weighting (>1: longer stalactites).
    roof_k: f32,
}

impl CaveSeed {
    pub fn for_level(id: &str) -> CaveSeed {
        let h = id.bytes().fold(0x9e37_79b9u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193));
        let r = |k: i32| hash2(h as i32, 4000 + k);
        CaveSeed {
            off: (h % 20_000) as i32 * 3 - 30_000,
            len_k: 0.75 + 0.55 * r(0),
            width_k: 0.8 + 0.45 * r(1),
            lean_k: 0.4 + 1.4 * r(2),
            column_k: 0.35 + 1.3 * r(3),
            skip_k: 0.6 + 1.0 * r(4),
            roof_k: 0.75 + 0.5 * r(5),
        }
    }
}

fn build_col(l: usize, col: i32, cs: &CaveSeed) -> Col {
    let layer = &LAYERS[l];
    let li = l as i32;
    // Same screen column, a different stretch of rock per level.
    let col = col.wrapping_add(cs.off);
    let mut c = Col { top: None, bot: None, column: None, cx_top: 0.0 };
    if hash2(col, li + 90) < (layer.skip_chance * cs.skip_k).min(0.6) {
        return c;
    }
    c.cx_top = (hash2(col, li + 3) - 0.5) * layer.spacing * 0.8;
    let half_w = layer.width * cs.width_k * (0.28 + 0.34 * hash2(col, li + 31));
    let seed = (col.rem_euclid(100_000)) as f32 * 13.13 + l as f32 * 7.7;
    if hash2(col, li + 57) < (layer.column_chance * cs.column_k).min(0.85) {
        c.column = Some(column_shape(half_w * 1.05, seed));
        return c;
    }
    let fx = col.rem_euclid(100_000) as f32;
    let len_t = (layer.len_base + layer.len_var * fbm(fx * 1.7 + l as f32 + 0.5)) * cs.len_k * cs.roof_k;
    let lean_t = (hash2(col, li + 41) - 0.5) * half_w * 0.9 * cs.lean_k;
    c.top = Some((spike_shape(half_w, lean_t, seed + 0.3), len_t.min(REF_H * 0.62)));
    let cx_bot = layer.spacing * 0.5 + (hash2(col, li + 71) - 0.5) * layer.spacing * 0.6;
    let half_wb = layer.width * cs.width_k * (0.28 + 0.34 * hash2(col, li + 97));
    let len_b = (layer.len_base + layer.len_var * fbm(fx * 2.3 + l as f32 + 9.1)) * cs.len_k / cs.roof_k;
    let lean_b = (hash2(col, li + 19) - 0.5) * half_wb * 0.9 * cs.lean_k;
    c.bot = Some((spike_shape(half_wb, lean_b, seed + 5.1), len_b.min(REF_H * 0.62), cx_bot));
    c
}

/// The screen-space backdrop mesh.
#[derive(Component)]
pub struct Backdrop {
    mesh: Handle<Mesh>,
    theme: ThemeColors,
    cols: HashMap<(usize, i32), Col>,
    /// Pulses started by the music: (layer, pulse).
    beats: Vec<(usize, Pulse)>,
    seed: CaveSeed,
}

/// The screen-space foreground mesh.
#[derive(Component)]
pub struct Foreground {
    mesh: Handle<Mesh>,
    theme: ThemeColors,
    seed: CaveSeed,
    /// Camera height when each piece came into view (its vertical anchor).
    seen: HashMap<i32, f32>,
}

/// Spawn the backdrop and foreground for a dark level.
pub fn spawn(commands: &mut Commands, meshes: &mut Assets<Mesh>, shared: &Shared, theme: &ThemeColors, level_id: &str) {
    let seed = CaveSeed::for_level(level_id);
    let mesh = meshes.add(crate::render::empty_mesh());
    commands.spawn((
        Mesh2d(mesh.clone()),
        MeshMaterial2d(shared.blend.clone()),
        Transform::from_xyz(0.0, 0.0, z::FAR - 20.0),
        Backdrop { mesh, theme: *theme, cols: HashMap::new(), beats: Vec::new(), seed },
        LevelEntity,
    ));
    let mesh = meshes.add(crate::render::empty_mesh());
    commands.spawn((
        Mesh2d(mesh.clone()),
        MeshMaterial2d(shared.blend.clone()),
        Transform::from_xyz(0.0, 0.0, z::DECOR_FRONT + 3.0),
        Foreground { mesh, theme: *theme, seed, seen: HashMap::new() },
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
    beat: Option<Res<crate::audio::MusicBeat>>,
) {
    let Some((c, half, _)) = view(&cam) else { return };
    let t = time.elapsed_secs();
    let downbeat = beat.as_ref().filter(|b| b.crossed(crate::audio::Groove::Downbeat)).map(|b| (b.beat / 4.0).floor() as i32);
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
        // Now and then a downbeat starts a gentle pulse near the middle of
        // the view on one of the living layers.
        if let Some(bar) = downbeat {
            if hash2(bar, 1400) < 0.35 {
                let l = 1 + (hash2(bar, 1401) * 3.0) as usize;
                let layer = &LAYERS[l.min(3)];
                let centre = (c.x * layer.parallax + w * 0.5) / layer.spacing;
                let q = ((centre + (hash2(bar, 1402) - 0.5) * 3.0) * 2.0).round() * 0.5;
                bd.beats.push((l.min(3), Pulse { q, t0: t, amp: 0.6 }));
            }
        }
        bd.beats.retain(|(_, p)| t - p.t0 < P_LIFE);
        let beats = std::mem::take(&mut bd.beats);
        let cs = bd.seed;
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
            let pulses = layer_pulses(l, first, last, t, &beats);
            let dr = Dress { theme: &theme, layer, l, u, t, zz: zz + 0.0015, rock, half: PVec2::new(w * 0.5, h * 0.5) * u, off_x, pulses: &pulses };
            for col in first..=last {
                let cc = bd.cols.entry((l, col)).or_insert_with(|| build_col(l, col, &cs));
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
                    dress(&mut glows, &dr, &left, &right, Part::Column, (col + cs.off) * 3, col as f32);
                }
                if let Some((s, len)) = &cc.top {
                    let cx = base_x + cc.cx_top;
                    let left: Vec<PVec2> = s.left.iter().map(|p| to(cx + p.x, -ext + p.y * (len + ext))).collect();
                    let right: Vec<PVec2> = s.right.iter().map(|p| to(cx + p.x, -ext + p.y * (len + ext))).collect();
                    let n = left.len();
                    fill_strip(&mut buf, &left, &right, zz, |i| grad(i, n));
                    dress(&mut glows, &dr, &left, &right, Part::Top, (col + cs.off) * 3 + 1, col as f32);
                }
                if let Some((s, len, cx_off)) = &cc.bot {
                    let cx = base_x + cx_off;
                    let left: Vec<PVec2> = s.left.iter().map(|p| to(cx + p.x, h + ext - p.y * (len + ext))).collect();
                    let right: Vec<PVec2> = s.right.iter().map(|p| to(cx + p.x, h + ext - p.y * (len + ext))).collect();
                    let n = left.len();
                    fill_strip(&mut buf, &left, &right, zz, |i| grad(i, n));
                    dress(&mut glows, &dr, &left, &right, Part::Bot, (col + cs.off) * 3 + 2, col as f32 + 0.5);
                }
            }
            // This layer's glows sit just in front of it.
            append(&mut buf, std::mem::take(&mut glows));
        }
        bd.beats = beats;
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

// ------------------------------------------------------- the pulse network

/// How fast a pulse front runs along a vein (screen px / s).
const P_SPEED: f32 = 120.0;
/// How fast it travels root to root through the cave's roof and floor.
const P_HOP_SPEED: f32 = 230.0;
/// Softness of the leading edge, and length of the glowing tail (px).
const P_LEAD: f32 = 48.0;
const P_TAIL: f32 = P_SPEED * 2.2;
/// A layer's ambient pulses: one chance per district of columns per period.
const P_PERIOD: f32 = 7.0;
const P_DISTRICT: i32 = 6;
/// How many shapes along a layer one pulse can reach.
const P_MAX_HOPS: f32 = 5.0;
/// How long a pulse can still light something (s).
const P_LIFE: f32 = 18.0;

/// A pulse starting at a layer's shape `q` (column index; +0.5 for the
/// stalagmite between columns) at time `t0`.
#[derive(Clone, Copy)]
struct Pulse {
    q: f32,
    t0: f32,
    amp: f32,
}

/// Every pulse that could light anything in columns `first..=last` of a
/// layer: ambient ones (seeded, stateless) plus any from the music.
fn layer_pulses(l: usize, first: i32, last: i32, t: f32, extra: &[(usize, Pulse)]) -> Vec<Pulse> {
    let mut v = Vec::new();
    let period = P_PERIOD * (1.0 + 0.17 * l as f32);
    let d0 = first.div_euclid(P_DISTRICT) - 1;
    let d1 = last.div_euclid(P_DISTRICT) + 1;
    let k0 = ((t - P_LIFE) / period).floor() as i32;
    let k1 = (t / period).floor() as i32;
    for d in d0..=d1 {
        for k in k0..=k1 {
            let h = |s: i32| hash2(d * 131 + k * 7919, l as i32 * 50 + 1300 + s);
            if h(0) > 0.7 {
                continue;
            }
            let t0 = (k as f32 + h(1) * 0.9) * period;
            if t0 > t {
                continue;
            }
            let q = (d * P_DISTRICT) as f32 + (h(2) * (P_DISTRICT * 2) as f32).floor() * 0.5;
            v.push(Pulse { q, t0, amp: 0.7 + 0.3 * h(3) });
        }
    }
    v.extend(extra.iter().filter(|(el, _)| *el == l).map(|(_, p)| *p));
    v
}

/// The pulses reaching one shape, and how bright any point of its network
/// is. Distances `s` are screen px along the network from the shape's root
/// (where the rock meets the roof or floor and the pulse comes in).
struct Net {
    hits: Vec<(f32, f32)>,
    t: f32,
    /// Trunk length; a column is entered from both ends.
    total: f32,
    two_ends: bool,
}

impl Net {
    fn new(pulses: &[Pulse], q: f32, spacing: f32, t: f32, total: f32, two_ends: bool) -> Net {
        let hits = pulses
            .iter()
            .filter_map(|p| {
                let hops = (p.q - q).abs();
                if hops > P_MAX_HOPS {
                    return None;
                }
                let arr = p.t0 + hops * spacing / P_HOP_SPEED;
                let age = t - arr;
                if age < -0.6 || age > total / P_SPEED + 9.0 {
                    return None;
                }
                Some((arr, p.amp * 0.8f32.powf(hops)))
            })
            .collect();
        Net { hits, t, total, two_ends }
    }

    fn at(&self, s: f32) -> f32 {
        self.hits.iter().fold(0.0, |acc, (arr, amp)| screen_add(acc, amp * pulse_env((self.t - arr) * P_SPEED - s, P_LEAD, P_TAIL)))
    }

    /// Light `extra` px past trunk distance `s` (down a branch).
    fn lit(&self, s: f32, extra: f32) -> f32 {
        let a = self.at(s + extra);
        if self.two_ends {
            // The floor end's front comes in a beat later.
            a.max(self.at(self.total - s + extra + P_SPEED * 0.7))
        } else {
            a
        }
    }
}

/// Which kind of rock a piece of life sits on.
#[derive(Clone, Copy, PartialEq)]
enum Part {
    /// Floor-to-ceiling column; index 0 at the top.
    Column,
    /// Stalactite; index 0 at the ceiling root, last at the tip.
    Top,
    /// Stalagmite; index 0 at the floor root, last at the tip.
    Bot,
}

/// What one shape needs to dress itself.
struct Dress<'a> {
    theme: &'a ThemeColors,
    layer: &'a Layer,
    l: usize,
    /// Screen px -> local units.
    u: f32,
    t: f32,
    zz: f32,
    /// The layer's rock colour (mushrooms are made of the same stuff).
    rock: Color,
    /// Visible half-extents in local units.
    half: PVec2,
    /// The layer's scroll (screen px), so hues stay put on the rock.
    off_x: f32,
    pulses: &'a [Pulse],
}

impl Dress<'_> {
    fn visible(&self, p: PVec2, pad: f32) -> bool {
        p.x.abs() < self.half.x + pad && p.y.abs() < self.half.y + pad
    }

    /// The scene's glow hue at a local point (fixed to the rock).
    fn hue(&self, p: PVec2) -> Color {
        glow_at(self.theme, p.x / self.u + self.off_x, p.y / self.u)
    }
}

/// A point inside the strip: `i` a (fractional) index along it, `f` 0..1
/// from the left edge to the right.
fn inside(left: &[PVec2], right: &[PVec2], i: f32, f: f32) -> PVec2 {
    let n = left.len();
    let i0 = (i.floor() as usize).min(n - 2);
    let s = (i - i0 as f32).clamp(0.0, 1.0);
    let l = left[i0] + (left[i0 + 1] - left[i0]) * s;
    let r = right[i0] + (right[i0 + 1] - right[i0]) * s;
    l + (r - l) * f
}

/// Cumulative length (screen px) along a polyline in local units.
fn arc_len(pts: &[PVec2], u: f32) -> Vec<f32> {
    let mut s = 0.0;
    let mut out = Vec::with_capacity(pts.len());
    for i in 0..pts.len() {
        if i > 0 {
            s += pts[i].distance(pts[i - 1]) / u;
        }
        out.push(s);
    }
    out
}

/// The vein from trunk point `from` to `to` (just inside the skin under
/// something that grows there), bowed a little so it reads as grown.
fn branch_path(from: PVec2, to: PVec2, bow: f32, u: f32) -> Vec<PVec2> {
    let d = to - from;
    let side = PVec2::new(-d.y, d.x).normalize_or_zero();
    let steps = ((d.length() / (12.0 * u)).ceil() as usize).clamp(3, 16);
    (0..=steps)
        .map(|k| {
            let s = k as f32 / steps as f32;
            from + d * s + side * (s * (1.0 - s) * 4.0 * bow * d.length())
        })
        .collect()
}

/// Dress one rock shape (already mapped to local space) with life that
/// belongs to it, all wired together: a vein trunk running from the rock's
/// root up through it, with branches that lead into every goop patch and
/// mushroom cluster on its skin and on to the silk under its tip. Pulses
/// come in at the root (passed along the layer's roof and floor from
/// neighbouring rock), run up the trunk as a visible front, fork into the
/// branches and light whatever they reach, then ease back to dark.
#[allow(clippy::too_many_arguments)]
fn dress(buf: &mut MeshBuf, d: &Dress, left: &[PVec2], right: &[PVec2], part: Part, seed: i32, q: f32) {
    let n = left.len();
    let u = d.u;
    let li = d.l as i32 * 1000;
    let hs = |k: i32| hash2(seed, li + k);
    let (lo, hi) = left.iter().chain(right).fold((PVec2::splat(f32::MAX), PVec2::splat(f32::MIN)), |(a, b), p| (a.min(*p), b.max(*p)));
    let pad = 60.0 * u;
    if hi.x < -d.half.x - pad || lo.x > d.half.x + pad || hi.y < -d.half.y - pad || lo.y > d.half.y + pad {
        return;
    }
    let life = d.layer.goop > 0.0;
    let has_vein = hs(10) < d.layer.vein;
    // What grows here (decided up front so the trunk knows where to reach).
    let tip_threads = part == Part::Top && life && hs(40) < 0.5 * d.layer.goop;
    let tip_drop = part == Part::Top && life && !tip_threads && hs(40) < 0.85 * d.layer.goop;
    let tip_cap = part == Part::Bot && life && hs(41) < 0.45 * d.layer.goop;
    let patches = if life { (hs(20) * 3.2 * d.layer.goop) as i32 } else { 0 };
    let shrooms = life && part != Part::Top && hs(50) < 0.55 * d.layer.goop;
    if !has_vein && !(life && (tip_threads || tip_drop || tip_cap || patches > 0 || shrooms)) {
        return;
    }

    // The outline as one loop root -> tip -> root, outward normals.
    let mut ol: Vec<PVec2> = left.to_vec();
    ol.extend(right.iter().rev().copied());
    let mid: Vec<PVec2> = left.iter().zip(right).map(|(a, b)| (*a + *b) * 0.5).collect();
    let m = ol.len();
    let side_idx = |k: usize| if k < n { k } else { 2 * n - 1 - k };
    let half_w = |k: usize| left[side_idx(k)].distance(right[side_idx(k)]) * 0.5;
    let nrm: Vec<PVec2> = (0..m)
        .map(|k| {
            let d0 = ol[(k + 1).min(m - 1)] - ol[k.saturating_sub(1)];
            let nn = PVec2::new(d0.y, -d0.x).normalize_or_zero();
            if (ol[k] - mid[side_idx(k)]).dot(nn) < 0.0 { -nn } else { nn }
        })
        .collect();

    // ---- the trunk
    let nf = n as f32;
    let reaches_tip = tip_threads || tip_drop || tip_cap;
    let (i0, i1) = match part {
        Part::Column => (0.3, nf - 1.3),
        _ if reaches_tip => (0.3, nf - 1.15),
        _ => (0.3, (nf - 1.0) * (0.62 + 0.25 * hs(11))),
    };
    let fs = seed as f32 * 0.731 + d.l as f32 * 5.3;
    // A slow, smooth meander (no fine jitter: a vein, not lightning).
    let ph = hash2(seed, li + 14) * 6.28;
    let f_at = |i: f32| (0.5 + 0.2 * (i * 0.42 + ph).sin() + 0.08 * (i * 0.95 + fs).sin()).clamp(0.24, 0.76);
    let steps = (((i1 - i0) * 3.0) as usize).max(4);
    let mut trunk: Vec<PVec2> = (0..=steps)
        .map(|s| {
            let i = i0 + (i1 - i0) * s as f32 / steps as f32;
            // Narrow towards a spike's tip: pull to the centre line.
            let f = f_at(i);
            let pull = if part == Part::Column { 0.0 } else { (i / (nf - 1.0)).powi(2) * 0.8 };
            inside(left, right, i, f + (0.5 - f) * pull)
        })
        .collect();
    // Relax away the rock outline's jitter so the vein flows.
    for _ in 0..4 {
        let prev = trunk.clone();
        for k in 1..trunk.len() - 1 {
            trunk[k] = prev[k] * 0.5 + (prev[k - 1] + prev[k + 1]) * 0.25;
        }
    }
    let tip = (left[n - 1] + right[n - 1]) * 0.5;
    if reaches_tip {
        trunk.push(tip);
    }
    let ts = arc_len(&trunk, u);
    let total = *ts.last().unwrap();
    let net = Net::new(d.pulses, q, d.layer.spacing, d.t, total, part == Part::Column);
    // The trunk point nearest `p`.
    let nearest = |p: PVec2| -> usize {
        (0..trunk.len()).min_by(|a, b| trunk[*a].distance_squared(p).total_cmp(&trunk[*b].distance_squared(p))).unwrap_or(0)
    };
    let glow = d.layer.vein_glow.max(0.35);
    // Fade the trunk's free end(s) into the stone.
    let fade_root = |k: usize| ((ts[k] / 30.0).min(1.0), if reaches_tip { 1.0 } else { ((total - ts[k]) / 40.0).clamp(0.0, 1.0) });
    let trunk_s: Vec<f32> = ts.clone();
    let trunk_fade: Vec<f32> = (0..trunk.len()).map(|k| { let (a, b) = fade_root(k); if part == Part::Column { 1.0 } else { a * b } }).collect();
    draw_vein(buf, d, &trunk, &(0..trunk.len()).map(|k| net.lit(trunk_s[k], 0.0)).collect::<Vec<_>>(), &trunk_fade, glow, seed);

    // ---- goop patches on the skin, each fed by its own branch
    for k in 0..patches {
        let h = |qq: i32| hash2(seed * 7 + k, li + 30 + qq);
        let right_side = h(0) < 0.5;
        let along = match part {
            Part::Column => 0.25 + 0.6 * h(1),
            Part::Top => 0.35 + 0.5 * h(1),
            Part::Bot => 0.15 + 0.6 * h(1),
        };
        let i = ((along * (n - 1) as f32) as usize).clamp(1, n - 3);
        let span = 2 + (h(2) * 2.0) as usize;
        let i1 = (i + span).min(n - 1);
        let ks: Vec<usize> = if right_side { (i..=i1).map(|qq| 2 * n - 1 - qq).collect() } else { (i..=i1).collect() };
        let thin = ks.iter().map(|qq| half_w(*qq)).fold(f32::MAX, f32::min);
        if thin < 8.0 * u {
            continue;
        }
        let pts: Vec<PVec2> = ks.iter().map(|qq| ol[*qq]).collect();
        let nr: Vec<PVec2> = ks.iter().map(|qq| nrm[*qq]).collect();
        if !pts.iter().any(|p| d.visible(*p, 60.0 * u)) {
            continue;
        }
        let cm = pts.len() / 2;
        let contact = pts[cm] - nr[cm] * (thin * 0.25).min(4.0 * u);
        let j = nearest(contact);
        let br = branch_path(trunk[j], contact, (h(9) - 0.5) * 0.3, u);
        let bs = arc_len(&br, u);
        let bl: Vec<f32> = bs.iter().map(|s| net.lit(trunk_s[j], *s)).collect();
        draw_vein(buf, d, &br, &bl, &vec![1.0; br.len()], glow * 0.8, seed * 7 + k);
        goop(buf, d, &pts, &nr, thin, part, seed * 7 + k, &|p: PVec2| net.lit(trunk_s[j], bs.last().unwrap() + p.distance(contact) / u));
    }

    // ---- the tip
    let tip_s = total;
    if tip_threads && d.visible(tip, pad * 2.0) {
        threads(buf, d, tip, seed, &|s: f32| net.lit(tip_s, s));
    } else if tip_drop {
        drop_on_tip(buf, d, tip, seed, net.lit(tip_s, 6.0));
    } else if tip_cap {
        // A cap of goop over the tip, down both flanks.
        let ks: Vec<usize> = (n - 4..2 * n - 1 - (n - 4) + 1).collect();
        let pts: Vec<PVec2> = ks.iter().map(|qq| ol[*qq]).collect();
        let nr: Vec<PVec2> = ks.iter().map(|qq| nrm[*qq]).collect();
        goop(buf, d, &pts, &nr, 2.0 * u, part, seed * 7 + 99, &|p: PVec2| net.lit(tip_s, p.distance(tip) / u));
    }

    // ---- mushrooms growing off a flank, their roots in the vein
    if shrooms {
        let right_side = hs(51) < 0.5;
        let along = match part {
            // The collar where the drips met is a natural ledge;
            // otherwise low on the flank.
            Part::Column => {
                if hs(52) < 0.4 { 0.5 } else { 0.62 + 0.2 * hs(53) }
            }
            _ => 0.2 + 0.4 * hs(53),
        };
        let i = ((along * (n - 1) as f32).round() as usize).clamp(1, n - 2);
        let k = if right_side { 2 * n - 1 - i } else { i };
        let at = ol[k];
        // Only where the flank faces sideways or up — not under an overhang.
        if nrm[k].y > -0.3 && d.visible(at, pad) {
            let contact = at - nrm[k] * 3.0 * u;
            let j = nearest(contact);
            let br = branch_path(trunk[j], contact, (hs(54) - 0.5) * 0.4, u);
            let bs = arc_len(&br, u);
            let bl: Vec<f32> = bs.iter().map(|s| net.lit(trunk_s[j], *s)).collect();
            draw_vein(buf, d, &br, &bl, &vec![1.0; br.len()], glow * 0.85, seed + 31);
            let s_base = *bs.last().unwrap();
            mushrooms(buf, d, at, nrm[k], seed, &|s: f32| net.lit(trunk_s[j], s_base + s));
        }
    }

    // ---- a free side branch on bare veins, heading toward one edge
    if has_vein && patches == 0 && !shrooms {
        let ib = 0.3 + 0.4 * hs(12);
        let j = ((trunk.len() - 1) as f32 * ib) as usize;
        let to_edge = if hs(13) < 0.5 { 0.14 } else { 0.86 };
        let i_tr = i0 + (i1 - i0) * ib;
        let end = inside(left, right, (i_tr + 2.0).min(nf - 1.2), to_edge);
        let br = branch_path(trunk[j], end, 0.15, u);
        let bs = arc_len(&br, u);
        let bl: Vec<f32> = bs.iter().map(|s| net.lit(trunk_s[j], *s)).collect();
        let bf: Vec<f32> = bs.iter().map(|s| ((bs.last().unwrap() - s) / 30.0).clamp(0.0, 1.0)).collect();
        draw_vein(buf, d, &br, &bl, &bf, glow * 0.7, seed + 1);
    }
}

/// A vein: a dim mineral seam in the rock (always there, faintly), and the
/// light running along it — per point `lit` (0..1), `fade` tapering the
/// ends into the stone. Hue follows the scene's glow field point by point.
fn draw_vein(buf: &mut MeshBuf, d: &Dress, pts: &[PVec2], lit: &[f32], fade: &[f32], glow: f32, seed: i32) {
    let u = d.u;
    let n = pts.len();
    if n < 2 {
        return;
    }
    let cols: Vec<Color> = pts.iter().map(|p| d.hue(*p)).collect();
    // The seam: rock with a breath of the glow in it.
    let seam: Vec<[f32; 4]> = (0..n).map(|i| la(mix(d.rock, cols[i], 0.16), 0.55 * fade[i])).collect();
    buf.stroke_cols(pts, 2.2 * u, d.zz - 0.0001, &seam);
    let peak = lit.iter().copied().fold(0.0, f32::max);
    if peak < 0.004 {
        return;
    }
    let g: Vec<f32> = (0..n).map(|i| lit[i] * fade[i] * glow).collect();
    let soft: Vec<[f32; 4]> = (0..n).map(|i| la(cols[i], 0.16 * g[i])).collect();
    buf.stroke_cols(pts, 10.0 * u, d.zz, &soft);
    let core: Vec<[f32; 4]> = (0..n).map(|i| la(lighten(cols[i], 0.2 + 0.25 * g[i]), 0.8 * g[i])).collect();
    buf.stroke_cols(pts, 1.8 * u, d.zz + 0.0001, &core);
    // Beads of light along it, swelling as the front passes.
    let off = (hash2(seed, 77) * 3.0) as usize;
    for i in (off..n).step_by(5) {
        if g[i] > 0.02 {
            buf.ellipse(pts[i], PVec2::splat((1.2 + 1.1 * g[i]) * u), 0.0, d.zz + 0.0002, la(lighten(cols[i], 0.45), 0.85 * g[i]));
        }
    }
}

/// Luminous goop clinging to the rock's skin along `pts` (with outward
/// normals): a film just inside the edge, a soft spill outside it, a few
/// lumps, and drips hanging off anything facing down. Lit point by point
/// by `lit` (spreading out from where its vein touches it).
#[allow(clippy::too_many_arguments)]
fn goop(buf: &mut MeshBuf, d: &Dress, pts: &[PVec2], nrm: &[PVec2], thin: f32, part: Part, seed: i32, lit: &dyn Fn(PVec2) -> f32) {
    let u = d.u;
    if pts.len() < 2 || !pts.iter().any(|p| d.visible(*p, 40.0 * u)) {
        return;
    }
    // Subdivide so the ends taper smoothly and the light spreads smoothly.
    let mut p2 = Vec::new();
    let mut n2 = Vec::new();
    for i in 0..pts.len() - 1 {
        for s in 0..3 {
            let k = s as f32 / 3.0;
            p2.push(pts[i] + (pts[i + 1] - pts[i]) * k);
            n2.push((nrm[i] + (nrm[i + 1] - nrm[i]) * k).normalize_or_zero());
        }
    }
    p2.push(*pts.last().unwrap());
    n2.push(*nrm.last().unwrap());
    let m = p2.len();
    let a: Vec<f32> = p2.iter().map(|p| d.layer.goop * lit(*p)).collect();
    if a.iter().all(|x| *x < 0.004) {
        return;
    }
    let cols: Vec<Color> = p2.iter().map(|p| d.hue(*p)).collect();
    let prof = |i: usize| (std::f32::consts::PI * i as f32 / (m - 1) as f32).sin().max(0.0).powf(0.7);
    let film = |k: f32| -> Vec<[f32; 4]> { (0..m).map(|i| la(cols[i], k * a[i] * prof(i))).collect() };
    let clear: Vec<[f32; 4]> = (0..m).map(|i| la(cols[i], 0.0)).collect();
    // Never deeper than the rock is thick, or a thin tip fills solid.
    let depth = ((4.0 + 5.0 * hash2(seed, 3)) * u).min(thin * 0.4);
    buf.band(&p2, &n2, 0.0, depth, d.zz, &film(0.42), &clear);
    buf.band(&p2, &n2, 0.0, (1.4 * u).min(depth), d.zz + 0.0001, &film(0.6), &film(0.25));
    buf.band(&p2, &n2, 0.0, -14.0 * u, d.zz - 0.0001, &film(0.14), &clear);
    let lumps = 1 + (hash2(seed, 4) * 3.0) as usize;
    for k in 0..lumps {
        let i = 1 + ((hash2(seed + k as i32, 5) * (m - 2) as f32) as usize).min(m - 3);
        let r = (1.4 + 1.6 * hash2(seed + k as i32, 6)) * u;
        let p = p2[i] + n2[i] * r * 0.4;
        let ai = a[i] * prof(i);
        if ai < 0.004 {
            continue;
        }
        buf.ellipse(p, PVec2::splat(r), 0.0, d.zz + 0.0002, la(lighten(cols[i], 0.4), 0.7 * ai));
        if n2[i].y < -0.25 || (part == Part::Top && hash2(seed + k as i32, 7) < 0.5) {
            let s = (d.t * 0.25 + hash2(seed + k as i32, 8) * 3.0).fract();
            let len = (4.0 + 12.0 * s) * u;
            buf.stroke(&[p, p - PVec2::new(0.0, len)], 1.0 * u, d.zz + 0.0001, la(cols[i], 0.35 * ai));
            buf.ellipse(p - PVec2::new(0.0, len), PVec2::new(1.3, 1.7) * u, 0.0, d.zz + 0.0002, la(lighten(cols[i], 0.45), 0.7 * ai));
        }
    }
}

/// A drop slowly forming on a stalactite tip: a dim bead of water always,
/// glowing when the pulse reaches the tip.
fn drop_on_tip(buf: &mut MeshBuf, d: &Dress, tip: PVec2, seed: i32, lit: f32) {
    let u = d.u;
    if !d.visible(tip, 30.0 * u) {
        return;
    }
    let col = d.hue(tip);
    let a = d.layer.goop * lit;
    let s = 0.6 + 0.4 * (d.t * 0.4 + hash2(seed, 9) * 6.0).sin();
    let r = (2.2 + 1.2 * s) * u;
    let c = tip - PVec2::new(0.0, r * 0.9);
    if a > 0.004 {
        buf.halo(c, PVec2::splat(22.0 * u), d.zz, la(col, 0.14 * a));
    }
    let body = mix(mix(d.rock, col, 0.25), lighten(col, 0.5), a.min(1.0));
    buf.ellipse(c, PVec2::new(r * 0.85, r * 1.1), 0.0, d.zz + 0.0002, la(body, 0.45 + 0.4 * a));
}

/// Glow-worm silk under a stalactite tip: every strand hangs from one
/// shared point and fans out under gravity. The silk is always there,
/// dimly; the light runs down it from the knot when the pulse arrives and
/// the strands stir.
fn threads(buf: &mut MeshBuf, d: &Dress, tip: PVec2, seed: i32, lit: &dyn Fn(f32) -> f32) {
    let u = d.u;
    let col = d.hue(tip);
    let anchor = tip + PVec2::new(0.0, 2.0 * u);
    let a0 = d.layer.goop * lit(0.0);
    if a0 > 0.004 {
        buf.halo(anchor - PVec2::new(0.0, 36.0 * u), PVec2::new(60.0, 80.0) * u, d.zz, la(col, 0.09 * a0));
    }
    let silk = mix(d.rock, col, 0.3);
    let n = 3 + (hash1(seed, 7) * 3.0) as i32;
    for k in 0..n {
        let spread = if n > 1 { k as f32 / (n - 1) as f32 * 2.0 - 1.0 } else { 0.0 };
        let ang0 = spread * 0.30 + (hash1(seed * 31 + k, 8) - 0.5) * 0.12;
        let len = (28.0 + 72.0 * hash1(seed * 17 + k, 9)) * u;
        // Stirs more while lit.
        let stir = 0.04 + 0.06 * lit(len / u * 0.5);
        let sway = (d.t * 0.6 + k as f32 * 1.3 + seed as f32).sin() * stir;
        const N: usize = 7;
        let mut p = anchor;
        let mut pts = vec![p];
        for j in 1..=N {
            let s = j as f32 / N as f32;
            let ang = ang0 * (1.0 - 0.6 * s) + sway * s;
            p += PVec2::new(ang.sin(), -ang.cos()) * len / N as f32;
            pts.push(p);
        }
        let ss = arc_len(&pts, u);
        let g: Vec<f32> = ss.iter().map(|s| d.layer.goop * lit(*s)).collect();
        // Silk: physical, never gone.
        buf.stroke(&pts, 0.9 * u, d.zz, la(silk, 0.55));
        if g.iter().any(|x| *x > 0.004) {
            let cs: Vec<[f32; 4]> = (0..pts.len()).map(|i| la(lighten(col, 0.3), 0.45 * g[i])).collect();
            buf.stroke_cols(&pts, 1.1 * u, d.zz + 0.00005, &cs);
            for i in (2..pts.len()).step_by(2) {
                buf.ellipse(pts[i], PVec2::splat(1.1 * u), 0.0, d.zz + 0.0001, la(lighten(col, 0.5), 0.6 * g[i]));
            }
        }
        // The larva at the end: a dim bead at rest, a lamp when lit.
        let gt = g[N];
        buf.ellipse(pts[N], PVec2::splat((1.8 + 0.6 * gt) * u), 0.0, d.zz + 0.0001, la(mix(silk, lighten(col, 0.6), 0.3 + 0.7 * gt), 0.5 + 0.45 * gt));
    }
    buf.ellipse(anchor, PVec2::splat(1.8 * u), 0.0, d.zz + 0.0001, la(mix(silk, lighten(col, 0.3), a0), 0.6));
}

/// A little cluster of mushrooms growing out of the rock at `at` (outward
/// normal `nrm`): stalks and caps of the layer's own rock (always there),
/// gills and rim lighting up as the pulse climbs out of the vein, each cap
/// a moment after the last; lit caps nod.
fn mushrooms(buf: &mut MeshBuf, d: &Dress, at: PVec2, nrm: PVec2, seed: i32, lit: &dyn Fn(f32) -> f32) {
    let u = d.u;
    let col = d.hue(at);
    let tan = PVec2::new(-nrm.y, nrm.x);
    let size = d.layer.width * (0.10 + 0.07 * hash2(seed, 60)) * u;
    let a_all = d.layer.goop * lit(size / u);
    if a_all > 0.004 {
        buf.halo(at + PVec2::new(0.0, size * 0.8) + nrm * size * 0.3, PVec2::new(size * 1.6, size * 1.2), d.zz - 0.0001, la(col, 0.2 * a_all));
    }
    let count = 1 + (hash2(seed, 61) * 3.0) as i32;
    for k in 0..count {
        let h = |qq: i32| hash2(seed * 5 + k, 70 + qq);
        let s = size * if k == 0 { 1.0 } else { 0.45 + 0.35 * h(0) };
        let base = at + tan * (k as f32 - (count - 1) as f32 * 0.5) * size * 0.35 - nrm * 3.0 * u;
        // The light reaches this cap after climbing its stalk.
        let a = d.layer.goop * lit((s + k as f32 * 8.0 * u) / u);
        let out = (nrm * 0.8 + PVec2::new(0.0, 0.6)).normalize_or_zero();
        let lean = (h(1) - 0.5) * 0.3 + a * 0.07 * (d.t * 1.7 + k as f32 * 2.1 + seed as f32).sin();
        let up = PVec2::new(lean, 1.0).normalize_or_zero();
        const N: usize = 5;
        let pts: Vec<PVec2> = (0..=N)
            .scan(base, |p, j| {
                let s0 = j as f32 / N as f32;
                let dir = (out * (1.0 - s0) + up * s0).normalize_or_zero();
                let qp = *p;
                *p += dir * s / N as f32;
                Some(qp)
            })
            .collect();
        let top = pts[N];
        let wd = s * 0.16;
        // The body is rock that warms a little toward the light.
        let body = mix(d.rock, lighten(col, 0.1), 0.07 + 0.3 * a.min(1.0));
        for j in 0..N {
            buf.stroke(&[pts[j], pts[j + 1]], wd * (1.0 - 0.35 * j as f32 / N as f32), d.zz, lin(body));
        }
        let dir = (pts[N] - pts[N - 1]).normalize_or_zero();
        let side = PVec2::new(dir.y, -dir.x);
        let (cw, ch) = (s * 0.42, s * 0.32);
        let dome: Vec<PVec2> = (0..=12)
            .map(|i| {
                let an = std::f32::consts::PI * i as f32 / 12.0;
                top - side * (an.cos() * cw) + dir * (an.sin() * ch)
            })
            .collect();
        buf.fan(&dome, top + dir * ch * 0.3, d.zz, lin(body), lin(body));
        if a > 0.004 {
            let g0 = top - side * cw * 0.9 - dir * 0.5 * u;
            let g1 = top + side * cw * 0.9 - dir * 0.5 * u;
            buf.halo(top - dir * 2.0 * u, PVec2::new(cw * 2.4, ch * 2.6), d.zz + 0.0001, la(col, 0.3 * a));
            buf.stroke(&[g0, top - dir * 1.5 * u, g1], 2.6 * u, d.zz + 0.0001, la(lighten(col, 0.35), 0.95 * a.min(1.0)));
            buf.stroke(&dome, 1.2 * u, d.zz + 0.0001, la(lighten(col, 0.25), 0.55 * a.min(1.0)));
        }
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

/// The foreground sits between the camera and the play area, so it slides
/// past much faster than the world (screen motion per unit of camera
/// motion; the play area is 1.0).
const FG_SPEED: f32 = 2.0;
/// World spacing of foreground spots (one spot per stretch, most empty):
/// a piece sweeps past now and then, it never sits on screen.
const FG_SPACING: f32 = 1500.0;

/// What stands at a foreground spot.
#[derive(Clone, Copy, PartialEq)]
enum FgKind {
    /// A stalactite tip hanging into the top of the view.
    Fang,
    /// A bundle of roots hanging from above.
    Roots,
    /// A rock lump rising into the bottom of the view.
    Lump,
    /// A tuft of cave fronds rising from below.
    Fronds,
}

#[allow(clippy::type_complexity)]
fn update_foreground(
    time: Res<Time>,
    cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>,
    mut q: Query<(&mut Foreground, &mut Transform, &mut Visibility), Without<crate::camera::MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
    game: Option<Res<crate::sim::Game>>,
) {
    let Some((c, half, _)) = view(&cam) else { return };
    let t = time.elapsed_secs();
    // The title screen is v2's clean menu: no foreground silhouettes.
    let title = game.as_ref().is_some_and(|g| g.sim.level.id == "title");
    for (mut fg, mut tf, mut vis) in q.iter_mut() {
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
        // Near-black with a breath of the cave hue; a rim of cave light so
        // the shape reads even against black rock.
        let body = mix(Color::BLACK, hue, 0.05);
        let rim = mix(Color::BLACK, lighten(hue, 0.2), 0.42);
        let mut buf = MeshBuf::default();
        let off = fg.seed.off;
        // Spots are fixed in the world; a spot at world x is drawn at
        // screen x = (x - camera x) * FG_SPEED, so it crosses the view in
        // half the camera travel the world needs.
        let reach = (half.x + 400.0 * u) / FG_SPEED;
        let first = ((c.x - reach) / FG_SPACING).floor() as i32;
        let last = ((c.x + reach) / FG_SPACING).ceil() as i32;
        let mut live = Vec::new();
        for k in first..=last {
            let hk = |n: i32| hash2(k.wrapping_add(off), 900 + n);
            if hk(0) > 0.55 {
                continue;
            }
            let kind = match (hk(1) * 4.0) as i32 {
                0 => FgKind::Fang,
                1 => FgKind::Roots,
                2 => FgKind::Lump,
                _ => FgKind::Fronds,
            };
            let wx = (k as f32 + 0.2 + 0.6 * hk(2)) * FG_SPACING;
            let sx = (wx - c.x) * FG_SPEED / u + w * 0.5;
            if sx < -450.0 || sx > w + 450.0 {
                continue;
            }
            live.push(k);
            // Vertical: anchored to where the camera was when the piece
            // came into view; camera climbs move it fast too, but it may
            // only intrude a little toward the play line.
            let y0 = *fg.seen.entry(k).or_insert(c.y);
            let dy = ((y0 - c.y) * FG_SPEED / u).clamp(-260.0, 260.0);
            let top = matches!(kind, FgKind::Fang | FgKind::Roots);
            let dy = if top { dy.max(-50.0) } else { dy.min(50.0) };
            let seed = k.wrapping_add(off);
            match kind {
                FgKind::Fang => {
                    let len = 120.0 + 110.0 * hk(3);
                    let hw = 55.0 + 45.0 * hk(4);
                    let s = spike_shape(hw, (hk(5) - 0.5) * hw, (seed.rem_euclid(9973)) as f32 * 3.7 + 0.5);
                    fg_shape(&mut buf, &s, |p| to(sx + p.x, -40.0 - dy + p.y * (len + 40.0)), body, rim, u);
                }
                FgKind::Roots => roots(&mut buf, |x, y| to(x, y - dy), sx, seed, t, body, rim, theme.crystal, u),
                FgKind::Lump => {
                    let len = 70.0 + 80.0 * hk(3);
                    let hw = 90.0 + 70.0 * hk(4);
                    let s = spike_shape(hw, (hk(5) - 0.5) * hw * 0.6, (seed.rem_euclid(9973)) as f32 * 5.3 + 2.0);
                    fg_shape(&mut buf, &s, |p| to(sx + p.x, h + 40.0 - dy - p.y * (len + 40.0)), body, rim, u);
                }
                FgKind::Fronds => fronds(&mut buf, |x, y| to(x, y - dy), sx, h, seed, t, body, rim, theme.mush, u),
            }
        }
        fg.seen.retain(|k, _| live.contains(k));
        // A few drifting spores, close to the lens: same fast parallax in
        // both axes, wrapping the view, kept out of the middle band.
        for k in 0..10 {
            let hs = |n: i32| hash2(k, 1200 + n);
            let wx = w + 200.0;
            let wy = h + 200.0;
            let x = (hs(0) * wx - c.x / u * FG_SPEED + t * (6.0 + 10.0 * hs(2)) + (t * 0.4 + k as f32).sin() * 20.0).rem_euclid(wx) - 100.0;
            let y = (hs(1) * wy + c.y / u * FG_SPEED - t * (4.0 + 6.0 * hs(3))).rem_euclid(wy) - 100.0;
            let mid = 1.0 - (-(((y / h) - 0.5) / 0.22).powi(2)).exp() * 0.8;
            let col = if k % 3 == 0 { theme.crystal } else { theme.mush };
            let r = (5.0 + 9.0 * hs(4)) * u;
            let a = (0.09 + 0.07 * (t * 1.1 + k as f32).sin()) * mid;
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
    let rim_out: Vec<[f32; 4]> = (0..n).map(|_| la(rim, 0.75)).collect();
    buf.band(&outline, &nrms, 5.0 * u, 0.0, 0.0006, &rim_in, &rim_out);
    // …and a wide feather outside it: out of focus, close to the lens.
    let inner: Vec<[f32; 4]> = (0..n).map(|_| la(body, 0.85)).collect();
    let outer: Vec<[f32; 4]> = (0..n).map(|_| la(body, 0.0)).collect();
    buf.band(&outline, &nrms, 0.0, -22.0 * u, 0.0005, &inner, &outer);
}

/// Hanging roots from the top edge, swaying slowly, with tiny glowing
/// beads at their tips.
#[allow(clippy::too_many_arguments)]
fn roots(buf: &mut MeshBuf, to: impl Fn(f32, f32) -> PVec2, cx: f32, col: i32, t: f32, body: Color, rim: Color, glow: Color, u: f32) {
    // Every strand of a bundle grows from the same point and fans out.
    let n = 2 + (hash2(col, 950) * 3.0) as i32;
    for k in 0..n {
        let spread = if n > 1 { k as f32 / (n - 1) as f32 * 2.0 - 1.0 } else { 0.0 };
        let fan = spread * 45.0 + (hash2(col * 7 + k, 951) - 0.5) * 20.0;
        let len = 90.0 + 150.0 * hash2(col * 5 + k, 952);
        let ph = hash2(col, 953 + k) * 6.0;
        const N: usize = 16;
        let pts: Vec<PVec2> = (0..=N)
            .map(|i| {
                let s = i as f32 / N as f32;
                let sway = (t * 0.7 + ph).sin() * 10.0 * s * s + (s * 5.0 + ph).sin() * 6.0 * s;
                // Splay out near the root, then hang straight.
                let out = fan * (1.0 - (1.0 - s) * (1.0 - s));
                to(cx + out + sway, -10.0 + s * len)
            })
            .collect();
        let wd = (9.0 + 9.0 * hash2(col + k, 954)) * u;
        let pts_w: Vec<f32> = (0..=N).map(|i| wd * (1.0 - 0.75 * i as f32 / N as f32)).collect();
        // Soft out-of-focus edge, then the root itself, rounded at the tip.
        taper(buf, &pts, &pts_w, -0.0002, la(body, 0.25), 10.0 * u);
        taper(buf, &pts, &pts_w, 0.0, la(body, 0.92), 0.0);
        rim_line(buf, &pts, &pts_w, rim);
        let tip = pts[N];
        buf.halo(tip, PVec2::splat(22.0 * u), 0.001, la(glow, 0.15));
        buf.ellipse(tip, PVec2::splat(3.2 * u), 0.0, 0.0012, la(lighten(glow, 0.5), 0.65));
    }
}

/// A tuft of out-of-focus cave fronds rising from the bottom edge: long
/// curved blades (smooth tapered strokes), each with a dim bead of light at
/// its tip. Close to the lens, so dark and soft.
#[allow(clippy::too_many_arguments)]
fn fronds(buf: &mut MeshBuf, to: impl Fn(f32, f32) -> PVec2, cx: f32, h: f32, seed: i32, t: f32, body: Color, rim: Color, glow: Color, u: f32) {
    let n = 3 + (hash2(seed, 960) * 4.0) as i32;
    for k in 0..n {
        let hk = |m: i32| hash2(seed * 7 + k, 961 + m);
        let spread = if n > 1 { k as f32 / (n - 1) as f32 * 2.0 - 1.0 } else { 0.0 };
        let tall = 130.0 + 120.0 * hk(0) * (1.0 - 0.4 * spread.abs());
        let bend = spread * 70.0 + (hk(1) - 0.5) * 40.0 + (t * 0.6 + hk(2) * 6.0).sin() * 6.0;
        const N: usize = 14;
        let pts: Vec<PVec2> = (0..=N)
            .map(|i| {
                let s = i as f32 / N as f32;
                to(cx + spread * 30.0 + bend * s * s, h + 30.0 - s * tall)
            })
            .collect();
        let wd = (20.0 + 12.0 * hk(3)) * u;
        let widths: Vec<f32> = (0..=N).map(|i| wd * (1.0 - i as f32 / N as f32).powf(0.8).max(0.08)).collect();
        taper(buf, &pts, &widths, -0.0002, la(body, 0.3), 10.0 * u);
        taper(buf, &pts, &widths, 0.0, la(body, 0.94), 0.0);
        rim_line(buf, &pts, &widths, rim);
        let tip = pts[N];
        buf.halo(tip, PVec2::splat(26.0 * u), 0.001, la(glow, 0.12));
        buf.ellipse(tip, PVec2::splat(3.4 * u), 0.0, 0.0012, la(mix(Color::BLACK, glow, 0.6), 0.7));
    }
}

/// A thin line of cave light along one flank of a tapered stroke.
fn rim_line(buf: &mut MeshBuf, pts: &[PVec2], widths: &[f32], rim: Color) {
    let n = pts.len();
    let side: Vec<PVec2> = (0..n)
        .map(|i| {
            let d = pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)];
            let nr = PVec2::new(-d.y, d.x).normalize_or_zero();
            let nr = if nr.x > 0.0 { -nr } else { nr };
            pts[i] + nr * widths[i] * 0.38
        })
        .collect();
    let cols: Vec<[f32; 4]> = (0..n).map(|i| la(rim, 0.7 * (1.0 - i as f32 / n as f32 * 0.6))).collect();
    buf.stroke_cols(&side, widths[0] * 0.12 + 1.0, 0.0003, &cols);
}

/// A smooth tapered stroke (one strip, per-point widths, rounded tip).
fn taper(buf: &mut MeshBuf, pts: &[PVec2], widths: &[f32], zz: f32, col: [f32; 4], extra: f32) {
    let n = pts.len();
    if n < 2 {
        return;
    }
    let base = buf.pos.len() as u32;
    for i in 0..n {
        let d = pts[(i + 1).min(n - 1)] - pts[i.saturating_sub(1)];
        let nr = PVec2::new(-d.y, d.x).normalize_or_zero() * (widths[i] + extra) * 0.5;
        buf.vert(pts[i] + nr, zz, col);
        buf.vert(pts[i] - nr, zz, col);
    }
    for i in 0..(n - 1) as u32 {
        let (a, b, c, d) = (base + i * 2, base + i * 2 + 1, base + i * 2 + 2, base + i * 2 + 3);
        buf.tri(a, b, d);
        buf.tri(a, d, c);
    }
    buf.ellipse(pts[n - 1], PVec2::splat((widths[n - 1] + extra) * 0.5), 0.0, zz, col);
}
