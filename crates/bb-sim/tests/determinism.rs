//! Same level + same inputs = the same simulation, step for step.
//!
//! Scene files promise "same file + same seed = same frames", which needs
//! the sim itself to be a pure function of its inputs: no hash-order
//! iteration, no clocks, no unseeded randomness. Every `HashMap` gets its
//! own random keys, so two sims in one process already iterate them in
//! different orders: if anything leaks that order, these runs diverge.

use bb_level::{LevelBuilder, Theme, v};
use bb_sim::{Input, Sim, Vec2};

/// Four blobs shoulder to shoulder on flat ground, pushing into each other
/// and jumping onto each other.
fn pileup() -> Sim {
    let mut b = LevelBuilder::new("pileup", "Pileup", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(3000.0, 0.0)], 300.0);
    let mut sim = Sim::new(b.build());
    for slot in 0..4u8 {
        sim.add_player(slot, "P", 0xff5d73);
        let body = sim.player(slot).unwrap().ctl.body;
        sim.world.respawn(body, Vec2::new(-90.0 + 60.0 * slot as f32, 40.0 + 25.0 * slot as f32));
    }
    sim
}

fn input(slot: u8, step: u32) -> Input {
    // Outer pair pushes inward, inner pair outward; everyone hops on their
    // own rhythm so blobs land on blobs.
    let dir = match slot {
        0 | 2 => 1.0,
        _ => -1.0,
    };
    let phase = (step + slot as u32 * 17) % 50;
    Input { stick: Vec2::new(dir, 0.0), button: phase < 12 }
}

/// Per step: the state hash and the events, in order.
fn run(steps: u32) -> Vec<(u64, String)> {
    let mut sim = pileup();
    (0..steps)
        .map(|i| {
            for slot in 0..4 {
                sim.set_input(slot, input(slot, i));
            }
            sim.step();
            (sim.state_hash(), format!("{:?}", sim.drain_events()))
        })
        .collect()
}

#[test]
fn same_inputs_replay_bit_for_bit() {
    let a = run(240);
    let b = run(240);
    let bumps = a.iter().filter(|s| s.1.contains("Bump")).count();
    assert!(bumps > 0, "the scene never made blobs collide, so it proves nothing");
    for (i, (x, y)) in a.iter().zip(&b).enumerate() {
        assert_eq!(x.0, y.0, "state diverged at step {i}");
        assert_eq!(x.1, y.1, "events differ at step {i}");
    }
}
