//! 2.x feel checks: prints numbers (run with --nocapture) and asserts the
//! mechanics still work with the 2.x blob.
use bb_level::{LevelBuilder, Theme, v};
use bb_sim::{Input, Sim, Vec2};

fn flat() -> Sim {
    let mut b = LevelBuilder::new("flat", "Flat", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(20000.0, 0.0)], 300.0);
    let mut sim = Sim::new(b.build());
    if let Ok(n) = std::env::var("SUB") { sim.world.config.substeps = n.parse().unwrap(); }
    sim.add_player(0, "P", 0xff5d73);
    for _ in 0..90 { sim.step(); }
    sim
}
fn body(sim: &Sim) -> &bb_physics::Body { sim.world.body(sim.players[0].ctl.body).unwrap() }
fn feet(sim: &Sim) -> f32 { body(sim).outline().map(|p| p.y).fold(f32::MAX, f32::min) }
fn dims(sim: &Sim) -> Vec2 { let b = body(sim); let (mut lo, mut hi) = (Vec2::splat(1e9), Vec2::splat(-1e9)); for p in b.outline() { lo = lo.min(p); hi = hi.max(p); } hi - lo }
fn set(sim: &mut Sim, stick: Vec2, button: bool) { sim.set_input(0, Input { stick, button }); }

fn jump(hold: usize, stick: Vec2) -> (f32, f32) {
    let mut sim = flat();
    let y0 = feet(&sim);
    let mut best: f32 = 0.0; let mut air = 0.0;
    for f in 0..240 {
        set(&mut sim, stick, f < hold);
        sim.step();
        best = best.max(feet(&sim) - y0);
        if feet(&sim) - y0 > 4.0 { air += 1.0 / 60.0; }
    }
    (best, air)
}

#[test]
fn probe() {
    let sim = flat();
    println!("rest dims {:?} centroid {:?}", dims(&sim), body(&sim).centroid());
    // jitter at rest
    let mut sim = flat(); let mut mv: f32 = 0.0; let c0 = body(&sim).centroid();
    for _ in 0..120 { sim.step(); mv = mv.max(body(&sim).centroid().distance(c0)); }
    println!("rest drift {mv:.2}");
    for hold in [3, 6, 10, 20, 40] { let (h, a) = jump(hold, Vec2::ZERO); println!("hold {hold:>2}f jump {h:6.1} air {a:.2}s"); }
    let (h, a) = jump(40, Vec2::new(0.0, 1.0)); println!("hold40 + up: jump {h:6.1} air {a:.2}s");
    // run
    let mut sim = flat(); let mut sp = vec![];
    for f in 0..300 { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); if f % 60 == 59 { sp.push(body(&sim).velocity().x as i32); } }
    println!("run speed per sec {sp:?}");
    // crouch
    let mut sim = flat(); let mut d = vec![];
    for f in 0..90 { set(&mut sim, Vec2::new(0.0, -1.0), false); sim.step(); if f % 15 == 14 { let x = dims(&sim); d.push((x.x as i32, x.y as i32)); } }
    println!("crouch dims {d:?}");
    // running jump distance
    let mut sim = flat();
    for _ in 0..90 { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); }
    let x0 = body(&sim).centroid().x; let y0 = feet(&sim); let mut up = 0.0f32; let mut land = 0.0;
    for f in 0..200 { set(&mut sim, Vec2::new(1.0, 0.0), f < 30); sim.step(); up = up.max(feet(&sim) - y0); if f > 10 && feet(&sim) - y0 < 3.0 && land == 0.0 { land = body(&sim).centroid().x - x0; } }
    println!("running jump peak {up:.0} lands after {land:.0}px");
}

#[test]
fn probe_spring() {
    for kind in ["spring", "trampoline"] {
        let mut b = LevelBuilder::new("s", "S", Theme::Hollow);
        b.spawn(v(0.0, 40.0)).ground(&[v(-600.0, 0.0), v(600.0, 0.0)], 300.0);
        if kind == "spring" { b.spring(v(0.0, 0.0), 90.0, 1400.0); } else { b.trampoline(v(0.0, 0.0), 90.0, 160.0, 1200.0); }
        let mut sim = Sim::new(b.build());
        sim.add_player(0, "P", 0xff5d73);
        let id = sim.players[0].ctl.body;
        // drop from above
        let off = Vec2::new(27.0, 300.0);
        if let Some(bd) = sim.world.body_mut(id) { for p in bd.x.iter_mut() { *p += off; } for p in bd.prev.iter_mut() { *p += off; } }
        let mut peak = -1e9f32; let mut lowest = 1e9f32; let mut fell = false;
        for f in 0..240 { sim.step(); let y = body(&sim).centroid().y; if !fell { lowest = lowest.min(y); if f > 5 && body(&sim).velocity().y > 0.0 { fell = true; } } else { peak = peak.max(y); } }
        println!("{kind}: lowest {lowest:.0} rebound peak {peak:.0}");
        assert!(peak > 500.0, "{kind} launch");
    }
}

fn put(sim: &mut Sim, at: Vec2) {
    let id = sim.players[0].ctl.body;
    let off = at - body(sim).centroid();
    if let Some(bd) = sim.world.body_mut(id) { for p in bd.x.iter_mut() { *p += off; } for p in bd.prev.iter_mut() { *p += off; } }
}

#[test]
fn probe_mechanics() {
    use bb_level::{Material, Shape};
    // Sticky chimney: walls at x 140..200 and 400..460.
    let mut b = LevelBuilder::new("w", "W", Theme::Hollow);
    b.spawn(v(300.0, 40.0)).ground(&[v(-400.0, 0.0), v(900.0, 0.0)], 300.0);
    b.terrain(Shape::rect(v(400.0, 0.0), v(460.0, 2000.0)), Material::Sticky);
    b.terrain(Shape::rect(v(140.0, 160.0), v(200.0, 2000.0)), Material::Sticky);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    put(&mut sim, Vec2::new(360.0, 200.0));
    let mut log = vec![]; let mut prev = false;
    for f in 0..900 {
        let stuck = sim.players[0].ctl.stuck;
        let mut inp = Input::default();
        if let Some(n) = stuck { inp.stick = Vec2::new(n.x.signum() * 0.5, 1.0); inp.button = !prev && f % 20 == 0; } else { inp.stick = Vec2::new(if body(&sim).centroid().x > 300.0 { 1.0 } else { -1.0 }, 0.0); inp.button = sim.players[0].ctl.grounded && f % 30 < 10; }
        prev = inp.button;
        sim.set_input(0, inp); sim.step();
        if f % 60 == 59 { let c = body(&sim).centroid(); log.push(format!("({:.0},{:.0}){}", c.x, c.y, if stuck.is_some() { "S" } else { "" })); }
    }
    println!("chimney: {log:?}");
    assert!(body(&sim).centroid().y > 1500.0, "sticky chimney climb");

    // Water: pool 400..1400, surface -40, floor -400.
    let mut b = LevelBuilder::new("s", "S", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).ground(&[v(-400.0, 0.0), v(400.0, 0.0)], 1000.0);
    b.ground(&[v(400.0, -400.0), v(1400.0, -400.0)], 600.0);
    b.water(v(400.0, -400.0), v(1400.0, -40.0));
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    put(&mut sim, Vec2::new(800.0, -200.0));
    let mut log = vec![];
    for f in 0..300 { sim.set_input(0, Input { stick: Vec2::new(1.0, 0.0), button: f > 150 && f % 30 == 0 }); sim.step(); if f % 30 == 29 { let c = body(&sim).centroid(); log.push(format!("({:.0},{:.0})", c.x, c.y)); } }
    println!("swim: {log:?}");
    assert!(log[1].ends_with(",-19)") || log.iter().take(3).any(|p| p.contains(",-") && p.split(',').nth(1).unwrap().trim_end_matches(')').parse::<f32>().unwrap() > -80.0), "floats up");

    // Vine.
    let mut b = LevelBuilder::new("r", "R", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).ground(&[v(-400.0, 0.0), v(400.0, 0.0)], 1000.0);
    b.vine(v(700.0, 600.0), 340.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    for _ in 0..30 { sim.step(); }
    let mut grabbed = None;
    for f in 0..200 { let btn = (40..50).contains(&f); sim.set_input(0, Input { stick: Vec2::new(1.0, 0.0), button: btn }); sim.step(); if sim.players[0].ctl.grab.is_some() && grabbed.is_none() { grabbed = Some(f); } }
    println!("vine grabbed at frame {grabbed:?}, pos {:?}", body(&sim).centroid());
    assert!(grabbed.is_some(), "vine grab");
}
