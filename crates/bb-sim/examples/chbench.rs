//! Step cost of every campaign chapter with 4 players (release).
fn main() {
    for n in 1..=10u8 {
        let mut sim = bb_sim::Sim::new(bb_level::campaign::chapter(n));
        for s in 0..4 { sim.add_player(s, "p", 0); }
        let parts: usize = sim.world.bodies().map(|(_, b)| b.len()).sum();
        let t = std::time::Instant::now();
        for f in 0..300 {
            for s in 0..4 { sim.set_input(s, bb_sim::Input { stick: bb_sim::Vec2::new(1.0, 0.0), button: f % 60 < 8 }); }
            sim.step();
        }
        println!("ch{n:02}: {} bodies, {parts} particles, {:.2} ms/step", sim.world.body_count(), t.elapsed().as_secs_f64() * 1000.0 / 300.0);
    }
}
