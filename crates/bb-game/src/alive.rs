//! The living cave. At rest everything is calm and dark; blobs wake it up.
//!
//! Everything alive in a level is one connected network — Pandora-style
//! bioluminescence:
//!
//! * **Hangers** — roots, glow-worm silk and jelly drips under every
//!   ceiling; they swing when a blob brushes past.
//! * **Fronds** — tufts of cave-grass along floors that bend away from a
//!   passing blob.
//! * **Veins** — mineral seams inside walls.
//! * **Mushrooms** — the level's reactive glow mushrooms (drawn by
//!   `cave.rs`, lit from here).
//!
//! A blob landing, rolling along stone or brushing a plant is a pulse
//! *source*. The pulse travels as a visible front: along each thing it
//! reaches (down a hanger from its root, up a frond, along a vein), and
//! from each thing on to its neighbours with a delay and some falloff —
//! through the rock along faint hidden roots that light only while the
//! front passes. Brightness at a point is a function of how long ago the
//! front passed it: a soft leading edge, a brighter crest, a long gentle
//! tail, then dark again. Light (glow, beads, gills) fades away
//! completely; physical things (roots, silk, grass, drips) keep a dim
//! resting colour and only brighten as the pulse reaches them. All glow
//! colours come from one smooth hue field ([`palette::glow_at`]) so
//! neighbouring lights never clash.
//!
//! Everything is render-side and procedural (seeded from the level); the
//! network's links are precomputed once per level; drawing is culled to
//! the camera.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use bb_physics::{Aabb, BodyId, Collider, Vec2 as PVec2, geom};
use bevy::prelude::*;

use crate::crag::hash1;
use crate::level_view::{LevelEntity, near_checkpoint};
use crate::palette::{self, ThemeColors, glow_at, lighten, mix, pulse_env, screen_add};
use crate::render::{Ends, MeshBuf, Shared, ccw, empty_mesh, la, z};
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

/// Pulse front speed (world px / s), along things and between them.
const SPEED: f32 = 300.0;
/// Soft leading edge and glowing tail of a front (px).
const LEAD: f32 = 60.0;
const TAIL: f32 = SPEED * 1.7;
/// A hit stops mattering this long after it arrived (s).
const HIT_LIFE: f32 = 6.0;
/// Longest link through rock / through open air between two things (px).
const LINK_ROCK: f32 = 260.0;
const LINK_AIR: f32 = 130.0;
/// How far from its source a pulse finds its first things (px).
const SOURCE_REACH: f32 = 190.0;
/// Pulses stop spreading after this long (s) or this faint.
const SPREAD_TIME: f32 = 3.2;
const MIN_AMP: f32 = 0.1;
/// Per-hop falloff.
const HOP_KEEP: f32 = 0.84;
/// Delay at each thing before it passes the pulse on (s).
const HOP_DELAY: f32 = 0.07;

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
    phase: f32,
    col: Color,
    w: f32,
    /// How far the strand runs on up into the rock above its root (hidden
    /// behind it), so its top never shows as a flat cut.
    lead: f32,
    cool: f32,
    t: f32,
    node: usize,
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
    phase: f32,
    col: Color,
    cool: f32,
    t: f32,
    node: usize,
}

struct Vein {
    pts: Vec<PVec2>,
    /// Arc length at each point.
    s: Vec<f32>,
    centre: PVec2,
    node: usize,
}

struct Mark {
    p: PVec2,
    age: f32,
    strength: f32,
    col: Color,
}

/// A pulse front reaching a node: at time `t`, at distance `s` along it.
#[derive(Clone, Copy)]
struct Hit {
    t: f32,
    s: f32,
    amp: f32,
}

/// A link to a neighbouring node: leave this node at `from_s`, cross `gap`
/// px (from `a` to `b`), arrive at the other's `to_s`.
struct Edge {
    to: usize,
    from_s: f32,
    to_s: f32,
    gap: f32,
    a: PVec2,
    b: PVec2,
    rock: bool,
}

/// One thing in the network.
struct Node {
    /// Where pulses can enter or leave it, and how far along it that is.
    ports: Vec<(PVec2, f32)>,
    edges: Vec<Edge>,
    hits: Vec<Hit>,
}

/// A front crossing hidden rock between two nodes: lit along `a`→`b`,
/// leaving `a` at `t0`.
struct Link {
    a: PVec2,
    b: PVec2,
    t0: f32,
    amp: f32,
}

/// A level mushroom (drawn by `cave.rs`) as a node.
struct Mush {
    decor: usize,
    cap: f32,
    node: usize,
}

#[derive(Resource, Default)]
pub struct Alive {
    hangers: Vec<Hanger>,
    fronds: Vec<Frond>,
    veins: Vec<Vein>,
    mush: Vec<Mush>,
    nodes: Vec<Node>,
    links: Vec<Link>,
    marks: Vec<Mark>,
    solids: Vec<(Vec<PVec2>, Aabb)>,
    last_mark: HashMap<BodyId, PVec2>,
    /// Per blob: where and when it last sent a pulse.
    last_emit: HashMap<BodyId, (PVec2, f32)>,
    meshes: Vec<Handle<Mesh>>,
    theme: Option<ThemeColors>,
    now: f32,
}

impl Alive {
    /// How lit the level mushroom made from decor `idx` is (cap light).
    pub fn decor_light(&self, idx: usize) -> f32 {
        self.mush.iter().find(|m| m.decor == idx).map_or(0.0, |m| light(&self.nodes[m.node].hits, self.now, m.cap))
    }

    fn solid_at(&self, p: PVec2) -> bool {
        self.solids.iter().any(|(o, b)| b.contains(p) && geom::point_in_polygon(p, o))
    }

    /// Send a pulse out from `p`: everything within reach lights as the
    /// front arrives and passes it on to its neighbours.
    fn emit(&mut self, p: PVec2, t: f32, amp: f32) {
        #[derive(PartialEq)]
        struct Q {
            t: f32,
            node: usize,
            s: f32,
            amp: f32,
            via: Option<(PVec2, PVec2, f32)>,
        }
        impl Eq for Q {}
        impl Ord for Q {
            fn cmp(&self, o: &Self) -> Ordering {
                o.t.total_cmp(&self.t)
            }
        }
        impl PartialOrd for Q {
            fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
                Some(self.cmp(o))
            }
        }
        let mut heap = BinaryHeap::new();
        for (i, n) in self.nodes.iter().enumerate() {
            let Some((q, s)) = n.ports.iter().map(|(q, s)| (*q, *s)).min_by(|a, b| a.0.distance_squared(p).total_cmp(&b.0.distance_squared(p))) else { continue };
            let d = q.distance(p);
            if d < SOURCE_REACH {
                let rock = d > 30.0 && self.solid_at((p + q) * 0.5);
                heap.push(Q { t: t + d / SPEED, node: i, s, amp: amp * (1.0 - 0.35 * d / SOURCE_REACH), via: rock.then_some((p, q, t)) });
            }
        }
        let mut seen = vec![false; self.nodes.len()];
        while let Some(Q { t: tn, node, s, amp: an, via }) = heap.pop() {
            if seen[node] {
                continue;
            }
            seen[node] = true;
            if let Some((a, b, t0)) = via {
                self.links.push(Link { a, b, t0, amp: an });
            }
            let n = &mut self.nodes[node];
            // Merge with a front already passing here.
            if let Some(h) = n.hits.iter_mut().find(|h| (h.t - tn).abs() < 0.3 && (h.s - s).abs() < 80.0) {
                h.amp = h.amp.max(an);
            } else {
                n.hits.push(Hit { t: tn, s, amp: an });
                if n.hits.len() > 10 {
                    n.hits.remove(0);
                }
            }
            for e in &self.nodes[node].edges {
                if seen[e.to] {
                    continue;
                }
                let along = (e.from_s - s).abs() / SPEED;
                let t2 = tn + along + e.gap / SPEED + HOP_DELAY;
                let a2 = an * HOP_KEEP * (-e.gap / 1100.0).exp();
                if a2 < MIN_AMP || t2 - t > SPREAD_TIME {
                    continue;
                }
                heap.push(Q { t: t2, node: e.to, s: e.to_s, amp: a2, via: e.rock.then_some((e.a, e.b, tn + along + HOP_DELAY)) });
            }
        }
        if self.links.len() > 600 {
            let extra = self.links.len() - 600;
            self.links.drain(0..extra);
        }
    }
}

/// Light at distance `s` along a node from all fronts that reached it.
fn light(hits: &[Hit], t: f32, s: f32) -> f32 {
    hits.iter().fold(0.0, |acc, h| screen_add(acc, h.amp * pulse_env((t - h.t) * SPEED - (s - h.s).abs(), LEAD, TAIL)))
}

/// Did a front reach this node between `t0` and `t1`? (Its strength.)
fn arrived(hits: &[Hit], t0: f32, t1: f32) -> f32 {
    hits.iter().filter(|h| h.t > t0 && h.t <= t1).map(|h| h.amp).fold(0.0, f32::max)
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
    let ground = crate::level_view::Ground::new(level);
    let solids: Vec<Vec<PVec2>> = level.terrain.iter().filter(|t| !t.one_way).map(|t| ccw(t.shape.outline())).collect();
    let boxes: Vec<Aabb> = solids.iter().map(|o| Aabb::from_points(o.iter().copied())).collect();
    let solid_at = |p: PVec2| solids.iter().zip(&boxes).any(|(o, b)| b.contains(p) && geom::point_in_polygon(p, o));
    let jelly_boxes: Vec<(PVec2, PVec2)> = level.jelly.iter().map(|j| j.shape.bounds()).collect();
    let under_jelly = |p: PVec2| jelly_boxes.iter().any(|(a, b)| p.x > a.x - 4.0 && p.x < b.x + 4.0 && p.y > a.y - 4.0 && p.y < b.y + 30.0);
    let hue = |p: PVec2| glow_at(&theme, p.x, p.y);
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
        // Only from real rock: decor authored in mid-air (dust markers in
        // a draft, say) would hang from nothing.
        if !(0..4).any(|k| ground.solid(root + PVec2::new(0.0, 4.0 + k as f32 * 12.0))) {
            continue;
        }
        hangers.push(hanger(kind, root, len, hue(root), hash1(i, seed)));
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
                    let root = p + PVec2::new(0.0, 26.0);
                    // Roots are the level's vines: one colour for all of them.
                    let col = if kind == HangKind::Root { palette::vine(&theme) } else { hue(root) };
                    hangers.push(hanger(kind, root, l + 26.0, col, h(5)));
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
                    // Sprout from the real surface here (the jelly skin's
                    // top where there is one), never from a bounding box.
                    let Some((top, _)) = ground.snap(p + nrm * 4.0, 60.0, 24.0) else { continue };
                    let base = top - PVec2::new(0.0, 3.0);
                    fronds.push(Frond {
                        base,
                        tan: -tan,
                        nrm,
                        blades: 2 + (h(2) * 4.0) as u8,
                        height: 16.0 + 26.0 * h(3) + if on_jelly { 6.0 } else { 0.0 },
                        width: 10.0 + 22.0 * h(4),
                        bend: 0.0,
                        bend_v: 0.0,
                        phase: h(5) * 6.28,
                        col: hue(base),
                        cool: 0.0,
                        t: 0.0,
                        node: 0,
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
                    let pts = smooth(&pts);
                    let mut acc = 0.0;
                    let s: Vec<f32> = (0..pts.len())
                        .map(|i| {
                            if i > 0 {
                                acc += pts[i].distance(pts[i - 1]);
                            }
                            acc
                        })
                        .collect();
                    veins.push(Vein { pts, s, centre, node: 0 });
                }
            }
        }
    }
    hangers.sort_by(|a, b| a.root.x.total_cmp(&b.root.x));
    for h in hangers.iter_mut() {
        // Up into the rock, only as far as it stays solid (thin shelves).
        h.lead = (1..=5).take_while(|k| solid_at(h.root + PVec2::new(0.0, *k as f32 * 8.0))).count() as f32 * 8.0;
    }
    fronds.sort_by(|a, b| a.base.x.total_cmp(&b.base.x));
    veins.sort_by(|a, b| a.centre.x.total_cmp(&b.centre.x));

    // The network: every thing is a node with ports…
    let mut nodes: Vec<Node> = Vec::new();
    let mut node = |ports: Vec<(PVec2, f32)>| {
        nodes.push(Node { ports, edges: Vec::new(), hits: Vec::new() });
        nodes.len() - 1
    };
    for h in hangers.iter_mut() {
        // Root (in the rock) and down its length, so a touch anywhere
        // enters where it touched.
        h.node = node((0..=4).map(|k| (h.root - PVec2::new(0.0, h.len * k as f32 / 4.0), h.len * k as f32 / 4.0)).collect());
    }
    for f in fronds.iter_mut() {
        // Fed from just under the surface it grows on.
        f.node = node(vec![(f.base - f.nrm * 10.0, 0.0)]);
    }
    for v in veins.iter_mut() {
        v.node = node(v.pts.iter().zip(&v.s).step_by(2).map(|(p, s)| (*p, *s)).collect());
    }
    let mut mush = Vec::new();
    for (i, d) in level.decor.iter().enumerate() {
        if crate::cave::is_reactive(&d.kind) && !near_checkpoint(level, d.pos) {
            let Some((pos, _)) = crate::level_view::place_decor(&ground, &d.kind, d.pos, d.scale) else { continue };
            let n = node(vec![(pos - PVec2::new(0.0, 10.0), 0.0)]);
            mush.push(Mush { decor: i, cap: 50.0 * d.scale, node: n });
        }
    }
    // …linked to every neighbour in reach (hanger links only from the root).
    let link_ports = |n: &Node, is_hanger: bool| -> Vec<(PVec2, f32)> { if is_hanger { n.ports[..1].to_vec() } else { n.ports.clone() } };
    let hanger_nodes: Vec<bool> = {
        let mut v = vec![false; nodes.len()];
        for h in &hangers {
            v[h.node] = true;
        }
        v
    };
    let ports: Vec<Vec<(PVec2, f32)>> = nodes.iter().enumerate().map(|(i, n)| link_ports(n, hanger_nodes[i])).collect();
    let bbox: Vec<Aabb> = ports.iter().map(|p| Aabb::from_points(p.iter().map(|q| q.0))).collect();
    for i in 0..nodes.len() {
        for j in 0..nodes.len() {
            if i == j || bbox[i].min.x - LINK_ROCK > bbox[j].max.x || bbox[j].min.x - LINK_ROCK > bbox[i].max.x || bbox[i].min.y - LINK_ROCK > bbox[j].max.y || bbox[j].min.y - LINK_ROCK > bbox[i].max.y {
                continue;
            }
            let mut best: Option<(f32, (PVec2, f32), (PVec2, f32))> = None;
            for a in &ports[i] {
                for b in &ports[j] {
                    let d = a.0.distance(b.0);
                    if best.is_none_or(|x| d < x.0) {
                        best = Some((d, *a, *b));
                    }
                }
            }
            let Some((gap, a, b)) = best else { continue };
            if gap > LINK_ROCK {
                continue;
            }
            let rock = (1..4).all(|k| solid_at(a.0 + (b.0 - a.0) * (k as f32 / 4.0)));
            if !rock && gap > LINK_AIR {
                continue;
            }
            nodes[i].edges.push(Edge { to: j, from_s: a.1, to_s: b.1, gap, a: a.0, b: b.0, rock });
        }
    }
    // Only the nearest few neighbours: a network, not a lattice.
    for n in nodes.iter_mut() {
        n.edges.sort_by(|a, b| a.gap.total_cmp(&b.gap));
        n.edges.truncate(4);
    }
    alive.hangers = hangers;
    alive.fronds = fronds;
    alive.veins = veins;
    alive.mush = mush;
    alive.nodes = nodes;
    alive.solids = solids.into_iter().zip(boxes).collect();

    // Back (hangers, behind the rock), surface (veins, hidden roots and
    // light pools on the stone), fronds (behind the jelly).
    for zz in [z::TERRAIN - 0.3, z::SPILL + 0.04, z::JELLY - 0.05] {
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
        phase: h * 40.0,
        col,
        w: match kind {
            HangKind::Root => 5.0 + 4.0 * h,
            HangKind::Thread => 1.2,
            HangKind::Drip => 7.0 + 3.0 * h,
        },
        lead: 0.0,
        cool: 0.0,
        t: 0.0,
        node: 0,
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

/// Subdivide a polyline (Catmull-Rom, 3 per segment) so light can run
/// smoothly along it.
fn smooth(p: &[PVec2]) -> Vec<PVec2> {
    let n = p.len();
    let at = |i: isize| p[i.clamp(0, n as isize - 1) as usize];
    let mut out = Vec::with_capacity(n * 3);
    for i in 0..n - 1 {
        let (p0, p1, p2, p3) = (at(i as isize - 1), at(i as isize), at(i as isize + 1), at(i as isize + 2));
        for k in 0..3 {
            let t = k as f32 / 3.0;
            let (t2, t3) = (t * t, t * t * t);
            out.push((p1 * 2.0 + (p2 - p0) * t + (p0 * 2.0 - p1 * 5.0 + p2 * 4.0 - p3) * t2 + (p1 * 3.0 - p0 - p2 * 3.0 + p3) * t3) * 0.5);
        }
    }
    out.push(p[n - 1]);
    out
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
    /// Background blobs send gentler pulses than the player.
    npc: bool,
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
    if !theme.dark || alive.meshes.len() < 3 {
        msgs.clear();
        return;
    }
    let dt = time.delta_secs().min(0.05);
    let t = time.elapsed_secs();
    let t_prev = alive.now;
    alive.now = t;
    let sim = &game.sim;
    let actors: Vec<Actor> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| (p.ctl.body, p.ctl.radius, p.color, false))
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (n.ctl.body, n.ctl.radius, n.color, true)))
        .filter_map(|(id, r, c, npc)| sim.world.body(id).map(|b| Actor { id, p: b.centroid(), v: b.velocity(), r, col: palette::hex(c), npc }))
        .collect();
    // Landings send pulses; hard ones also shake things.
    let mut shocks: Vec<(PVec2, f32)> = Vec::new();
    let mut sources: Vec<(PVec2, f32)> = Vec::new();
    for m in msgs.read() {
        if let bb_sim::SimEvent::Impact { body, pos, speed } = m.0 {
            let Some(a) = actors.iter().find(|a| a.id == body) else { continue };
            if speed > 150.0 {
                sources.push((pos, ((speed - 60.0) / 520.0).clamp(0.4, 1.0) * if a.npc { 0.55 } else { 1.0 }));
            }
            if speed > 330.0 {
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

    // ------------------------------------------- blobs as pulse sources
    let alive_ref = &mut *alive;
    for a in &actors {
        let speed = a.v.length();
        // Light pools where the blob touches stone, and a pulse into the
        // rock every so often as it rolls along.
        let touch = sim.world.contacts_of(a.id).find(|c| matches!(c.other, Collider::Static(_))).map(|c| c.point);
        if let Some(p) = touch {
            let far = alive_ref.last_mark.get(&a.id).is_none_or(|q| q.distance(p) > 26.0);
            if far {
                alive_ref.last_mark.insert(a.id, p);
                let strength = (0.35 + speed / 900.0).min(1.0);
                alive_ref.marks.push(Mark { p, age: 0.0, strength, col: mix(glow_at(&theme, p.x, p.y), a.col, 0.2) });
            }
            let due = alive_ref.last_emit.get(&a.id).is_none_or(|(q, te)| t - te > 0.25 && (q.distance(p) > 110.0 || (t - te > 1.4 && speed > 40.0)));
            if due {
                sources.push((p, (0.45 + speed / 1400.0).min(0.8) * if a.npc { 0.55 } else { 1.0 }));
            }
        }
    }
    for (p, amp) in &sources {
        alive_ref.emit(*p, t, *amp);
        for a in &actors {
            if a.p.distance(*p) < a.r * 2.5 {
                alive_ref.last_emit.insert(a.id, (*p, t));
            }
        }
    }
    for n in alive_ref.nodes.iter_mut() {
        if !n.hits.is_empty() {
            n.hits.retain(|h| t - h.t < HIT_LIFE);
        }
    }
    alive_ref.links.retain(|l| t - l.t0 < HIT_LIFE);

    let mut back = MeshBuf::default();
    let mut surface = MeshBuf::default();
    let mut grass = MeshBuf::default();
    let mut emits: Vec<(PVec2, f32)> = Vec::new();

    // -------------------------------------------------------- hangers
    let (lo, hi) = {
        let hs = &alive_ref.hangers;
        range(&|i| hs[i].root.x, hs.len())
    };
    let mut puffs: Vec<(PVec2, Color)> = Vec::new();
    let nodes = &alive_ref.nodes;
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
        let tip = hgr.root + PVec2::new(hgr.ang.sin(), -hgr.ang.cos()) * hgr.len;
        let mut touched = None;
        for a in &actors {
            let (q, _) = geom::closest_on_segment(a.p, hgr.root, tip);
            let d = (a.p.distance(q) - a.r).max(0.0);
            if d < 14.0 {
                // Drag along with the blob: transfer some of its velocity.
                let along = ((q - hgr.root).length() / hgr.len).clamp(0.25, 1.0);
                let want = a.v.x / (hgr.len * along) * 0.6;
                hgr.vel += (want - hgr.vel) * (1.0 - (-6.0 * dt).exp());
                touched = Some(q);
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
            }
        }
        // A pulse arriving stirs it a little.
        let hits = &nodes[hgr.node].hits;
        let stir = arrived(hits, t_prev, t);
        if stir > 0.0 {
            hgr.vel += if hgr.phase.fract() > 0.5 { 1.0 } else { -1.0 } * 0.35 * stir * (60.0 / hgr.len).sqrt();
        }
        hgr.cool = (hgr.cool - dt).max(0.0);
        if let Some(q) = touched {
            if hgr.cool <= 0.0 {
                hgr.cool = 0.7;
                emits.push((q, 0.85));
                if hgr.kind != HangKind::Drip {
                    puffs.push((tip, hgr.col));
                }
            }
        }
        // Damped pendulum.
        let stiff = match hgr.kind {
            HangKind::Drip => 4.0,
            _ => 1.0,
        } * 2200.0
            / hgr.len.max(20.0);
        let acc = -stiff * hgr.ang - 1.1 * hgr.vel;
        hgr.vel += acc * dt;
        hgr.ang = (hgr.ang + hgr.vel * dt).clamp(-1.2, 1.2);
        draw_hanger(&mut back, hgr, hits, t);
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
        let mut push = 0.0;
        let top = f.base + f.nrm * f.height * 0.6;
        let mut touched = false;
        for a in &actors {
            let d = (a.p.distance(top) - a.r).max(0.0);
            if d < 30.0 {
                let away = (top - a.p).dot(f.tan).signum();
                let k = 1.0 - d / 30.0;
                // Pressed flat away from the blob, and swept by its motion.
                push += (away * 0.9 + a.v.dot(f.tan) / 500.0) * k;
                touched = true;
            }
        }
        for (sp, s) in &shocks {
            let d = sp.distance(f.base);
            if d < 420.0 {
                let k = s * (1.0 - d / 420.0);
                f.bend_v += (f.base - *sp).dot(f.tan).signum() * k * 9.0;
            }
        }
        let hits = &nodes[f.node].hits;
        let stir = arrived(hits, t_prev, t);
        if stir > 0.0 {
            f.bend_v += if f.phase > 3.14 { 1.0 } else { -1.0 } * 3.0 * stir;
        }
        f.cool = (f.cool - dt).max(0.0);
        if touched && f.cool <= 0.0 {
            f.cool = 0.6;
            emits.push((top, 0.6));
        }
        let acc = -110.0 * f.bend - 5.0 * f.bend_v + push * 160.0;
        f.bend_v += acc * dt;
        f.bend = (f.bend + f.bend_v * dt).clamp(-1.1, 1.1);
        draw_frond(&mut grass, f, hits, t);
    }

    // ---------------------------------------------------------- veins
    let (lo, hi) = {
        let vs = &alive_ref.veins;
        range(&|i| vs[i].centre.x, vs.len())
    };
    for v in alive_ref.veins[lo..hi].iter() {
        if !in_view(v.centre) {
            continue;
        }
        draw_vein(&mut surface, v, &nodes[v.node].hits, &theme, t);
    }

    // ------------------------------------- hidden roots between things
    for l in &alive_ref.links {
        if !in_view(l.a) && !in_view(l.b) {
            continue;
        }
        draw_link(&mut surface, l, &theme, t);
    }

    // ------------------------------------------------- pools of light
    for m in alive_ref.marks.iter_mut() {
        m.age += dt;
    }
    alive_ref.marks.retain(|m| m.age < 4.2);
    if alive_ref.marks.len() > 300 {
        let extra = alive_ref.marks.len() - 300;
        alive_ref.marks.drain(0..extra);
    }
    for m in &alive_ref.marks {
        if !in_view(m.p) {
            continue;
        }
        let k = (m.age / 0.25).min(1.0).powi(2) * (-m.age / 1.3).exp() * m.strength;
        surface.halo(m.p, PVec2::new(90.0, 60.0), -0.001, la(m.col, 0.13 * k));
    }
    for (p, c) in puffs {
        spores.puff(p, 18.0, c, 4);
    }
    for (p, amp) in emits {
        alive_ref.emit(p, t, amp);
    }

    for (h, buf) in alive_ref.meshes.clone().iter().zip([back, surface, grass]) {
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

fn draw_hanger(buf: &mut MeshBuf, h: &Hanger, hits: &[Hit], t: f32) {
    const N: usize = 9;
    // Light per point down its length (the front runs root → tip).
    let g: Vec<f32> = (0..=N).map(|i| light(hits, t, h.len * i as f32 / N as f32)).collect();
    let gmax = g.iter().copied().fold(0.0, f32::max);
    let gt = g[N];
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
    // Every strand runs on up into the rock it hangs from (the drawn crag
    // edge can sit above the root), so it never starts with a flat top.
    let lead = [h.root + PVec2::new(0.0, h.lead.max(0.5)), h.root];
    match h.kind {
        HangKind::Root => {
            // Physical: a dim root always, one smooth tapered strand with a
            // rounded tip; it warms where the light is.
            let sp = crate::render::smooth_open(&pts, 3);
            let m = sp.len();
            let gs: Vec<f32> = (0..m).map(|i| { let f = i as f32 / (m - 1) as f32 * N as f32; let k = (f as usize).min(N - 1); g[k] + (g[k + 1] - g[k]) * (f - k as f32) }).collect();
            let ws: Vec<f32> = (0..m).map(|i| h.w * (1.0 - 0.62 * i as f32 / (m - 1) as f32)).collect();
            let cs: Vec<[f32; 4]> = gs.iter().map(|x| la(mix(Color::BLACK, mix(h.col, Color::WHITE, 0.1), 0.16 + 0.16 * x), 1.0)).collect();
            buf.stroke(&lead, ws[0], 0.0, cs[0]);
            buf.taper(&sp, &ws, 0.0, &cs, false, true);
            // A curled rootlet near the tip so it ends in growth, not a cut.
            let d = (sp[m - 1] - sp[m - 4]).normalize_or(PVec2::new(0.0, -1.0));
            let side = PVec2::new(-d.y, d.x) * if h.phase.fract() > 0.5 { 1.0 } else { -1.0 };
            let at = sp[m - 5];
            let curl: Vec<PVec2> = (0..=5).map(|k| { let u = k as f32 / 5.0; at + (side * 0.9 + d * 0.5) * (u * h.w * 2.2) + d * (u * u * h.w * 0.8) }).collect();
            let cw: Vec<f32> = (0..=5).map(|k| ws[m - 5] * 0.45 * (1.0 - 0.6 * k as f32 / 5.0)).collect();
            buf.taper(&curl, &cw, -0.0001, &vec![cs[m - 5]; 6], false, true);
            if gmax > 0.004 {
                // A glowing rim and nodes that wake as the front passes.
                let rim: Vec<[f32; 4]> = gs.iter().map(|x| la(lighten(h.col, 0.2), 0.6 * x)).collect();
                buf.stroke_taper(&sp[6..], 1.4, 0.0005, &rim[6..], h.len * 0.2, Ends::Both);
                for (k, q) in pts.iter().enumerate().skip(3).step_by(3) {
                    let a = 0.85 * g[k];
                    soft_dot(buf, *q, 7.0 + 8.0 * g[k], 0.001, la(h.col, 0.3 * a));
                    buf.ellipse(*q, PVec2::splat(1.8 + 0.6 * (k % 2) as f32), 0.0, 0.0012, la(lighten(h.col, 0.5), a));
                }
                soft_dot(buf, tip, 10.0 + 16.0 * gt, 0.001, la(h.col, 0.42 * gt));
            }
            buf.ellipse(tip, PVec2::splat(2.4), 0.0, 0.0012, la(mix(mix(Color::BLACK, h.col, 0.3), lighten(h.col, 0.6), gt), 0.6 + 0.4 * gt));
        }
        HangKind::Thread => {
            // Silk is always faintly there; light runs down it.
            let silk: Vec<[f32; 4]> = g.iter().map(|x| la(lighten(mix(Color::BLACK, h.col, 0.45 + 0.55 * x), 0.2 * x), 0.2 + 0.4 * x)).collect();
            buf.stroke(&lead, 1.2, 0.0, silk[0]);
            buf.stroke_cols(&pts, 1.2, 0.0, &silk);
            for (k, q) in pts.iter().enumerate().skip(4).step_by(2) {
                if g[k] > 0.004 {
                    buf.ellipse(*q, PVec2::splat(1.5), 0.0, 0.0005, la(lighten(h.col, 0.5), 0.75 * g[k]));
                }
            }
            if gt > 0.004 {
                soft_dot(buf, tip, 14.0 + 24.0 * gt, 0.001, la(h.col, 0.5 * gt));
            }
            // The larva: a dim body at rest, a lamp when lit.
            let breathe = 0.5 + 0.5 * (t * 1.2 + h.phase).sin();
            buf.ellipse(tip, PVec2::new(3.0, 4.2), 0.0, 0.0012, la(mix(mix(Color::BLACK, h.col, 0.45), lighten(h.col, 0.65), gt), 0.5 + 0.08 * breathe + 0.42 * gt));
        }
        HangKind::Drip => {
            let n = pts.len();
            let ws: Vec<f32> = (0..n).map(|i| h.w * (1.0 - 0.55 * i as f32 / (n - 1) as f32)).collect();
            buf.stroke(&lead, ws[0], 0.0, la(mix(Color::BLACK, h.col, 0.3 + 0.35 * g[0]), 0.95));
            for i in 0..n - 1 {
                let jelly = mix(Color::BLACK, h.col, 0.3 + 0.35 * g[i]);
                buf.stroke(&[pts[i], pts[i + 1]], ws[i], 0.0, la(jelly, 0.95));
            }
            if gt > 0.004 {
                soft_dot(buf, tip, 16.0 + 22.0 * gt, 0.001, la(h.col, 0.5 * gt));
            }
            buf.ellipse(tip - PVec2::new(0.0, 3.0), PVec2::new(h.w * 0.75, h.w), 0.0, 0.0012, la(mix(mix(Color::BLACK, h.col, 0.4), lighten(h.col, 0.4), gt), 0.95));
            buf.ellipse(tip + PVec2::new(-1.5, -1.0), PVec2::new(1.4, 2.0), 0.0, 0.0014, la(Color::WHITE, 0.25 + 0.45 * gt));
        }
    }
}

fn draw_frond(buf: &mut MeshBuf, f: &Frond, hits: &[Hit], t: f32) {
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
        // The front climbs each blade from the root (outer blades a touch
        // later, so the tuft lights from the middle out).
        let n = pts.len();
        let g: Vec<f32> = (0..n).map(|i| light(hits, t, x.abs() * 0.6 + h * i as f32 / (n - 1) as f32)).collect();
        for i in 0..n - 1 {
            let w = 3.2 * (1.0 - i as f32 / n as f32);
            let dim = mix(Color::BLACK, f.col, 0.2 + 0.4 * g[i]);
            buf.stroke(&[pts[i], pts[i + 1]], w, 0.0, la(dim, 1.0));
        }
        let tip = pts[n - 1];
        let gt = g[n - 1];
        if gt > 0.004 {
            soft_dot(buf, tip, 6.0 + 12.0 * gt, 0.001, la(f.col, 0.5 * gt));
        }
        buf.ellipse(tip, PVec2::splat(1.6 + 0.6 * gt), 0.0, 0.0012, la(mix(mix(Color::BLACK, f.col, 0.4), lighten(f.col, 0.6), gt), 0.45 + 0.55 * gt));
    }
}

fn draw_vein(buf: &mut MeshBuf, v: &Vein, hits: &[Hit], theme: &ThemeColors, t: f32) {
    let n = v.pts.len();
    let cols: Vec<Color> = v.pts.iter().map(|p| glow_at(theme, p.x, p.y)).collect();
    // Both ends taper into the stone (narrowing as they fade).
    let total = v.s[n - 1] - v.s[0];
    let tl = 30.0f32.min(total * 0.4).max(1.0);
    let end = |i: usize| {
        let e = ((v.s[i] - v.s[0]).min(v.s[n - 1] - v.s[i]) / tl).clamp(0.0, 1.0);
        e * e * (3.0 - 2.0 * e)
    };
    // The seam: always faintly there in the stone.
    let seam: Vec<[f32; 4]> = (0..n).map(|i| la(mix(Color::BLACK, cols[i], 0.12), 0.8)).collect();
    buf.stroke_taper(&v.pts, 2.4, -0.0002, &seam, tl, Ends::Both);
    if hits.is_empty() {
        return;
    }
    let g: Vec<f32> = (0..n).map(|i| light(hits, t, v.s[i])).collect();
    if g.iter().all(|x| *x < 0.004) {
        return;
    }
    let soft: Vec<[f32; 4]> = (0..n).map(|i| la(cols[i], 0.16 * g[i])).collect();
    buf.stroke_taper(&v.pts, 9.0, 0.0, &soft, tl, Ends::Both);
    let core: Vec<[f32; 4]> = (0..n).map(|i| la(lighten(cols[i], 0.2 + 0.25 * g[i]), 0.85 * g[i])).collect();
    buf.stroke_taper(&v.pts, 1.9, 0.0005, &core, tl, Ends::Both);
    for i in (2..n).step_by(5) {
        let gi = g[i] * end(i);
        if gi > 0.02 {
            soft_dot(buf, v.pts[i], 8.0 + 10.0 * gi, 0.0003, la(cols[i], 0.25 * gi));
            buf.ellipse(v.pts[i], PVec2::splat(1.3 + 1.0 * gi), 0.0, 0.0008, la(lighten(cols[i], 0.45), 0.85 * gi));
        }
    }
}

/// A hidden root in the rock between two things, lit only while a front
/// runs along it.
fn draw_link(buf: &mut MeshBuf, l: &Link, theme: &ThemeColors, t: f32) {
    let d = l.b - l.a;
    let len = d.length();
    if len < 1.0 {
        return;
    }
    let x_front = (t - l.t0) * SPEED;
    if x_front < -LEAD || x_front - len > TAIL * 4.0 {
        return;
    }
    let side = PVec2::new(-d.y, d.x) / len;
    let wob = hash1((l.a.x * 3.0 + l.b.y) as i32, 41) * 6.28;
    let steps = ((len / 9.0) as usize).clamp(3, 40);
    let pts: Vec<PVec2> = (0..=steps)
        .map(|k| {
            let s = k as f32 / steps as f32;
            // A gentle meander, pinned at both ends.
            l.a + d * s + side * ((s * 5.0 + wob).sin() * (4.0 + len * 0.05) * (s * (1.0 - s) * 4.0))
        })
        .collect();
    let g: Vec<f32> = (0..=steps).map(|k| l.amp * 0.8 * pulse_env(x_front - len * k as f32 / steps as f32, LEAD, TAIL * 0.35)).collect();
    if g.iter().all(|x| *x < 0.004) {
        return;
    }
    let cols: Vec<Color> = pts.iter().map(|p| glow_at(theme, p.x, p.y)).collect();
    let soft: Vec<[f32; 4]> = (0..=steps).map(|k| la(cols[k], 0.1 * g[k])).collect();
    let tl = 24.0f32.min(len * 0.4);
    buf.stroke_taper(&pts, 8.0, -0.0003, &soft, tl, Ends::Both);
    let core: Vec<[f32; 4]> = (0..=steps).map(|k| la(lighten(cols[k], 0.25), 0.55 * g[k])).collect();
    buf.stroke_taper(&pts, 1.4, 0.0004, &core, tl, Ends::Both);
}
