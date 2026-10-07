//! Craggy rock. Solid terrain keeps its exact collider polygon for physics,
//! but is drawn with a jagged silhouette: deterministic noise pushes the
//! outline of walls, undersides and overhangs in (and a few px out), while
//! walkable tops stay smooth so the surface you land on reads cleanly.
//! Inside the rock: faint cracks and a few dim mineral flecks.

use bb_physics::{Vec2 as PVec2, geom};
use bevy::prelude::*;

use crate::palette::{darken, lighten, lin, mix};
use crate::render::{MeshBuf, ccw, la};

// ------------------------------------------------------------------ noise

/// Deterministic hash of an integer lattice point, 0..1.
pub fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (y as u32).wrapping_mul(0xd816_3841) ^ seed.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1_e995);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    (h & 0x00ff_ffff) as f32 / 16_777_215.0
}

/// Hash of a single integer, 0..1.
pub fn hash1(i: i32, seed: u32) -> f32 {
    hash(i, i.wrapping_mul(7) ^ 0x51ed, seed)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

pub fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Value noise in -1..1. Linear interpolation keeps it faceted, which reads
/// as broken stone rather than smooth waves.
pub fn vnoise(p: PVec2, seed: u32) -> f32 {
    let (fx, fy) = (p.x.floor(), p.y.floor());
    let (ix, iy) = (fx as i32, fy as i32);
    let (tx, ty) = (p.x - fx, p.y - fy);
    let a = hash(ix, iy, seed);
    let b = hash(ix + 1, iy, seed);
    let c = hash(ix, iy + 1, seed);
    let d = hash(ix + 1, iy + 1, seed);
    lerp(lerp(a, b, tx), lerp(c, d, tx), ty) * 2.0 - 1.0
}

/// Smooth value noise in -1..1 (smoothstep-interpolated, for soft fields).
pub fn snoise(p: PVec2, seed: u32) -> f32 {
    let (fx, fy) = (p.x.floor(), p.y.floor());
    let (ix, iy) = (fx as i32, fy as i32);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (tx, ty) = (s(p.x - fx), s(p.y - fy));
    let a = hash(ix, iy, seed);
    let b = hash(ix + 1, iy, seed);
    let c = hash(ix, iy + 1, seed);
    let d = hash(ix + 1, iy + 1, seed);
    lerp(lerp(a, b, tx), lerp(c, d, tx), ty) * 2.0 - 1.0
}

/// Rock-edge displacement profile in -1..1 at a world point.
pub fn crag_noise(p: PVec2, seed: u32) -> f32 {
    let n = 0.55 * vnoise(p / 64.0, seed) + 0.3 * vnoise(p / 21.0, seed ^ 0x9e37) + 0.15 * vnoise(p / 7.5, seed ^ 0x7f4a);
    (n * 1.8).clamp(-1.0, 1.0)
}

// ---------------------------------------------------------------- outline

/// A roughened outline (CCW). `top[i]` marks the segment `pts[i] → pts[i+1]`
/// as part of a smooth walkable top.
pub struct Crag {
    pub pts: Vec<PVec2>,
    pub top: Vec<bool>,
}

#[derive(Clone, Copy, Debug)]
pub struct CragParams {
    /// Max px the silhouette may poke out into play space (walls/ceilings).
    pub out_amp: f32,
    /// Max px it may bite into the rock.
    pub in_amp: f32,
    /// Sample spacing along rough edges.
    pub spacing: f32,
    pub seed: u32,
}

/// Outward normal of the CCW edge a→b.
pub fn edge_normal(a: PVec2, b: PVec2) -> PVec2 {
    let d = b - a;
    PVec2::new(d.y, -d.x).normalize_or_zero()
}

/// An edge you can stand on: its outward normal points mostly up.
pub fn is_walkable(n: PVec2) -> bool {
    n.y > 0.55
}

/// Roughen `poly` (any winding). Walkable tops and the corners next to them
/// are left exactly in place; walls, slopes too steep to stand on and
/// undersides are displaced along their normals. Outward pokes are only
/// allowed on walls and ceilings (never on anything facing up), so the
/// silhouette never rises above a surface you can land on.
pub fn crag_outline(poly: &[PVec2], p: &CragParams) -> Crag {
    let poly = ccw(poly.to_vec());
    let n = poly.len();
    let mut out = Crag { pts: Vec::new(), top: Vec::new() };
    if n < 3 {
        return out;
    }
    let en: Vec<PVec2> = (0..n).map(|i| edge_normal(poly[i], poly[(i + 1) % n])).collect();
    // Roughness weight and outward allowance per edge.
    let ew: Vec<f32> = en.iter().map(|e| if is_walkable(*e) { 0.0 } else { 1.0 - smoothstep(0.15, 0.55, e.y) }).collect();
    let eo: Vec<f32> = en.iter().map(|e| 1.0 - smoothstep(-0.05, 0.2, e.y)).collect();
    let prev = |i: usize| (i + n - 1) % n;
    let vw = |i: usize| ew[i % n].min(ew[prev(i % n)]);
    let vo = |i: usize| eo[i % n].min(eo[prev(i % n)]);
    let vn = |i: usize| (en[i % n] + en[prev(i % n)]).normalize_or(en[i % n]);
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let len = (b - a).length();
        let k = if ew[i] > 0.0 { (len / p.spacing).ceil().max(1.0) as usize } else { 1 };
        let taper = (len * 0.5).min(30.0).max(1.0);
        for s in 0..k {
            let t = s as f32 / k as f32;
            let q = a + (b - a) * t;
            let (w, o, nr) = if s == 0 {
                (vw(i), vo(i), vn(i))
            } else {
                let (d0, d1) = (t * len, (1.0 - t) * len);
                let (end_w, end_o, d) = if d0 < d1 { (vw(i), vo(i), d0) } else { (vw(i + 1), vo(i + 1), d1) };
                let m = smoothstep(0.0, taper, d);
                (lerp(end_w, ew[i], m), lerp(end_o, eo[i], m), en[i])
            };
            let z = crag_noise(q, p.seed);
            let disp = if z > 0.0 { z * p.out_amp * o } else { z * p.in_amp } * w;
            out.pts.push(q + nr * disp);
            out.top.push(ew[i] == 0.0);
        }
    }
    out
}

fn segs_cross(a: PVec2, b: PVec2, c: PVec2, d: PVec2) -> bool {
    let o = |p: PVec2, q: PVec2, r: PVec2| (q - p).perp_dot(r - p);
    let (d1, d2, d3, d4) = (o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d));
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

/// Does the loop cross itself? (Brute force with an AABB reject; fine for
/// load-time geometry.)
pub fn self_intersects(pts: &[PVec2]) -> bool {
    let n = pts.len();
    for i in 0..n {
        let (a, b) = (pts[i], pts[(i + 1) % n]);
        let (lo, hi) = (a.min(b), a.max(b));
        for j in (i + 2)..n {
            if i == 0 && j == n - 1 {
                continue;
            }
            let (c, d) = (pts[j], pts[(j + 1) % n]);
            if c.max(d).x < lo.x || c.min(d).x > hi.x || c.max(d).y < lo.y || c.min(d).y > hi.y {
                continue;
            }
            if segs_cross(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

/// Triangulate, returning None if the result doesn't cover the polygon
/// (self-touching or degenerate input).
pub fn fill_tris(pts: &[PVec2]) -> Option<Vec<[u32; 3]>> {
    if pts.len() < 3 || self_intersects(pts) {
        return None;
    }
    let tris = geom::triangulate(pts);
    let area: f32 = tris
        .iter()
        .map(|t| {
            let (a, b, c) = (pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]);
            ((b - a).perp_dot(c - a) * 0.5).abs()
        })
        .sum();
    let want = geom::signed_area_slice(pts).abs();
    ((area - want).abs() <= want * 0.004 + 2.0).then_some(tris)
}

// ------------------------------------------------------------------- draw

/// Colours for a rock mass.
#[derive(Clone, Copy, Debug)]
pub struct RockLook {
    pub fill: Color,
    /// Rim along walkable tops (unchanged from the clean look).
    pub rim: Color,
    pub rim_w: f32,
    /// Faint light catching the up-facing facets of rough edges.
    pub lit: Color,
    pub crack: Color,
    pub fleck: Color,
    /// 0..1 how rough; scales the displacement.
    pub rough: f32,
    /// Flecks and cracks at all (off for light themes' stone).
    pub detail: bool,
}

/// A whole rock polygon: rough silhouette, rim light, bevel, cracks, flecks.
pub fn rock_mesh(poly: &[PVec2], look: &RockLook, seed: u32, buf: &mut MeshBuf) {
    if poly.len() < 3 {
        return;
    }
    let orig = ccw(poly.to_vec());
    let bb = bb_physics::Aabb::from_points(orig.iter().copied());
    let thick = (bb.max.x - bb.min.x).min(bb.max.y - bb.min.y);
    let scale = (thick / 120.0).clamp(0.2, 1.0) * look.rough;
    let mut chosen = None;
    for amp in [1.0f32, 0.55, 0.3, 0.0] {
        let p = CragParams { out_amp: 8.0 * amp * scale, in_amp: 22.0 * amp * scale, spacing: 10.0, seed };
        let c = crag_outline(&orig, &p);
        if let Some(t) = fill_tris(&c.pts) {
            chosen = Some((c, t));
            break;
        }
    }
    let (crag, tris) = match chosen {
        Some(x) => x,
        None => {
            let c = crag_outline(&orig, &CragParams { out_amp: 0.0, in_amp: 0.0, spacing: 1.0e9, seed });
            let t = geom::triangulate(&c.pts);
            (c, t)
        }
    };
    let pts = &crag.pts;
    let n = pts.len();

    // Fill: a faint vertical gradient (invisible on pure black).
    let span = (bb.max.y - bb.min.y).max(1.0);
    let base = buf.pos.len() as u32;
    for p in pts {
        let t = ((p.y - bb.min.y) / span).clamp(0.0, 1.0);
        buf.vert(*p, 0.0, lin(mix(darken(look.fill, 0.25), look.fill, t)));
    }
    for t in &tris {
        buf.tri(base + t[0], base + t[1], base + t[2]);
    }

    // Facet normals of the rough outline (for rim light and bevel).
    let fn_: Vec<PVec2> = (0..n).map(|i| edge_normal(pts[(i + n - 1) % n], pts[(i + 1) % n])).collect();

    // Runs: maximal stretches of rough vs. top segments.
    let start = (0..n).find(|&i| crag.top[i] != crag.top[(i + n - 1) % n]).unwrap_or(0);
    let mut runs: Vec<(bool, Vec<usize>)> = Vec::new();
    for k in 0..n {
        let i = (start + k) % n;
        let kind = crag.top[i];
        match runs.last_mut() {
            Some((t, v)) if *t == kind => v.push(i),
            _ => runs.push((kind, vec![i])),
        }
    }
    for (_, v) in runs.iter_mut() {
        let last = *v.last().unwrap();
        v.push((last + 1) % n);
    }

    for (top, run) in &runs {
        let rp: Vec<PVec2> = run.iter().map(|&i| pts[i]).collect();
        let rn: Vec<PVec2> = run.iter().map(|&i| fn_[i]).collect();
        if *top {
            let inset: Vec<PVec2> = rp.iter().zip(&rn).map(|(p, n)| *p - *n * look.rim_w * 0.5).collect();
            buf.stroke(&inset, look.rim_w, 0.001, lin(look.rim));
            continue;
        }
        // Bevel: a soft dim band just inside the rough edge, brighter on
        // facets that face up.
        let cin: Vec<[f32; 4]> = rn.iter().map(|n| la(look.lit, 0.08 + 0.3 * (n.y * 0.5 + 0.5).powi(2))).collect();
        let cout: Vec<[f32; 4]> = rn.iter().map(|_| la(look.lit, 0.0)).collect();
        buf.band(&rp, &rn, 0.0, 16.0 * scale.max(0.5), 0.0005, &cin, &cout);
        // Strata: broken ledge lines a little inside the edge.
        let mut seg: Vec<PVec2> = Vec::new();
        let mut segc: Vec<[f32; 4]> = Vec::new();
        for (k, &i) in run.iter().enumerate() {
            let p = pts[i];
            let z = vnoise(p / 37.0, seed ^ 0x51a7);
            let q = p - rn[k] * (17.0 + 9.0 * vnoise(p / 23.0, seed ^ 0x2b) ) * scale.max(0.5);
            if z > 0.15 && deep_ok(pts, q) {
                seg.push(q);
                segc.push(la(look.lit, (0.18 + 0.25 * (rn[k].y * 0.5 + 0.5)) * smoothstep(0.15, 0.4, z)));
            } else {
                buf.stroke_cols(&seg, 1.3, 0.0006, &segc);
                seg.clear();
                segc.clear();
            }
        }
        buf.stroke_cols(&seg, 1.3, 0.0006, &segc);
        // Rim light: up-facing facets catch the cave glow, down-facing ones
        // fall into shadow.
        let cols: Vec<[f32; 4]> = rn
            .iter()
            .map(|n| {
                let k = (n.y * 0.5 + 0.5).powf(1.6);
                lin(mix(darken(look.rim, 0.55), look.lit, k))
            })
            .collect();
        let inset: Vec<PVec2> = rp.iter().zip(&rn).map(|(p, n)| *p - *n * 0.9).collect();
        buf.stroke_cols(&inset, 1.8, 0.001, &cols);
    }

    if !look.detail {
        return;
    }
    // Interior detail must stay out of the area right under walkable tops.
    let inside = |p: PVec2| geom::point_in_polygon(p, pts);
    let deep = |p: PVec2| inside(p) && inside(p + PVec2::new(0.0, 40.0));

    // Cracks running in from the rough edges.
    let mut acc = 0.0;
    let mut ci = 0i32;
    for (top, run) in &runs {
        if *top {
            continue;
        }
        for w in run.windows(2) {
            acc += pts[w[0]].distance(pts[w[1]]);
            if acc < 64.0 {
                continue;
            }
            acc = 0.0;
            ci += 1;
            let h = |k: i32| hash(ci, k, seed ^ 0xc4a5);
            if h(0) > 0.55 {
                continue;
            }
            let i = w[0];
            let mut p = pts[i] - fn_[i] * 1.5;
            let mut dir = (-fn_[i]).rotate(PVec2::from_angle((h(1) - 0.5) * 1.1));
            let steps = 2 + (h(2) * 4.0) as i32;
            let mut line = vec![p];
            for s in 0..steps {
                let q = p + dir * (6.0 + h(3 + s) * 10.0) * scale.max(0.5);
                if !deep(q) {
                    break;
                }
                line.push(q);
                p = q;
                dir = dir.rotate(PVec2::from_angle((h(10 + s) - 0.5) * 1.3));
            }
            draw_crack(buf, &line, look.crack);
        }
    }

    // Interior cracks and mineral flecks on a jittered grid.
    let cell = 58.0;
    let (gx0, gy0) = ((bb.min.x / cell).floor() as i32, (bb.min.y / cell).floor() as i32);
    let (gx1, gy1) = ((bb.max.x / cell).ceil() as i32, (bb.max.y / cell).ceil() as i32);
    for gy in gy0..gy1 {
        for gx in gx0..gx1 {
            let h = |k: u32| hash(gx, gy, seed.wrapping_mul(31).wrapping_add(k));
            let p = PVec2::new((gx as f32 + h(1)) * cell, (gy as f32 + h(2)) * cell);
            let r = h(0);
            if r < 0.12 {
                // Mineral fleck (sometimes a little cluster).
                if !(deep(p) && inside(p + PVec2::new(12.0, -12.0)) && inside(p + PVec2::new(-12.0, -12.0))) {
                    continue;
                }
                let bright = 0.3 + 0.45 * h(3);
                let col = mix(Color::BLACK, look.fleck, bright);
                if h(4) < 0.35 {
                    buf.halo(p, PVec2::splat(10.0 + 8.0 * h(5)), 0.0006, la(look.fleck, 0.05));
                }
                let count = if h(6) < 0.3 { 3 } else { 1 };
                for k in 0..count {
                    let q = p + if k == 0 { PVec2::ZERO } else { PVec2::new(h(7 + k) - 0.5, h(9 + k) - 0.5) * 12.0 };
                    let s = (1.0 + 1.8 * h(11 + k)) * if k == 0 { 1.0 } else { 0.7 };
                    fleck(buf, q, s, h(13 + k) * 3.0, la(col, 1.0), la(lighten(col, 0.4), 1.0));
                }
            } else if r > 0.93 {
                // A hairline crack in the middle of the rock.
                if !deep(p) {
                    continue;
                }
                let mut q = p;
                let mut dir = PVec2::from_angle(h(3) * std::f32::consts::TAU);
                let mut line = vec![q];
                for s in 0..(3 + (h(4) * 4.0) as u32) {
                    let nq = q + dir * (8.0 + 9.0 * h(5 + s));
                    if !deep(nq) {
                        break;
                    }
                    line.push(nq);
                    q = nq;
                    dir = dir.rotate(PVec2::from_angle((h(12 + s) - 0.5) * 1.2));
                }
                draw_crack(buf, &line, darken(look.crack, 0.2));
            }
        }
    }
}

/// Inside the rock and not right under a walkable top.
fn deep_ok(pts: &[PVec2], p: PVec2) -> bool {
    geom::point_in_polygon(p, pts) && geom::point_in_polygon(p + PVec2::new(0.0, 40.0), pts)
}

/// A tapering hairline crack.
fn draw_crack(buf: &mut MeshBuf, line: &[PVec2], col: Color) {
    let n = line.len();
    if n < 2 {
        return;
    }
    for k in 0..n - 1 {
        let f = 1.0 - k as f32 / (n - 1) as f32;
        buf.stroke(&[line[k], line[k + 1]], 0.7 + 1.1 * f, 0.0007, la(col, 0.25 + 0.4 * f));
    }
}

/// A tiny faceted mineral: a diamond with a lit half.
fn fleck(buf: &mut MeshBuf, p: PVec2, s: f32, ang: f32, dark: [f32; 4], lit: [f32; 4]) {
    let r = PVec2::from_angle(ang);
    let q = |x: f32, y: f32| p + r.rotate(PVec2::new(x, y) * s);
    let c = buf.vert(p, 0.0008, lit);
    let a = buf.vert(q(0.0, 1.6), 0.0008, lit);
    let b = buf.vert(q(-1.0, 0.0), 0.0008, lit);
    let d = buf.vert(q(0.0, -1.3), 0.0008, dark);
    let e = buf.vert(q(1.1, 0.0), 0.0008, dark);
    buf.tri(c, a, b);
    buf.tri(c, b, d);
    buf.tri(c, d, e);
    buf.tri(c, e, a);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(min: PVec2, max: PVec2) -> Vec<PVec2> {
        vec![min, PVec2::new(max.x, min.y), max, PVec2::new(min.x, max.y)]
    }

    #[test]
    fn tops_stay_put_and_nothing_rises_above_them() {
        let poly = rect(PVec2::new(0.0, -400.0), PVec2::new(600.0, 0.0));
        let c = crag_outline(&poly, &CragParams { out_amp: 7.0, in_amp: 15.0, spacing: 11.0, seed: 3 });
        assert!(c.pts.len() > 40);
        for p in &c.pts {
            assert!(p.y <= 1e-3, "rough point {p:?} pokes above the walkable top");
            assert!(p.x >= -7.01 && p.x <= 607.01, "{p:?} pokes out more than out_amp");
        }
        // The two top corners are untouched.
        assert!(c.pts.iter().any(|p| p.distance(PVec2::new(0.0, 0.0)) < 1e-3));
        assert!(c.pts.iter().any(|p| p.distance(PVec2::new(600.0, 0.0)) < 1e-3));
        assert!(fill_tris(&c.pts).is_some());
    }

    #[test]
    fn deterministic() {
        let poly = rect(PVec2::new(0.0, 0.0), PVec2::new(300.0, 300.0));
        let p = CragParams { out_amp: 7.0, in_amp: 15.0, spacing: 11.0, seed: 9 };
        assert_eq!(crag_outline(&poly, &p).pts, crag_outline(&poly, &p).pts);
    }
}
