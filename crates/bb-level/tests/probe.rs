//! Temporary measurements of mechanics (run with --nocapture).

use bb_level::*;
use bb_sim::{Input, Sim, Vec2};

fn c(sim: &Sim) -> Vec2 {
    sim.world.body(sim.players[0].ctl.body).unwrap().centroid()
}
fn run(sim: &mut Sim, n: usize, i: Input) -> (Vec2, Vec2) {
    let mut lo = Vec2::splat(f32::MAX);
    let mut hi = Vec2::splat(f32::MIN);
    sim.set_input(0, i);
    for _ in 0..n {
        sim.step();
        let p = c(sim);
        lo = lo.min(p);
        hi = hi.max(p);
    }
    (lo, hi)
}
fn inp(x: f32, b: bool) -> Input {
    Input { stick: v(x, 0.0), button: b }
}
fn mk(f: impl Fn(&mut LevelBuilder)) -> Sim {
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
    f(&mut b);
    let mut s = Sim::new(b.build());
    s.add_player(0, "P", 0xff0000);
    run(&mut s, 60, inp(0.0, false));
    s
}

#[test]
fn probe_mushroom() {
    for hold in [false, true] {
        let mut s = mk(|b| {
            b.mushroom(v(300.0, 0.0), 110.0, 170.0);
        });
        // walk onto mushroom by jumping
        s.set_input(0, inp(1.0, true));
        let mut peak = 0.0f32;
        let mut peaks = vec![];
        let mut prev_vy = 0.0;
        for k in 0..600 {
            let x = c(&s).x;
            let stick = if x < 290.0 { 1.0 } else if x > 310.0 { -1.0 } else { 0.0 };
            s.set_input(0, Input { stick: v(if k < 20 { 1.0 } else { stick * 0.3 }, 0.0), button: hold || k < 20 });
            s.step();
            let b = s.world.body(s.players[0].ctl.body).unwrap();
            let vy = b.velocity().y;
            if prev_vy > 0.0 && vy <= 0.0 {
                peaks.push(c(&s).y as i32);
            }
            prev_vy = vy;
            peak = peak.max(c(&s).y);
        }
        println!("mushroom hold={hold} peaks {:?}", peaks);
    }
}

#[test]
fn probe_spring_wind_water() {
    let mut s = mk(|b| {
        b.spring(v(200.0, 0.0), 90.0, 1400.0);
    });
    let (_, hi) = run(&mut s, 30, inp(1.0, false));
    let (_, hi2) = run(&mut s, 90, inp(0.0, false));
    println!("spring 1400 peak y {}", hi.y.max(hi2.y));
    for acc in [2000.0, 2600.0, 3200.0] {
        for b in [false, true] {
            let mut s = mk(|bb| {
                bb.wind(v(-200.0, 0.0), v(200.0, 2000.0), v(0.0, acc));
            });
            let (_, hi) = run(&mut s, 180, inp(0.0, b));
            println!("wind {acc} puff={b} y after 3s {} max {}", c(&s).y, hi.y);
        }
    }
    for b in [false, true] {
        let mut s = mk(|bb| {
            bb.water(v(-400.0, 0.0), v(400.0, 600.0));
        });
        let (lo, hi) = run(&mut s, 240, inp(0.0, b));
        println!("water puff={b} y {} lo {} hi {}", c(&s).y, lo.y, hi.y);
        let x0 = c(&s).x;
        run(&mut s, 60, inp(1.0, b));
        println!("  swim speed {}", c(&s).x - x0);
    }
}

#[test]
fn probe_wall_jump() {
    let mut s = mk(|b| {
        b.terrain(Shape::rect(v(-260.0, 0.0), v(-200.0, 2000.0)), Material::Sticky);
        b.terrain(Shape::rect(v(200.0, 0.0), v(260.0, 2000.0)), Material::Sticky);
    });
    let mut hi = 0.0f32;
    let mut dir = 1.0;
    let mut t = 0;
    let mut presses = 0;
    for _ in 0..900 {
        let st = s.players[0].ctl.stuck;
        let btn = if st.is_some() && t > 6 { t = 0; presses += 1; dir = -dir; true } else { false };
        t += 1;
        let b0 = s.players[0].ctl.grounded;
        s.set_input(0, Input { stick: v(dir, 0.0), button: btn || (b0 && t % 30 < 10) });
        s.step();
        hi = hi.max(c(&s).y);
    }
    println!("wall jump climb max y {hi} presses {presses}");
}

#[test]
fn probe_rope() {
    let mut s = mk(|b| {
        b.vine(v(400.0, 600.0), 300.0);
    });
    // run and jump into vine
    let mut grabbed_at = None;
    let mut rel = None;
    for k in 0..400 {
        let g = s.players[0].ctl.grab.is_some();
        if g && grabbed_at.is_none() {
            grabbed_at = Some(k);
        }
        let b = s.world.body(s.players[0].ctl.body).unwrap();
        let vel = b.velocity();
        let mut i = inp(1.0, k > 30 && k < 45);
        if g {
            i = inp(1.0, false);
            if k > grabbed_at.unwrap() + 40 && vel.x > 250.0 && c(&s).x > 420.0 {
                i.button = true;
                rel = Some(c(&s));
            }
        }
        s.set_input(0, i);
        s.step();
        if rel.is_some() && !s.players[0].ctl.grab.is_some() && s.players[0].ctl.grounded {
            println!("rope: released {:?} landed {:?}", rel, c(&s));
            break;
        }
    }
    println!("rope grabbed at {:?}", grabbed_at);
}

#[test]
fn probe_perf() {
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(v(0.0, 60.0));
    let mut pts = vec![];
    for i in 0..60 {
        pts.push(v(i as f32 * 300.0, ((i as f32) * 0.7).sin() * 80.0));
    }
    b.ground(&pts, 300.0);
    for i in 0..20 {
        b.mushroom(v(i as f32 * 900.0, 100.0), 110.0, 170.0);
        b.slab(v(i as f32 * 900.0 + 300.0, 500.0), v(220.0, 40.0), 0.4);
        b.vine(v(i as f32 * 900.0 + 600.0, 900.0), 300.0);
    }
    let l = b.build();
    println!("jelly {} platforms {} ropes {}", l.jelly.len(), l.platforms.len(), l.ropes.len());
    let mut s = Sim::new(l);
    s.add_player(0, "P", 0);
    let t = std::time::Instant::now();
    for _ in 0..300 {
        s.step();
    }
    println!("300 steps: {:?}", t.elapsed());
}

fn drop_on(f: impl Fn(&mut LevelBuilder), at: Vec2, hold: bool, steps: usize) -> Vec<i32> {
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(at).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
    f(&mut b);
    let mut s = Sim::new(b.build());
    s.add_player(0, "P", 0xff0000);
    let mut peaks = vec![];
    let mut prev = 0.0;
    for _ in 0..steps {
        s.set_input(0, inp(0.0, hold));
        s.step();
        let vy = s.world.body(s.players[0].ctl.body).unwrap().velocity().y;
        if prev > 0.0 && vy <= 0.0 { peaks.push(c(&s).y as i32); }
        prev = vy;
    }
    peaks
}

#[test]
fn probe_bounce2() {
    println!("mushroom drop from 600 {:?}", drop_on(|b| { b.mushroom(v(0.0, 0.0), 110.0, 170.0); }, v(0.0, 600.0), false, 300));
    println!("mushroom drop hold {:?}", drop_on(|b| { b.mushroom(v(0.0, 0.0), 110.0, 170.0); }, v(0.0, 600.0), true, 300));
    println!("static bouncy drop {:?}", drop_on(|b| { b.terrain(Shape::rect(v(-100.0, 0.0), v(100.0, 100.0)), Material::Bouncy); }, v(0.0, 600.0), false, 300));
    println!("static bouncy drop hold {:?}", drop_on(|b| { b.terrain(Shape::rect(v(-100.0, 0.0), v(100.0, 100.0)), Material::Bouncy); }, v(0.0, 600.0), true, 300));
    println!("bouncy jelly ground drop {:?}", drop_on(|b| { b.ground_with(&[v(-200.0, 100.0), v(200.0, 100.0)], 100.0, Material::Bouncy, 0.8); }, v(0.0, 600.0), false, 300));
}

#[test]
fn probe_bouncy_jump() {
    // standing on static bouncy, press jump repeatedly when grounded
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(v(0.0, 160.0)).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
    b.terrain(Shape::rect(v(-150.0, 0.0), v(150.0, 100.0)), Material::Bouncy);
    let mut s = Sim::new(b.build());
    s.add_player(0, "P", 0xff0000);
    let mut peaks = vec![]; let mut prev = 0.0;
    for k in 0..600 {
        let g = s.players[0].ctl.grounded;
        s.set_input(0, inp(0.0, k > 60 && (g || prev > 0.0)));
        s.step();
        let vy = s.world.body(s.players[0].ctl.body).unwrap().velocity().y;
        if prev > 0.0 && vy <= 0.0 { peaks.push(c(&s).y as i32); }
        prev = vy;
    }
    println!("bouncy repeated jumps {:?}", peaks);
}

#[test]
fn probe_wall2() {
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(v(0.0, 300.0)).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
    b.terrain(Shape::rect(v(-260.0, 200.0), v(-200.0, 3000.0)), Material::Sticky);
    b.terrain(Shape::rect(v(200.0, 200.0), v(260.0, 3000.0)), Material::Sticky);
    let mut s = Sim::new(b.build());
    s.add_player(0, "P", 0xff0000);
    let mut dir = 1.0; let mut hi = 0.0f32; let mut presses = 0; let mut t = 0;
    let mut stuck_frames = 0;
    for _ in 0..900 {
        let st = s.players[0].ctl.stuck;
        if st.is_some() { stuck_frames += 1; }
        let mut btn = false;
        if let Some(n) = st { if t > 8 { btn = true; t = 0; presses += 1; dir = n.x.signum() * -1.0; dir = -dir; } }
        t += 1;
        // steer toward the wall opposite to where we jumped from
        let g = s.players[0].ctl.grounded;
        s.set_input(0, Input { stick: v(dir, 0.0), button: btn || g });
        s.step();
        hi = hi.max(c(&s).y);
    }
    println!("wall2 climb max y {hi} presses {presses} stuck frames {stuck_frames}");
}

#[test]
fn probe_rope2() {
    for (bottom, len) in [(150.0, 400.0), (120.0, 250.0)] {
        let mut s = mk(|b| { b.vine(v(400.0, bottom + len), len); });
        let mut grabbed = None; let mut released = None;
        for k in 0..600 {
            let g = s.players[0].ctl.grab.is_some();
            if g && grabbed.is_none() { grabbed = Some((k, c(&s))); }
            let vel = s.world.body(s.players[0].ctl.body).unwrap().velocity();
            let mut i = inp(1.0, k > 20 && k < 40);
            if g {
                i = inp(1.0, false);
                if k > grabbed.unwrap().0 + 30 && vel.x > 200.0 && c(&s).x > 430.0 { i.button = true; released = Some((c(&s), vel)); }
            }
            s.set_input(0, i);
            s.step();
            if released.is_some() && s.players[0].ctl.grounded { println!("rope len {len}: grabbed {:?} released {:?} landed {:?}", grabbed, released, c(&s)); break; }
        }
        if released.is_none() { println!("rope len {len}: grabbed {:?} never released, at {:?}", grabbed, c(&s)); }
    }
}

#[test]
fn probe_wall3() {
    let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
    b.terrain(Shape::rect(v(200.0, 100.0), v(260.0, 3000.0)), Material::Sticky);
    let mut s = Sim::new(b.build());
    s.add_player(0, "P", 0xff0000);
    for k in 0..120 {
        let g = s.players[0].ctl.grounded;
        s.set_input(0, Input { stick: v(1.0, 0.0), button: k > 30 && k < 50 });
        s.step();
        if k % 5 == 0 {
            let cs: Vec<_> = s.world.contacts_of(s.players[0].ctl.body).map(|c| (c.other, c.normal)).take(2).collect();
            println!("{k} {:?} g={g} stuck={:?} {:?}", c(&s), s.players[0].ctl.stuck, cs);
        }
    }
    println!("terrain ids {:?}", s.terrain);
}

#[test]
fn probe_squeeze() {
    for h in [60.0, 50.0, 42.0, 36.0] {
        let mut s = mk(|b| { b.block(v(300.0, h), v(700.0, 400.0)); });
        let mut popped = false;
        for _ in 0..360 {
            s.set_input(0, inp(1.0, false));
            s.step();
            if s.players[0].dead.is_some() { popped = true; break; }
        }
        println!("squeeze h={h}: x {} popped {popped}", c(&s).x);
    }
}

#[test]
fn probe_seesaw() {
    // plank on a wedge, pinned by a short rope to the pivot tip
    let mut s = mk(|b| {
        b.poly(&[v(560.0, 0.0), v(640.0, 0.0), v(600.0, 70.0)]);
        b.prop("plank", PropKind::Block, v(600.0, 88.0), v(520.0, 28.0), 3.0, "#ffd166");
        b.level.ropes.push(RopeDef { id: String::new(), from: RopeEnd::World { at: v(600.0, 88.0) }, to: RopeEnd::Body { id: "plank".into() }, length: 1.0, grabbable: false, style: RopeStyle::Rope });
        b.crate_box(v(780.0, 150.0), 60.0);
    });
    for k in 0..6 {
        run(&mut s, 30, inp(1.0, false));
        let pb = s.world.body(s.props[0]).unwrap();
        let ang = bb_physics::geom::best_fit_angle(&pb.rest.clone(), &pb.x, &vec![1.0; pb.x.len()]);
        println!("seesaw t={} player {:?} plank c {:?} angle {}", k, c(&s), pb.centroid(), ang);
    }
}

#[test]
fn probe_squeeze2() {
    for h in [72.0, 66.0, 60.0, 54.0, 48.0] {
        let mut s = mk(|b| { b.poly(&[v(200.0, 160.0), v(400.0, h), v(800.0, h), v(1000.0, 160.0), v(1000.0, 400.0), v(200.0, 400.0)]); });
        let mut popped = false;
        let mut miny = f32::MAX;
        for _ in 0..360 {
            s.set_input(0, inp(1.0, false));
            s.step();
            if c(&s).x > 400.0 && c(&s).x < 800.0 { miny = miny.min(c(&s).y); }
            if s.players[0].dead.is_some() { popped = true; break; }
        }
        println!("squeeze2 h={h}: x {} popped {popped}", c(&s).x);
    }
}

#[test]

#[test]
fn probe_step_climb() {
    for (gap, hold_right) in [(5.0, true), (5.0, false), (60.0, true), (120.0, true)] {
        for step in [100.0, 150.0, 180.0] {
            let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
            b.spawn(v(300.0 - 32.0 - gap, 40.0)).ground(&[v(-3000.0, 0.0), v(300.0, 0.0)], 300.0).ground(&[v(300.0, step), v(1300.0, step)], 300.0 + step);
            let mut s = Sim::new(b.build());
            s.add_player(0, "P", 0);
            run(&mut s, 60, inp(0.0, false));
            let mut hi = 0.0f32;
            for k in 0..120 {
                s.set_input(0, inp(if hold_right || k > 12 { 1.0 } else { 0.0 }, k < 30));
                s.step();
                hi = hi.max(c(&s).y);
            }
            println!("step {step} gap {gap} hold_right {hold_right}: peak {hi:.0} final {:?} climbed {}", c(&s), c(&s).x > 340.0);
        }
    }
}

#[test]
fn probe_oneway_jump() {
    for thick in [20.0, 40.0, 80.0] {
        for run in [false, true] {
            let mut b = LevelBuilder::new("p", "P", Theme::Hollow);
            b.spawn(v(0.0, 540.0)).ground(&[v(-3000.0, 0.0), v(8000.0, 0.0)], 300.0);
            b.one_way(v(-400.0, 500.0 - thick), v(400.0, 500.0));
            let mut s = Sim::new(b.build());
            s.add_player(0, "P", 0);
            run_n(&mut s, 90, inp(0.0, false));
            let y0 = c(&s).y;
            let mut hi = y0;
            for k in 0..60 {
                s.set_input(0, inp(if run { 1.0 } else { 0.0 }, k < 30));
                s.step();
                hi = hi.max(c(&s).y);
            }
            println!("oneway thick {thick} run {run}: rest {y0:.0} jump peak +{:.0}", hi - y0);
        }
    }
}

fn run_n(s: &mut Sim, n: usize, i: Input) {
    s.set_input(0, i);
    for _ in 0..n {
        s.step();
    }
}

#[test]
fn probe_ch10_m8() {
    let mut l = bb_level::campaign::chapter(10);
    l.npcs.clear();
    let mut s = Sim::new(l);
    s.add_player(0, "P", 0);
    let body = s.players[0].ctl.body;
    let at: Vec<f32> = std::env::var("AT").unwrap_or("610,1480".into()).split(',').map(|x| x.parse().unwrap()).collect();
    s.world.respawn(body, v(at[0], at[1]));
    run_n(&mut s, 60, inp(0.0, false));
    for k in 0..30 {
        s.set_input(0, inp(-0.3, k < 25));
        s.step();
        let cs: Vec<String> = s.world.contacts_of(body).map(|c| format!("{:?} n({:.2},{:.2})", c.other, c.normal.x, c.normal.y)).take(3).collect();
        println!("{k} pos {:?} v {:?} {:?}", c(&s), s.world.body(body).unwrap().velocity(), cs);
    }
    for (i, t) in s.level.terrain.iter().enumerate() {
        let (mn, mx) = t.shape.bounds();
        if mn.x < at[0] + 100.0 && mx.x > at[0] - 100.0 && mn.y < at[1] + 220.0 && mx.y > at[1] - 30.0 { println!("terrain {i} {mn} {mx} oneway {}", t.one_way); }
    }
}
