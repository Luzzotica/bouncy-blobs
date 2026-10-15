//! Glimmer the companion: waits to be met, then hovers along at the
//! player's shoulder, passes through everything, and catches up after a
//! respawn.
use bb_level::{LevelBuilder, NpcRole, Theme, v};
use bb_sim::npc::COMPANION;
use bb_sim::{Input, Sim, Vec2};

fn pbody(sim: &Sim) -> &bb_physics::Body {
    sim.world.body(sim.players[0].ctl.body).unwrap()
}
fn put(sim: &mut Sim, at: Vec2) {
    let id = sim.players[0].ctl.body;
    let off = at - pbody(sim).centroid();
    if let Some(bd) = sim.world.body_mut(id) {
        bd.translate(off);
        for vv in bd.v.iter_mut() {
            *vv = Vec2::ZERO;
        }
    }
}
fn gc(sim: &Sim) -> Vec2 {
    sim.world.body(sim.npc_by_id(COMPANION).unwrap().ctl.body).unwrap().centroid()
}

#[test]
fn companion_waits_meets_follows_and_keeps_up() {
    let mut b = LevelBuilder::new("c", "C", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).ground(&[v(-3000.0, 0.0), v(9000.0, 0.0)], 300.0);
    // A rock pillar in the way: the player hops it, she flies through it.
    b.block(v(2400.0, 0.0), v(2480.0, 160.0));
    b.npc(COMPANION, v(1200.0, 190.0), NpcRole::Glimmer, "", 12.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 1);
    let meet = Vec2::new(1200.0, 190.0);

    // Not met yet: she stays put.
    for _ in 0..120 {
        sim.set_input(0, Input::default());
        sim.step();
    }
    assert!(gc(&sim).distance(meet) < 60.0, "wandered before being met: {:?}", gc(&sim));
    assert!(!sim.npc_by_id(COMPANION).unwrap().following);

    // Roll right past her and on; she tags along the whole way.
    let mut worst: f32 = 0.0;
    for f in 0..(9 * 60) {
        let c = pbody(&sim).centroid();
        let hop = (2250.0..2420.0).contains(&c.x);
        sim.set_input(0, Input { stick: Vec2::new(1.0, 0.0), button: hop });
        sim.step();
        if f > 240 {
            worst = worst.max(gc(&sim).distance(pbody(&sim).centroid()));
        }
    }
    let (p, g) = (pbody(&sim).centroid(), gc(&sim));
    println!("player {p:?}, glimmer {g:?}, worst gap {worst:.0}");
    assert!(sim.npc_by_id(COMPANION).unwrap().following);
    assert!(p.x > 3000.0, "player didn't get past the pillar: {p:?}");
    assert!(worst < 420.0, "lagged too far behind ({worst:.0})");
    // Hovering above, not in the player's way.
    assert!(g.y > p.y + 40.0, "not above the player: {g:?} vs {p:?}");

    // She never collides with the player (or anything).
    assert_eq!(sim.world.body(sim.npc_by_id(COMPANION).unwrap().ctl.body).unwrap().mask, 0);

    // A respawn far away: she pops in beside the player at once.
    put(&mut sim, Vec2::new(-2000.0, 40.0));
    for _ in 0..30 {
        sim.set_input(0, Input::default());
        sim.step();
    }
    let d = gc(&sim).distance(pbody(&sim).centroid());
    assert!(d < 260.0, "didn't catch up after a respawn ({d:.0})");
}

#[test]
fn scripted_glimmer_can_be_walked() {
    let mut b = LevelBuilder::new("c", "C", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).ground(&[v(-3000.0, 0.0), v(3000.0, 0.0)], 300.0);
    b.npc("glimmer", v(-420.0, 260.0), NpcRole::Glimmer, "", 12.0);
    let mut sim = Sim::new(b.build());
    for f in 0..240 {
        let n = &mut sim.npcs[0];
        n.scripted = true;
        let x = sim.world.body(sim.npcs[0].ctl.body).unwrap().centroid().x;
        sim.npcs[0].ctl.input.stick.x = if (-100.0 - x).abs() < 14.0 { 0.0 } else { (-100.0 - x).signum() };
        sim.step();
        if f % 40 == 0 { println!("{:?}", sim.world.body(sim.npcs[0].ctl.body).unwrap().centroid()); }
    }
    let x = sim.world.body(sim.npcs[0].ctl.body).unwrap().centroid().x;
    assert!((x + 100.0).abs() < 80.0, "glimmer at {x}");
}
