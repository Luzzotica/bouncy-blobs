//! Nudging a locally simulated body toward its owner's state.
//!
//! The receiver keeps simulating every body (so it jiggles, collides and
//! squashes locally); this only removes drift. Velocity is matched quickly,
//! positional error is spread over ~150 ms by translating particles (which
//! keeps the shape and its wobble), and a body that is hopelessly off
//! (> 120 px: a teleport, a respawn, a long stall) snaps.

use bb_physics::{Body, Vec2};

use crate::wire::BodyState;

#[derive(Copy, Clone, Debug)]
pub struct BlendParams {
    /// Seconds to remove positional error (exponential time constant).
    pub pos_time: f32,
    /// Seconds to match velocity.
    pub vel_time: f32,
    /// Error beyond this snaps (px).
    pub snap: f32,
    /// Errors under this are left to the local sim (px), so resting bodies
    /// don't shimmer from quantisation.
    pub dead_zone: f32,
    /// Don't extrapolate older states further than this (s).
    pub max_extrapolate: f32,
}

impl Default for BlendParams {
    fn default() -> Self {
        BlendParams { pos_time: 0.06, vel_time: 0.04, snap: 120.0, dead_zone: 0.75, max_extrapolate: 0.25 }
    }
}

/// What a blend step did (for debug overlays and tests).
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Blended {
    Nudged { error: f32 },
    Snapped { error: f32 },
    Skipped,
}

/// Where the owner's body probably is now: its state extrapolated by `age`
/// seconds (latency + time since the packet arrived).
pub fn predicted_position(target: &BodyState, age: f32, p: &BlendParams) -> Vec2 {
    target.position() + target.velocity() * age.clamp(0.0, p.max_extrapolate)
}

/// Move `body` a `dt`-sized step toward `target`. Call once per fixed tick
/// for every remote-owned body that has a state.
pub fn blend_body(body: &mut Body, target: &BodyState, age: f32, dt: f32, p: &BlendParams) -> Blended {
    if body.is_empty() || !dt.is_finite() || dt <= 0.0 {
        return Blended::Skipped;
    }
    // Popped / respawn state follows the owner outright.
    if !target.alive() {
        body.enabled = false;
        return Blended::Skipped;
    }
    let goal = predicted_position(target, age, p);
    let vel = target.velocity();
    if !body.enabled {
        body.enabled = true;
        body.rest_scale = target.rest_scale();
        body.reset_to(goal);
        body.add_velocity(vel);
        return Blended::Snapped { error: f32::INFINITY };
    }

    let c = body.centroid();
    let err = goal - c;
    let e = err.length();
    if e > p.snap || !e.is_finite() {
        body.reset_to(goal);
        body.add_velocity(vel);
        return Blended::Snapped { error: e };
    }

    // Velocity: converge on the owner's motion so the error stops growing.
    let kv = 1.0 - (-dt / p.vel_time.max(1e-3)).exp();
    body.add_velocity((vel - body.velocity()) * kv);

    // Position: translate a fraction of the error. Moving `prev` along with
    // `x` (Body::translate) keeps this from injecting velocity.
    if e > p.dead_zone {
        let kp = 1.0 - (-dt / p.pos_time.max(1e-3)).exp();
        body.translate(err * kp);
    }

    // Orientation: a gentle spin toward the owner's angle. Blobs are round,
    // so this only matters for props, and it must never fight the sim hard.
    let da = wrap_angle(target.angle_rad() - body.angle());
    if da.abs() > 0.05 {
        body.add_spin(da * kv * 2.0);
    }
    Blended::Nudged { error: e }
}

fn wrap_angle(a: f32) -> f32 {
    use std::f32::consts::{PI, TAU};
    (a + PI).rem_euclid(TAU) - PI
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{BodyState, NetId, StateReceiver, StateSender, flags, input_flags};
    use bb_level::{LevelBuilder, Theme, v};
    use bb_sim::{Input, Sim};

    fn flat() -> Sim {
        let mut b = LevelBuilder::new("flat", "Flat", Theme::Hollow);
        b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(6000.0, 0.0)], 300.0);
        Sim::new(b.build())
    }

    fn centre(sim: &Sim) -> Vec2 {
        sim.world.body(sim.players[0].ctl.body).unwrap().centroid()
    }

    struct MirrorRun {
        converged_tick: Option<u32>,
        /// Worst / RMS error once converged (px), mirror vs the owner *now*.
        worst: f32,
        rms: f32,
    }

    /// Owner sim A drives player 0 and streams 30 Hz states; mirror sim B
    /// receives them over a link with `latency` ticks of one-way delay that
    /// loses every `lose_every`th packet, animates with the owner's buttons
    /// and blends. B starts 80 px off (under the snap distance, so it must
    /// blend, not teleport).
    fn mirror(latency: u32, lose_every: u32, hops: bool) -> MirrorRun {
        let mut a = flat();
        a.add_player(0, "A", 0xff5d73);
        let mut b = flat();
        b.add_player(0, "A", 0xff5d73);
        b.players[0].local = false;
        for _ in 0..30 {
            a.step();
            b.step();
        }
        b.world.body_mut(b.players[0].ctl.body).unwrap().translate(Vec2::new(-80.0, 0.0));

        let mut tx = StateSender::default();
        let mut rx = StateReceiver::default();
        let params = BlendParams::default();
        let mut in_flight: std::collections::VecDeque<(u32, Vec<u8>)> = Default::default();
        let mut run = MirrorRun { converged_tick: None, worst: 0.0, rms: 0.0 };
        let mut sum_sq = 0.0;
        let mut n = 0;

        for tick in 0..360u32 {
            // Run right, then turn around and run back (+ optional hops).
            let stick = if tick < 180 { v(1.0, 0.0) } else { v(-1.0, 0.0) };
            let button = hops && tick % 120 < 12; // 2.x airtime is ~1.3 s
            a.set_input(0, Input { stick, button });
            a.step();

            if tick % 2 == 0 {
                let p = &a.players[0];
                let body = a.world.body(p.ctl.body).unwrap();
                let s = BodyState::of_body(NetId::Player(0), body, input_flags(p.ctl.input.stick, p.ctl.input.button));
                if let Some(pkt) = tx.build(&[(s, 4.0)]) {
                    if lose_every == 0 || tick % (2 * lose_every) != 0 {
                        in_flight.push_back((tick + latency, pkt));
                    }
                }
            }
            let now = tick as f64 / 60.0;
            while in_flight.front().is_some_and(|f| f.0 <= tick) {
                let (_, pkt) = in_flight.pop_front().unwrap();
                rx.receive(&pkt, now);
            }

            if let Some((s, at)) = rx.get(NetId::Player(0)) {
                b.set_input(0, Input { stick: s.stick(), button: s.button() });
                b.step();
                let age = (now - at) as f32 + latency as f32 / 60.0;
                let id = b.players[0].ctl.body;
                blend_body(b.world.body_mut(id).unwrap(), &s, age, bb_sim::DT, &params);
            } else {
                b.step();
            }

            let err = centre(&a).distance(centre(&b));
            if run.converged_tick.is_none() && err < 5.0 {
                run.converged_tick = Some(tick);
            }
            if run.converged_tick.is_some() {
                run.worst = run.worst.max(err);
                sum_sq += err * err;
                n += 1;
            }
        }
        run.rms = (sum_sq / n.max(1) as f32).sqrt();
        println!(
            "latency {latency} ticks, lose 1/{lose_every}, hops {hops}: converged {:?} ms, worst {:.1} px, rms {:.1} px",
            run.converged_tick.map(|t| t as f32 * 1000.0 / 60.0),
            run.worst,
            run.rms
        );
        run
    }

    #[test]
    fn mirror_converges_and_tracks_a_running_owner() {
        let r = mirror(0, 0, false);
        assert!(r.converged_tick.is_some_and(|t| t <= 30), "converge within 0.5 s");
        assert!(r.worst < 5.0, "drifted {} px while the owner ran and turned", r.worst);
    }

    #[test]
    fn mirror_survives_latency_loss_and_jumps() {
        // ~67 ms one-way, 1 packet in 7 lost, hopping: errors spike at jump
        // onset (the owner's jump is news to us for a latency's worth of
        // time) and then blend back out; never snaps, never runs away.
        let r = mirror(4, 7, true);
        // Softer blobs settle a touch slower under latency; tracking error
        // (worst / rms below) is what players feel.
        // 2.x blobs launch near-instantly at ~1000 px/s, so a jump is ~70 px
        // of news per 67 ms of latency (the 3.0 jump was ~1.6× gentler).
        assert!(r.converged_tick.is_some_and(|t| t <= 90), "converge within 1.5 s");
        assert!(r.worst < 180.0, "worst {}", r.worst);
        assert!(r.rms < 45.0, "rms {}", r.rms);
        let r = mirror(0, 0, true);
        assert!(r.rms < 12.0, "rms {}", r.rms);
    }

    #[test]
    fn far_error_snaps_and_dead_body_disables() {
        let mut s = flat();
        s.add_player(0, "A", 0);
        let id = s.players[0].ctl.body;
        let target = BodyState::new(NetId::Player(0), Vec2::new(500.0, 200.0), Vec2::new(10.0, 0.0), 0.0, 1.0, flags::ALIVE);
        let r = blend_body(s.world.body_mut(id).unwrap(), &target, 0.0, bb_sim::DT, &BlendParams::default());
        assert!(matches!(r, Blended::Snapped { .. }));
        assert!(s.world.body(id).unwrap().centroid().distance(Vec2::new(500.0, 200.0)) < 1.0);

        let dead = BodyState { flags: 0, ..target };
        blend_body(s.world.body_mut(id).unwrap(), &dead, 0.0, bb_sim::DT, &BlendParams::default());
        assert!(!s.world.body(id).unwrap().enabled);
        // Alive again: reappears at the owner's spot.
        blend_body(s.world.body_mut(id).unwrap(), &target, 0.0, bb_sim::DT, &BlendParams::default());
        assert!(s.world.body(id).unwrap().enabled);
    }
}
