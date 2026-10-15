//! Gadgets: launch plates, seed pods, balloons, claw cranes.
use bb_level::{LevelBuilder, Theme, v};
use bb_sim::gadgets::{self, GadgetEvent, GadgetRt};
use bb_sim::{Input, Sim, SimEvent, Vec2};

fn pbody(sim: &Sim) -> &bb_physics::Body {
    sim.world.body(sim.players[0].ctl.body).unwrap()
}
fn put(sim: &mut Sim, at: Vec2) {
    let id = sim.players[0].ctl.body;
    let off = at - pbody(sim).centroid();
    if let Some(bd) = sim.world.body_mut(id) {
        for p in bd.x.iter_mut() {
            *p += off;
        }
        for p in bd.prev.iter_mut() {
            *p += off;
        }
        for vv in bd.v.iter_mut() {
            *vv = Vec2::ZERO;
        }
    }
}
fn set(sim: &mut Sim, stick: Vec2, button: bool) {
    sim.set_input(0, Input { stick, button });
}
fn gadget_events(sim: &mut Sim) -> Vec<(GadgetEvent, Vec2)> {
    sim.drain_events().into_iter().filter_map(|e| if let SimEvent::Gadget { what, pos, .. } = e { Some((what, pos)) } else { None }).collect()
}
/// The blob's gravity (2.x's, stronger than the world's).
fn blob_g(sim: &Sim) -> f32 {
    sim.tuning.gravity.gravity
}

// ------------------------------------------------------------ launch plate

const PLATE: Vec2 = Vec2::new(0.0, 500.0);

fn plate_sim(speed: f32, angle: f32) -> Sim {
    let mut b = LevelBuilder::new("plate", "Plate", Theme::Stoneworks);
    b.spawn(v(-600.0, 40.0)).kill_y(-3000.0);
    b.ground(&[v(-1500.0, 0.0), v(6000.0, 0.0)], 300.0);
    b.launch_plate(PLATE, 150.0, speed, angle, true);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    // Drop onto the top of the gear.
    put(&mut sim, PLATE + v(-20.0, 150.0 + 14.0 + 40.0));
    sim
}

/// Ride the plate; press the button from frame `press` on (None = never).
/// Returns (launch frame, velocity just after the launch, launch event).
fn ride_plate(speed: f32, angle: f32, press: Option<usize>) -> (usize, Vec2, GadgetEvent) {
    let mut sim = plate_sim(speed, angle);
    for f in 0..900 {
        set(&mut sim, Vec2::ZERO, press.is_some_and(|p| f >= p));
        sim.step();
        assert!(sim.players[0].dead.is_none(), "popped on the plate");
        if let Some((e, _)) = gadget_events(&mut sim).into_iter().find(|e| matches!(e.0, GadgetEvent::PlateLaunch { .. })) {
            return (f, pbody(&sim).velocity(), e);
        }
    }
    panic!("the plate never flung the blob");
}

#[test]
fn plate_grips_spins_up_and_flings_tangentially_at_rim_speed() {
    for (speed, angle) in [(1400.0, 45.0), (1100.0, 70.0)] {
        let (f, vel, e) = ride_plate(speed, angle, None);
        let dir = Vec2::from_angle(f32::to_radians(angle));
        let off = vel.angle_to(dir).to_degrees().abs();
        println!("plate {speed} @ {angle}°: launched at frame {f}, v {vel} ({:.0} px/s, {off:.1}° off)", vel.length());
        assert_eq!(e, GadgetEvent::PlateLaunch { boosted: false });
        assert!(off < 6.0, "launch {off:.1}° off the tangent");
        assert!((vel.length() / speed - 1.0).abs() < 0.08, "launch speed {:.0} vs rim speed {speed}", vel.length());
        // It took a moment to spin up (not an instant spring).
        assert!(f > 30, "flung after only {f} frames");
    }
}

#[test]
fn swelling_at_the_release_adds_the_swell_boost() {
    let (f, plain, _) = ride_plate(1400.0, 45.0, None);
    // Press a few frames before it lets go.
    let (f2, boosted, e) = ride_plate(1400.0, 45.0, Some(f - 4));
    println!("plain {:.0} px/s at {f}, swelled {:.0} px/s at {f2}", plain.length(), boosted.length());
    assert_eq!(e, GadgetEvent::PlateLaunch { boosted: true });
    assert!(boosted.length() > plain.length() * 1.3, "swell boost too small: {:.0} vs {:.0}", boosted.length(), plain.length());
    assert!(boosted.angle_to(plain).to_degrees().abs() < 6.0, "boost changed the direction");
    // Holding the button the whole ride (puffed long before) still helps a bit.
    let (_, early, _) = ride_plate(1400.0, 45.0, Some(0));
    assert!(early.length() > plain.length() * 1.05 && early.length() < boosted.length(), "early {:.0}", early.length());
}

#[test]
fn a_flung_blob_flies_far() {
    // 1400 px/s at 45°, blob gravity: range ≈ v²/g (plus the drop from the plate).
    let mut sim = plate_sim(1400.0, 45.0);
    let mut launched_at = None;
    for _ in 0..900 {
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        if gadget_events(&mut sim).iter().any(|e| matches!(e.0, GadgetEvent::PlateLaunch { .. })) {
            launched_at = Some(pbody(&sim).centroid());
        }
        if launched_at.is_some() && sim.players[0].ctl.grounded {
            break;
        }
    }
    let from = launched_at.expect("never launched");
    let land = pbody(&sim).centroid();
    let ideal = 1400.0f32.powi(2) / blob_g(&sim);
    println!("flung from {from} landed {land} ({:.0} px; flat-ground ideal {ideal:.0})", land.x - from.x);
    assert!(land.x - from.x > ideal * 0.9, "only flew {:.0}", land.x - from.x);
}

// ---------------------------------------------------------------- seed pod

fn pod_sim(angle: f32, sweep: f32, power: f32) -> Sim {
    let mut b = LevelBuilder::new("pod", "Pod", Theme::Vines);
    b.spawn(v(-400.0, 40.0)).kill_y(-3000.0);
    b.ground(&[v(-1500.0, 0.0), v(6000.0, 0.0)], 300.0);
    b.seed_pod(v(0.0, 0.0), 130.0, angle, sweep, power);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    sim
}

/// Roll into the pod from the left, wait `wait` s inside, press to fire.
/// Returns (velocity after firing, launch point, landing point).
fn fire_pod(angle: f32, sweep: f32, power: f32, wait: f32) -> (Vec2, Vec2, Vec2) {
    let mut sim = pod_sim(angle, sweep, power);
    put(&mut sim, v(-200.0, 40.0));
    let mut loaded_at = None;
    let mut fired: Option<(Vec2, Vec2)> = None;
    for f in 0..1200 {
        let t = f as f32 / 60.0;
        let press = loaded_at.is_some_and(|l: f32| t - l >= wait) && fired.is_none();
        // Roll right and hop into the mouth.
        let (stick, button) = if loaded_at.is_none() { (v(1.0, 0.0), f % 40 < 12) } else { (Vec2::ZERO, press) };
        set(&mut sim, stick, button);
        sim.step();
        for (e, _) in gadget_events(&mut sim) {
            match e {
                GadgetEvent::PodLoad => loaded_at = Some(t),
                GadgetEvent::PodFire => fired = Some((pbody(&sim).velocity(), pbody(&sim).centroid())),
                _ => {}
            }
        }
        if let Some((vel, from)) = fired {
            if sim.players[0].ctl.grounded && pbody(&sim).centroid().x > from.x + 100.0 {
                return (vel, from, pbody(&sim).centroid());
            }
        }
    }
    panic!("pod never fired / landed (loaded {loaded_at:?}, fired {fired:?})");
}

#[test]
fn seed_pod_fires_along_its_barrel_with_predictable_range() {
    let power = 1100.0;
    let (vel, from, land) = fire_pod(45.0, 0.0, power, 0.6);
    let sim = pod_sim(45.0, 0.0, power);
    let g = blob_g(&sim);
    let speed = power * (g / 1800.0).sqrt();
    let off = vel.angle_to(Vec2::from_angle(45f32.to_radians())).to_degrees().abs();
    // Ballistic range from the mouth down to resting height (centroid 32 up).
    let (vx, vy) = (speed * 0.7071, speed * 0.7071);
    let h = from.y - 32.0;
    let t = (vy + (vy * vy + 2.0 * g * h).sqrt()) / g;
    let ideal = vx * t;
    println!("pod: v {vel} ({:.0} px/s, {off:.1}° off), flew {:.0} (ideal {ideal:.0})", vel.length(), land.x - from.x);
    assert!(off < 3.0, "fired {off:.1}° off the barrel");
    assert!((vel.length() / speed - 1.0).abs() < 0.05, "muzzle speed {:.0} vs {speed:.0}", vel.length());
    assert!(((land.x - from.x) / ideal - 1.0).abs() < 0.15, "range {:.0} vs ideal {ideal:.0}", land.x - from.x);
}

#[test]
fn seed_pod_holds_you_then_fires_by_itself_and_swings_its_aim() {
    let mut sim = pod_sim(60.0, 25.0, 1000.0);
    let pod = sim.level.gadgets[0].pos;
    put(&mut sim, pod + v(0.0, 10.0));
    let mut aims = Vec::new();
    let mut loaded = None;
    for f in 0..400 {
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        if let GadgetRt::Pod { aim, .. } = sim.gadgets[0].rt {
            aims.push(aim.to_degrees());
        }
        for (e, _) in gadget_events(&mut sim) {
            match e {
                GadgetEvent::PodLoad => loaded = Some(f),
                GadgetEvent::PodFire => {
                    let l = loaded.expect("fired before loading");
                    let held = (f - l) as f32 / 60.0;
                    println!("auto-fired after {held:.2} s");
                    assert!((held - 2.5).abs() < 0.1, "auto-fire after {held}");
                    let lo = aims.iter().copied().fold(f32::MAX, f32::min);
                    let hi = aims.iter().copied().fold(f32::MIN, f32::max);
                    assert!(lo < 40.0 && hi > 80.0, "aim swung only {lo:.0}..{hi:.0}");
                    return;
                }
                _ => {}
            }
        }
        if loaded.is_some() && f > loaded.unwrap() + 2 {
            // Held still in the mouth.
            assert!(pbody(&sim).centroid().distance(pod) < 12.0, "drifted out of the pod: {}", pbody(&sim).centroid());
        }
    }
    panic!("never auto-fired");
}

// ----------------------------------------------------------------- balloon

fn balloon_sim(roof_spikes: Option<f32>) -> Sim {
    let mut b = LevelBuilder::new("balloon", "Balloon", Theme::Chimney);
    b.spawn(v(0.0, 40.0)).kill_y(-3000.0);
    b.ground(&[v(-1500.0, 0.0), v(3000.0, 0.0)], 300.0);
    b.balloon(v(200.0, 70.0), 7.0);
    if let Some(y) = roof_spikes {
        b.block(v(-1500.0, y), v(3000.0, y + 300.0));
        b.ceiling_spikes(-1500.0, 3000.0, y);
    }
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    sim
}

/// Roll right into the balloon and tie it on. Returns the frame it was tied.
fn take_balloon(sim: &mut Sim) {
    for _ in 0..240 {
        set(sim, v(1.0, 0.0), false);
        sim.step();
        if gadget_events(sim).iter().any(|e| e.0 == GadgetEvent::BalloonTie) {
            return;
        }
    }
    panic!("never tied the balloon on");
}

#[test]
fn balloon_lifts_while_swelling_sinks_when_not_and_expires() {
    let mut sim = balloon_sim(None);
    take_balloon(&mut sim);
    let body = sim.players[0].ctl.body;
    assert!(gadgets::has_balloon(&sim, body));
    let y0 = pbody(&sim).centroid().y;
    // Hold swell: rise, never faster than the cap.
    let mut top_vy: f32 = 0.0;
    for _ in 0..180 {
        set(&mut sim, Vec2::ZERO, true);
        sim.step();
        top_vy = top_vy.max(pbody(&sim).velocity().y);
    }
    let y1 = pbody(&sim).centroid().y;
    println!("balloon: rose {:.0} px in 3 s, top vy {top_vy:.0}", y1 - y0);
    assert!(y1 - y0 > 650.0, "only rose {:.0}", y1 - y0);
    assert!(top_vy <= 380.0 + 25.0, "rose too fast ({top_vy:.0} px/s)");
    // Let go: sink gently.
    let mut low_vy: f32 = 0.0;
    for _ in 0..90 {
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        low_vy = low_vy.min(pbody(&sim).velocity().y);
    }
    let y2 = pbody(&sim).centroid().y;
    println!("released: sank {:.0} px in 1.5 s, fastest {low_vy:.0}", y1 - y2);
    assert!(y2 < y1 - 120.0, "didn't sink");
    assert!(low_vy > -300.0 - 25.0, "sank too fast ({low_vy:.0})");
    // Run out the clock: it's gone, and you fall normally.
    let mut gone = false;
    for _ in 0..300 {
        set(&mut sim, Vec2::ZERO, true);
        sim.step();
        gone |= gadget_events(&mut sim).iter().any(|e| e.0 == GadgetEvent::BalloonGone);
    }
    assert!(gone, "balloon never expired");
    assert!(!gadgets::has_balloon(&sim, body));
    assert!(sim.players[0].ctl.grounded || pbody(&sim).velocity().y < -300.0, "still floating after it expired");
    // It floats back home for another go.
    for _ in 0..200 {
        sim.step();
    }
    match sim.gadgets[0].rt {
        GadgetRt::Balloon { away, carrier, .. } => assert!(away <= 0.0 && carrier.is_none(), "balloon didn't come back"),
        _ => unreachable!(),
    }
}

#[test]
fn balloon_lift_scales_with_puff() {
    // Half a puff (a tap) lifts less than a full swell: compare climb with
    // the button held vs pulsed.
    let climb = |pattern: fn(usize) -> bool| {
        let mut sim = balloon_sim(None);
        take_balloon(&mut sim);
        let y0 = pbody(&sim).centroid().y;
        for f in 0..150 {
            set(&mut sim, Vec2::ZERO, pattern(f));
            sim.step();
        }
        pbody(&sim).centroid().y - y0
    };
    let full = climb(|_| true);
    let pulsed = climb(|f| f % 20 < 7);
    println!("full {full:.0}, pulsed {pulsed:.0}");
    assert!(full > pulsed + 150.0, "lift doesn't scale with puff (full {full:.0} vs pulsed {pulsed:.0})");
}

#[test]
fn balloon_pops_on_spikes_and_you_fall() {
    let mut sim = balloon_sim(Some(620.0));
    take_balloon(&mut sim);
    let mut popped = None;
    for f in 0..300 {
        set(&mut sim, Vec2::ZERO, true);
        sim.step();
        if gadget_events(&mut sim).iter().any(|e| e.0 == GadgetEvent::BalloonPop) {
            popped = Some(f);
            break;
        }
    }
    let f = popped.expect("balloon never touched the roof spikes");
    let at = pbody(&sim).centroid();
    println!("popped at frame {f}, blob at {at}");
    assert!(sim.players[0].dead.is_none(), "the blob itself shouldn't pop (the balloon is above it)");
    assert!(!gadgets::has_balloon(&sim, sim.players[0].ctl.body));
    for _ in 0..90 {
        set(&mut sim, Vec2::ZERO, true);
        sim.step();
    }
    assert!(pbody(&sim).centroid().y < at.y - 200.0, "didn't fall after the pop");
}

#[test]
fn balloon_keeps_you_off_the_roof() {
    // With a balloon you can't crawl along a ceiling: the balloon's in the way.
    let mut b = LevelBuilder::new("roof", "Roof", Theme::Chimney);
    b.spawn(v(0.0, 40.0)).kill_y(-3000.0);
    b.ground(&[v(-1500.0, 0.0), v(3000.0, 0.0)], 300.0);
    b.balloon(v(200.0, 70.0), 7.0);
    b.block(v(-1500.0, 700.0), v(3000.0, 1000.0));
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    take_balloon(&mut sim);
    let mut top: f32 = 0.0;
    for _ in 0..240 {
        set(&mut sim, v(0.0, 1.0), true);
        sim.step();
        top = top.max(pbody(&sim).centroid().y);
    }
    println!("highest centroid {top:.0} under a roof at 700");
    assert!(top < 700.0 - 32.0 * 2.0 - 80.0, "blob got up against the roof ({top:.0})");
}

// ------------------------------------------------------------- claw crane

/// A claw crane carrying you from a pad over a spike gulf to a narrow
/// chute beside a shelf: only a swollen blob wedges across the chute.
pub fn crane_course() -> Sim {
    let mut b = LevelBuilder::new("crane", "Crane", Theme::Toys);
    b.spawn(v(0.0, 40.0)).kill_y(-3000.0);
    b.ground(&[v(-800.0, 0.0), v(200.0, 0.0)], 600.0);
    b.ground(&[v(200.0, -220.0), v(1600.0, -220.0)], 380.0);
    b.spikes(v(200.0, -220.0), v(1600.0, -220.0));
    // Chute: a thin lip, an 80 px slot, the shelf.
    b.block(v(1100.0, -220.0), v(1130.0, 0.0));
    b.ground(&[v(1210.0, 0.0), v(2000.0, 0.0)], 600.0);
    b.crane(v(0.0, 150.0), v(1170.0, 150.0), 2.5);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    sim
}

/// Stand on the pad, get carried, swell from `swell_from` s after the grab
/// (None = never), roll right after the drop. Returns where the blob ended.
fn claw_run(swell_from: Option<f32>) -> (bool, Vec2) {
    let mut sim = crane_course();
    let mut grabbed: Option<usize> = None;
    let mut dropped: Option<usize> = None;
    for f in 0..900 {
        let t = grabbed.map_or(0.0, |g| (f - g) as f32 / 60.0);
        let swell = swell_from.is_some_and(|s| grabbed.is_some() && t >= s);
        let stick = if dropped.is_some_and(|d| f > d + 20) { v(1.0, 0.0) } else { Vec2::ZERO };
        set(&mut sim, stick, swell);
        sim.step();
        for (e, _) in gadget_events(&mut sim) {
            match e {
                GadgetEvent::CraneGrab => grabbed = grabbed.or(Some(f)),
                GadgetEvent::CraneDrop => dropped = Some(f),
                _ => {}
            }
        }
        if sim.players[0].dead.is_some() {
            return (false, Vec2::ZERO);
        }
        let c = pbody(&sim).centroid();
        if c.x > 1350.0 && c.y > 0.0 && sim.players[0].ctl.grounded {
            return (true, c);
        }
    }
    (false, pbody(&sim).centroid())
}

#[test]
fn claw_crane_needs_a_swell_at_the_drop() {
    // Travel: reach .35 + close .2 + lift .45 + carry 2.5 + pause .45 = 3.95 s.
    let (ok, at) = claw_run(None);
    assert!(!ok, "reached the shelf without swelling ({at})");
    let (ok, at) = claw_run(Some(3.4));
    assert!(ok, "swelling as the claw opened didn't reach the shelf ({at})");
    // Puffed the whole ride works too (it's being swollen when dropped that counts).
    let (ok, at) = claw_run(Some(0.5));
    assert!(ok, "swelling the whole ride didn't reach the shelf ({at})");
    // Too late: already through the slot.
    let (ok, _) = claw_run(Some(4.4));
    assert!(!ok, "swelling after falling through still reached the shelf");
}

#[test]
fn claw_crane_carries_you_and_comes_back() {
    let mut sim = crane_course();
    let mut seen = Vec::new();
    for _ in 0..900 {
        set(&mut sim, Vec2::ZERO, false);
        sim.step();
        seen.extend(gadget_events(&mut sim).into_iter().map(|e| e.0));
        if let GadgetRt::Crane { held: Some(_), claw, phase, t, .. } = sim.gadgets[0].rt {
            let d = pbody(&sim).centroid().distance(claw);
            let carrying = matches!(phase, gadgets::ClawPhase::Carry | gadgets::ClawPhase::Pause);
            assert!(!carrying || d < 30.0, "blob fell out of the claw ({d:.0} px in {phase:?} at {t:.2})");
        }
    }
    assert!(seen.contains(&GadgetEvent::CraneGrab) && seen.contains(&GadgetEvent::CraneDrop), "{seen:?}");
    match sim.gadgets[0].rt {
        GadgetRt::Crane { phase, claw, .. } => {
            assert_eq!(phase, gadgets::ClawPhase::Idle, "claw didn't return");
            assert!(claw.distance(sim.level.gadgets[0].pos) < 10.0);
        }
        _ => unreachable!(),
    }
}

#[test]
fn gadget_levels_round_trip() {
    let sim = crane_course();
    let json = sim.level.to_json();
    let back = bb_level::Level::from_json(&json).unwrap();
    assert_eq!(back.gadgets.len(), 1);
    assert_eq!(back.to_json(), json);
    // Levels without gadgets don't mention them.
    let plain = LevelBuilder::new("p", "P", Theme::Hollow).build().to_json();
    assert!(!plain.contains("gadgets"));
}
