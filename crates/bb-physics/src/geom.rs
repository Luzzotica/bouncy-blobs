//! Small 2D geometry helpers shared by the solver and the body builders.

use glam::Vec2;

/// Signed area of a closed polygon (positive when counter-clockwise).
pub fn signed_area(pts: impl Iterator<Item = Vec2> + Clone) -> f32 {
    let mut it = pts.clone();
    let Some(first) = it.next() else { return 0.0 };
    let mut prev = first;
    let mut sum = 0.0;
    for p in it {
        sum += prev.perp_dot(p);
        prev = p;
    }
    sum += prev.perp_dot(first);
    0.5 * sum
}

pub fn signed_area_slice(pts: &[Vec2]) -> f32 {
    signed_area(pts.iter().copied())
}

pub fn centroid(pts: &[Vec2]) -> Vec2 {
    if pts.is_empty() {
        return Vec2::ZERO;
    }
    pts.iter().copied().sum::<Vec2>() / pts.len() as f32
}

/// Closest point on segment `a..b` to `p`. Returns (point, t in [0,1]).
#[inline]
pub fn closest_on_segment(p: Vec2, a: Vec2, b: Vec2) -> (Vec2, f32) {
    let ab = b - a;
    let len2 = ab.length_squared();
    if len2 <= f32::EPSILON {
        return (a, 0.0);
    }
    let t = ((p - a).dot(ab) / len2).clamp(0.0, 1.0);
    (a + ab * t, t)
}

/// Even-odd point-in-polygon test over an index loop into `pts`.
pub fn point_in_loop(p: Vec2, pts: &[Vec2], ring: &[u32]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = pts[ring[i] as usize];
        let b = pts[ring[j] as usize];
        if (a.y > p.y) != (b.y > p.y) {
            let x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
            if p.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = poly[i];
        let b = poly[j];
        if (a.y > p.y) != (b.y > p.y) {
            let x = (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x;
            if p.x < x {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Aabb {
    pub min: Vec2,
    pub max: Vec2,
}

impl Aabb {
    pub const EMPTY: Aabb = Aabb { min: Vec2::splat(f32::MAX), max: Vec2::splat(f32::MIN) };

    pub fn from_points(pts: impl Iterator<Item = Vec2>) -> Aabb {
        let mut bb = Aabb::EMPTY;
        for p in pts {
            bb.min = bb.min.min(p);
            bb.max = bb.max.max(p);
        }
        bb
    }

    pub fn expand(self, r: f32) -> Aabb {
        Aabb { min: self.min - Vec2::splat(r), max: self.max + Vec2::splat(r) }
    }

    pub fn union(self, o: Aabb) -> Aabb {
        Aabb { min: self.min.min(o.min), max: self.max.max(o.max) }
    }

    pub fn overlaps(&self, o: &Aabb) -> bool {
        self.min.x <= o.max.x && self.max.x >= o.min.x && self.min.y <= o.max.y && self.max.y >= o.min.y
    }

    pub fn contains(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }

    pub fn center(&self) -> Vec2 {
        (self.min + self.max) * 0.5
    }
}

/// Ear-clipping triangulation of a simple polygon (either winding).
/// Returns triangles as CCW index triples into `poly`.
pub fn triangulate(poly: &[Vec2]) -> Vec<[u32; 3]> {
    let n = poly.len();
    if n < 3 {
        return Vec::new();
    }
    let ccw = signed_area_slice(poly) > 0.0;
    let mut idx: Vec<u32> = if ccw { (0..n as u32).collect() } else { (0..n as u32).rev().collect() };
    let mut tris = Vec::with_capacity(n - 2);
    let mut guard = 0;
    while idx.len() > 3 && guard < n * n {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for i in 0..m {
            let ia = idx[(i + m - 1) % m];
            let ib = idx[i];
            let ic = idx[(i + 1) % m];
            let (a, b, c) = (poly[ia as usize], poly[ib as usize], poly[ic as usize]);
            if (b - a).perp_dot(c - b) <= 1e-9 {
                continue; // reflex or degenerate
            }
            let blocked = idx.iter().any(|&k| {
                k != ia && k != ib && k != ic && point_in_triangle(poly[k as usize], a, b, c)
            });
            if blocked {
                continue;
            }
            tris.push([ia, ib, ic]);
            idx.remove(i);
            clipped = true;
            break;
        }
        if !clipped {
            // Degenerate input (self-touching / collinear run): fan the rest.
            break;
        }
    }
    for i in 1..idx.len().saturating_sub(1) {
        tris.push([idx[0], idx[i], idx[i + 1]]);
    }
    tris
}

pub fn point_in_triangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2) -> bool {
    let d1 = (b - a).perp_dot(p - a);
    let d2 = (c - b).perp_dot(p - b);
    let d3 = (a - c).perp_dot(p - c);
    d1 >= 0.0 && d2 >= 0.0 && d3 >= 0.0
}

/// Rotation angle that best maps `rest` onto `cur` (both centred), the 2D
/// polar-decomposition used by shape matching.
pub fn best_fit_angle(rest: &[Vec2], cur: &[Vec2], weights: &[f32]) -> f32 {
    let mut s_dot = 0.0;
    let mut s_cross = 0.0;
    for ((r, c), w) in rest.iter().zip(cur).zip(weights) {
        s_dot += w * r.dot(*c);
        s_cross += w * r.perp_dot(*c);
    }
    s_cross.atan2(s_dot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn square_area_and_triangulation() {
        let sq = [Vec2::new(0., 0.), Vec2::new(2., 0.), Vec2::new(2., 2.), Vec2::new(0., 2.)];
        assert!((signed_area_slice(&sq) - 4.0).abs() < 1e-6);
        let tris = triangulate(&sq);
        assert_eq!(tris.len(), 2);
        let total: f32 = tris
            .iter()
            .map(|t| signed_area_slice(&[sq[t[0] as usize], sq[t[1] as usize], sq[t[2] as usize]]))
            .sum();
        assert!((total - 4.0).abs() < 1e-5);
    }

    #[test]
    fn concave_triangulation_covers_area() {
        // An "L" shape.
        let l = [
            Vec2::new(0., 0.),
            Vec2::new(3., 0.),
            Vec2::new(3., 1.),
            Vec2::new(1., 1.),
            Vec2::new(1., 3.),
            Vec2::new(0., 3.),
        ];
        let tris = triangulate(&l);
        assert_eq!(tris.len(), 4);
        let total: f32 = tris
            .iter()
            .map(|t| signed_area_slice(&[l[t[0] as usize], l[t[1] as usize], l[t[2] as usize]]))
            .sum();
        assert!((total - 5.0).abs() < 1e-5, "area {total}");
        assert!(tris.iter().all(|t| signed_area_slice(&[l[t[0] as usize], l[t[1] as usize], l[t[2] as usize]]) > 0.0));
    }
}
