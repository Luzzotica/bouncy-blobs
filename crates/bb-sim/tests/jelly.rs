//! Jelly ground lies still: neighbouring skin tiles overlap a few px and
//! must not shove each other (they used to: every seam bulged and notched
//! ~8 px and jostled as you rolled over it).

use bb_level::{LevelBuilder, Theme, v};
use bb_sim::{Sim, Vec2};

/// Worst deformation (px, translation removed) of any jelly body after
/// `steps` steps, and where.
fn settle(level: bb_level::Level, steps: usize) -> (f32, Vec2) {
    let mut sim = Sim::new(level);
    let rest: Vec<_> = sim.jelly.iter().map(|(id, _)| (*id, sim.world.body(*id).unwrap().x.clone())).collect();
    for _ in 0..steps {
        sim.step();
    }
    let mut worst = (0.0f32, Vec2::ZERO);
    for (id, r) in &rest {
        let x = &sim.world.body(*id).unwrap().x;
        let mean = x.iter().zip(r).map(|(p, q)| *p - *q).sum::<Vec2>() / r.len() as f32;
        for (p, q) in x.iter().zip(r) {
            let d = (*p - *q - mean).length();
            if d > worst.0 {
                worst = (d, *q);
            }
        }
    }
    worst
}

#[test]
fn jelly_tiles_rest_without_shoving_each_other() {
    let mut b = LevelBuilder::new("flat", "Flat", Theme::Hollow);
    b.spawn(v(0.0, 300.0)).ground(&[v(-1500.0, 0.0), v(0.0, 0.0), v(400.0, 60.0), v(1500.0, 60.0)], 400.0);
    let (d, at) = settle(b.build(), 240);
    println!("worst jelly deformation at rest: {d:.2} px at {at}");
    assert!(d < 2.5, "jelly skin deforms {d:.1} px at rest near {at} (tiles shoving each other?)");
}

#[test]
fn chapter_one_floor_lies_still() {
    let (d, at) = settle(bb_level::campaign::chapter(1), 240);
    println!("ch01 worst jelly deformation at rest: {d:.2} px at {at}");
    assert!(d < 2.5, "ch01 jelly deforms {d:.1} px at rest near {at}");
}
