//! Regression tests for gameplay physics fixes (slopes, jelly stepping
//! stones, drips, springs/mushrooms, Reg, blades, droplets, NPCs).
use bb_level::{LevelBuilder, Theme, v};
use bb_sim::{Input, Sim, Vec2};

fn pbody(sim: &Sim) -> &bb_physics::Body { sim.world.body(sim.players[0].ctl.body).unwrap() }
fn put(sim: &mut Sim, at: Vec2) {
    let id = sim.players[0].ctl.body;
    let off = at - pbody(sim).centroid();
    if let Some(bd) = sim.world.body_mut(id) { for p in bd.x.iter_mut() { *p += off; } for p in bd.prev.iter_mut() { *p += off; } for vv in bd.v.iter_mut() { *vv = Vec2::ZERO; } }
}
fn set(sim: &mut Sim, stick: Vec2, button: bool) { sim.set_input(0, Input { stick, button }); }

/// Ride the ch01 big slope from its checkpoint holding right; `jump_at`
/// presses the button while the blob is on the kicker. Returns where it
/// came down past the basin (x, y) and the top speed on the slope.
fn ch01_slope_run(jump_at: Option<(f32, f32)>) -> (Vec2, f32) {
    let mut sim = Sim::new(bb_level::campaign::chapter(1));
    sim.add_player(0, "P", 1);
    put(&mut sim, Vec2::new(8950.0, 870.0));
    let mut top: f32 = 0.0;
    let mut log = vec![];
    for f in 0..400 {
        let c = pbody(&sim).centroid();
        let btn = jump_at.is_some_and(|(a, b)| c.x > a && c.x < b);
        set(&mut sim, Vec2::new(1.0, 0.0), btn);
        sim.step();
        let b = pbody(&sim);
        let c = b.centroid();
        if c.x < 10700.0 { top = top.max(b.velocity().length()); }
        if f % 10 == 9 { log.push(format!("({:.0},{:.0} v{:.0},{:.0})", c.x, c.y, b.velocity().x, b.velocity().y)); }
        assert!(sim.players[0].dead.is_none(), "popped on the slope: {}", log.join(" "));
        // Came down: either in the basin (below the lip) or on the far side.
        if c.x > 11460.0 && b.velocity().y <= 0.0 && (c.y < -40.0 || (c.x > 11860.0 && c.y < 60.0)) {
            println!("jump {jump_at:?}: top {top:.0} landed ({:.0},{:.0}) {}", c.x, c.y, log.join(" "));
            return (c, top);
        }
    }
    panic!("never came down: {}", log.join(" "));
}

/// Item 1: ch01's big jelly slope builds enough speed to clear the basin
/// off the kicker (rolling straight off it, or jumping on it).
#[test]
fn ch01_slope_clears_the_basin() {
    // Rolling straight off without jumping drops into the soft basin (by
    // design); just check it doesn't pop.
    let (_, top) = ch01_slope_run(None);
    assert!(top > 1150.0, "slope too slow ({top:.0})");
    for jump in [Some((11150.0, 11460.0)), Some((11250.0, 11460.0)), Some((11330.0, 11460.0)), Some((11400.0, 11460.0))] {
        let (land, top) = ch01_slope_run(jump);
        assert!(top > 1150.0, "slope too slow ({top:.0}) with jump {jump:?}");
        assert!(land.x > 11850.0 && land.y > -40.0, "fell into the basin at {land:?} with jump {jump:?}");
    }
}

fn slope_sim(jelly: bool, deg: f32) -> Sim {
    let drop = (deg.to_radians()).tan() * 1500.0;
    let mut b = LevelBuilder::new("s", "S", Theme::Hollow);
    let top = [v(-600.0, drop), v(0.0, drop), v(1500.0, 0.0), v(5000.0, 0.0)];
    if jelly { b.ground(&top, 400.0); } else { let mut p = top.to_vec(); p.push(v(5000.0, -400.0)); p.push(v(-600.0, -400.0)); p.reverse(); b.poly(&p); }
    b.spawn(v(-300.0, drop + 40.0));
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    for _ in 0..30 { sim.step(); }
    sim
}

fn flat_speed() -> f32 {
    let mut b = LevelBuilder::new("f", "F", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).ground(&[v(-600.0, 0.0), v(9000.0, 0.0)], 300.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    for _ in 0..30 { sim.step(); }
    let mut sp = 0.0;
    for f in 0..240 { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); if f >= 180 { sp += pbody(&sim).velocity().x / 60.0; } }
    sp
}

/// Item 1: rolling down a ~28° hill picks up speed well beyond the flat
/// steady speed (with or without the stick; on rock and on jelly).
#[test]
fn downhill_builds_speed() {
    let flat = flat_speed();
    for jelly in [false, true] {
        for stick in [0.0, 1.0] {
            let mut sim = slope_sim(jelly, 28.0);
            let mut bottom = 0.0;
            for f in 0..300 {
                set(&mut sim, Vec2::new(if f < 40 { 1.0 } else { stick }, 0.0), false);
                sim.step();
                let b = pbody(&sim);
                if b.centroid().x < 1450.0 { bottom = b.velocity().length(); } else { break; }
            }
            println!("flat {flat:.0}, 28° bottom jelly={jelly} stick={stick}: {bottom:.0}");
            assert!(bottom > flat * 1.8, "downhill {bottom:.0} vs flat {flat:.0} (jelly={jelly} stick={stick})");
        }
    }
    // …but you can still brake on a slope.
    let mut sim = slope_sim(false, 28.0);
    let mut bottom = 0.0;
    for f in 0..400 {
        let on_slope = pbody(&sim).centroid().x > 150.0;
        set(&mut sim, Vec2::new(if on_slope { -1.0 } else { 1.0 }, 0.0), false);
        sim.step();
        let b = pbody(&sim);
        if b.centroid().x < 1450.0 { bottom = b.velocity().length(); } else { break; }
    }
    println!("braking bottom {bottom:.0}");
    assert!(bottom < flat * 1.2, "can't brake downhill ({bottom:.0})");
}
