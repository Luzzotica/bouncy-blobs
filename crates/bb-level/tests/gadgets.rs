//! The gadget set-pieces, played in their real chapters: ch04's seed pods,
//! ch05's spinning gears, ch07's balloons, ch08's claw machine. Each test
//! drives the blob with a few scripted inputs and checks the intended line
//! works and the obvious wrong one doesn't.

use bb_level::campaign::{self, Move};
use bb_level::*;
use bb_sim::gadgets::{GadgetEvent, GadgetRt};
use bb_sim::{Input, Sim, SimEvent, Vec2};

fn sim_for(n: u8) -> Sim {
    let mut l = campaign::chapter(n);
    // Followers wander into the gadgets; this is about the player.
    l.npcs.clear();
    let mut sim = Sim::new(l);
    sim.add_player(0, "P", 0x4d96ff);
    sim
}
fn body(sim: &Sim) -> &bb_physics::Body {
    sim.world.body(sim.players[0].ctl.body).unwrap()
}
fn pos(sim: &Sim) -> Vec2 {
    body(sim).centroid()
}
fn put(sim: &mut Sim, at: Vec2) {
    let id = sim.players[0].ctl.body;
    sim.world.respawn(id, at);
}
fn set(sim: &mut Sim, stick: Vec2, button: bool) {
    sim.set_input(0, Input { stick, button });
}
fn dead(sim: &Sim) -> bool {
    sim.players[0].dead.is_some()
}
/// Gadget events this step: (gadget index, event).
fn events(sim: &mut Sim) -> Vec<(usize, GadgetEvent)> {
    sim.drain_events().into_iter().filter_map(|e| if let SimEvent::Gadget { index, what, .. } = e { Some((index, what)) } else { None }).collect()
}
fn gadget_near(sim: &Sim, p: Vec2) -> usize {
    sim.level.gadgets.iter().enumerate().min_by(|a, b| a.1.pos.distance(p).total_cmp(&b.1.pos.distance(p))).unwrap().0
}

/// Run until the blob has landed (grounded, slow, after `min` frames) or
/// popped; returns where it came to rest (None = popped).
fn settle(sim: &mut Sim, frames: usize, mut input: impl FnMut(&Sim, usize) -> Input) -> Option<Vec2> {
    let mut calm = 0;
    for f in 0..frames {
        let i = input(sim, f);
        sim.set_input(0, i);
        sim.step();
        if dead(sim) {
            return None;
        }
        let held = bb_sim::gadgets::is_held(sim, sim.players[0].ctl.body);
        calm = if sim.players[0].ctl.grounded && !held && body(sim).velocity().length() < 260.0 { calm + 1 } else { 0 };
        if calm > 20 {
            return Some(pos(sim));
        }
    }
    Some(pos(sim))
}

// ------------------------------------------------------------ ch05 gears

/// Roll right from `from` into the next gear; keep still while it carries
/// you; with `press_before`, swell from that many frames before it lets go
/// (the launch frame comes from a dry run: the sim is deterministic).
fn ride_gear(from: Vec2, press_before: Option<usize>) -> Option<Vec2> {
    let run = |press: Option<usize>| {
        let mut sim = sim_for(5);
        put(&mut sim, from);
        let mut gripped = false;
        let mut launch = None;
        let mut frame = 0;
        let end = settle(&mut sim, 900, |s, f| {
            frame = f;
            gripped |= bb_sim::gadgets::is_held(s, s.players[0].ctl.body);
            if launch.is_none() && gripped && !bb_sim::gadgets::is_held(s, s.players[0].ctl.body) {
                launch = Some(f - 1);
            }
            if std::env::var("GADGET_TRACE").is_ok() {
                for e in s.events.iter() {
                    if let SimEvent::Gadget { what, .. } = e {
                        println!("f{f} EVENT {what:?} v {:.0} press {press:?}", body(s).velocity());
                    }
                }
            }
            if std::env::var("GADGET_TRACE").is_ok() && f % 5 == 0 {
                println!("f{f} c {:.0} v {:.0} held {gripped}", pos(s), body(s).velocity());
            }
            Input { stick: if gripped { Vec2::ZERO } else { Vec2::X }, button: press.is_some_and(|p| f >= p && f < p + 40) }
        });
        (end, launch)
    };
    let (end, launch) = run(None);
    match press_before {
        None => end,
        Some(k) => run(Some(launch.expect("gear never launched") - k)).0,
    }
}

#[test]
fn ch05_gears_fling_you_up_and_across() {
    // The first gear: up onto the ledge over safe floor.
    let end = ride_gear(Vec2::new(10050.0, 1540.0), None);
    let at = end.expect("popped riding the first gear");
    println!("gear 1 → {at}");
    assert!(at.x > 10650.0 && at.x < 11400.0 && (at.y - 1832.0).abs() < 40.0, "gear 1 landed at {at}");
    // The second: across the spike pit.
    let end = ride_gear(Vec2::new(10950.0, 1840.0), None);
    let at = end.expect("popped riding the second gear (spike pit)");
    println!("gear 2 → {at}");
    assert!(at.x > 12350.0 && at.x < 14000.0 && (at.y - 1832.0).abs() < 40.0, "gear 2 landed at {at}");
}

#[test]
fn ch05_last_gear_needs_the_swell_boost() {
    let from = Vec2::new(12950.0, 1840.0);
    // A plain fling falls back beside the gear (and it grabs you again):
    // it never gets you onto the shelf.
    let mut sim = sim_for(5);
    put(&mut sim, from);
    let mut gripped = false;
    let mut flings = 0;
    for _ in 0..900 {
        gripped |= bb_sim::gadgets::is_held(&sim, sim.players[0].ctl.body);
        set(&mut sim, if gripped { Vec2::ZERO } else { Vec2::X }, false);
        sim.step();
        flings += events(&mut sim).iter().filter(|e| matches!(e.1, GadgetEvent::PlateLaunch { .. })).count();
        assert!(!dead(&sim), "popped on a plain fling");
        let c = pos(&sim);
        assert!(!(c.y > 2440.0 && sim.players[0].ctl.grounded), "a plain fling reached the shelf at {c}");
    }
    println!("gear 3 plain: {flings} flings, never up");
    assert!(flings >= 1);
    let end = ride_gear(from, Some(4));
    let boosted = end.expect("popped on a boosted fling");
    println!("gear 3 boosted → {boosted}");
    assert!(boosted.y > 2430.0 && boosted.x > 13480.0, "swelling as it let go should reach the shelf, got {boosted}");
}

// ------------------------------------------------------------- ch04 pods

/// Roll right into a pod, fire when `fire(aim_deg, secs_inside)`; after
/// `shots` shots (chained pods count), return where you first land
/// (None = popped).
fn pod_run(from: Vec2, shots: usize, fire: impl Fn(f32, f32) -> bool) -> Option<Vec2> {
    let mut sim = sim_for(4);
    put(&mut sim, from);
    let mut inside: Option<(usize, usize)> = None;
    let mut fired = 0;
    let mut airborne = false;
    for f in 0..1500 {
        let button = if let Some((g, at)) = inside {
            let aim = if let GadgetRt::Pod { aim, .. } = sim.gadgets[g].rt { aim.to_degrees() } else { 0.0 };
            fire(aim, (f - at) as f32 / 60.0)
        } else {
            false
        };
        let stick = if inside.is_none() && fired == 0 { Vec2::X } else { Vec2::ZERO };
        set(&mut sim, stick, button);
        sim.step();
        for (g, e) in events(&mut sim) {
            match e {
                GadgetEvent::PodLoad => inside = Some((g, f)),
                GadgetEvent::PodFire => {
                    inside = None;
                    fired += 1;
                }
                _ => {}
            }
        }
        if dead(&sim) {
            return None;
        }
        if fired >= shots && inside.is_none() {
            if !sim.players[0].ctl.grounded {
                airborne = true;
            } else if airborne {
                return Some(pos(&sim));
            }
        }
    }
    None
}

#[test]
fn ch04_first_pod_lobs_you_onto_the_branch() {
    let at = pod_run(Vec2::new(11750.0, 2640.0), 1, |_, t| t > 0.5).expect("popped");
    println!("pod 1 → {at}");
    assert!(at.x > 12350.0 && at.x < 12950.0 && (at.y - 2792.0).abs() < 40.0, "landed at {at}");
}

#[test]
fn ch04_nodding_pod_needs_timing() {
    let from = Vec2::new(12600.0, 2800.0);
    // Fire while the barrel points high: across the brambles.
    let good = pod_run(from, 1, |aim, t| t > 0.35 && aim > 38.0).expect("popped firing high");
    println!("nodding pod, high → {good}");
    assert!(good.x > 13950.0 && good.x < 14700.0 && (good.y - 2792.0).abs() < 40.0, "landed at {good}");
    // Fire at the bottom of the nod: short, into the brambles.
    let bad = pod_run(from, 1, |aim, t| t > 0.35 && aim < 19.0);
    println!("nodding pod, low → {bad:?}");
    assert!(bad.is_none_or(|p| p.x < 13950.0), "a low shot still made it ({bad:?})");
}

#[test]
fn ch04_pod_fires_you_into_a_hanging_pod() {
    let from = Vec2::new(14380.0, 2800.0);
    let mut sim = sim_for(4);
    let hung = gadget_near(&sim, Vec2::new(15160.0, 2790.0));
    drop(sim.drain_events());
    // Watch for the catch by the hanging pod.
    put(&mut sim, from);
    let mut caught = false;
    let mut fired = 0;
    for _ in 0..600 {
        let inside = sim.gadgets.iter().position(|g| matches!(g.rt, GadgetRt::Pod { loaded: Some(_), .. }));
        set(&mut sim, if inside.is_none() && fired == 0 { Vec2::X } else { Vec2::ZERO }, false);
        sim.step();
        for (g, e) in events(&mut sim) {
            if e == GadgetEvent::PodLoad && g == hung {
                caught = true;
            }
            if e == GadgetEvent::PodFire {
                fired += 1;
            }
        }
        if caught || dead(&sim) {
            break;
        }
    }
    assert!(caught, "the hanging pod didn't catch the shot (blob at {})", pos(&sim));
    // Then fire from it when it points high enough: onto the far bank.
    let at = pod_run(from, 2, |aim, t| t > 0.35 && (aim > 26.0 || t > 2.0)).expect("popped on the pod chain");
    println!("pod chain → {at}");
    assert!(at.x > 15700.0 && (at.y - 2792.0).abs() < 40.0, "landed at {at}");
}

// ---------------------------------------------------------- ch07 balloons

/// Fly a balloon: `plan(pos)` gives (x to steer toward, altitude to hold);
/// the button is held while below that altitude (with a little lookahead).
fn balloon_run(from: Vec2, end_x: f32, plan: impl Fn(Vec2) -> (f32, f32)) -> (Option<Vec2>, Vec<GadgetEvent>) {
    let mut sim = sim_for(7);
    put(&mut sim, from);
    let mut seen = Vec::new();
    let mut had = false;
    let trace = std::env::var("GADGET_TRACE").is_ok();
    for f in 0..900 {
        let c = pos(&sim);
        let v = body(&sim).velocity();
        let has = bb_sim::gadgets::has_balloon(&sim, sim.players[0].ctl.body);
        had |= has;
        let (to_x, alt) = plan(c);
        let button = has && c.y + v.y * 0.3 < alt;
        let stick = Vec2::new(((to_x - c.x) / 120.0).clamp(-1.0, 1.0), 0.0);
        set(&mut sim, stick, button);
        sim.step();
        let ev: Vec<GadgetEvent> = events(&mut sim).into_iter().map(|e| e.1).collect();
        if trace && (f % 10 == 0 || !ev.is_empty()) {
            println!("f{f} c {c:.0} v {v:.0} has {has} btn {button} {ev:?}");
        }
        seen.extend(ev);
        if dead(&sim) {
            return (None, seen);
        }
        if had && sim.players[0].ctl.grounded && c.x > end_x {
            return (Some(pos(&sim)), seen);
        }
    }
    (Some(pos(&sim)), seen)
}

#[test]
fn ch07_balloon_floats_you_up_onto_the_shelf() {
    // Rise beside the shelf, then drift over it and sink onto it.
    let (end, seen) = balloon_run(Vec2::new(9250.0, 4540.0), 9850.0, |c| if c.y < 5200.0 { (9500.0, 5300.0) } else { (10000.0, 5000.0) });
    let at = end.expect("popped");
    println!("balloon 1 → {at} {seen:?}");
    assert!(seen.contains(&GadgetEvent::BalloonTie));
    assert!((at.y - 5152.0).abs() < 40.0 && at.x > 9800.0 && at.x < 10300.0, "ended at {at}");
}

#[test]
fn ch07_balloon_drifts_you_over_the_gulf() {
    let (end, seen) = balloon_run(Vec2::new(10000.0, 5160.0), 11320.0, |c| if c.x < 11250.0 { (11500.0, 5260.0) } else { (11500.0, 5000.0) });
    let at = end.expect("popped crossing the gulf");
    println!("balloon 2 → {at} {seen:?}");
    assert!((at.y - 5152.0).abs() < 40.0 && at.x > 11300.0, "ended at {at}");
    // Never puffing: you just sink into the brambles.
    let (end, _) = balloon_run(Vec2::new(10000.0, 5160.0), 11320.0, |_| (11500.0, 0.0));
    assert!(end.is_none_or(|p| p.x < 11300.0), "crossed without puffing ({end:?})");
}

#[test]
fn ch07_needle_flue_pops_balloons_that_fly_high() {
    // Low and steady under the fang: through.
    let (end, seen) = balloon_run(Vec2::new(11500.0, 5160.0), 12920.0, |c| if c.x < 12500.0 { (13100.0, 5090.0) } else if c.x < 12950.0 { (13100.0, 5170.0) } else { (13100.0, 4900.0) });
    let at = end.expect("popped in the needle flue");
    println!("balloon 3 → {at} {seen:?}");
    assert!(!seen.contains(&GadgetEvent::BalloonPop), "{seen:?}");
    assert!(at.x > 12900.0 && (at.y - 5092.0).abs() < 40.0, "ended at {at}");
    // Up high: the roof spikes pop the balloon and down you go.
    let (end, seen) = balloon_run(Vec2::new(11500.0, 5160.0), 12920.0, |_| (13100.0, 5450.0));
    println!("balloon 3 high → {end:?} {seen:?}");
    assert!(seen.contains(&GadgetEvent::BalloonPop), "flying high didn't pop the balloon: {seen:?}");
    assert!(end.is_none(), "survived after the balloon popped over spikes");
}

// ------------------------------------------------------ ch08 claw machine

/// Ride both claws; `swell(t_since_second_grab)` decides the button on the
/// second ride. Returns where you ended (None = popped).
fn claw_run(swell: impl Fn(f32) -> bool) -> Option<Vec2> {
    let mut sim = sim_for(8);
    put(&mut sim, Vec2::new(11560.0, 2600.0));
    let second = gadget_near(&sim, Vec2::new(13260.0, 2710.0));
    let mut grabbed_2: Option<usize> = None;
    let mut dropped_2: Option<usize> = None;
    let mut drops = 0;
    for f in 0..1500 {
        let c = pos(&sim);
        let held = bb_sim::gadgets::is_held(&sim, sim.players[0].ctl.body);
        let t2 = grabbed_2.map_or(-1.0, |g| (f - g) as f32 / 60.0);
        let target = if drops == 0 { 11740.0 } else if dropped_2.is_none() { 13260.0 } else { 15000.0 };
        let stick = if held || dropped_2.is_some_and(|d| f < d + 20) { Vec2::ZERO } else { Vec2::new(((target - c.x) / 60.0).clamp(-1.0, 1.0), 0.0) };
        let button = grabbed_2.is_some() && swell(t2);
        set(&mut sim, stick, button);
        sim.step();
        for (g, e) in events(&mut sim) {
            match e {
                GadgetEvent::CraneGrab if g == second => grabbed_2 = grabbed_2.or(Some(f)),
                GadgetEvent::CraneDrop => {
                    drops += 1;
                    if g == second {
                        dropped_2 = Some(f);
                    }
                }
                _ => {}
            }
        }
        if dead(&sim) {
            return None;
        }
        if c.x > 14700.0 && sim.players[0].ctl.grounded && (c.y - 2592.0).abs() < 40.0 {
            return Some(c);
        }
    }
    Some(pos(&sim))
}

#[test]
fn ch08_claw_machine_needs_a_swell_at_the_chute() {
    // Reach .35 + close .2 + lift .45 + carry 2.6 + pause .45 = 4.05 s to the drop.
    let none = claw_run(|_| false);
    println!("claw, no swell → {none:?}");
    assert!(none.is_none_or(|p| p.x < 14530.0), "reached the lid without swelling");
    let good = claw_run(|t| t > 3.6);
    println!("claw, swell at the drop → {good:?}");
    assert!(good.is_some_and(|p| p.x > 14700.0), "swelling as the claw opened didn't reach the lid ({good:?})");
}

// ------------------------------------------------------------- no cheese

/// Rule 5 for gadget crossings: wherever a gadget carries / flings / floats
/// you over a floor hazard, the roof over it is out of reach (700+ px above
/// the path) or spiked.
#[test]
fn gadget_crossings_have_no_ceiling_shortcut() {
    let mut errs = Vec::new();
    for n in [4u8, 5, 7, 8] {
        let c = campaign::course(n);
        let l = &c.level;
        let sim = Sim::new(l.clone());
        let roof_spiked = |x: f32| l.spikes.iter().any(|s| (s.b - s.a).perp().y < 0.0 && x >= s.a.x.min(s.b.x) && x <= s.a.x.max(s.b.x));
        let floor_spiked = |x: f32| l.spikes.iter().any(|s| (s.b - s.a).perp().y > 0.0 && x >= s.a.x.min(s.b.x) && x <= s.a.x.max(s.b.x));
        for w in c.path.windows(2) {
            if !matches!(w[1].how, Move::Spring | Move::Ride | Move::Wind) {
                continue;
            }
            let (a, b) = (w[0].at, w[1].at);
            let (x0, x1) = (a.x.min(b.x), a.x.max(b.x));
            if !l.gadgets.iter().any(|g| g.pos.x > x0 - 400.0 && g.pos.x < x1 + 400.0) {
                continue;
            }
            let mut x = x0;
            while x <= x1 {
                if floor_spiked(x) {
                    let y = a.y.max(b.y);
                    let hit = sim.world.raycast(Vec2::new(x, y + 40.0), Vec2::Y, 2000.0, bb_sim::load::layer::WORLD, None);
                    let room = hit.map_or(f32::MAX, |h| h.3 + 40.0);
                    if room < 700.0 && !roof_spiked(x) {
                        errs.push(format!("ch{n:02}: roof only {room:.0} px over the gadget crossing at x={x:.0} and not spiked"));
                        break;
                    }
                }
                x += 25.0;
            }
        }
    }
    assert!(errs.is_empty(), "{}", errs.join("\n"));
}

#[test]
fn gadget_chapters_have_their_gadgets() {
    let count = |n: u8, f: fn(&GadgetKind) -> bool| campaign::chapter(n).gadgets.iter().filter(|g| f(&g.kind)).count();
    assert!(count(4, |k| matches!(k, GadgetKind::Launcher { .. })) >= 3, "ch04 seed pods");
    assert!(count(5, |k| matches!(k, GadgetKind::LaunchPlate { .. })) >= 3, "ch05 gears");
    assert!(count(7, |k| matches!(k, GadgetKind::Balloon { .. })) >= 3, "ch07 balloons");
    assert!(count(8, |k| matches!(k, GadgetKind::Crane { .. })) >= 2, "ch08 claws");
    for n in [1u8, 2, 3, 6, 9, 10] {
        assert!(campaign::chapter(n).gadgets.is_empty(), "ch{n:02} has gadgets it shouldn't");
    }
}
