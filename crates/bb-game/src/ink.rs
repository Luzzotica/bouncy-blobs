//! Ink: a newly eaten colour soaking through a blob like a drop of ink in
//! water.
//!
//! Each blob that is mid-soak carries an [`InkField`]: a small square
//! grid in the blob's *material* frame (a unit disc pinned to the hull
//! particles, so the ink rolls and squashes with the blob). Every eaten
//! colour is one ink — up to [`MAX_INKS`] at once — dropped in at the hull
//! point where it was eaten. The inks are carried by one shared flow
//! (a plunge from the drop point, slow curl-noise eddies, a gentle swirl,
//! and slosh from the blob's own acceleration / spin), diffuse softly, and
//! are composited oldest-first over the previous colour. After a while
//! the newest ink blooms outward from wherever it already is until it
//! fills the whole body; then the field is dropped and the blob is drawn
//! plain again in its (already current) gameplay colour.
//!
//! Cost: only blobs with a live field pay anything (a 40² grid per ink).

use std::collections::HashMap;

use bb_physics::{Body, BodyId, Vec2 as PVec2, geom};
use bevy::prelude::*;

/// Grid cells per side.
const G: usize = 40;
/// The grid covers [-EXT, EXT]² of the unit disc.
const EXT: f32 = 1.08;
/// Most inks swirling at once (a fifth bakes the oldest into the base).
pub const MAX_INKS: usize = 4;
/// When the newest ink starts taking the whole blob over (s after its drop).
const TAKE_START: f32 = 1.3;
/// Seconds over which the takeover ramps up.
const TAKE_RAMP: f32 = 1.6;
/// Safety: drop a field this long after its newest ink regardless.
const MAX_AGE: f32 = 9.0;

type Rgb = [f32; 3];

fn rgb(c: Color) -> Rgb {
    let s = c.to_srgba();
    [s.red, s.green, s.blue]
}

fn lerp3(a: Rgb, b: Rgb, t: f32) -> Rgb {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// How opaque an ink looks at concentration `c` (soft, never a hard edge).
fn cover(c: f32) -> f32 {
    smoothstep(0.06, 0.55, c)
}

fn rot(v: PVec2, a: f32) -> PVec2 {
    let (s, c) = a.sin_cos();
    PVec2::new(v.x * c - v.y * s, v.x * s + v.y * c)
}

fn wrap(a: f32) -> f32 {
    let t = std::f32::consts::TAU;
    (a + std::f32::consts::PI).rem_euclid(t) - std::f32::consts::PI
}

/// Cell centre in unit-disc coordinates.
fn cell_pos(i: usize, j: usize) -> PVec2 {
    let h = 2.0 * EXT / G as f32;
    PVec2::new(-EXT + (i as f32 + 0.5) * h, -EXT + (j as f32 + 0.5) * h)
}

/// Bilinear sample of a G×G field at unit-disc point `p`.
fn sample(f: &[f32], p: PVec2) -> f32 {
    let h = 2.0 * EXT / G as f32;
    let gx = ((p.x + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let gy = ((p.y + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let (i, j) = (gx as usize, gy as usize);
    let (fx, fy) = (gx - i as f32, gy - j as f32);
    let at = |i: usize, j: usize| f[j * G + i];
    let a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    let b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    a + (b - a) * fy
}

/// Material angle of hull particle `k` of `n` (matches the outline order
/// so the local frame is a rotation of the world, not a mirror).
fn hull_dir(k: f32, n: f32, sgn: f32) -> PVec2 {
    PVec2::from_angle(sgn * std::f32::consts::TAU * k / n)
}

/// +1 if the body's hull runs counter-clockwise, else -1.
fn hull_sign(b: &Body) -> f32 {
    let pts: Vec<PVec2> = b.outline().collect();
    if geom::signed_area_slice(&pts) >= 0.0 { 1.0 } else { -1.0 }
}

/// Unit-disc direction of drawn-outline vertex `j` of `a` (outline order
/// as drawn after `ccw`; `reversed` = `ccw` flipped it).
pub fn outline_dir(j: usize, a: usize, reversed: bool) -> PVec2 {
    if reversed { hull_dir((a - 1 - j) as f32, a as f32, -1.0) } else { hull_dir(j as f32, a as f32, 1.0) }
}

struct Ink {
    col: Rgb,
    /// Where its vortex pair (and the two legs it splits into) are.
    head: PVec2,
    legs: [PVec2; 2],
    c: Vec<f32>,
    /// Drop point (unit disc) and the direction it plunges (inward).
    src: PVec2,
    dive: PVec2,
    age: f32,
    /// This ink's own swirl (each enters with a slightly different curl).
    curl: f32,
}

/// One blob's ink: base colour field plus up to four inks.
pub struct InkField {
    base: [Vec<f32>; 3],
    inks: Vec<Ink>,
    /// Inside-the-disc mask.
    inside: Vec<bool>,
    /// For each cell outside the disc, the nearest cell inside (so
    /// sampling at the wall never mixes in empty space).
    edge: Vec<usize>,
    seed: f32,
    time: f32,
    /// Material → world rotation.
    phi: f32,
    prev: Option<(PVec2, f32)>,
    /// Fluid velocity / spin relative to the blob (slosh).
    slosh: PVec2,
    spin: f32,
    vel: Vec<PVec2>,
    tmp: Vec<f32>,
}

/// When a drop's pair splits into legs (s after the drop).
const SPLIT: f32 = 0.45;

impl Ink {
    /// Circulation and half-gap of the main vortex pair.
    fn pair(&self) -> (f32, f32) {
        let fade = (1.0 - self.age / 2.0).max(0.0);
        let split = smoothstep(SPLIT - 0.1, SPLIT + 0.35, self.age);
        (2.2 * fade * fade.sqrt() * (1.0 - 0.7 * split), 0.17 + 0.06 * self.age.min(1.0))
    }

    fn legs_pair(&self) -> (f32, f32) {
        let fade = (1.0 - self.age / 2.4).max(0.0);
        let split = smoothstep(SPLIT - 0.1, SPLIT + 0.35, self.age);
        (1.2 * fade * split, 0.11)
    }

    fn leg_dir(&self, s: f32) -> PVec2 {
        rot(self.dive, s * (0.6 + 0.2 * self.curl))
    }

    /// Pairs travel at their own self-induced speed, so the ink trapped
    /// between the cores rides along with them.
    fn advance(&mut self, dt: f32) {
        let speed = |circ: f32, gap: f32| circ * gap / (std::f32::consts::PI * (4.0 * gap * gap + 0.012));
        let (c, g) = self.pair();
        self.head = (self.head + self.dive * speed(c, g) * dt).clamp_length_max(0.9);
        if self.age < SPLIT {
            self.legs = [self.head; 2];
        } else {
            let (lc, lg) = self.legs_pair();
            for (n, s) in [1.0f32, -1.0].into_iter().enumerate() {
                self.legs[n] = (self.legs[n] + self.leg_dir(s) * speed(lc, lg) * dt).clamp_length_max(0.9);
            }
        }
    }
}

impl InkField {
    fn new(b: &Body, from: Color, seed: f32) -> Self {
        let col = rgb(from);
        let inside = (0..G * G).map(|k| cell_pos(k % G, k / G).length() < 1.0 + 1.0 / G as f32).collect();
        let edge = (0..G * G)
            .map(|k| {
                let p = cell_pos(k % G, k / G).clamp_length_max(0.97);
                let h = 2.0 * EXT / G as f32;
                let (i, j) = (((p.x + EXT) / h - 0.5).round() as usize, ((p.y + EXT) / h - 0.5).round() as usize);
                j.min(G - 1) * G + i.min(G - 1)
            })
            .collect();
        let mut f = InkField {
            edge,
            base: [vec![col[0]; G * G], vec![col[1]; G * G], vec![col[2]; G * G]],
            inks: Vec::new(),
            inside,
            seed,
            time: 0.0,
            phi: 0.0,
            prev: None,
            slosh: PVec2::ZERO,
            spin: 0.0,
            vel: vec![PVec2::ZERO; G * G],
            tmp: vec![0.0; G * G],
        };
        f.phi = f.frame(b).1;
        f
    }

    /// Centroid and material → world rotation of the body.
    fn frame(&self, b: &Body) -> (PVec2, f32) {
        let c = b.centroid();
        let n = b.boundary.len() as f32;
        let sgn = hull_sign(b);
        let (mut s, mut d) = (0.0, 0.0);
        for (k, p) in b.outline().enumerate() {
            let l = hull_dir(k as f32, n, sgn);
            let w = p - c;
            s += l.perp_dot(w);
            d += l.dot(w);
        }
        (c, s.atan2(d))
    }

    /// Unit-disc point of a world point on (or near) the hull: found on
    /// the material hull itself, so it is exact however squashed the blob.
    fn hull_local(b: &Body, world: PVec2) -> PVec2 {
        let pts: Vec<PVec2> = b.outline().collect();
        let n = pts.len();
        if n < 3 {
            return PVec2::X;
        }
        let mut best = (f32::MAX, 0.0);
        for k in 0..n {
            let (a, e) = (pts[k], pts[(k + 1) % n]);
            let ab = e - a;
            let t = ((world - a).dot(ab) / ab.length_squared().max(1e-6)).clamp(0.0, 1.0);
            let d = (a + ab * t).distance_squared(world);
            if d < best.0 {
                best = (d, k as f32 + t);
            }
        }
        hull_dir(best.1, n as f32, hull_sign(b))
    }

    /// Drop a new ink in at world point `contact`.
    fn add(&mut self, b: &Body, col: Color, contact: PVec2) {
        if self.inks.len() >= MAX_INKS {
            // Bake the oldest into the base so nothing pops.
            let old = self.inks.remove(0);
            for k in 0..G * G {
                let a = cover(old.c[k]);
                for ch in 0..3 {
                    self.base[ch][k] += (old.col[ch] - self.base[ch][k]) * a;
                }
            }
        }
        let dir = Self::hull_local(b, contact);
        let src = dir * 0.86;
        let mut c = vec![0.0; G * G];
        for (k, v) in c.iter_mut().enumerate() {
            let d2 = cell_pos(k % G, k / G).distance_squared(src);
            *v = 0.95 * (-d2 / (0.13 * 0.13)).exp();
        }
        let n = self.inks.len() as f32;
        let curl = if (self.seed * 7.3 + n * 1.7).sin() > 0.0 { 1.0 } else { -1.0 } * (0.7 + 0.3 * (self.seed * 3.1 + n).cos().abs());
        let head = src - dir * 0.04;
        self.inks.push(Ink { col: rgb(col), head, legs: [head; 2], c, src, dive: -dir, age: 0.0, curl });
    }

    /// Velocity of the shared flow at unit-disc point `p`.
    fn flow(&self, p: PVec2) -> PVec2 {
        let t = self.time;
        let mut u = PVec2::ZERO;
        // Stir: strongest just after a drop, calming as it settles.
        let stir = self.inks.iter().map(|i| (-i.age / 1.8).exp()).fold(0.0f32, f32::max) * 0.5 + 0.5;
        // Curl-noise eddies (divergence-free plane-wave stream function).
        for o in 0..5 {
            let of = o as f32;
            let ang = self.seed * 11.0 + of * 2.39996;
            let d = PVec2::from_angle(ang);
            let k = 2.4 + of * 1.1;
            let ph = d.dot(p) * k + t * (0.5 + 0.3 * of) + self.seed * 5.0 + of * 1.3;
            let amp = 0.2 / (1.0 + of * 0.4);
            u += PVec2::new(d.y, -d.x) * amp * ph.cos() * stir;
        }
        // Each drop plunges in as a little vortex pair (a 2D smoke ring)
        // carrying its ink with it, then splits into two smaller pairs
        // that fan out (the ink's legs). Its curl makes one side roll harder.
        for ink in &self.inks {
            let (circ, gap) = ink.pair();
            if circ > 0.0 {
                u += vortex_pair(p, ink.head, ink.dive, gap, circ, ink.curl);
            }
            let (lc, lg) = ink.legs_pair();
            if lc > 0.0 {
                for (n, s) in [1.0f32, -1.0].into_iter().enumerate() {
                    u += vortex_pair(p, ink.legs[n], ink.leg_dir(s), lg, lc, ink.curl * s);
                }
            }
        }
        // Slosh: the fluid lags the blob's moves and spin.
        let wall = (1.0 - p.length_squared()).max(0.0);
        u += self.slosh * wall;
        u += PVec2::new(-p.y, p.x) * self.spin;
        u
    }

    /// Advance the ink by `dt`; returns false once it has fully settled.
    fn step(&mut self, b: &Body, dt: f32) -> bool {
        let dt = dt.clamp(0.0, 1.0 / 20.0);
        if dt <= 0.0 || self.inks.is_empty() {
            return !self.inks.is_empty();
        }
        self.time += dt;
        let r = (b.area().abs() / std::f32::consts::PI).sqrt().max(1.0);
        // Body frame and slosh.
        let (_, phi) = self.frame(b);
        let vel = b.velocity();
        let omega = wrap(phi - self.phi) / dt;
        self.phi = phi;
        if let Some((pv, pw)) = self.prev {
            let acc = ((vel - pv) / dt).clamp_length_max(6000.0);
            let alpha = ((omega - pw) / dt).clamp(-400.0, 400.0);
            let acc_l = rot(acc, -phi) / r;
            // A damped spring: the ink sloshes back and settles.
            self.slosh += (-acc_l * 0.035 - self.slosh * 3.0) * dt;
            self.slosh = self.slosh.clamp_length_max(2.5);
            self.spin += (-alpha * 0.35 - self.spin * 2.5) * dt;
            self.spin = self.spin.clamp(-4.0, 4.0);
        }
        self.prev = Some((vel, omega));
        for ink in &mut self.inks {
            ink.age += dt;
            ink.advance(dt);
        }
        // Velocity per cell (shared by every ink).
        for k in 0..G * G {
            self.vel[k] = if self.inside[k] { self.flow(cell_pos(k % G, k / G)) } else { PVec2::ZERO };
        }
        let h = 2.0 * EXT / G as f32;
        let diff = |d: f32| (d * dt / (h * h)).min(0.2);
        let newest = self.inks.len() - 1;
        let inside = std::mem::take(&mut self.inside);
        let edge = std::mem::take(&mut self.edge);
        let vel = std::mem::take(&mut self.vel);
        let mut tmp = std::mem::take(&mut self.tmp);
        let mut hat = vec![0.0; G * G];
        let trace = |k: usize, s: f32| {
            let p = cell_pos(k % G, k / G);
            let mid = p - vel[k] * dt * 0.5 * s;
            (p - sample_v(&vel, mid) * dt * s).clamp_length_max(0.97)
        };
        let back: Vec<PVec2> = (0..G * G).map(|k| if inside[k] { trace(k, 1.0) } else { PVec2::ZERO }).collect();
        let fwd: Vec<PVec2> = (0..G * G).map(|k| if inside[k] { trace(k, -1.0) } else { PVec2::ZERO }).collect();
        let mut advect = |f: &mut Vec<f32>, tmp: &mut Vec<f32>, diff: f32| {
            // MacCormack: semi-Lagrangian there and back again, correct
            // the error, clamp to the source cell's range (crisp wisps
            // without overshoot).
            for k in 0..G * G {
                if inside[k] {
                    hat[k] = sample(f, back[k]);
                }
            }
            for k in 0..G * G {
                if !inside[k] {
                    hat[k] = hat[edge[k]];
                }
            }
            for k in 0..G * G {
                if !inside[k] {
                    continue;
                }
                let bar = sample(&hat, fwd[k]);
                let (lo, hi) = range(f, back[k]);
                tmp[k] = (hat[k] + 0.5 * (f[k] - bar)).clamp(lo, hi);
            }
            // Soft diffusion with no flux through the wall.
            for k in 0..G * G {
                if !inside[k] {
                    continue;
                }
                let (i, j) = (k % G, k / G);
                let c = tmp[k];
                let nb = |ii: isize, jj: isize| {
                    if ii < 0 || jj < 0 || ii >= G as isize || jj >= G as isize {
                        return c;
                    }
                    let q = jj as usize * G + ii as usize;
                    if inside[q] { tmp[q] } else { c }
                };
                let (ii, jj) = (i as isize, j as isize);
                let lap = nb(ii - 1, jj) + nb(ii + 1, jj) + nb(ii, jj - 1) + nb(ii, jj + 1) - 4.0 * c;
                f[k] = c + diff * lap;
            }
            for k in 0..G * G {
                if !inside[k] {
                    f[k] = f[edge[k]];
                }
            }
        };
        for ink in self.inks.iter_mut() {
            advect(&mut ink.c, &mut tmp, diff(0.006));
        }
        for ch in self.base.iter_mut() {
            advect(ch, &mut tmp, diff(0.006));
        }
        self.tmp = tmp;
        self.vel = vel;
        self.inside = inside;
        self.edge = edge;
        // Sources and the final takeover.
        let mut settled = false;
        for (n, ink) in self.inks.iter_mut().enumerate() {
            let feed = (1.0 - ink.age / 0.9).max(0.0);
            let take = if n == newest { smoothstep(TAKE_START, TAKE_START + TAKE_RAMP, ink.age) } else { 0.0 };
            for k in 0..G * G {
                if !self.inside[k] {
                    continue;
                }
                let c = &mut ink.c[k];
                if feed > 0.0 {
                    let d2 = cell_pos(k % G, k / G).distance_squared(ink.src);
                    *c += dt * 10.0 * feed * (-d2 / (0.13 * 0.13)).exp() * (1.0 - *c);
                }
                // Last of all, a gentle wash makes sure it fills.
                let wash = smoothstep(TAKE_START + TAKE_RAMP + 0.6, TAKE_START + TAKE_RAMP + 1.6, ink.age);
                *c += dt * 2.5 * wash * (1.0 - *c);
                *c = c.clamp(0.0, 1.0);
            }
            if take > 0.0 {
                bloom(&mut ink.c, &mut self.tmp, &self.inside, ink.src, take, dt, self.seed);
                for k in 0..G * G {
                    if !self.inside[k] {
                        ink.c[k] = ink.c[self.edge[k]];
                    }
                }
            }
            if n == newest {
                settled = (0..G * G).all(|k| !self.inside[k] || cover(ink.c[k]) >= 0.999);
            }
        }
        let age = self.inks[newest].age;
        !(settled && age > TAKE_START) && age < MAX_AGE
    }

    /// Colour at unit-disc point `p`.
    pub fn color_at(&self, p: PVec2) -> Color {
        let p = p.clamp_length_max(0.97);
        let mut col = [sample(&self.base[0], p), sample(&self.base[1], p), sample(&self.base[2], p)];
        for ink in &self.inks {
            let c = sample(&ink.c, p);
            let a = cover(c);
            if a <= 0.0 {
                continue;
            }
            // Thin ink reads denser at its tendrils: a touch deeper there.
            let dense = 4.0 * c * (1.0 - c) * (1.0 - smoothstep(0.55, 0.95, c));
            let ic = lerp3(ink.col, [ink.col[0] * 0.8, ink.col[1] * 0.8, ink.col[2] * 0.8], dense * 0.35);
            col = lerp3(col, ic, a);
        }
        Color::srgb(col[0].clamp(0.0, 1.0), col[1].clamp(0.0, 1.0), col[2].clamp(0.0, 1.0))
    }

    /// Average colour (for glows).
    pub fn mean_color(&self) -> Color {
        let mut acc = [0.0f32; 3];
        let pts = [PVec2::ZERO, PVec2::new(0.6, 0.0), PVec2::new(-0.6, 0.0), PVec2::new(0.0, 0.6), PVec2::new(0.0, -0.6)];
        for p in pts {
            let c = self.color_at(p).to_srgba();
            acc[0] += c.red / 5.0;
            acc[1] += c.green / 5.0;
            acc[2] += c.blue / 5.0;
        }
        Color::srgb(acc[0], acc[1], acc[2])
    }

    /// World offset from the centroid (in blob radii) → unit disc.
    pub fn to_local(&self, off: PVec2) -> PVec2 {
        rot(off, -self.phi)
    }
}

/// The takeover: the ink grows out from wherever it is dense as a soft
/// travelling front (bistable reaction–diffusion), so it keeps its
/// tendrilly shape while it fills the blob instead of fading in evenly.
fn bloom(c: &mut [f32], tmp: &mut [f32], inside: &[bool], src: PVec2, take: f32, dt: f32, seed: f32) {
    let h = 2.0 * EXT / G as f32;
    let (d, k, a) = (0.12 * take, 30.0 * take, 0.2);
    let subs = ((d * dt / (h * h)) / 0.2).ceil().max(1.0) as usize;
    let dts = dt / subs as f32;
    // Thinned-out wisps thicken back up in their own shape (so the
    // front starts from all of them), and the densest spot stays a seed.
    let (mut top, mut at) = (0.0f32, src);
    for q in 0..G * G {
        if inside[q] && c[q] > top {
            top = c[q];
            at = cell_pos(q % G, q / G);
        }
    }
    let gain = (1.0 / top.max(0.05)).powf((dt * take * 2.5).min(1.0));
    for (q, v) in c.iter_mut().enumerate() {
        if inside[q] {
            let d2 = cell_pos(q % G, q / G).distance_squared(at);
            *v = (*v * gain).min(1.0).max(take * (-d2 / 0.03).exp());
        }
    }
    for _ in 0..subs {
        tmp.copy_from_slice(c);
        for q in 0..G * G {
            if !inside[q] {
                continue;
            }
            let (i, j) = ((q % G) as isize, (q / G) as isize);
            let v = tmp[q];
            let nb = |ii: isize, jj: isize| {
                if ii < 0 || jj < 0 || ii >= G as isize || jj >= G as isize {
                    return v;
                }
                let r = jj as usize * G + ii as usize;
                if inside[r] { tmp[r] } else { v }
            };
            let lap = nb(i - 1, j) + nb(i + 1, j) + nb(i, j - 1) + nb(i, j + 1) - 4.0 * v;
            // A lumpy threshold: the front runs ahead in fingers.
            let p = cell_pos(q % G, q / G);
            let lump = (p.x * 7.0 + seed * 3.0).sin() * (p.y * 6.0 - seed).cos() + 0.6 * (p.x * 11.0 - p.y * 9.0 + seed * 2.0).sin();
            let a = (a + 0.16 * lump).clamp(0.02, 0.45);
            c[q] = (v + dts * (d * lap / (h * h) + k * v * (1.0 - v) * (v - a))).clamp(0.0, 1.0);
        }
    }
}

/// Flow of a vortex pair centred at `at` travelling along `dir`, cores
/// `gap` either side; `curl` (±1) makes one core spin harder.
fn vortex_pair(p: PVec2, at: PVec2, dir: PVec2, gap: f32, circ: f32, curl: f32) -> PVec2 {
    let side = dir.perp();
    let mut u = PVec2::ZERO;
    for s in [1.0f32, -1.0] {
        let r = p - (at + side * gap * s);
        let d2 = r.length_squared() + 0.012;
        let gamma = circ * s * (1.0 + 0.4 * curl * s);
        u += r.perp() * gamma / (std::f32::consts::TAU * d2);
    }
    u
}

/// Min and max of the four cells a bilinear sample at `p` reads.
fn range(f: &[f32], p: PVec2) -> (f32, f32) {
    let h = 2.0 * EXT / G as f32;
    let gx = ((p.x + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let gy = ((p.y + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let (i, j) = (gx as usize, gy as usize);
    let v = [f[j * G + i], f[j * G + i + 1], f[(j + 1) * G + i], f[(j + 1) * G + i + 1]];
    (v.iter().copied().fold(f32::MAX, f32::min), v.iter().copied().fold(f32::MIN, f32::max))
}

fn sample_v(v: &[PVec2], p: PVec2) -> PVec2 {
    let h = 2.0 * EXT / G as f32;
    let gx = ((p.x + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let gy = ((p.y + EXT) / h - 0.5).clamp(0.0, (G - 1) as f32 - 1e-4);
    let (i, j) = (gx as usize, gy as usize);
    let (fx, fy) = (gx - i as f32, gy - j as f32);
    let at = |i: usize, j: usize| v[j * G + i];
    at(i, j).lerp(at(i + 1, j), fx).lerp(at(i, j + 1).lerp(at(i + 1, j + 1), fx), fy)
}

/// Every live ink field, by body.
#[derive(Default)]
pub struct Inks(HashMap<BodyId, InkField>);

impl Inks {
    /// A new colour was eaten at world point `contact`; `from` is what
    /// the blob looked like before (only used when no ink is live).
    pub fn add(&mut self, id: BodyId, b: &Body, from: Color, to: Color, contact: PVec2) {
        let seed = (id.index as f32 * 0.618 + self.0.len() as f32 * 0.31).fract() * 6.0 + 0.5;
        let f = self.0.entry(id).or_insert_with(|| InkField::new(b, from, seed));
        f.add(b, to, contact);
    }

    pub fn get(&self, id: BodyId) -> Option<&InkField> {
        self.0.get(&id)
    }

    /// Step the field for `id` (drops it once settled).
    pub fn step(&mut self, id: BodyId, b: &Body, dt: f32) {
        if let Some(f) = self.0.get_mut(&id) {
            if !f.step(b, dt) {
                self.0.remove(&id);
            }
        }
    }

    /// Forget fields whose bodies are gone.
    pub fn retain(&mut self, mut keep: impl FnMut(BodyId) -> bool) {
        self.0.retain(|id, _| keep(*id));
    }
}

/// Dev hook: `BB_AMOEBA=frame:deg[,frame:deg…]` slides the next living
/// amoeba up against player 1 from angle `deg` (0 = right, 90 = above) on
/// that frame, so the real eat path runs from a known side.
pub fn dev_amoeba(game: Option<ResMut<crate::sim::Game>>, mut frame: Local<u32>) {
    *frame += 1;
    let Some(mut g) = game else { return };
    let spec = std::env::var("BB_AMOEBA").unwrap_or_default();
    for item in spec.split(',') {
        let Some((f, deg)) = item.split_once(':') else { continue };
        let (Ok(f), Ok(deg)) = (f.trim().parse::<u32>(), deg.trim().parse::<f32>()) else { continue };
        if f != *frame {
            continue;
        }
        let Some((c, r)) = g.sim.player(0).and_then(|p| g.sim.world.body(p.ctl.body).map(|b| (b.centroid(), p.ctl.radius * p.ctl.expand))) else { continue };
        let Some(id) = g.sim.amoebas.iter().flatten().copied().next() else { continue };
        let at = c + PVec2::from_angle(deg.to_radians()) * (r + 4.0);
        if let Some(a) = g.sim.world.body_mut(id) {
            let d = at - a.centroid();
            a.translate(d);
            for h in a.home.iter_mut().flatten() {
                *h += d;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bb_physics::{BodyDesc, World};

    fn blob() -> (World, BodyId) {
        let mut w = World::new(Default::default());
        let id = w.add_body(BodyDesc::blob(PVec2::ZERO, 40.0, 20, 1.0));
        (w, id)
    }

    /// Runs one ink to completion: it must settle on the eaten colour and
    /// drop the field.
    #[test]
    fn settles_on_last_colour() {
        let (w, id) = blob();
        let b = w.body(id).unwrap();
        let mut inks = Inks::default();
        let red = Color::srgb(1.0, 0.3, 0.4);
        let green = Color::srgb(0.4, 0.95, 0.75);
        let blue = Color::srgb(0.5, 0.8, 1.0);
        inks.add(id, b, red, green, PVec2::new(40.0, 0.0));
        for _ in 0..20 {
            inks.step(id, b, 1.0 / 60.0);
        }
        inks.add(id, b, red, blue, PVec2::new(-40.0, 0.0));
        let mut frames = 0;
        while inks.get(id).is_some() && frames < 1200 {
            inks.step(id, b, 1.0 / 60.0);
            frames += 1;
            if let Some(f) = inks.get(id) {
                // Shortly before it's dropped it must already look blue.
                let c = f.color_at(PVec2::new(0.5, 0.2)).to_srgba();
                assert!(c.red.is_finite());
            }
        }
        assert!(inks.get(id).is_none(), "ink never settled");
        assert!(frames > 120, "settled too fast ({frames} frames)");
    }

    /// `BB_INK_PPM=path cargo test -p bb-game ink::tests::film -- --ignored`
    /// writes a strip of the field over time (for tuning).
    #[test]
    #[ignore]
    fn film() {
        let Ok(path) = std::env::var("BB_INK_PPM") else { return };
        let (w, id) = blob();
        let b = w.body(id).unwrap();
        let mut inks = Inks::default();
        let red = Color::srgb(1.0, 0.36, 0.45);
        let cols = [Color::srgb(0.49, 0.96, 0.76), Color::srgb(1.0, 0.88, 0.4), Color::srgb(0.56, 0.83, 1.0), Color::srgb(0.78, 0.64, 1.0)];
        let multi = std::env::var("BB_INK_MULTI").is_ok();
        let (cell, cols_n, shots) = (72usize, 8usize, 24usize);
        let mut img = vec![[20u8; 3]; cell * cols_n * cell * shots.div_ceil(cols_n)];
        let width = cell * cols_n;
        let mut frame = 0;
        inks.add(id, b, red, cols[0], PVec2::new(40.0, 0.0));
        for s in 0..shots {
            for _ in 0..12 {
                frame += 1;
                if multi {
                    for (k, (f, ang)) in [(15, 90.0f32), (30, 200.0), (45, 300.0)].iter().enumerate() {
                        if frame == *f {
                            inks.add(id, b, red, cols[k + 1], PVec2::from_angle(ang.to_radians()) * 40.0);
                        }
                    }
                }
                inks.step(id, b, 1.0 / 60.0);
            }
            let (ox, oy) = ((s % cols_n) * cell, (s / cols_n) * cell);
            for y in 0..cell {
                for x in 0..cell {
                    let p = PVec2::new(x as f32 / cell as f32 * 2.2 - 1.1, 1.1 - y as f32 / cell as f32 * 2.2);
                    if p.length() > 1.0 {
                        continue;
                    }
                    let c = inks.get(id).map_or(cols[if multi { 3 } else { 0 }], |f| f.color_at(p)).to_srgba();
                    img[(oy + y) * width + ox + x] = [(c.red * 255.0) as u8, (c.green * 255.0) as u8, (c.blue * 255.0) as u8];
                }
            }
        }
        let mut out = format!("P6 {} {} 255\n", width, img.len() / width).into_bytes();
        out.extend(img.iter().flatten());
        std::fs::write(path, out).unwrap();
    }
}
