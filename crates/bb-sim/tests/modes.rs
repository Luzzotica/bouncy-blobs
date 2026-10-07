use bb_level::{LevelBuilder, Shape, Theme, v};
use bb_sim::modes::{CHAIN_LENGTH, KOTH_TARGET, Match, MatchPhase, ModeKind};
use bb_sim::{DT, Input, Sim};

fn arena(goal: bool, hills: bool) -> Sim {
    let mut b = LevelBuilder::new("a", "A", Theme::Party);
    b.spawn(v(0.0, 60.0)).ground(&[v(-2000.0, 0.0), v(3000.0, 0.0)], 300.0);
    if goal {
        b.goal(v(900.0, 0.0), v(1100.0, 300.0));
    }
    let mut l = b.build();
    if hills {
        l.hills.push(Shape::rect(v(-150.0, 0.0), v(150.0, 300.0)));
    }
    let mut sim = Sim::new(l);
    for s in 0..3 {
        sim.add_player(s, "p", 0);
    }
    sim
}

fn run(sim: &mut Sim, m: &mut Match, secs: f32, input: impl Fn(u8) -> Input) {
    for _ in 0..(secs / DT) as usize {
        let slots: Vec<u8> = sim.players.iter().map(|p| p.slot).collect();
        for s in slots {
            sim.set_input(s, input(s));
        }
        sim.step();
        m.update(sim, DT);
    }
}

#[test]
fn countdown_freezes_input_then_race_winner() {
    let mut sim = arena(true, false);
    let mut m = Match::new(ModeKind::Race);
    m.start(&mut sim);
    let x0 = sim.world.body(sim.players[0].ctl.body).unwrap().centroid().x;
    run(&mut sim, &mut m, 2.5, |_| Input { stick: v(1.0, 0.0), button: false });
    let x1 = sim.world.body(sim.players[0].ctl.body).unwrap().centroid().x;
    assert!((x1 - x0).abs() < 30.0, "moved during countdown");
    // Only slot 2 (rightmost) runs right.
    run(&mut sim, &mut m, 8.0, |s| Input { stick: v(if s == 2 { 1.0 } else { 0.0 }, 0.0), button: false });
    assert_eq!(m.winner, Some(2));
    assert!(matches!(m.phase, MatchPhase::Results(_) | MatchPhase::Over));
}

#[test]
fn koth_sole_occupant_scores_fastest() {
    let mut sim = arena(false, true);
    let mut m = Match::new(ModeKind::Koth);
    m.start(&mut sim);
    // Push slot 0 and 2 away from the hill; slot 1 stays on it.
    run(&mut sim, &mut m, 3.1, |_| Input::default());
    run(&mut sim, &mut m, 30.0, |s| match s {
        0 => Input { stick: v(-1.0, 0.0), button: false },
        2 => Input { stick: v(1.0, 0.0), button: false },
        _ => Input::default(),
    });
    let s1 = m.scores.iter().find(|e| e.0 == 1).unwrap().1;
    assert!(s1 >= KOTH_TARGET || m.winner == Some(1), "slot 1 score {s1}");
    assert_eq!(m.winner, Some(1));
}

#[test]
fn chained_players_are_roped_together() {
    let mut sim = arena(true, false);
    let mut m = Match::new(ModeKind::Chained);
    m.start(&mut sim);
    run(&mut sim, &mut m, 3.1, |_| Input::default());
    // Slot 0 runs right, the others drag behind but stay within rope reach.
    run(&mut sim, &mut m, 3.0, |s| Input { stick: v(if s == 0 { 1.0 } else { 0.0 }, 0.0), button: false });
    let c: Vec<_> = sim.players.iter().map(|p| sim.world.body(p.ctl.body).unwrap().centroid()).collect();
    for w in c.windows(2) {
        assert!(w[0].distance(w[1]) < CHAIN_LENGTH * 1.05 + 10.0, "players {} apart", w[0].distance(w[1]));
    }
    m.cleanup(&mut sim);
    assert_eq!(sim.world.ropes().count(), 0);
}
