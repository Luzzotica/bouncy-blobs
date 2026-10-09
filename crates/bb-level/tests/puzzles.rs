//! Squishy-object puzzles (level design rule 3): every "push it into the
//! pit" bridge in the campaign is solvable by pushing, and is NOT solvable
//! without the prop (the gap really is wider than a running swell-jump).

use bb_level::*;
use bb_sim::{Input, Sim, Vec2};

struct Puzzle {
    chapter: u8,
    /// Where the player starts (behind the props).
    start: Vec2,
    props: &'static [&'static str],
    /// Near rim x / floor height, far rim x.
    rim: f32,
    rim_y: f32,
    far: f32,
}

const PUZZLES: &[Puzzle] = &[
    Puzzle { chapter: 2, start: Vec2::new(9600.0, 2080.0), props: &["jellyball"], rim: 10300.0, rim_y: 2030.0, far: 11220.0 },
    Puzzle { chapter: 8, start: Vec2::new(9450.0, 2610.0), props: &["ballA", "ballB"], rim: 10400.0, rim_y: 2560.0, far: 11400.0 },
    Puzzle { chapter: 9, start: Vec2::new(10400.0, 1950.0), props: &["boulder"], rim: 10900.0, rim_y: 1900.0, far: 11820.0 },
];

/// Push (unless `skip_push`, which removes the props), then run at the gap
/// from 300 px back and hop whenever grounded past the rim. Returns whether
/// the player got across alive.
fn attempt(z: &Puzzle, skip_push: bool) -> Result<f32, String> {
    let mut l = campaign::chapter(z.chapter);
    l.npcs.retain(|n| n.role != NpcRole::Follower && n.role != NpcRole::Trapped);
    let idx: Vec<usize> = z.props.iter().map(|id| l.props.iter().position(|p| p.id == *id).unwrap_or_else(|| panic!("ch{:02}: no prop {id}", z.chapter))).collect();
    if skip_push {
        for i in idx.iter().rev() {
            l.props.remove(*i);
        }
    }
    let mut sim = Sim::new(l);
    sim.add_player(0, "P", 0xff0000);
    let body = sim.players[0].ctl.body;
    sim.world.respawn(body, z.start);
    if !skip_push {
        let mut done = false;
        for _ in 0..60 * 12 {
            let c = sim.world.body(body).unwrap().centroid();
            let stick = if c.x > z.rim - 60.0 { Vec2::new(-1.0, 0.0) } else { Vec2::new(1.0, 0.0) };
            sim.set_input(0, Input { stick, button: false, ..Default::default() });
            sim.step();
            if sim.players[0].dead.is_some() {
                return Err("popped while pushing".into());
            }
            if idx.iter().all(|i| sim.world.body(sim.props[*i]).is_some_and(|b| b.centroid().y < z.rim_y - 20.0 && b.centroid().x > z.rim)) {
                done = true;
                break;
            }
        }
        if !done {
            return Err("props never went in".into());
        }
        for _ in 0..120 {
            sim.set_input(0, Input::default());
            sim.step();
        }
    }
    let props: Vec<_> = if skip_push { Vec::new() } else { idx.iter().map(|i| sim.props[*i]).collect() };
    let settled: Vec<Vec2> = props.iter().filter_map(|p| sim.world.body(*p)).map(|b| b.centroid()).collect();
    println!("ch{:02}: props settled at {settled:?}", z.chapter);
    sim.world.respawn(body, Vec2::new(z.rim - 300.0, z.rim_y + 40.0));
    for f in 0..60 * 10 {
        let c = sim.world.body(body).unwrap().centroid();
        // Like a player: take off at the rim; on a prop, roll to its far
        // shoulder before hopping on.
        let on_prop = props.iter().filter_map(|p| sim.world.body(*p)).map(|b| b.centroid()).find(|p| (p.x - c.x).abs() < 200.0 && c.y > p.y);
        let at_edge = match on_prop {
            Some(p) => c.x > p.x + 60.0,
            None => c.x > z.rim - 50.0,
        };
        let button = sim.players[0].ctl.grounded && at_edge;
        sim.set_input(0, Input { stick: Vec2::new(1.0, 0.0), button, ..Default::default() });
        sim.step();
        if sim.players[0].dead.is_some() {
            return Err(format!("popped crossing at x {:.0}", c.x));
        }
        if c.x > z.far + 40.0 && c.y > z.rim_y - 10.0 {
            return Ok(f as f32 / 60.0);
        }
    }
    Err("never got across".into())
}

#[test]
fn push_puzzles_are_solvable() {
    for z in PUZZLES {
        let r = attempt(z, false);
        println!("ch{:02} with props: {r:?}", z.chapter);
        assert!(r.is_ok(), "ch{:02}: push puzzle not solvable: {r:?}", z.chapter);
    }
}

#[test]
fn push_puzzles_cannot_be_skipped() {
    for z in PUZZLES {
        let r = attempt(z, true);
        println!("ch{:02} without props: {r:?}", z.chapter);
        assert!(r.is_err(), "ch{:02}: the gap can be jumped without the prop", z.chapter);
    }
}

/// Spiked movers (falling rocks with teeth) pop you when you touch their
/// underside, even while they hang still; plain ones don't.
#[test]
fn spiked_movers_pop_from_below() {
    for spiked in [false, true] {
        let mut b = LevelBuilder::new("t", "T", Theme::CaveIn);
        b.spawn(v(0.0, 40.0)).kill_y(-1000.0);
        b.ground(&[v(-600.0, 0.0), v(600.0, 0.0)], 400.0);
        // A crusher whose underside hangs 150 px up, waiting a long time.
        b.crusher(v(0.0, 270.0), 260.0, 100.0, 0.0);
        if let Some(m) = b.level.movers.last_mut() {
            m.motion = MoverMotion::Crusher { slam: 0.25, hold: 0.4, rise: 1.2, wait: 60.0 };
            m.period = 61.85;
        }
        if spiked {
            b.spiked();
        }
        let mut sim = Sim::new(b.build());
        sim.add_player(0, "P", 0xff0000);
        let mut popped = false;
        for f in 0..240 {
            sim.set_input(0, Input { stick: Vec2::new(0.0, 1.0), button: f % 40 < 20, ..Default::default() });
            sim.step();
            popped |= sim.players[0].dead.is_some();
        }
        assert_eq!(popped, spiked, "spiked={spiked}: popped={popped}");
    }
}
