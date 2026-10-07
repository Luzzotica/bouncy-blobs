//! Measure the player controller so level metrics are grounded in reality.

use bb_level::{LevelBuilder, Theme, metrics, v};
use bb_sim::{Input, Sim, Vec2};

fn flat() -> Sim {
    let mut b = LevelBuilder::new("flat", "Flat", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(6000.0, 0.0)], 300.0);
    let mut sim = Sim::new(b.build());
    sim.add_player(0, "P", 0xff5d73);
    sim
}

fn centre(sim: &Sim) -> Vec2 {
    sim.world.body(sim.players[0].ctl.body).unwrap().centroid()
}

/// Lowest point of the blob: swelling moves the centroid up without
/// leaving the ground, so jumps are measured at the feet.
fn feet(sim: &Sim) -> Vec2 {
    let b = sim.world.body(sim.players[0].ctl.body).unwrap();
    let c = b.centroid();
    Vec2::new(c.x, b.outline().map(|p| p.y).fold(f32::MAX, f32::min))
}

fn settle(sim: &mut Sim) {
    for _ in 0..90 {
        sim.step();
    }
}

#[test]
fn rests_on_jelly_ground() {
    let mut sim = flat();
    settle(&mut sim);
    let c = centre(&sim);
    assert!(c.y > 20.0 && c.y < 45.0, "rest height {c}");
    assert!(sim.players[0].ctl.grounded);
}

#[test]
fn runs_at_top_speed() {
    let mut sim = flat();
    settle(&mut sim);
    let x0 = centre(&sim).x;
    sim.set_input(0, Input { stick: v(1.0, 0.0), button: false });
    for _ in 0..60 {
        sim.step();
    }
    let x1 = centre(&sim).x;
    for _ in 0..60 {
        sim.step();
    }
    let x2 = centre(&sim).x;
    let speed = x2 - x1;
    println!("run: first second {} px, steady {} px/s", x1 - x0, speed);
    assert!(speed > 400.0 && speed < 650.0, "steady speed {speed}");
}

#[test]
fn jump_height_matches_metrics() {
    let mut sim = flat();
    settle(&mut sim);
    let y0 = feet(&sim).y;
    sim.set_input(0, Input { stick: Vec2::ZERO, button: true });
    let mut peak = y0;
    for _ in 0..90 {
        sim.step();
        peak = peak.max(feet(&sim).y);
    }
    let h = peak - y0;
    println!("full jump height {h}");
    assert!(h > metrics::JUMP_H * 0.9 && h < metrics::JUMP_H * 1.5, "jump {h}");
    // A tap is a hop (relax first: you can only launch by growing).
    sim.set_input(0, Input { stick: Vec2::ZERO, button: false });
    settle(&mut sim);
    let y0 = feet(&sim).y;
    sim.set_input(0, Input { stick: Vec2::ZERO, button: true });
    sim.step();
    sim.step();
    sim.step();
    sim.set_input(0, Input { stick: Vec2::ZERO, button: false });
    let mut hop = y0;
    for _ in 0..60 {
        sim.step();
        hop = hop.max(feet(&sim).y);
    }
    println!("tap hop height {}", hop - y0);
    assert!(hop - y0 < h * 0.7, "hop {} not shorter than jump {h}", hop - y0);
}

#[test]
fn running_jump_clears_the_design_gap() {
    let mut sim = flat();
    settle(&mut sim);
    sim.set_input(0, Input { stick: v(1.0, 0.0), button: false });
    for _ in 0..60 {
        sim.step();
    }
    let start = feet(&sim);
    sim.set_input(0, Input { stick: v(1.0, 0.0), button: true });
    let mut land = start;
    let mut airborne = false;
    for _ in 0..120 {
        sim.step();
        let c = feet(&sim);
        if c.y > start.y + 20.0 {
            airborne = true;
        }
        if airborne && sim.players[0].ctl.grounded {
            land = c;
            break;
        }
    }
    let dist = land.x - start.x;
    println!("running jump distance {dist}");
    assert!(dist > metrics::GAP + 2.0 * metrics::PLAYER_R, "only {dist}");
}
