//! Behavioural tests for the things that used to break: dense platforms,
//! ropes that stretch, and crushes that cascade.

use bb_physics::*;

const DT: f32 = 1.0 / 60.0;

fn world() -> World {
    let mut w = World::new(Config::default());
    // Floor and two walls.
    w.add_static(StaticDesc::rect(Vec2::new(-2000.0, -100.0), Vec2::new(2000.0, 0.0)));
    w.add_static(StaticDesc::rect(Vec2::new(-2100.0, -100.0), Vec2::new(-2000.0, 2000.0)));
    w.add_static(StaticDesc::rect(Vec2::new(2000.0, -100.0), Vec2::new(2100.0, 2000.0)));
    w
}

fn run(w: &mut World, secs: f32) -> Vec<Event> {
    let mut ev = Vec::new();
    for _ in 0..(secs / DT) as usize {
        w.step(DT);
        ev.extend(w.drain_events());
        for (_, b) in w.bodies() {
            assert!(b.x.iter().all(|p| p.is_finite()), "non-finite particle");
        }
    }
    ev
}

fn pops(ev: &[Event]) -> Vec<BodyId> {
    ev.iter().filter_map(|e| if let Event::Popped { body, .. } = e { Some(*body) } else { None }).collect()
}

#[test]
fn blob_lands_and_rests() {
    let mut w = world();
    let b = w.add_body(BodyDesc::blob(Vec2::new(0.0, 300.0), 40.0, 20, 1.0));
    let ev = run(&mut w, 8.0);
    assert!(pops(&ev).is_empty());
    let body = w.body(b).unwrap();
    let c = body.centroid();
    assert!(c.y > 25.0 && c.y < 45.0, "resting centroid y = {}", c.y);
    assert!(body.velocity().length() < 5.0, "still moving {}", body.velocity());
    assert!((body.area_ratio - 1.0).abs() < 0.15, "area ratio {}", body.area_ratio);
    assert!(body.outline().all(|p| p.y > -1.0), "sank into floor");
}

#[test]
fn fast_blob_does_not_tunnel_through_floor() {
    let mut w = world();
    let b = w.add_body(BodyDesc::blob(Vec2::new(0.0, 300.0), 40.0, 20, 1.0).with_velocity(Vec2::new(0.0, -4500.0)));
    run(&mut w, 2.0);
    assert!(w.body(b).unwrap().centroid().y > 0.0);
}

#[test]
fn pile_of_blobs_never_pops() {
    let mut w = world();
    let mut ids = Vec::new();
    for row in 0..4 {
        for col in 0..8 {
            let p = Vec2::new(-300.0 + col as f32 * 85.0 + (row % 2) as f32 * 40.0, 60.0 + row as f32 * 90.0);
            ids.push(w.add_body(BodyDesc::blob(p, 40.0, 18, 1.0)));
        }
    }
    let ev = run(&mut w, 6.0);
    assert!(pops(&ev).is_empty(), "pile popped: {:?}", pops(&ev));
    for id in ids {
        assert!(w.body(id).unwrap().enabled);
    }
}

#[test]
fn dense_soft_platform_is_stable() {
    // 80×4 cells = 405 particles: the kind of platform that used to explode.
    let mut w = world();
    let mut d = BodyDesc::grid(Vec2::new(-400.0, 200.0), Vec2::new(400.0, 230.0), 80, 4, 8.0);
    // A soft bridge: shape matching gives resolution-independent stiffness.
    d.params.shape_compliance = Some(1e-7);
    let plat = w.add_body(d);
    {
        let p = w.body_mut(plat).unwrap();
        let n = p.len();
        for i in 0..n {
            if p.x[i].x < -390.0 || p.x[i].x > 390.0 {
                p.pin(i);
            }
        }
    }
    let blobs: Vec<BodyId> =
        (0..5).map(|k| w.add_body(BodyDesc::blob(Vec2::new(-200.0 + k as f32 * 100.0, 400.0), 35.0, 18, 1.0))).collect();
    let ev = run(&mut w, 5.0);
    assert!(pops(&ev).is_empty());
    let p = w.body(plat).unwrap();
    let min_y = p.x.iter().map(|v| v.y).fold(f32::MAX, f32::min);
    assert!(min_y > 120.0, "platform sagged to {min_y}");
    for b in blobs {
        let c = w.body(b).unwrap().centroid();
        assert!(c.y > 200.0, "blob fell through platform: {c}");
    }
    assert!(p.velocity().length() < 5.0);
}

#[test]
fn jelly_ground_with_home_anchors_holds_its_shape() {
    // Soft terrain: a dense mesh tethered to its rest pose wobbles but
    // stays put no matter how many points it has.
    let mut w = World::new(Config::default());
    let mut d = BodyDesc::grid(Vec2::new(-600.0, -60.0), Vec2::new(600.0, 0.0), 120, 6, 40.0);
    d.params.shape_compliance = None;
    let ground = w.add_body(d);
    w.body_mut(ground).unwrap().anchor_home(2e-6);
    let blobs: Vec<BodyId> =
        (0..6).map(|k| w.add_body(BodyDesc::blob(Vec2::new(-300.0 + k as f32 * 120.0, 300.0), 40.0, 20, 1.0))).collect();
    let ev = run(&mut w, 4.0);
    assert!(pops(&ev).is_empty());
    let g = w.body(ground).unwrap();
    let min_y = g.x.iter().map(|v| v.y).fold(f32::MAX, f32::min);
    assert!(min_y > -75.0, "ground sank to {min_y}");
    for b in blobs {
        assert!(w.body(b).unwrap().centroid().y > 20.0);
    }
}

#[test]
fn hanging_rope_does_not_stretch() {
    let mut w = world();
    let anchor = Vec2::new(0.0, 900.0);
    let blob = w.add_body(BodyDesc::blob(Vec2::new(250.0, 900.0), 40.0, 20, 3.0));
    let top = Anchor::World(anchor);
    let bottom = Anchor::centre(&w, blob).unwrap();
    let rope = w.add_rope(RopeDesc::new(top, bottom).length(400.0));
    // Swing for a while, then check the rope never got longer than 1%.
    let mut worst: f32 = 0.0;
    let mut lowest = f32::MAX;
    for _ in 0..(5.0 / DT) as usize {
        w.step(DT);
        worst = worst.max(w.rope(rope).unwrap().current_length / 400.0);
        lowest = lowest.min(w.body(blob).unwrap().centroid().y);
        let d = w.body(blob).unwrap().centroid().distance(anchor);
        assert!(d < 400.0 * 1.01 + 1.0, "blob {d} from anchor");
    }
    assert!(worst < 1.01, "rope stretched to {worst}×");
    // And the blob actually swung down beneath the anchor.
    assert!(lowest < 900.0 - 350.0, "never swung down: {lowest}");
}

#[test]
fn rope_ties_two_blobs_together() {
    let mut w = world();
    let a = w.add_body(BodyDesc::blob(Vec2::new(-100.0, 45.0), 40.0, 20, 1.0));
    let b = w.add_body(BodyDesc::blob(Vec2::new(100.0, 45.0), 40.0, 20, 1.0));
    let (aa, ab) = (Anchor::centre(&w, a).unwrap(), Anchor::centre(&w, b).unwrap());
    let rope = w.add_rope(RopeDesc::new(aa, ab).length(260.0));
    // Fling A away hard; B must be dragged, the rope must hold.
    w.body_mut(a).unwrap().add_velocity(Vec2::new(-3000.0, 800.0));
    let mut worst: f32 = 0.0;
    for _ in 0..(3.0 / DT) as usize {
        w.step(DT);
        worst = worst.max(w.rope(rope).unwrap().current_length / 260.0);
        let d = w.body(a).unwrap().centroid().distance(w.body(b).unwrap().centroid());
        assert!(d < 260.0 * 1.02 + 2.0, "blobs {d} apart");
    }
    assert!(worst < 1.02, "rope stretched to {worst}×");
    assert!(w.body(b).unwrap().centroid().x < 100.0 - 50.0, "B wasn't dragged");
}

#[test]
fn rope_wraps_around_a_peg() {
    let mut w = world();
    w.add_static(StaticDesc::rect(Vec2::new(-20.0, 580.0), Vec2::new(20.0, 620.0)));
    let left = w.add_body(BodyDesc::blob(Vec2::new(-150.0, 660.0), 30.0, 16, 1.0));
    let right = w.add_body(BodyDesc::blob(Vec2::new(150.0, 660.0), 30.0, 16, 1.0));
    let (al, ar) = (Anchor::centre(&w, left).unwrap(), Anchor::centre(&w, right).unwrap());
    let rope = w.add_rope(RopeDesc::new(al, ar));
    run(&mut w, 4.0);
    let r = w.rope(rope).unwrap();
    assert!(r.current_length < r.length * 1.02);
    // Both blobs hang either side of the peg.
    assert!(w.body(left).unwrap().centroid().x < -20.0 && w.body(right).unwrap().centroid().x > 20.0);
    // The rope is draped over the peg: some node sits above it.
    let chain = w.body(r.body).unwrap();
    assert!(chain.x.iter().any(|p| p.y > 615.0 && p.x.abs() < 40.0), "rope fell off the peg");
}

#[test]
fn crusher_pops_only_the_crushed_blob() {
    let mut w = world();
    let victim = w.add_body(BodyDesc::blob(Vec2::new(0.0, 42.0), 40.0, 20, 1.0));
    // A neighbour pressed up against the victim but outside the piston.
    let bystander = w.add_body(BodyDesc::blob(Vec2::new(-86.0, 42.0), 40.0, 20, 1.0));
    let piston = w.add_static(StaticDesc::rect(Vec2::new(-40.0, 200.0), Vec2::new(40.0, 260.0)));
    run(&mut w, 1.0);
    let mut ev = Vec::new();
    for k in 0..240 {
        let y = (200.0 - k as f32 * 2.0).max(6.0);
        w.move_static(
            piston,
            vec![Vec2::new(-40.0, y), Vec2::new(40.0, y), Vec2::new(40.0, y + 60.0), Vec2::new(-40.0, y + 60.0)],
        );
        w.step(DT);
        ev.extend(w.drain_events());
    }
    let popped = pops(&ev);
    assert_eq!(popped, vec![victim], "expected only the victim to pop");
    assert!(w.body(bystander).unwrap().enabled);
    assert!(matches!(ev.iter().find(|e| matches!(e, Event::Popped { .. })), Some(Event::Popped { cause: PopCause::Crushed, .. })));
}

#[test]
fn being_stood_on_is_not_a_crush() {
    let mut w = world();
    let bottom = w.add_body(BodyDesc::blob(Vec2::new(0.0, 42.0), 40.0, 20, 1.0));
    // A heavy friend lands on top.
    w.add_body(BodyDesc::blob(Vec2::new(0.0, 400.0), 40.0, 20, 6.0).with_velocity(Vec2::new(0.0, -1500.0)));
    let ev = run(&mut w, 3.0);
    assert!(pops(&ev).is_empty());
    assert!(w.body(bottom).unwrap().enabled);
}

#[test]
fn overstretch_pops() {
    let mut w = world();
    let b = w.add_body(BodyDesc::blob(Vec2::new(0.0, 400.0), 40.0, 20, 1.0));
    // Tie one side to the world, then drag the other side away kinematically.
    let left = w.nearest_particle(b, Vec2::new(-40.0, 400.0)).unwrap();
    let right = w.nearest_particle(b, Vec2::new(40.0, 400.0)).unwrap() as usize;
    w.add_joint(Joint::pin(Anchor::particle(b, left), Anchor::World(Vec2::new(-40.0, 400.0))));
    w.body_mut(b).unwrap().pin(right);
    let mut ev = Vec::new();
    for k in 0..120 {
        w.body_mut(b).unwrap().drive_pinned(right, Vec2::new(40.0 + k as f32 * 6.0, 400.0));
        w.step(DT);
        ev.extend(w.drain_events());
    }
    assert!(
        ev.iter().any(|e| matches!(e, Event::Popped { cause: PopCause::Overstretched, .. })),
        "never popped; strain {}",
        w.body(b).unwrap().strain
    );
}

#[test]
fn rope_snaps_when_configured() {
    let mut w = world();
    let b = w.add_body(BodyDesc::blob(Vec2::new(0.0, 500.0), 30.0, 16, 1.0));
    let mut d = RopeDesc::new(Anchor::World(Vec2::new(0.0, 700.0)), Anchor::centre(&w, b).unwrap()).length(200.0);
    d.break_stretch = Some(1.15);
    w.add_rope(d);
    // Pin the blob and yank it away: the rope can't win against a pin.
    for i in 0..w.body(b).unwrap().len() {
        w.body_mut(b).unwrap().pin(i);
    }
    let mut ev = Vec::new();
    for k in 0..60 {
        let target = Vec2::new(0.0, 500.0 - k as f32 * 10.0);
        let bb = w.body_mut(b).unwrap();
        let c = bb.centroid();
        for i in 0..bb.len() {
            let p = bb.x[i] - c + target;
            bb.drive_pinned(i, p);
        }
        w.step(DT);
        ev.extend(w.drain_events());
    }
    assert!(ev.iter().any(|e| matches!(e, Event::RopeSnapped { .. })));
}

#[test]
fn pick_finds_tapped_body() {
    let mut w = world();
    let a = w.add_body(BodyDesc::grid(Vec2::new(100.0, 100.0), Vec2::new(300.0, 160.0), 10, 3, 1.0));
    assert_eq!(w.pick(Vec2::new(200.0, 130.0), u32::MAX), Some(a));
    assert_eq!(w.pick(Vec2::new(500.0, 130.0), u32::MAX), None);
}
