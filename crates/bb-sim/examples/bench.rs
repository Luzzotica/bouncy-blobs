//! `cargo run --release -p bb-sim --example bench` — sim step cost with 8 players.
use bb_level::{LevelBuilder, PropKind, Theme, v};
use bb_sim::{Input, Sim};
fn main() {
    let mut b = LevelBuilder::new("bench", "Bench", Theme::Hollow);
    b.spawn(v(0.0, 100.0)).ground(&[v(-3000.0, 0.0), v(3000.0, 0.0)], 300.0);
    for k in 0..6 { b.bridge(v(-2000.0 + k as f32 * 700.0, 300.0), v(-1600.0 + k as f32 * 700.0, 300.0), 26.0, 0.4); }
    for k in 0..8 { b.vine(v(-1500.0 + k as f32 * 400.0, 900.0), 350.0); }
    for k in 0..12 { b.prop("", PropKind::Block, v(-1200.0 + k as f32 * 200.0, 200.0), v(60.0, 60.0), 1.0, ""); }
    for k in 0..6 { b.npc(&format!("n{k}"), v(-600.0 + k as f32 * 200.0, 100.0), bb_level::NpcRole::Follower, "", 28.0); }
    let mut sim = Sim::new(b.build());
    for s in 0..8 { sim.add_player(s, "p", 0); }
    let particles: usize = sim.world.bodies().map(|(_, b)| b.len()).sum();
    let t = std::time::Instant::now();
    let n = 600;
    for f in 0..n {
        for s in 0..8 { sim.set_input(s, Input { stick: v(if (f / 90 + s as usize) % 2 == 0 { 1.0 } else { -1.0 }, 0.0), button: f % 50 < 10 }); }
        sim.step();
    }
    let ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
    println!("{} bodies, {particles} particles: {ms:.2} ms/step (budget 16.6 ms at 60 Hz)", sim.world.body_count());
}
