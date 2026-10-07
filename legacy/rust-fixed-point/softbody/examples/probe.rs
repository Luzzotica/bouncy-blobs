//! Ground truth for the 3.0 port: the 2.x blob (slimeBlob.ts) on flat ground.
use softbody::fx::{Fx, FxVec2};
use softbody::types::{SurfaceMaterial, WorldConfig};
use softbody::world::{AddBlobParams, SoftBodyWorld};

fn f(x: f64) -> Fx { Fx::from_f64(x) }
fn v(x: f64, y: f64) -> FxVec2 { FxVec2::new(f(x), f(y)) }

struct Blob { w: SoftBodyWorld, id: u32, hull: Vec<usize>, scale: f64, was: bool }

fn make() -> Blob {
    let mut cfg = WorldConfig::default();
    cfg.gravity = v(0.0, 3920.0);
    cfg.substeps = 4;
    let mut w = SoftBodyWorld::new(cfg, 7);
    w.register_static_polygon(vec![v(-5000.0, 0.0), v(40000.0, 0.0), v(40000.0, 400.0), v(-5000.0, 400.0)], SurfaceMaterial::Default, Some("g".into()), None, None);
    let hull: Vec<FxVec2> = (0..16).map(|i| { let a = std::f64::consts::TAU * i as f64 / 16.0 - std::f64::consts::FRAC_PI_2; v(a.cos() * 48.0, a.sin() * 48.0) }).collect();
    let r = w.add_blob_from_hull(AddBlobParams {
        hull_rest_local: hull, center_local: FxVec2::ZERO, center_mass: f(0.1), hull_mass: f(0.06),
        spring_k: f(55.0 * 0.92), spring_damp: f(3.5), radial_k: Fx::ZERO, radial_damp: Fx::ZERO,
        pressure_k: f(0.12), shape_match_k: f(132.0 * 0.92), shape_match_damp: f(1.5),
        world_origin: v(0.0, -60.0), sort_key: None, static_hull_indices: vec![], static_center: false, pin_frame: false,
    });
    let hull = r.hull_indices.iter().map(|&i| i as usize).collect();
    let mut b = Blob { w, id: r.blob_id, hull, scale: 1.0, was: false };
    for _ in 0..90 { b.tick(0.0, 0.0, false); }
    b
}

impl Blob {
    fn tick(&mut self, sx: f64, sy: f64, btn: bool) {
        let dt = 1.0 / 60.0;
        let on_floor = self.w.get_blob_ground_contacts(self.id) > 0;
        let touching = self.w.get_blob_particle_contacts(self.id).iter().any(|&c| c != 0);
        self.w.set_blob_spring_stiffness_scale(self.id, f(if btn { 1.45 } else { 1.0 }), None);
        let lat = if on_floor { 1.0 } else if touching { 0.4 } else { 0.6 };
        self.w.apply_blob_move_force(self.id, v(sx, 0.0), f(240.0 * lat), f(dt));
        if sy > 0.1 { self.w.apply_blob_move_force(self.id, v(0.0, 1.0), f(180.0 * sy), f(dt)); }
        else if sy < -0.1 { self.w.apply_blob_move_force(self.id, v(0.0, -1.0), f(96.0 * -sy), f(dt)); }
        self.w.set_blob_squash_lean(self.id, f(sy.max(0.0)), Fx::ZERO, v(0.0, 1.0));
        let target = if btn { 3.0 } else { 1.0 };
        let rate = if target > self.scale { 24.0 } else { 18.0 } * dt;
        self.scale = if (target - self.scale).abs() <= rate { target } else { self.scale + rate * (target - self.scale).signum() };
        self.w.set_blob_shape_match_rest_scale(self.id, f(self.scale));
        self.was = btn;
        self.w.step(f(dt));
    }
    fn pts(&self) -> Vec<(f64, f64)> { let p = self.w.positions(); self.hull.iter().map(|&i| (p[i].x.to_f64(), p[i].y.to_f64())).collect() }
    fn feet(&self) -> f64 { -self.pts().iter().map(|p| p.1).fold(f64::MIN, f64::max) }
    fn dims(&self) -> (i32, i32) { let p = self.pts(); let (a, b) = p.iter().fold((f64::MAX, f64::MIN), |(lo, hi), q| (lo.min(q.0), hi.max(q.0))); let (c, d) = p.iter().fold((f64::MAX, f64::MIN), |(lo, hi), q| (lo.min(q.1), hi.max(q.1))); ((b - a) as i32, (d - c) as i32) }
    fn cx(&self) -> f64 { let p = self.pts(); p.iter().map(|q| q.0).sum::<f64>() / p.len() as f64 }
    fn vx(&self) -> f64 { let vv = self.w.velocities(); self.hull.iter().map(|&i| vv[i].x.to_f64()).sum::<f64>() / self.hull.len() as f64 }
}

fn jump(hold: usize, sy: f64) -> (f64, f64) {
    let mut b = make(); let y0 = b.feet(); let mut best: f64 = 0.0; let mut air = 0.0;
    for k in 0..240 { b.tick(0.0, sy, k < hold); best = best.max(b.feet() - y0); if b.feet() - y0 > 6.0 { air += 1.0 / 60.0; } }
    (best, air)
}

fn main() {
    let b = make();
    println!("(TS px; ×2/3 for 3.0) rest dims {:?} cx {:.1}", b.dims(), b.cx());
    for hold in [3, 6, 10, 20, 40] { let (h, a) = jump(hold, 0.0); println!("hold {hold:>2}f jump {h:6.1} (={:5.1}) air {a:.2}s", h * 2.0 / 3.0); }
    let (h, a) = jump(40, -1.0); println!("hold40 + up: jump {h:6.1} (={:5.1}) air {a:.2}s", h * 2.0 / 3.0);
    let mut b = make(); let mut sp = vec![];
    for k in 0..300 { b.tick(1.0, 0.0, false); if k % 60 == 59 { sp.push((b.vx() * 2.0 / 3.0) as i32); } }
    println!("run speed per sec (scaled) {sp:?}");
    let mut b = make(); let mut d = vec![];
    for k in 0..90 { b.tick(0.0, 1.0, false); if k % 15 == 14 { d.push(b.dims()); } }
    println!("crouch dims (TS px) {d:?}");
    let mut b = make();
    for _ in 0..90 { b.tick(1.0, 0.0, false); }
    let x0 = b.cx(); let y0 = b.feet(); let mut up: f64 = 0.0; let mut land = 0.0;
    for k in 0..200 { b.tick(1.0, 0.0, k < 30); up = up.max(b.feet() - y0); if k > 10 && b.feet() - y0 < 4.0 && land == 0.0 { land = b.cx() - x0; } }
    println!("running jump peak {:.0} lands after {:.0}px (scaled)", up * 2.0 / 3.0, land * 2.0 / 3.0);
}
