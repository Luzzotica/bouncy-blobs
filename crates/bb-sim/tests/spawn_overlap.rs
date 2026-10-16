//! Blobs must never (re)spawn inside each other.
//!
//! Two soft blobs placed on top of each other don't come apart cleanly:
//! their rings tangle into a permanent knot, the de-penetration flings them
//! off at ~1000 px/s, and whoever is squeezed in the middle pops ("crushed")
//! as soon as its 0.6 s spawn immunity runs out. That's what popped purple
//! mid-air in content's bb-mushroom-party scene (the capture code stacked the
//! whole cast on Pip's spawn), and plain co-op hit the same thing: joiners
//! were added 18 px apart and simultaneous respawns 20 px apart, with 64 px
//! wide blobs.

use bb_sim::physics::Body;
use bb_sim::{BodyId, Input, Sim, SimEvent, Vec2, Who};

const R: f32 = bb_sim::control::tune::RADIUS;

/// A blob whose outline no longer winds once, in order, around its centre
/// (the knot overlapping blobs tangle into). Only meaningful at rest.
fn knotted(b: &Body) -> bool {
    let c = b.centroid();
    let a: Vec<f32> = b.outline().map(|p| (p - c).y.atan2((p - c).x)).collect();
    let mut turn = 0.0;
    for k in 0..a.len() {
        let d = (a[(k + 1) % a.len()] - a[k] + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI;
        if d <= 0.0 {
            return true;
        }
        turn += d;
    }
    (turn - std::f32::consts::TAU).abs() > 0.1
}

fn bodies(sim: &Sim) -> Vec<BodyId> {
    sim.players.iter().map(|p| p.ctl.body).collect()
}

fn centre(sim: &Sim, id: BodyId) -> Vec2 {
    sim.world.body(id).unwrap().centroid()
}

fn assert_apart(sim: &Sim, what: &str) {
    let ids = bodies(sim);
    for i in 0..ids.len() {
        for j in i + 1..ids.len() {
            let d = centre(sim, ids[i]).distance(centre(sim, ids[j]));
            assert!(d >= 2.0 * R, "{what}: players {i} and {j} placed {d:.0} px apart (blobs are {} px wide)", 2.0 * R);
        }
    }
}

/// Steps `n` ticks; returns how many players popped.
fn run(sim: &mut Sim, n: usize) -> usize {
    let mut pops = 0;
    for _ in 0..n {
        sim.step();
        pops += sim.drain_events().iter().filter(|e| matches!(e, SimEvent::Popped { who: Who::Player(_), .. })).count();
    }
    pops
}

fn assert_whole(sim: &Sim, what: &str) {
    for (k, id) in bodies(sim).into_iter().enumerate() {
        let b = sim.world.body(id).unwrap();
        assert!(!knotted(b), "{what}: player {k} is tangled (area {:.2} of rest)", b.area_ratio);
    }
}

#[test]
fn players_joining_together_spawn_side_by_side() {
    for ch in 1..=bb_level::campaign::CHAPTERS {
        let mut sim = Sim::new(bb_level::campaign::chapter(ch));
        for s in 0..4 {
            sim.add_player(s, "p", 0);
        }
        let what = format!("ch{ch:02}, 4 players");
        assert_apart(&sim, &what);
        let start: Vec<Vec2> = bodies(&sim).into_iter().map(|b| centre(&sim, b)).collect();
        assert_eq!(run(&mut sim, 120), 0, "{what}: someone popped standing at the start");
        assert_whole(&sim, &what);
        for (k, b) in bodies(&sim).into_iter().enumerate() {
            let d = (centre(&sim, b) - start[k]).length();
            assert!(d < 120.0, "{what}: player {k} was shoved {d:.0} px at the start (from {} to {})", start[k], centre(&sim, b));
        }
    }
}

#[test]
fn solo_spawn_is_unchanged() {
    let mut sim = Sim::new(bb_level::campaign::chapter(1));
    sim.add_player(0, "p", 0);
    let want = sim.respawn_point() + Vec2::new(-1.5 * 18.0, 40.0);
    assert!(centre(&sim, sim.players[0].ctl.body).distance(want) < 0.5);
}

#[test]
fn players_popped_together_respawn_side_by_side() {
    let mut sim = Sim::new(bb_level::campaign::chapter(1));
    for s in 0..4 {
        sim.add_player(s, "p", 0);
    }
    run(&mut sim, 60);
    for id in bodies(&sim) {
        sim.pop(id);
    }
    let delay = sim.rules.respawn_delay;
    run(&mut sim, (delay / bb_sim::DT) as usize + 2);
    assert!(sim.players.iter().all(|p| p.dead.is_none()), "everyone is back");
    assert_apart(&sim, "simultaneous respawn");
    assert_eq!(run(&mut sim, 120), 0, "someone popped after respawning");
    assert_whole(&sim, "simultaneous respawn");
}

#[test]
fn respawn_beside_a_player_waiting_at_the_checkpoint() {
    let mut sim = Sim::new(bb_level::campaign::chapter(1));
    sim.add_player(0, "waiting", 0);
    sim.add_player(1, "popped", 0);
    let waiting = sim.players[0].ctl.body;
    let popped = sim.players[1].ctl.body;
    // Player 0 stands right where player 1 is about to reappear.
    let spot = sim.respawn_point() + Vec2::new(-20.0, 30.0);
    sim.world.respawn(waiting, spot);
    run(&mut sim, 60);
    sim.pop(popped);
    let delay = sim.rules.respawn_delay;
    run(&mut sim, (delay / bb_sim::DT) as usize + 2);
    assert_apart(&sim, "respawn next to a waiting player");
    assert_eq!(run(&mut sim, 120), 0);
    assert_whole(&sim, "respawn next to a waiting player");
}

#[test]
fn restart_spreads_everyone() {
    let mut sim = Sim::new(bb_level::campaign::chapter(3));
    for s in 0..3 {
        sim.add_player(s, "p", 0);
    }
    run(&mut sim, 30);
    let at = sim.respawn_point() + Vec2::new(0.0, 40.0);
    sim.place_players(at);
    assert_apart(&sim, "restart");
    assert_eq!(run(&mut sim, 120), 0);
    assert_whole(&sim, "restart");
}

// ------------------------------------------------- bb-mushroom-party scene

fn seeded(seed: u32, i: u32) -> f32 {
    // bb-game's scene::seeded (input jitter).
    let mut x = seed.wrapping_mul(0x9e37_79b9) ^ i.wrapping_mul(0x85eb_ca6b) ^ 0x27d4_eb2f;
    x ^= x >> 15;
    x = x.wrapping_mul(0x2c1b_3c6d);
    x ^= x >> 12;
    x = x.wrapping_mul(0x297a_2d39);
    x ^= x >> 15;
    (x >> 8) as f32 / (1u32 << 24) as f32
}

/// The scene's inputs: (t, slot, jump (else squish), hold). Slots as the
/// runner assigns them: pip 0, bluey 1, purple 2.
#[rustfmt::skip]
const INPUTS: &[(f32, u8, bool, f32)] = &[
    (-0.4, 1, true, 0.2), (-0.17, 0, true, 0.15), (0.06, 2, false, 0.35), (0.6, 1, true, 0.2), (0.68, 0, true, 0.12),
    (0.91, 2, true, 0.12), (1.53, 0, true, 0.15), (1.75, 1, true, 0.12), (1.91, 2, false, 0.35), (2.38, 0, false, 0.35),
    (2.75, 1, true, 0.12), (2.76, 2, true, 0.2), (3.23, 0, true, 0.12), (3.9, 1, false, 0.35), (3.91, 2, false, 0.35),
    (4.08, 0, true, 0.12), (4.75, 1, false, 0.35), (4.76, 2, true, 0.15), (4.93, 0, false, 0.35), (5.6, 1, true, 0.12),
    (5.61, 2, true, 0.15), (5.78, 0, true, 0.2), (6.6, 1, true, 0.2), (6.61, 2, true, 0.12), (6.93, 0, true, 0.12),
    (7.45, 1, false, 0.35), (7.61, 2, true, 0.12), (8.08, 0, false, 0.35), (8.3, 1, false, 0.35), (8.46, 2, false, 0.35),
    (8.93, 0, true, 0.15), (9.15, 1, false, 0.35), (9.31, 2, true, 0.2),
];
const PRE_ROLL: i64 = 48;

/// The runner's input plan for one tick (held keys in 60 Hz ticks from the
/// start of the pre-roll, with the seed's ±0.08 s jitter).
fn input_at(seed: u32, slot: u8, tick: i64) -> Input {
    let at = |t: f32| PRE_ROLL + (t * 60.0).round() as i64;
    let mut i = Input::default();
    for (k, &(t, s, jump, hold)) in INPUTS.iter().enumerate() {
        let t = t + (seeded(seed, 1000 + k as u32) * 2.0 - 1.0) * 0.08;
        let from = at(t).max(0);
        let to = from + (at(t + hold) - at(t)).max(1);
        if s == slot && (from..to).contains(&tick) {
            if jump { i.button = true } else { i.stick.y = -1.0 }
        }
    }
    i
}

/// Fungus Caverns with the cast at its spawns, the scene's 0.8 s pre-roll +
/// 10 s of inputs. `stacked` reproduces the old capture setup (everyone
/// moved onto Pip's spawn after the cast was placed).
fn mushroom_party(seed: u32, stacked: bool) -> (Vec<(i64, u8)>, Vec<f32>) {
    let mut sim = Sim::new(bb_level::campaign::chapter(3));
    let spawns = [(0u8, Vec2::new(130.0, 40.0)), (1, Vec2::new(-20.0, 40.0)), (2, Vec2::new(280.0, 40.0))];
    for (s, at) in spawns {
        sim.add_player(s, "", 0);
        let b = sim.player(s).unwrap().ctl.body;
        sim.world.respawn(b, at);
    }
    if stacked {
        for (s, _) in spawns {
            let b = sim.player(s).unwrap().ctl.body;
            sim.world.respawn(b, Vec2::new(130.0, 40.0));
        }
    }
    let mut pops = Vec::new();
    for tick in 0..PRE_ROLL + 600 {
        for s in 0..3 {
            sim.set_input(s, input_at(seed, s, tick));
        }
        sim.step();
        for e in sim.drain_events() {
            if let SimEvent::Popped { who: Who::Player(s), .. } = e {
                pops.push((tick, s));
            }
        }
    }
    let travel = spawns.iter().map(|(s, at)| (centre(&sim, sim.player(*s).unwrap().ctl.body).x - at.x).abs()).collect();
    (pops, travel)
}

#[test]
fn mushroom_party_cast_stays_whole() {
    for seed in [1, 2] {
        let (pops, travel) = mushroom_party(seed, false);
        assert!(pops.is_empty(), "seed {seed}: pops (tick, slot) {pops:?}");
        // Short hops and squishes on a flat floor wander a little (and the
        // secret spring / first trampoline are in reach) but go nowhere far.
        assert!(travel.iter().all(|d| *d < 800.0), "seed {seed}: travelled {travel:?} px with no left/right input");
    }
}

/// The old setup, kept as a record of what stacking does: purple pops in
/// mid-air right as its spawn immunity (0.6 s) runs out.
#[test]
fn stacked_cast_is_what_popped_purple() {
    let (pops, _) = mushroom_party(2, true);
    let first = pops.first().copied().expect("the stacked cast pops");
    assert!((30..=40).contains(&first.0), "pop at tick {} (expected ~0.58 s after spawning)", first.0);
}
