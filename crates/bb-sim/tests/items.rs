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

/// Item 2: ch01's three wobbly jelly stepping stones stay put when you
/// land, stand, hop and roll on them, and you come to rest on top.
#[test]
fn ch01_jelly_stones_hold_steady() {
    let lvl = bb_level::campaign::chapter(1);
    let stones: Vec<(Vec2, Vec2)> = lvl.jelly.iter().filter(|j| (j.wobble - 0.8).abs() < 1e-3).map(|j| j.shape.bounds()).collect();
    assert_eq!(stones.len(), 3);
    for (lo, hi) in stones {
        for mode in ["stand", "hop", "wiggle"] {
            let mut sim = Sim::new(lvl.clone());
            sim.add_player(0, "P", 1);
            put(&mut sim, Vec2::new((lo.x + hi.x) * 0.5, hi.y + 150.0));
            let jid = sim.jelly.iter().map(|j| j.0).find(|id| { let c = sim.world.body(*id).unwrap().centroid(); c.x > lo.x && c.x < hi.x && c.y > lo.y && c.y < hi.y }).unwrap();
            let home: Vec<Vec2> = sim.world.body(jid).unwrap().x.clone();
            let mut peak_v: f32 = 0.0;
            let mut shaky = 0;
            for f in 0..300 {
                let (stick, btn) = match mode {
                    "hop" => (0.0, f > 60 && f < 200 && f % 40 < 8),
                    "wiggle" => (if f > 60 && f < 200 { if (f / 12) % 2 == 0 { 0.6 } else { -0.6 } } else { 0.0 }, false),
                    _ => (0.0, false),
                };
                set(&mut sim, Vec2::new(stick, 0.0), btn);
                sim.step();
                let jb = sim.world.body(jid).unwrap();
                let jv = jb.v.iter().map(|v| v.length()).fold(0.0f32, f32::max);
                if f > 30 { peak_v = peak_v.max(jv); if jv > 800.0 { shaky += 1; } }
                if std::env::var("TRACE").is_ok() && jv > 300.0 { println!("  f{f} jv {jv:.0}"); }
                assert!(sim.players[0].dead.is_none(), "popped on the stone at {lo:?} ({mode})");
            }
            let jb = sim.world.body(jid).unwrap();
            let dev = jb.x.iter().zip(&home).map(|(a, b)| a.distance(*b)).fold(0.0f32, f32::max);
            let p = pbody(&sim);
            let c = p.centroid();
            println!("stone {lo:?} {mode}: jelly peak v {peak_v:.0} shaky {shaky}, dev {dev:.1}; blob at ({:.0},{:.0}) v {:.0}", c.x, c.y, p.velocity().length());
            // Landing / jump kicks give one-frame spikes; the bug was a
            // sustained ~7000 px/s shake.
            assert!(peak_v < 4000.0 && shaky <= 12, "jelly stone shook ({peak_v:.0} px/s, {shaky} frames) at {lo:?} ({mode})");
            assert!(dev < 12.0, "jelly stone deformed {dev:.1}px at rest ({mode})");
            assert!(c.x > lo.x - 10.0 && c.x < hi.x + 10.0 && c.y > hi.y && c.y < hi.y + 60.0 && p.velocity().length() < 60.0, "not resting on the stone at {lo:?}: {c:?} ({mode})");
        }
    }
}

#[test]
fn probe_jelly_variants() {
    let var = std::env::var("VAR").unwrap_or_default();
    let mut b = LevelBuilder::new("j", "J", Theme::Hollow);
    b.spawn(v(-500.0, 40.0)).ground(&[v(-800.0, 0.0), v(-300.0, 0.0)], 300.0);
    b.jelly(v(0.0, 180.0), v(200.0, 260.0), 0.8);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    let mut jid = sim.jelly.last().unwrap().0;
    if var.contains("ground") { jid = sim.jelly[1].0; }
    {
        let jb = sim.world.body_mut(jid).unwrap();
        println!("jelly n={} boundary={} mass={} w0={}", jb.x.len(), jb.boundary.len(), jb.mass(), jb.w[0]);
        if var.contains("home") { jb.home_compliance = 1e-6; }
        if var.contains("damp") { jb.params.internal_damping = 30.0; }
        if var.contains("heavy") { for w in jb.w.iter_mut() { *w *= 0.1; } for w in jb.base_w.iter_mut() { *w *= 0.1; } }
        if let Some(c) = var.strip_prefix("shape") { jb.params.shape_compliance = Some(c.parse().unwrap_or(1e-6)); }
    }
    if var.contains("sub") { sim.world.config.substeps = 24; }
    put(&mut sim, Vec2::new(100.0, 380.0));
    if var.contains("hi") { put(&mut sim, Vec2::new(100.0, 700.0)); }
    if var.contains("ground") { let c = sim.world.body(jid).unwrap().centroid(); put(&mut sim, c + Vec2::new(0.0, 150.0)); }
    let home: Vec<Vec2> = sim.world.body(jid).unwrap().x.clone();
    let mut log = vec![];
    let mut peak: f32 = 0.0;
    for f in 0..240 {
        if let Some(jb) = sim.world.body(jid) { peak = peak.max(jb.x.iter().zip(&home).map(|(a, b)| a.distance(*b)).fold(0.0f32, f32::max)); }
        set(&mut sim, Vec2::new(if var.contains("roll") && f > 100 { 1.0 } else { 0.0 }, 0.0), var.contains("jump") && f % 50 < 10);
        sim.step();
        let jb = sim.world.body(jid).unwrap();
        let dev = jb.x.iter().zip(&home).map(|(a, b)| a.distance(*b)).fold(0.0f32, f32::max);
        let vmax = jb.v.iter().map(|v| v.length()).fold(0.0f32, f32::max);
        let pv = pbody(&sim).v.iter().map(|v| v.length()).fold(0.0f32, f32::max);
        if f % 20 == 19 { let c = pbody(&sim).centroid(); log.push(format!("p({:.0},{:.0}) dev{:.1} jv{:.0} pv{:.0}", c.x, c.y, dev, vmax, pv)); }
    }
    println!("{var}: peak dev {peak:.1}: {}", log.join(" | "));
}

/// Item 3: a falling spiky drip pops the blob it lands on (and one it
/// brushes past on the way down).
#[test]
fn falling_drip_pops() {
    for (dx, label) in [(0.0, "under"), (52.0, "beside")] {
        let mut b = LevelBuilder::new("d", "D", Theme::Drip);
        b.spawn(v(-600.0, 40.0)).ground(&[v(-800.0, 0.0), v(800.0, 0.0)], 300.0);
        b.drip_hazard(v(0.0, 600.0), 560.0, 30.0, 0.0);
        let mut sim = Sim::new(b.build());
        sim.add_player(0, "P", 1);
        put(&mut sim, Vec2::new(dx, 34.0));
        let mut popped = None;
        for f in 0..300 {
            set(&mut sim, Vec2::ZERO, false);
            sim.step();
            if sim.players[0].dead.is_some() { popped = Some(f); break; }
        }
        println!("drip {label}: popped at {popped:?}");
        assert!(popped.is_some(), "drip {label} didn't pop the blob");
    }
}

/// Item 6: blades pop on touch; plain spinners don't.
#[test]
fn blades_pop_spinners_dont() {
    for lethal in [false, true] {
        let mut b = LevelBuilder::new("s", "S", Theme::Chimney);
        b.spawn(v(-600.0, 40.0)).ground(&[v(-800.0, 0.0), v(800.0, 0.0)], 300.0);
        if lethal { b.blade(v(0.0, 220.0), v(160.0, 20.0), 1.5); } else { b.spinner(v(0.0, 220.0), v(160.0, 20.0), 1.5); }
        let mut sim = Sim::new(b.build());
        sim.add_player(0, "P", 1);
        put(&mut sim, Vec2::new(0.0, 34.0));
        let mut popped = false;
        for f in 0..300 {
            set(&mut sim, Vec2::ZERO, f % 60 < 10);
            sim.step();
            if sim.players[0].dead.is_some() { popped = true; break; }
        }
        assert_eq!(popped, lethal, "lethal={lethal}");
    }
}

/// Item 6: with ch07's fans as lethal blades, you can still float up the
/// flue by steering around them (blades on the left low, right high).
#[test]
fn ch07_flue_steer_around_blades() {
    let mut lvl = bb_level::campaign::chapter(7);
    let mut n = 0;
    for m in lvl.movers.iter_mut() {
        if matches!(m.motion, bb_level::MoverMotion::Spin { .. }) { m.lethal = true; n += 1; }
    }
    assert!(n >= 2);
    let mut sim = Sim::new(lvl);
    sim.add_player(0, "P", 1);
    put(&mut sim, Vec2::new(3700.0, 1040.0));
    let mut log = vec![];
    let mut made_it = false;
    let mut phase = 0;
    for f in 0..900 {
        let c = pbody(&sim).centroid();
        let vy = pbody(&sim).velocity().y;
        // Up the right side past the low (left) blade, hover and drift left
        // under the high (right) one, then up and out to the right.
        if phase == 0 && c.y > 1790.0 { phase = 1; }
        if phase == 1 && c.x < 3890.0 { phase = 2; }
        if phase == 2 && c.y > 2300.0 { phase = 3; }
        let (target, btn) = match phase {
            0 => (4030.0, c.x > 3800.0),
            1 => (3860.0, vy < 0.0),
            2 => (3860.0, true),
            _ => (4300.0, c.y < 2440.0),
        };
        let stick = if c.x < 3820.0 && phase == 0 { 1.0 } else { ((target - c.x) / 60.0).clamp(-1.0, 1.0) };
        set(&mut sim, Vec2::new(stick, 0.0), btn);
        sim.step();
        if f % 30 == 29 { log.push(format!("({:.0},{:.0})", c.x, c.y)); }
        assert!(sim.players[0].dead.is_none(), "popped in the flue: {}", log.join(" "));
        if c.x > 4150.0 && c.y > 2400.0 { made_it = true; break; }
    }
    println!("flue: {}", log.join(" "));
    assert!(made_it, "didn't get up the flue: {}", log.join(" "));
}

/// …and a blob that just floats straight up the middle gets cut.
#[test]
fn ch07_blades_cut() {
    let mut lvl = bb_level::campaign::chapter(7);
    for m in lvl.movers.iter_mut() {
        if matches!(m.motion, bb_level::MoverMotion::Spin { .. }) { m.lethal = true; }
    }
    let mut sim = Sim::new(lvl);
    sim.add_player(0, "P", 1);
    put(&mut sim, Vec2::new(3875.0, 1040.0));
    let mut popped = false;
    for _ in 0..600 {
        let c = pbody(&sim).centroid();
        set(&mut sim, Vec2::new(((3875.0 - c.x) / 60.0).clamp(-1.0, 1.0), 0.0), true);
        sim.step();
        if sim.players[0].dead.is_some() { popped = true; break; }
    }
    assert!(popped, "floating into a blade should pop");
}
