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
    for _ in 0..400 {
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

fn npc_level(role: bb_level::NpcRole) -> Sim {
    let mut b = LevelBuilder::new("n", "N", Theme::CaveIn);
    b.spawn(v(0.0, 40.0)).ground(&[v(-3000.0, 0.0), v(6000.0, 0.0)], 300.0);
    b.npc("g", v(300.0, 40.0), role, "#8a8f86", 28.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    for _ in 0..30 { sim.step(); }
    sim
}

/// Item 8: freed Grumbles still bump into the player.
#[test]
fn freed_grumbles_collide_with_player() {
    let mut sim = npc_level(bb_level::NpcRole::Trapped);
    // Roll over to free it.
    for _ in 0..120 { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); if sim.npcs[0].freed { break; } }
    assert!(sim.npcs[0].freed && sim.npcs[0].following);
    let nb = sim.npcs[0].ctl.body;
    let pb = sim.players[0].ctl.body;
    let mut bumped = false;
    for f in 0..300 {
        set(&mut sim, Vec2::new(if (f / 60) % 2 == 0 { 1.0 } else { -1.0 }, 0.0), false);
        sim.step();
        if sim.world.contacts_of(pb).any(|c| c.other == bb_physics::Collider::Body(nb)) { bumped = true; break; }
    }
    assert!(bumped, "the freed Grumble passes through the player");
}

/// Item 9: followers tag along for a while, then settle and idle.
#[test]
fn followers_settle_after_a_while() {
    let mut sim = npc_level(bb_level::NpcRole::Trapped);
    for _ in 0..120 { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); if sim.npcs[0].freed { break; } }
    assert!(sim.npcs[0].following);
    // Walk right for a few seconds: it follows.
    for _ in 0..240 { set(&mut sim, Vec2::new(0.6, 0.0), false); sim.step(); }
    let nc = |sim: &Sim| sim.world.body(sim.npcs[0].ctl.body).unwrap().centroid();
    let p = pbody(&sim).centroid();
    println!("after 4 s: player {p:?} npc {:?}", nc(&sim));
    assert!(sim.npcs[0].following && nc(&sim).distance(p) < 500.0, "follows at first");
    // Hang about for 30 s: it gives up following and settles.
    for _ in 0..(30 * 60) { set(&mut sim, Vec2::ZERO, false); sim.step(); }
    assert!(!sim.npcs[0].following, "still following after 30 s");
    let home = nc(&sim);
    // Leave: it stays put.
    for _ in 0..(6 * 60) { set(&mut sim, Vec2::new(1.0, 0.0), false); sim.step(); }
    println!("settled at {home:?}, now {:?}, player {:?}", nc(&sim), pbody(&sim).centroid());
    assert!(nc(&sim).distance(home) < 150.0, "settled follower wandered after the player");
}

/// Item 9: Glimmer hovers by her light and only visits briefly.
#[test]
fn glimmer_stays_near_her_light() {
    let mut b = LevelBuilder::new("g", "G", Theme::Drip);
    b.spawn(v(0.0, 40.0)).ground(&[v(-3000.0, 0.0), v(6000.0, 0.0)], 300.0);
    b.npc("glimmer", v(300.0, 200.0), bb_level::NpcRole::Glimmer, "", 12.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    let gc = |sim: &Sim| sim.world.body(sim.npcs[0].ctl.body).unwrap().centroid();
    let home = Vec2::new(300.0, 200.0);
    // Player runs far away to the right: she stays home.
    let mut far_max: f32 = 0.0;
    for f in 0..(10 * 60) {
        set(&mut sim, Vec2::new(1.0, 0.0), false);
        sim.step();
        if f > 300 { far_max = far_max.max(gc(&sim).distance(home)); }
    }
    println!("player at {:?}, glimmer at {:?}", pbody(&sim).centroid(), gc(&sim));
    assert!(far_max < 120.0, "Glimmer followed the player away ({far_max:.0} from home)");
    // Player stands near her light: she drifts over briefly, then goes back.
    put(&mut sim, Vec2::new(550.0, 40.0));
    let mut visited: f32 = 0.0;
    let mut dist = vec![];
    for f in 0..(12 * 60) {
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        let d = gc(&sim).distance(pbody(&sim).centroid());
        if f < 180 { visited = visited.max(-d); }
        dist.push(gc(&sim).distance(home));
    }
    let late = dist[dist.len() - 120..].iter().copied().fold(0.0f32, f32::max);
    let peak = dist.iter().copied().fold(0.0f32, f32::max);
    println!("visit: peak {peak:.0} from home, late {late:.0}");
    assert!(peak > 120.0, "Glimmer never came over");
    assert!(late < 100.0, "Glimmer didn't go back to her light");
    let _ = visited;
}

/// The ch06 intro cutscene stage (replicates bb-game's story `stage()` +
/// the teacup prop Reg stands in).
fn ch06_stage() -> bb_level::Level {
    use bb_level::{NpcRole, PropKind};
    let mut b = LevelBuilder::new("ch06_intro", "ch06_intro", Theme::Lake);
    b.spawn(v(0.0, 60.0)).ground(&[v(-1600.0, 0.0), v(1600.0, 0.0)], 400.0).block(v(-1700.0, -400.0), v(-1600.0, 1400.0)).block(v(1600.0, -400.0), v(1700.0, 1400.0)).kill_y(-1000.0);
    b.npc("pip", v(-500.0, 60.0), NpcRole::Huddle, "#ff5d73", 32.0);
    b.npc("reg", v(300.0, 40.0 + 36.0), NpcRole::Reg, "", 36.0);
    b.prop("teacup", PropKind::Custom { outline: vec![v(-70.0, 30.0), v(70.0, 30.0), v(50.0, -30.0), v(-50.0, -30.0)] }, v(300.0, 32.0), v(140.0, 60.0), 3.0, "#fff1f6");
    b.build()
}

fn reg_log(sim: &Sim, i: usize) -> String {
    let bd = sim.world.body(sim.npcs[i].ctl.body).unwrap();
    let c = bd.centroid();
    format!("({:.0},{:.0} a{:.0} w{:.1})", c.x, c.y, bd.angle().to_degrees(), bd.angular_velocity())
}

/// Item 5: Reg (the L-shaped sock king) stays put and upright on the ch06
/// intro cutscene stage (he starts on his teacup prop), at both his ch06
/// spots, and when the player barges into him.
#[test]
fn reg_stays_upright_ch06() {
    // The cutscene stage: every actor scripted, Reg standing on the teacup.
    let mut sim = Sim::new(ch06_stage());
    for n in sim.npcs.iter_mut() { n.scripted = true; }
    let reg = sim.npcs.iter().position(|n| n.id == "reg").unwrap();
    let mut log = vec![];
    let mut worst: f32 = 0.0;
    for f in 0..900 {
        // The cutscene makes him puff/hop now and then.
        sim.npcs[reg].ctl.input.button = f % 200 < 12;
        sim.step();
        let bd = sim.world.body(sim.npcs[reg].ctl.body).unwrap();
        worst = worst.max(bd.angular_velocity().abs());
        if f % 60 == 59 { log.push(reg_log(&sim, reg)); }
    }
    println!("stage: worst spin {worst:.1}: {}", log.join(" "));
    let bd = sim.world.body(sim.npcs[reg].ctl.body).unwrap();
    let c = bd.centroid();
    assert!(bd.angle().abs() < 0.6 && (c.x - 300.0).abs() < 150.0 && c.y < 220.0 && worst < 12.0, "Reg flipped out on the stage: {}", log.join(" "));

    // The level: Reg in his teacup, and Reg at the start; the player barges
    // in, jumping about.
    for (id, at) in [("reg", Vec2::new(3900.0, 190.0)), ("reg_start", Vec2::new(-250.0, 160.0))] {
        let mut sim = Sim::new(bb_level::campaign::chapter(6));
        sim.add_player(0, "P", 1);
        let i = sim.npcs.iter().position(|n| n.id == id).unwrap();
        put(&mut sim, at + Vec2::new(-260.0, 0.0));
        let mut log = vec![];
        let mut worst: f32 = 0.0;
        for f in 0..900 {
            let pc = pbody(&sim).centroid();
            let dx = at.x - pc.x;
            set(&mut sim, Vec2::new(dx.signum(), 0.0), f % 50 < 10);
            sim.step();
            let bd = sim.world.body(sim.npcs[i].ctl.body).unwrap();
            worst = worst.max(bd.angular_velocity().abs());
            if f % 60 == 59 { log.push(reg_log(&sim, i)); }
        }
        // Then leave him be.
        put(&mut sim, at + Vec2::new(-600.0, 200.0));
        for _ in 0..300 { set(&mut sim, Vec2::ZERO, false); sim.step(); }
        let bd = sim.world.body(sim.npcs[i].ctl.body).unwrap();
        let c = bd.centroid();
        println!("{id}: worst spin {worst:.1} final ({:.0},{:.0}) a{:.0}: {}", c.x, c.y, bd.angle().to_degrees(), log.join(" "));
        assert!(worst < 12.0 && c.distance(at) < 350.0 && bd.angle().abs() < 0.6, "{id} flipped out: {}", log.join(" "));
    }
}


/// Drop the blob from `from` (with a sideways velocity) onto a gadget;
/// `swell_at` = press the button when the blob's bottom comes within this
/// many px of `surface_y` (None: never). Returns (peak height of the
/// centroid after the bounce, velocity just after launch).
fn bounce(level: bb_level::Level, from: Vec2, vel: Vec2, surface_y: f32, swell_at: Option<f32>) -> (f32, Vec2) {
    let mut sim = Sim::new(level);
    sim.add_player(0, "P", 1);
    put(&mut sim, from);
    let id = sim.players[0].ctl.body;
    sim.world.body_mut(id).unwrap().add_velocity(vel);
    let mut pressing = false;
    let mut launched = None;
    let mut peak = f32::MIN;
    let mut rising = false;
    for _ in 0..240 {
        let b = pbody(&sim);
        let bottom = b.outline().map(|p| p.y).fold(f32::MAX, f32::min);
        if let Some(d) = swell_at { if bottom - surface_y < d && b.velocity().y < 0.0 { pressing = true; } }
        set(&mut sim, Vec2::ZERO, pressing);
        let vy0 = pbody(&sim).velocity().y;
        sim.step();
        let b = pbody(&sim);
        if launched.is_none() && vy0 <= 0.0 && b.velocity().y > 300.0 { launched = Some(b.velocity()); rising = true; }
        if rising { peak = peak.max(b.centroid().y); if b.velocity().y < -100.0 { break; } }
    }
    (peak, launched.unwrap_or(Vec2::ZERO))
}

fn gadget_level(f: impl FnOnce(&mut LevelBuilder)) -> bb_level::Level {
    let mut b = LevelBuilder::new("g", "G", Theme::Fungus);
    b.spawn(v(-900.0, 40.0)).ground(&[v(-1200.0, 0.0), v(1200.0, 0.0)], 300.0);
    f(&mut b);
    b.build()
}

/// Item 4: swelling as you land on a spring launches you much higher.
#[test]
fn swell_into_spring_launches_higher() {
    let lvl = gadget_level(|b| { b.spring(v(0.0, 0.0), 90.0, 1400.0); });
    let (plain, _) = bounce(lvl.clone(), Vec2::new(0.0, 300.0), Vec2::ZERO, 18.0, None);
    let (held_long, _) = bounce(lvl.clone(), Vec2::new(0.0, 300.0), Vec2::ZERO, 18.0, Some(1000.0));
    let (timed, _) = bounce(lvl, Vec2::new(0.0, 300.0), Vec2::ZERO, 18.0, Some(40.0));
    println!("spring: plain {plain:.0}, puffed all the way {held_long:.0}, swell on impact {timed:.0}");
    assert!(timed > plain * 1.3, "swelling on the spring: {timed:.0} vs {plain:.0}");
    assert!(timed > held_long, "timing the swell beats just staying puffed");
}

/// Item 4: bouncy mushrooms launch (flat: up; dome: along its normal; ball:
/// away from its centre), and swelling on impact launches much higher.
#[test]
fn bouncy_mushrooms_launch() {
    use bb_level::MushroomShape as S;
    let mk = |shape: S| gadget_level(move |b| { b.bouncy_mushroom(v(0.0, 0.0), 100.0, shape, 160.0, 1300.0); });
    // Flat: straight up, swell boost.
    let top = 100.0 + S::Flat.cap_height(160.0);
    let (plain, v0) = bounce(mk(S::Flat), Vec2::new(30.0, top + 300.0), Vec2::ZERO, top, None);
    let (timed, v1) = bounce(mk(S::Flat), Vec2::new(30.0, top + 300.0), Vec2::ZERO, top, Some(40.0));
    println!("flat: plain peak {plain:.0} v{v0:?}; swell peak {timed:.0} v{v1:?}");
    assert!(v0.y > 1100.0 && v0.x.abs() < 200.0, "flat cap launches straight up: {v0:?}");
    assert!(timed - top > (plain - top) * 1.3, "swelling on the flat cap: {timed:.0} vs {plain:.0}");
    // Dome: land on its right shoulder → up and to the right.
    let top = 100.0 + S::Dome.cap_height(160.0);
    let (_, vd) = bounce(mk(S::Dome), Vec2::new(55.0, top + 260.0), Vec2::ZERO, top - 30.0, None);
    let (_, vdl) = bounce(mk(S::Dome), Vec2::new(-55.0, top + 260.0), Vec2::ZERO, top - 30.0, None);
    println!("dome: right shoulder {vd:?}, left {vdl:?}");
    assert!(vd.x > 250.0 && vd.y > 700.0 && vdl.x < -250.0, "dome launches along its normal");
    // Ball: hit it from the side (rolling into its equator) → flung back.
    let c = Vec2::new(0.0, 100.0 + 80.0);
    let mut sim = Sim::new(mk(S::Ball));
    sim.add_player(0, "P", 1);
    put(&mut sim, c + Vec2::new(-260.0, 0.0));
    sim.world.body_mut(sim.players[0].ctl.body).unwrap().add_velocity(Vec2::new(700.0, 150.0));
    let mut kicked = None;
    for _ in 0..60 {
        let vx0 = pbody(&sim).velocity().x;
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        let vv = pbody(&sim).velocity();
        if vx0 > 0.0 && vv.x < -600.0 { kicked = Some(vv); break; }
    }
    println!("ball: side hit {kicked:?}");
    assert!(kicked.is_some_and(|k| k.x < -800.0), "ball flings you back the way you came");
    // Ball from above: straight up.
    let top = 100.0 + 160.0;
    let (_, vb) = bounce(mk(S::Ball), Vec2::new(0.0, top + 300.0), Vec2::ZERO, top, None);
    assert!(vb.y > 1100.0 && vb.x.abs() < 300.0, "ball from above: {vb:?}");
}
