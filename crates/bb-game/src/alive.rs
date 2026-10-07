//! The living cave. At rest everything is calm and dark; blobs wake it up.
//! Where a blob goes it leaves motion, particles and light that slowly
//! settle back to a dark, steady state:
//!
//! * **Hangers** — roots, glow-worm silk and jelly drips under every
//!   ceiling swing when a blob brushes past (a little of its velocity
//!   transfers into a damped pendulum) and their beads light up.
//! * **Fronds** — tufts of luminous cave-grass along floors bend away from
//!   a passing blob and glow in its wake.
//! * **Veins** — mineral veins inside walls and ceilings brighten as a
//!   blob passes close.
//! * **Wake** — a trail of faint glowing wisps behind moving blobs, and
//!   pools of light on the stone wherever they touch it.
//!
//! Hard landings send a shockwave: hangers shake, fronds flatten and veins
//! flare in a radius. Everything decays over a few seconds.
//!
//! All of it is render-side and procedural (seeded from the level), culled
//! to the camera, and drawn into four shared meshes rebuilt each frame.

use std::collections::HashMap;

use bb_physics::{BodyId, Collider, Vec2 as PVec2, geom};
use bevy::prelude::*;

use crate::crag::hash1;
use crate::level_view::{LevelEntity, near_checkpoint};
use crate::palette::{self, ThemeColors, hex, lighten, mix};
use crate::render::{MeshBuf, Shared, ccw, empty_mesh, la, z};
use crate::sim::{Game, SimMsg};

pub struct AlivePlugin;

impl Plugin for AlivePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Alive>()
            .add_systems(PostUpdate, setup.run_if(resource_added::<Game>))
            .add_systems(PostUpdate, update.after(setup).run_if(resource_exists::<Game>))
            .add_systems(PostUpdate, clear.run_if(resource_removed::<Game>));
    }
}

/// Glow time constant (s): how slowly light fades back to dark.
const FADE: f32 = 2.6;
/// How near (px, past the blob's radius) things notice a blob.
const SENSE: f32 = 150.0;

/// Decor kinds that become reactive hangers instead of baked decor.
pub fn is_hanger(kind: &str) -> bool {
    matches!(kind, "glowworm" | "drip")
}

#[derive(Clone, Copy, PartialEq)]
enum HangKind {
    /// A dark root with glowing nodes.
    Root,
    /// Glow-worm silk with a bright larva at the end.
    Thread,
    /// A jelly drip: short, stiff, a fat bead at the tip.
    Drip,
}

struct Hanger {
    root: PVec2,
    len: f32,
    kind: HangKind,
    ang: f32,
    vel: f32,
    glow: f32,
    phase: f32,
    col: Color,
    w: f32,
    cool: f32,
    t: f32,
}

struct Frond {
    base: PVec2,
    /// Surface tangent and normal.
    tan: PVec2,
    nrm: PVec2,
    blades: u8,
    height: f32,
    width: f32,
    bend: f32,
    bend_v: f32,
    glow: f32,
    phase: f32,
    col: Color,
    t: f32,
}

struct Vein {
    pts: Vec<PVec2>,
    centre: PVec2,
    glow: f32,
    col: Color,
    t: f32,
}

struct Wisp {
    p: PVec2,
    v: PVec2,
    age: f32,
    life: f32,
    r: f32,
    col: Color,
}

struct Mark {
    p: PVec2,
    age: f32,
    strength: f32,
    col: Color,
}

#[derive(Resource, Default)]
pub struct Alive {
    hangers: Vec<Hanger>,
    fronds: Vec<Frond>,
    veins: Vec<Vein>,
    wisps: Vec<Wisp>,
    marks: Vec<Mark>,
    last_wisp: HashMap<BodyId, PVec2>,
    last_mark: HashMap<BodyId, PVec2>,
    meshes: Vec<Handle<Mesh>>,
    theme: Option<ThemeColors>,
    n: u32,
}

impl Alive {
    fn rnd(&mut self, k: i32) -> f32 {
        self.n = self.n.wrapping_add(1);
        hash1(self.n as i32, k as u32 ^ 0xa11e)
    }
}

// ------------------------------------------------------------------ setup

fn setup(mut commands: Commands, game: Res<Game>, shared: Res<Shared>, mut meshes: ResMut<Assets<Mesh>>, mut alive: ResMut<Alive>) {
    *alive = Alive::default();
    let level = &game.sim.level;
    let theme = palette::theme(level.theme);
    alive.theme = Some(theme);
    if !theme.dark {
        return;
    }
    let seed = level.id.bytes().fold(0x51ed_270bu32, |h, b| h.rotate_left(5) ^ b as u32);
    let solids: Vec<Vec<PVec2>> = level.terrain.iter().filter(|t| !t.one_way).map(|t| ccw(t.shape.outline())).collect();
    let boxes: Vec<bb_physics::Aabb> = solids.iter().map(|o| bb_physics::Aabb::from_points(o.iter().copied())).collect();
    let solid_at = |p: PVec2| solids.iter().zip(&boxes).any(|(o, b)| b.contains(p) && geom::point_in_polygon(p, o));
    let jelly_boxes: Vec<(PVec2, PVec2)> = level.jelly.iter().map(|j| j.shape.bounds()).collect();
    let under_jelly = |p: PVec2| jelly_boxes.iter().any(|(a, b)| p.x > a.x - 4.0 && p.x < b.x + 4.0 && p.y > a.y - 4.0 && p.y < b.y + 30.0);
    let colour = |h: f32| match (h * 3.0) as u32 {
        0 => theme.crystal,
        1 => theme.mush,
        _ => mix(theme.jelly, theme.crystal, 0.4),
    };
    let mut hangers = Vec::new();
    let mut fronds = Vec::new();
    let mut veins = Vec::new();

    // Level decor that hangs.
    for (i, d) in level.decor.iter().enumerate() {
        if !is_hanger(&d.kind) || near_checkpoint(level, d.pos) {
            continue;
        }
        let i = i as i32;
        let (kind, root, len) = match d.kind.as_str() {
            "glowworm" => (HangKind::Thread, d.pos + PVec2::new(18.0 * d.scale, 70.0 * d.scale), 70.0 * d.scale),
            _ => (HangKind::Drip, d.pos + PVec2::new(0.0, 6.0), 66.0 * d.scale),
        };
        hangers.push(hanger(kind, root, len, theme.crystal, hash1(i, seed)));
    }

    for (si, o) in solids.iter().enumerate() {
        let n = o.len();
        for e in 0..n {
            let (a, b) = (o[e], o[(e + 1) % n]);
            let d = b - a;
            let len = d.length();
            if len < 30.0 {
                continue;
            }
            let nrm = PVec2::new(d.y, -d.x) / len;
            let tan = d / len;
            let key = |k: i32| hash1(si as i32 * 7919 + e as i32 * 131 + k, seed);
            if nrm.y < -0.45 {
                // Ceiling (or a steep overhang): hangers.
                let mut s = 20.0 + key(1) * 80.0;
                let mut k = 0;
                while s < len - 15.0 {
                    k += 1;
                    let h = |m: i32| key(1000 + k * 17 + m);
                    let p = a + tan * s;
                    s += 60.0 + 140.0 * h(0);
                    if h(1) > 0.62 || near_checkpoint(level, p) {
                        continue;
                    }
                    // Keep clear of the floor below.
                    let mut gap = 0.0;
                    while gap < 400.0 && !solid_at(p - PVec2::new(0.0, gap + 20.0)) {
                        gap += 20.0;
                    }
                    if gap < 130.0 {
                        continue;
                    }
                    let r = h(2);
                    let kind = if r < 0.5 { HangKind::Root } else if r < 0.82 { HangKind::Thread } else { HangKind::Drip };
                    let want = match kind {
                        HangKind::Root => 50.0 + 130.0 * h(3),
                        HangKind::Thread => 40.0 + 110.0 * h(3),
                        HangKind::Drip => 24.0 + 30.0 * h(3),
                    };
                    let l = want.min((gap - 80.0) * 0.6);
                    if l < 20.0 {
                        continue;
                    }
                    // Root a little into the rock so the crag edge hides it.
                    hangers.push(hanger(kind, p + PVec2::new(0.0, 26.0), l + 26.0, colour(h(4)), h(5)));
                }
            } else if nrm.y > 0.6 {
                // Floor: fronds (behind the jelly lip, or on bare rock).
                let mut s = 10.0 + key(2) * 40.0;
                let mut k = 0;
                while s < len - 8.0 {
                    k += 1;
                    let h = |m: i32| key(5000 + k * 23 + m);
                    let p = a + tan * s;
                    s += 40.0 + 90.0 * h(0);
                    if h(1) > 0.5 || near_checkpoint(level, p) {
                        continue;
                    }
                    let on_jelly = under_jelly(p + PVec2::new(0.0, 8.0));
                    // Under a jelly skin, sprout from its top instead.
                    let base = if on_jelly {
                        let top = jelly_boxes
                            .iter()
                            .filter(|(lo, hi)| p.x > lo.x && p.x < hi.x && hi.y > p.y - 4.0 && lo.y < p.y + 60.0)
                            .map(|(_, hi)| hi.y)
                            .fold(f32::MIN, f32::max);
                        if top == f32::MIN {
                            continue;
                        }
                        PVec2::new(p.x, top - 7.0)
                    } else {
                        p
                    };
                    fronds.push(Frond {
                        base,
                        tan: -tan,
                        nrm,
                        blades: 2 + (h(2) * 4.0) as u8,
                        height: 16.0 + 26.0 * h(3) + if on_jelly { 6.0 } else { 0.0 },
                        width: 10.0 + 22.0 * h(4),
                        bend: 0.0,
                        bend_v: 0.0,
                        glow: 0.0,
                        phase: h(5) * 6.28,
                        col: colour(h(6)),
                        t: 0.0,
                    });
                }
            } else if nrm.y < 0.3 {
                // Walls: veins inside the rock.
                let mut s = 40.0 + key(3) * 120.0;
                let mut k = 0;
                while s < len - 30.0 {
                    k += 1;
                    let h = |m: i32| key(9000 + k * 29 + m);
                    let p = a + tan * s - nrm * (26.0 + 30.0 * h(0));
                    s += 160.0 + 220.0 * h(1);
                    if h(2) > 0.55 || !solid_at(p) || near_checkpoint(level, p) {
                        continue;
                    }
                    let pts = vein_path(p, -nrm, &solid_at, &|m| h(100 + m));
                    if pts.len() < 3 {
                        continue;
                    }
                    let centre = pts.iter().copied().fold(PVec2::ZERO, |a, b| a + b) / pts.len() as f32;
                    veins.push(Vein { pts, centre, glow: 0.0, col: colour(h(3)), t: 0.0 });
                }
            }
        }
    }
    hangers.sort_by(|a, b| a.root.x.total_cmp(&b.root.x));
    fronds.sort_by(|a, b| a.base.x.total_cmp(&b.base.x));
    veins.sort_by(|a, b| a.centre.x.total_cmp(&b.centre.x));
    alive.hangers = hangers;
    alive.fronds = fronds;
    alive.veins = veins;

    // Back (hangers, behind the rock), surface (veins + light pools on the
    // stone), fronds (behind the jelly), wake (wisps behind the blobs).
    for zz in [z::TERRAIN - 0.3, z::SPILL + 0.04, z::JELLY - 0.05, z::PROP - 0.1] {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, zz), AliveMesh, LevelEntity));
        alive.meshes.push(h);
    }
}

#[derive(Component)]
struct AliveMesh;

fn hanger(kind: HangKind, root: PVec2, len: f32, col: Color, h: f32) -> Hanger {
    Hanger {
        root,
        len,
        kind,
        ang: 0.0,
        vel: 0.0,
        glow: 0.0,
        phase: h * 40.0,
        col,
        w: match kind {
            HangKind::Root => 5.0 + 4.0 * h,
            HangKind::Thread => 1.2,
            HangKind::Drip => 7.0 + 3.0 * h,
        },
        cool: 0.0,
        t: 0.0,
    }
}

/// A short branching mineral vein heading into the rock.
fn vein_path(start: PVec2, inward: PVec2, solid: &dyn Fn(PVec2) -> bool, h: &dyn Fn(i32) -> f32) -> Vec<PVec2> {
    let mut dir = inward.rotate(PVec2::from_angle((h(0) - 0.5) * 2.2));
    let mut p = start;
    let mut pts = vec![p];
    for k in 0..(5 + (h(1) * 6.0) as i32) {
        let q = p + dir * (18.0 + 18.0 * h(10 + k));
        if !solid(q) {
            break;
        }
        pts.push(q);
        p = q;
        dir = dir.rotate(PVec2::from_angle((h(30 + k) - 0.5) * 1.2));
    }
    pts
}

fn clear(mut alive: ResMut<Alive>) {
    *alive = Alive::default();
}

// ----------------------------------------------------------------- update

struct Actor {
    id: BodyId,
    p: PVec2,
    v: PVec2,
    r: f32,
    col: Color,
}

#[allow(clippy::too_many_arguments)]
fn update(
    game: Res<Game>,
    time: Res<Time>,
    mut msgs: MessageReader<SimMsg>,
    mut alive: ResMut<Alive>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut spores: ResMut<crate::cave::Spores>,
    cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>,
) {
    let Some(theme) = alive.theme else { return };
    if !theme.dark || alive.meshes.len() < 4 {
        msgs.clear();
        return;
    }
    let dt = time.delta_secs().min(0.05);
    let t = time.elapsed_secs();
    let sim = &game.sim;
    let actors: Vec<Actor> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| (p.ctl.body, p.ctl.radius, p.color))
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (n.ctl.body, n.ctl.radius, n.color)))
        .filter_map(|(id, r, c)| sim.world.body(id).map(|b| Actor { id, p: b.centroid(), v: b.velocity(), r, col: hex(c) }))
        .collect();
    // Hard landings: a shockwave through everything nearby.
    let mut shocks: Vec<(PVec2, f32)> = Vec::new();
    for m in msgs.read() {
        if let bb_sim::SimEvent::Impact { body, pos, speed } = m.0 {
            if speed > 330.0 && actors.iter().any(|a| a.id == body) {
                shocks.push((pos, ((speed - 250.0) / 700.0).clamp(0.15, 1.0)));
            }
        }
    }

    // View rect for culling.
    let (vlo, vhi) = match cam.single() {
        Ok((tf, Projection::Orthographic(o))) => {
            let c = PVec2::new(tf.translation.x, tf.translation.y);
            (c + PVec2::new(o.area.min.x, o.area.min.y) - PVec2::splat(300.0), c + PVec2::new(o.area.max.x, o.area.max.y) + PVec2::splat(300.0))
        }
        _ => return,
    };
    let in_view = |p: PVec2| p.x > vlo.x && p.x < vhi.x && p.y > vlo.y && p.y < vhi.y;
    let range = |xs: &dyn Fn(usize) -> f32, n: usize| -> (usize, usize) {
        let lo = partition(n, |i| xs(i) < vlo.x - 200.0);
        let hi = partition(n, |i| xs(i) < vhi.x + 200.0);
        (lo, hi)
    };

    let mut back = MeshBuf::default();
    let mut surface = MeshBuf::default();
    let mut grass = MeshBuf::default();
    let mut wake = MeshBuf::default();
    let fade = |g: f32, el: f32| g * (-el / FADE).exp();
    let rise = |g: f32, target: f32| if target > g { g + (target - g) * (1.0 - (-7.0 * dt).exp()) } else { g };

    // -------------------------------------------------------- hangers
    let alive_ref = &mut *alive;
    let (lo, hi) = {
        let hs = &alive_ref.hangers;
        range(&|i| hs[i].root.x, hs.len())
    };
    let mut puffs: Vec<(PVec2, Color)> = Vec::new();
    for hgr in alive_ref.hangers[lo..hi].iter_mut() {
        if !in_view(hgr.root) {
            continue;
        }
        let el = (t - hgr.t).clamp(0.0, 10.0);
        hgr.t = t;
        if el > 0.5 {
            hgr.vel = 0.0;
            hgr.ang = 0.0;
        }
        hgr.glow = fade(hgr.glow, el.min(1.0));
        let tip = hgr.root + PVec2::new(hgr.ang.sin(), -hgr.ang.cos()) * hgr.len;
        let mut target: f32 = 0.0;
        let mut touched = false;
        for a in &actors {
            let (q, _) = geom::closest_on_segment(a.p, hgr.root, tip);
            let d = (a.p.distance(q) - a.r).max(0.0);
            target = target.max(1.0 - (d / SENSE).clamp(0.0, 1.0));
            if d < 14.0 {
                // Drag along with the blob: transfer some of its velocity.
                let along = ((q - hgr.root).length() / hgr.len).clamp(0.25, 1.0);
                let want = a.v.x / (hgr.len * along) * 0.6;
                hgr.vel += (want - hgr.vel) * (1.0 - (-6.0 * dt).exp());
                touched = true;
            } else if d < 70.0 {
                // A breeze from a blob rushing past.
                hgr.vel += a.v.x / hgr.len * 0.25 * (1.0 - d / 70.0) * dt * 3.0;
            }
        }
        for (sp, s) in &shocks {
            let d = sp.distance(hgr.root);
            if d < 520.0 {
                let k = s * (1.0 - d / 520.0);
                let sign = if hash1((hgr.phase * 100.0) as i32, (t * 10.0) as u32) > 0.5 { 1.0 } else { -1.0 };
                hgr.vel += sign * k * 3.5 * (60.0 / hgr.len).sqrt();
                target = target.max(0.9 * k);
            }
        }
        hgr.cool = (hgr.cool - dt).max(0.0);
        if touched {
            target = 1.3;
            if hgr.cool <= 0.0 && hgr.kind != HangKind::Drip {
                hgr.cool = 1.2;
                puffs.push((tip, hgr.col));
            }
        }
        hgr.glow = rise(hgr.glow, target);
        // Damped pendulum.
        let stiff = match hgr.kind {
            HangKind::Drip => 4.0,
            _ => 1.0,
        } * 2200.0
            / hgr.len.max(20.0);
        let acc = -stiff * hgr.ang - 1.1 * hgr.vel;
        hgr.vel += acc * dt;
        hgr.ang = (hgr.ang + hgr.vel * dt).clamp(-1.2, 1.2);
        draw_hanger(&mut back, hgr, t);
    }

    // --------------------------------------------------------- fronds
    let (lo, hi) = {
        let fs = &alive_ref.fronds;
        range(&|i| fs[i].base.x, fs.len())
    };
    for f in alive_ref.fronds[lo..hi].iter_mut() {
        if !in_view(f.base) {
            continue;
        }
        let el = (t - f.t).clamp(0.0, 10.0);
        f.t = t;
        if el > 0.5 {
            f.bend = 0.0;
            f.bend_v = 0.0;
        }
        f.glow = fade(f.glow, el.min(1.0));
        let mut target: f32 = 0.0;
        let mut push = 0.0;
        let top = f.base + f.nrm * f.height * 0.6;
        for a in &actors {
            let d = (a.p.distance(top) - a.r).max(0.0);
            target = target.max((1.0 - (d / (SENSE * 0.8)).clamp(0.0, 1.0)).powf(1.5));
            if d < 30.0 {
                let away = (top - a.p).dot(f.tan).signum();
                let k = 1.0 - d / 30.0;
                // Pressed flat away from the blob, and swept by its motion.
                push += (away * 0.9 + a.v.dot(f.tan) / 500.0) * k;
                target = target.max(1.2);
            }
        }
        for (sp, s) in &shocks {
            let d = sp.distance(f.base);
            if d < 420.0 {
                let k = s * (1.0 - d / 420.0);
                f.bend_v += (f.base - *sp).dot(f.tan).signum() * k * 9.0;
                target = target.max(k);
            }
        }
        f.glow = rise(f.glow, target);
        let acc = -110.0 * f.bend - 5.0 * f.bend_v + push * 160.0;
        f.bend_v += acc * dt;
        f.bend = (f.bend + f.bend_v * dt).clamp(-1.1, 1.1);
        draw_frond(&mut grass, f, t);
    }

    // ---------------------------------------------------------- veins
    let (lo, hi) = {
        let vs = &alive_ref.veins;
        range(&|i| vs[i].centre.x, vs.len())
    };
    for v in alive_ref.veins[lo..hi].iter_mut() {
        if !in_view(v.centre) {
            continue;
        }
        let el = (t - v.t).clamp(0.0, 10.0);
        v.t = t;
        v.glow = fade(v.glow, el.min(1.0));
        let mut target: f32 = 0.0;
        for a in &actors {
            let d = v.pts.iter().map(|p| p.distance(a.p)).fold(f32::MAX, f32::min) - a.r;
            target = target.max((1.0 - (d.max(0.0) / (SENSE * 1.3)).clamp(0.0, 1.0)).powf(1.3) * 1.1);
        }
        for (sp, s) in &shocks {
            let d = sp.distance(v.centre);
            if d < 500.0 {
                target = target.max(s * (1.0 - d / 500.0) * 1.2);
            }
        }
        v.glow = rise(v.glow, target);
        draw_vein(&mut surface, v, t);
    }

    // ----------------------------------------------- wake: wisps + pools
    for a in &actors {
        let speed = a.v.length();
        if speed > 70.0 {
            let far = alive_ref.last_wisp.get(&a.id).is_none_or(|q| q.distance(a.p) > 16.0);
            if far {
                alive_ref.last_wisp.insert(a.id, a.p);
                let back_dir = -a.v / speed;
                let j = PVec2::new(alive_ref.rnd(1) - 0.5, alive_ref.rnd(2) - 0.5);
                let col = mix(lighten(a.col, 0.35), theme.crystal, 0.45);
                let life = 1.6 + alive_ref.rnd(3) * 1.4;
                let r = 2.0 + alive_ref.rnd(4) * 3.0;
                alive_ref.wisps.push(Wisp {
                    p: a.p + back_dir * a.r * 0.6 + j * a.r * 1.2,
                    v: back_dir * 30.0 + PVec2::new(j.x * 30.0, 14.0 + j.y * 20.0),
                    age: 0.0,
                    life,
                    r,
                    col,
                });
            }
        }
        // Light pools where the blob touches stone.
        let touch = sim.world.contacts_of(a.id).find(|c| matches!(c.other, Collider::Static(_))).map(|c| c.point);
        if let Some(p) = touch {
            let far = alive_ref.last_mark.get(&a.id).is_none_or(|q| q.distance(p) > 26.0);
            if far {
                alive_ref.last_mark.insert(a.id, p);
                let strength = (0.35 + speed / 900.0).min(1.0);
                alive_ref.marks.push(Mark { p, age: 0.0, strength, col: mix(theme.crystal, a.col, 0.25) });
            }
        }
    }
    for (sp, s) in &shocks {
        alive_ref.marks.push(Mark { p: *sp, age: 0.0, strength: 0.6 + s, col: lighten(theme.crystal, 0.2) });
    }
    for w in alive_ref.wisps.iter_mut() {
        w.age += dt;
        w.v *= (-1.2 * dt).exp();
        w.v.y += 10.0 * dt;
        w.v.x += (t * 1.7 + w.r * 9.0).sin() * 14.0 * dt;
        w.p += w.v * dt;
    }
    alive_ref.wisps.retain(|w| w.age < w.life);
    if alive_ref.wisps.len() > 500 {
        let extra = alive_ref.wisps.len() - 500;
        alive_ref.wisps.drain(0..extra);
    }
    for m in alive_ref.marks.iter_mut() {
        m.age += dt;
    }
    alive_ref.marks.retain(|m| m.age < FADE * 1.6);
    if alive_ref.marks.len() > 300 {
        let extra = alive_ref.marks.len() - 300;
        alive_ref.marks.drain(0..extra);
    }
    for w in &alive_ref.wisps {
        if !in_view(w.p) {
            continue;
        }
        let k = (w.age / 0.2).min(1.0) * (1.0 - w.age / w.life).clamp(0.0, 1.0).powf(1.4);
        soft_dot(&mut wake, w.p, w.r * 4.0, 0.0, la(w.col, 0.22 * k));
        wake.ellipse(w.p, PVec2::splat(w.r * 0.55), 0.0, 0.001, la(lighten(w.col, 0.6), 0.75 * k));
    }
    for m in &alive_ref.marks {
        if !in_view(m.p) {
            continue;
        }
        let k = (m.age / 0.15).min(1.0) * (-m.age / (FADE * 0.5)).exp() * m.strength;
        surface.halo(m.p, PVec2::new(90.0, 60.0), -0.001, la(m.col, 0.13 * k));
    }
    for (p, c) in puffs {
        spores.puff(p, 18.0, c, 4);
    }

    for (h, buf) in alive_ref.meshes.clone().iter().zip([back, surface, grass, wake]) {
        if let Some(mut m) = meshes.get_mut(h) {
            buf.write(&mut m);
        }
    }
}

/// First index in 0..n where `pred` is false (pred must be monotone).
fn partition(n: usize, pred: impl Fn(usize) -> bool) -> usize {
    let (mut lo, mut hi) = (0, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if pred(mid) { lo = mid + 1 } else { hi = mid }
    }
    lo
}

/// A cheap soft glow: a fan from `col` at the centre to transparent.
fn soft_dot(buf: &mut MeshBuf, c: PVec2, r: f32, zz: f32, col: [f32; 4]) {
    let pts: Vec<PVec2> = (0..12).map(|i| c + PVec2::from_angle(i as f32 / 12.0 * std::f32::consts::TAU) * r).collect();
    buf.fan(&pts, c, zz, col, [col[0], col[1], col[2], 0.0]);
}

// ------------------------------------------------------------- drawing

fn draw_hanger(buf: &mut MeshBuf, h: &Hanger, t: f32) {
    let g = h.glow.clamp(0.0, 1.5);
    const N: usize = 9;
    // Idle: the faintest drift. Swing: the angle bends in more toward the
    // tip (a whip, not a stick).
    let idle = (t * 0.5 + h.phase).sin() * 0.03;
    let mut pts = Vec::with_capacity(N + 1);
    let mut p = h.root;
    pts.push(p);
    for i in 1..=N {
        let u = i as f32 / N as f32;
        let a = (h.ang + idle) * (0.55 + 0.9 * u) + (u * 5.0 + h.phase + t * 0.7).sin() * 0.04 * if h.kind == HangKind::Root { 1.0 } else { 0.0 };
        p += PVec2::new(a.sin(), -a.cos()) * h.len / N as f32;
        pts.push(p);
    }
    let tip = pts[N];
    match h.kind {
        HangKind::Root => {
            let body = mix(Color::BLACK, mix(h.col, Color::WHITE, 0.1), 0.1 + 0.18 * g);
            for i in 0..N {
                let w = h.w * (1.0 - 0.7 * i as f32 / N as f32);
                buf.stroke(&[pts[i], pts[i + 1]], w, 0.0, la(body, 1.0));
            }
            // A glowing rim along one side and nodes that wake up.
            buf.stroke(&pts[2..], 1.4, 0.0005, la(lighten(h.col, 0.2), 0.12 + 0.55 * g));
            for (k, q) in pts.iter().enumerate().skip(3).step_by(3) {
                let a = 0.18 + 0.7 * g;
                soft_dot(buf, *q, 7.0 + 8.0 * g, 0.001, la(h.col, 0.25 * a));
                buf.ellipse(*q, PVec2::splat(1.8 + 0.6 * (k % 2) as f32), 0.0, 0.0012, la(lighten(h.col, 0.5), a));
            }
            soft_dot(buf, tip, 10.0 + 14.0 * g, 0.001, la(h.col, 0.12 + 0.35 * g));
            buf.ellipse(tip, PVec2::splat(2.4), 0.0, 0.0012, la(lighten(h.col, 0.6), 0.3 + 0.7 * g.min(1.0)));
        }
        HangKind::Thread => {
            buf.stroke(&pts, 1.2, 0.0, la(lighten(h.col, 0.3), 0.14 + 0.4 * g));
            for q in pts.iter().skip(4).step_by(2) {
                buf.ellipse(*q, PVec2::splat(1.5), 0.0, 0.0005, la(lighten(h.col, 0.5), 0.2 + 0.6 * g));
            }
            soft_dot(buf, tip, 14.0 + 22.0 * g, 0.001, la(h.col, 0.18 + 0.4 * g));
            let breathe = 0.5 + 0.5 * (t * 1.2 + h.phase).sin();
            buf.ellipse(tip, PVec2::new(3.0, 4.2), 0.0, 0.0012, la(lighten(h.col, 0.65), 0.45 + 0.15 * breathe + 0.4 * g));
        }
        HangKind::Drip => {
            let jelly = mix(Color::BLACK, h.col, 0.35 + 0.35 * g);
            let n = pts.len();
            let ws: Vec<f32> = (0..n).map(|i| h.w * (1.0 - 0.55 * i as f32 / (n - 1) as f32)).collect();
            for i in 0..n - 1 {
                buf.stroke(&[pts[i], pts[i + 1]], ws[i], 0.0, la(jelly, 0.95));
            }
            soft_dot(buf, tip, 16.0 + 20.0 * g, 0.001, la(h.col, 0.15 + 0.4 * g));
            buf.ellipse(tip - PVec2::new(0.0, 3.0), PVec2::new(h.w * 0.75, h.w), 0.0, 0.0012, la(lighten(h.col, 0.25 + 0.3 * g), 0.95));
            buf.ellipse(tip + PVec2::new(-1.5, -1.0), PVec2::new(1.4, 2.0), 0.0, 0.0014, la(Color::WHITE, 0.4 + 0.4 * g));
        }
    }
}

fn draw_frond(buf: &mut MeshBuf, f: &Frond, t: f32) {
    let g = f.glow.clamp(0.0, 1.5);
    let idle = (t * 0.8 + f.phase).sin() * 0.05;
    for k in 0..f.blades {
        let hk = hash1(k as i32, (f.phase * 1000.0) as u32);
        let x = (k as f32 / (f.blades.max(2) - 1) as f32 - 0.5) * f.width;
        let base = f.base + f.tan * x;
        let lean = (hk - 0.5) * 0.5 + x / f.width * 0.4;
        let h = f.height * (0.65 + 0.5 * hk);
        let mut pts = Vec::with_capacity(6);
        for i in 0..=5 {
            let u = i as f32 / 5.0;
            let a = (lean + f.bend + idle) * u * u;
            pts.push(base + f.nrm * (h * u * a.cos()) + f.tan * (h * u * a.sin()));
        }
        let dim = mix(Color::BLACK, f.col, 0.18 + 0.4 * g);
        let n = pts.len();
        for i in 0..n - 1 {
            let w = 3.2 * (1.0 - i as f32 / n as f32);
            buf.stroke(&[pts[i], pts[i + 1]], w, 0.0, la(dim, 1.0));
        }
        let tip = pts[n - 1];
        soft_dot(buf, tip, 6.0 + 12.0 * g, 0.001, la(f.col, 0.12 + 0.4 * g));
        buf.ellipse(tip, PVec2::splat(1.6 + 0.6 * g), 0.0, 0.0012, la(lighten(f.col, 0.6), 0.25 + 0.75 * g.min(1.0)));
    }
}

fn draw_vein(buf: &mut MeshBuf, v: &Vein, t: f32) {
    let g = v.glow.clamp(0.0, 1.5);
    // A slow shimmer runs along a lit vein.
    let rest = 0.05 + 0.02 * (t * 0.6 + v.centre.x * 0.01).sin();
    let a = rest + 0.75 * g;
    if g > 0.02 {
        buf.halo(v.centre, PVec2::splat(70.0 + 50.0 * g), -0.0005, la(v.col, 0.1 * g));
    }
    buf.stroke(&v.pts, 6.0, 0.0, la(v.col, 0.12 * a));
    let n = v.pts.len();
    let cols: Vec<[f32; 4]> = (0..n)
        .map(|i| {
            let wave = 0.75 + 0.25 * (t * 3.0 - i as f32 * 0.9).sin();
            la(lighten(v.col, 0.35), a * wave)
        })
        .collect();
    buf.stroke_cols(&v.pts, 1.8, 0.0005, &cols);
}
