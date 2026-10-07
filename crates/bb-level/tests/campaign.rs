//! Campaign verification: every chapter serialises, loads, is restable at
//! every checkpoint, keeps its items out of rock, respects the jump metrics
//! along its declared critical path, and is playable by a simple autopilot.
//!
//! Bot playtests are slow-ish; they run per chapter in parallel and print a
//! report (`cargo test -p bb-level --test campaign -- --nocapture bot`).

use bb_level::campaign::{self, CHAPTERS, Course, Move, Waypoint};
use bb_level::*;
use bb_sim::{Input, Sim, Vec2, physics::geom};

const R: f32 = 32.0;

fn courses() -> Vec<(u8, Course)> {
    (1..=CHAPTERS).map(|n| (n, campaign::course(n))).collect()
}

/// Solid polygons of the level (terrain that isn't one-way, jelly, movers at rest).
fn solids(l: &Level) -> Vec<Vec<Vec2>> {
    l.terrain
        .iter()
        .filter(|t| !t.one_way)
        .map(|t| t.shape.outline())
        .chain(l.jelly.iter().map(|j| j.shape.outline()))
        .collect()
}

fn dist_to_poly(p: Vec2, poly: &[Vec2]) -> f32 {
    (0..poly.len())
        .map(|i| geom::closest_on_segment(p, poly[i], poly[(i + 1) % poly.len()]).0.distance(p))
        .fold(f32::MAX, f32::min)
}

fn embedded(solids: &[Vec<Vec2>], p: Vec2, margin: f32) -> bool {
    solids.iter().any(|s| geom::point_in_polygon(p, s) || dist_to_poly(p, s) < margin)
}

// ------------------------------------------------------------------ basics

#[test]
fn chapters_round_trip_through_json() {
    let all = campaign::campaign();
    assert_eq!(all.len(), CHAPTERS as usize);
    for l in &all {
        let json = l.to_json();
        let back = Level::from_json(&json).unwrap_or_else(|e| panic!("{}: {e}", l.id));
        assert_eq!(back.id, l.id);
        assert_eq!(back.to_json(), json, "{} changes on a round trip", l.id);
    }
    assert_eq!(campaign::by_id("ch03").unwrap().id, "ch03");
}

#[test]
fn chapters_have_story_structure() {
    for (n, c) in courses() {
        let l = &c.level;
        let id = format!("ch{n:02}");
        assert_eq!(l.id, id);
        assert_eq!(l.intro, format!("{id}_intro"));
        assert_eq!(l.outro, format!("{id}_outro"));
        assert!((3..=5).contains(&l.checkpoints.len()), "{id}: {} checkpoints", l.checkpoints.len());
        assert!((30..=60).contains(&l.pickups.len()), "{id}: {} pickups", l.pickups.len());
        assert!(l.goal.is_some(), "{id}: no goal");
        assert!(l.story.len() >= 2, "{id}: needs mid-level story beats");
        for s in &l.story {
            assert!(s.script.starts_with(&format!("{id}_")), "{id}: script {} misnamed", s.script);
        }
        // Length: total critical path travel.
        let travel: f32 = c.path.windows(2).map(|w| w[0].at.distance(w[1].at)).sum();
        println!("{id}: travel {travel:.0} px, {} checkpoints, {} pickups", l.checkpoints.len(), l.pickups.len());
        assert!(travel >= 8000.0, "{id}: only {travel} px of travel");
        // Checkpoints in path order, each death costs at most ~4500 px of path.
        let idx: Vec<usize> = l.respawn_points().iter().map(|p| nearest_wp(&c.path, *p)).collect();
        let goal_idx = nearest_wp(&c.path, l.goal.as_ref().unwrap().center());
        let mut stops = idx.clone();
        stops.push(goal_idx);
        for w in stops.windows(2) {
            assert!(w[0] < w[1], "{id}: checkpoints out of path order {stops:?}");
            let seg: f32 = c.path[w[0]..=w[1]].windows(2).map(|p| p[0].at.distance(p[1].at)).sum();
            assert!(seg <= 4800.0, "{id}: {seg:.0} px between respawns (path {:?}..{:?})", w[0], w[1]);
        }
    }
}

fn nearest_wp(path: &[Waypoint], p: Vec2) -> usize {
    path.iter().enumerate().min_by(|a, b| a.1.at.distance(p).total_cmp(&b.1.at.distance(p))).unwrap().0
}

#[test]
fn goal_and_pickups_are_not_in_rock() {
    for (n, c) in courses() {
        let l = &c.level;
        let solid = solids(l);
        for (i, p) in l.pickups.iter().enumerate() {
            assert!(!embedded(&solid, *p, 12.0), "ch{n:02}: pickup {i} at {p} is embedded");
        }
        let g = l.goal.as_ref().unwrap().center();
        assert!(!embedded(&solid, g, 40.0), "ch{n:02}: goal at {g} is embedded");
        for cp in &l.checkpoints {
            assert!(!embedded(&solid, cp.pos, 30.0), "ch{n:02}: checkpoint {} embedded", cp.pos);
        }
        for w in &c.path {
            assert!(!embedded(&solid, w.at + Vec2::new(0.0, R), 20.0), "ch{n:02}: waypoint {:?} embedded", w);
        }
    }
}

// --------------------------------------------------- resting at respawns

fn rest_check(n: u8) {
    let l = campaign::chapter(n);
    let solid = solids(&l);
    for (k, at) in l.respawn_points().iter().enumerate() {
        let mut sim = Sim::new(l.clone());
        sim.checkpoint = k;
        sim.add_player(0, "Pip", 0xff5d73);
        let body = sim.players[0].ctl.body;
        sim.world.respawn(body, *at);
        let mut grounded_late = false;
        for f in 0..300 {
            sim.step();
            assert!(sim.players[0].dead.is_none(), "ch{n:02} respawn {k} at {at}: popped at frame {f}");
            if f > 240 && sim.players[0].ctl.grounded {
                grounded_late = true;
            }
        }
        let b = sim.world.body(body).unwrap();
        let c = b.centroid();
        assert!(c.is_finite(), "ch{n:02} respawn {k}: NaN");
        assert!(c.y > l.kill_y, "ch{n:02} respawn {k}: fell out");
        assert!(grounded_late, "ch{n:02} respawn {k} at {at}: not resting on ground (now {c})");
        assert!(c.distance(*at) < 260.0, "ch{n:02} respawn {k} at {at}: drifted to {c}");
        assert!(b.velocity().length() < 120.0, "ch{n:02} respawn {k}: still moving {}", b.velocity());
        assert!(!solid.iter().any(|s| geom::point_in_polygon(c, s)), "ch{n:02} respawn {k}: inside rock at {c}");
    }
}

// ------------------------------------------------------ gap/height audit

/// Airborne horizontal reach for a jump that lands `rise` px higher.
fn reach(rise: f32) -> f32 {
    let (v0, g) = (930.0f32, 1800.0f32);
    let t = |h: f32| (v0 + (v0 * v0 - 2.0 * g * h).max(0.0).sqrt()) / g;
    (420.0 * t(rise) / t(0.0)).min(620.0)
}

fn ground_below(sim: &Sim, p: Vec2, depth: f32) -> bool {
    let mask = bb_sim::load::layer::WORLD;
    sim.world.raycast(p + Vec2::new(0.0, 100.0), Vec2::NEG_Y, 100.0 + depth, mask, None).is_some()
}

fn audit(n: u8) -> Vec<String> {
    let c = campaign::course(n);
    let sim = Sim::new(c.level.clone());
    let mut errs = Vec::new();
    let mut assisted = 0;
    for (i, w) in c.path.windows(2).enumerate() {
        let (a, b) = (w[0].at, w[1].at);
        let rise = b.y - a.y;
        let dx = (b.x - a.x).abs();
        let tag = format!("ch{n:02} step {} {:?} {a}→{b}", i + 1, w[1].how);
        if w[1].how.assisted() {
            assisted += 1;
            continue;
        }
        if !ground_below(&sim, b, 60.0) {
            errs.push(format!("{tag}: no ground at landing"));
        }
        match w[1].how {
            Move::Jump => {
                if rise > 190.0 {
                    errs.push(format!("{tag}: jump rise {rise} > 190"));
                }
                if dx > reach(rise) {
                    errs.push(format!("{tag}: jump {dx} px > reach {:.0}", reach(rise)));
                }
            }
            Move::Drop => {
                if rise > 20.0 || dx > 620.0 {
                    errs.push(format!("{tag}: not a drop (rise {rise}, dx {dx})"));
                }
            }
            _ => {
                // Walking: continuous ground underfoot and no sheer climbs.
                let steps = (dx / 30.0).ceil().max(1.0) as usize;
                for k in 0..=steps {
                    let p = a.lerp(b, k as f32 / steps as f32);
                    if !ground_below(&sim, p, 160.0) {
                        errs.push(format!("{tag}: gap underfoot at x={:.0}", p.x));
                        break;
                    }
                }
                if rise / dx.max(1.0) > 1.2 {
                    errs.push(format!("{tag}: too steep to walk"));
                }
            }
        }
    }
    println!("ch{n:02}: {} path steps, {assisted} assisted", c.path.len() - 1);
    errs
}

#[test]
fn critical_paths_respect_jump_metrics() {
    let errs: Vec<String> = (1..=CHAPTERS).flat_map(audit).collect();
    assert!(errs.is_empty(), "path audit:\n{}", errs.join("\n"));
}

// ------------------------------------------------------------- the bot

struct Bot {
    i: usize,
    hold: f32,
    blocked: f32,
    since_ground: f32,
    rope_t: f32,
    prev_button: bool,
    wall_dir: f32,
    /// Seconds left backing up for a run-up after a failed climb.
    retreat: f32,
    jumped: bool,
    vx_avg: f32,
    retreat_dir: f32,
}

impl Bot {
    fn new(path: &[Waypoint], from: Vec2) -> Bot {
        let i = (nearest_wp(path, from) + 1).min(path.len() - 1);
        Bot { i, hold: 0.0, blocked: 0.0, since_ground: 0.0, rope_t: 0.0, prev_button: false, wall_dir: 1.0, retreat: 0.0, jumped: false, vx_avg: 0.0, retreat_dir: -1.0 }
    }

    fn think(&mut self, sim: &Sim, path: &[Waypoint]) -> Input {
        let dt = bb_sim::DT;
        let p = &sim.players[0];
        let b = sim.world.body(p.ctl.body).unwrap();
        let pos = b.centroid();
        let vel = b.velocity();
        let feet = pos.y - R;
        let grounded = p.ctl.grounded;
        self.since_ground = if grounded { 0.0 } else { self.since_ground + dt };
        let on_ground = self.since_ground < 0.15;
        // Advance through reached waypoints.
        let reached = |t: Waypoint| {
            let near = (pos.x - t.at.x).abs() < 50.0 && feet > t.at.y - 45.0 && feet < t.at.y + 140.0;
            near && (on_ground || matches!(t.how, Move::Swim | Move::Wind))
        };
        while self.i < path.len() - 1 {
            if reached(path[self.i]) {
                self.i += 1;
                self.rope_t = 0.0;
            } else if self.i + 1 < path.len() - 1 && reached(path[self.i + 1]) {
                // Overshot a waypoint (e.g. bounced past it): skip ahead.
                self.i += 2;
                self.rope_t = 0.0;
            } else {
                break;
            }
        }
        // Fell well below where we were headed: go back to the last
        // waypoint at this height and retry from there.
        if grounded && self.i > 0 {
            let t = path[self.i];
            let goal_y = if t.how == Move::Spring { path[self.i - 1].at.y } else { t.at.y };
            let assisted_up = matches!(t.how, Move::Ride | Move::Wall | Move::Wind | Move::Swim | Move::Rope);
            if goal_y > feet + 260.0 && !assisted_up {
                let near = (0..self.i)
                    .filter(|&j| (path[j].at.y - feet).abs() < 70.0 && (path[j].at.x - pos.x).abs() < 600.0)
                    .min_by(|&a, &b| (path[a].at.x - pos.x).abs().total_cmp(&(path[b].at.x - pos.x).abs()));
                if let Some(j) = near {
                    self.i = j + 1;
                }
            }
        }
        let tgt = path[self.i];
        let prev = path[self.i.saturating_sub(1)];
        let dx = tgt.at.x - pos.x;
        let dir = if dx >= 0.0 { 1.0 } else { -1.0 };
        let mut stick = Vec2::new((dx / 80.0).clamp(-1.0, 1.0), 0.0);
        let mut button = false;
        let at_prev = (pos.x - prev.at.x).abs() < 35.0 && on_ground;

        // Blocked while pushing?
        self.vx_avg += (vel.x - self.vx_avg) * 0.1;
        if self.since_ground < 0.3 && stick.x.abs() > 0.5 && self.vx_avg.abs() < 60.0 {
            self.blocked += dt;
        } else {
            self.blocked = 0.0;
        }
        let blocked = self.blocked > 0.25;
        let edge_ahead = on_ground
            && !sim.world.raycast(pos + Vec2::new(dir * 50.0, 0.0), Vec2::NEG_Y, 150.0, bb_sim::load::layer::WORLD, Some(p.ctl.body)).is_some();
        let mut want_jump = blocked;
        // Target right above us: just jump.
        if tgt.at.y > feet + 40.0 && dx.abs() < 150.0 && !matches!(tgt.how, Move::Ride | Move::Swim | Move::Wall | Move::Spring) {
            want_jump = true;
        }
        // A jump that landed back short of a higher target: back up for a run-up.
        // (For spring moves the thing to climb onto is the spring/cap itself.)
        let goal = if tgt.how == Move::Spring && on_ground { prev.at } else { tgt.at };
        let gdir = if goal.x >= pos.x { 1.0 } else { -1.0 };
        if self.jumped && grounded && self.hold <= 0.0 {
            self.jumped = false;
            if goal.y > feet + 40.0 && (goal.x - pos.x).abs() < 240.0 && p.ctl.grab.is_none() {
                self.retreat = 0.45;
                self.retreat_dir = -gdir;
            }
        }
        if self.retreat > 0.0 {
            self.retreat -= dt;
            self.prev_button = false;
            return Input { stick: Vec2::new(self.retreat_dir, 0.0), button: false };
        }

        match tgt.how {
            Move::Walk | Move::Push | Move::Squeeze | Move::Drop => {}
            Move::Jump => {
                if at_prev || (edge_ahead && tgt.at.y > feet - 60.0) {
                    want_jump = true;
                }
            }
            Move::Spring => {
                if on_ground && (feet < tgt.at.y - 60.0 || (pos.x - tgt.at.x).abs() > 60.0) {
                    stick.x = ((prev.at.x - pos.x) / 40.0).clamp(-1.0, 1.0);
                    if (pos.x - prev.at.x).abs() < 40.0 && prev.at.y > feet + 40.0 {
                        want_jump = true;
                    }
                }
            }
            Move::Rope => {
                if p.ctl.grab.is_some() {
                    self.rope_t += dt;
                    stick.x = dir;
                    if tgt.at.y > feet + 160.0 {
                        stick.y = 1.0;
                    }
                    let good = vel.x * dir > 260.0 && vel.y > -150.0;
                    if (self.rope_t > 0.5 && good) || self.rope_t > 8.0 {
                        button = !self.prev_button;
                    }
                } else if at_prev || (edge_ahead && self.i > 0) {
                    want_jump = true;
                }
            }
            Move::Wind => {
                if at_prev || edge_ahead {
                    want_jump = true;
                }
                if !on_ground && feet < tgt.at.y + 120.0 {
                    button = true;
                }
            }
            Move::Swim => {
                if pos.y < tgt.at.y + R + 20.0 && !on_ground {
                    button = true;
                }
                if at_prev && tgt.at.y > feet + 40.0 {
                    want_jump = true;
                }
            }
            Move::Ride => {
                // Wait for the platform to be at the target before stepping on.
                let there = sim
                    .world
                    .raycast(tgt.at + Vec2::new(0.0, 80.0), Vec2::NEG_Y, 130.0, bb_sim::load::layer::WORLD, None)
                    .is_some_and(|h| (h.1.y - tgt.at.y).abs() < 40.0);
                let riding = (pos.x - prev.at.x).abs() < 90.0 && on_ground && prev.how == Move::Ride;
                let close = (tgt.at.y - feet) < 120.0 && dx.abs() < 360.0;
                if riding && !close {
                    stick.x = ((prev.at.x - pos.x) / 60.0).clamp(-1.0, 1.0);
                    want_jump = false;
                } else if !there && on_ground && dx.abs() > 90.0 && !riding {
                    stick.x = (-vel.x / 250.0).clamp(-1.0, 1.0);
                    want_jump = false;
                } else if on_ground && tgt.at.y > feet + 30.0 && dx.abs() < 330.0 {
                    want_jump = true;
                }
            }
            Move::Wall => {
                if let Some(nrm) = p.ctl.stuck {
                    let away = nrm.x.signum();
                    if feet < prev.at.y + 70.0 {
                        // Stuck too low: peel off and take a proper jump.
                        stick.x = away;
                    } else if vel.y < 80.0 {
                        self.wall_dir = away;
                        button = !self.prev_button;
                        stick.x = away;
                    } else {
                        stick.x = -away;
                    }
                } else if grounded {
                    self.wall_dir = dir;
                    if dx.abs() < 120.0 || (pos.x - prev.at.x).abs() < 100.0 {
                        want_jump = true;
                    }
                } else {
                    stick.x = self.wall_dir;
                }
            }
        }

        if want_jump && on_ground && self.hold <= 0.0 && !self.prev_button {
            self.hold = 0.55;
            self.jumped = true;
        }
        if self.hold > 0.0 {
            self.hold -= dt;
            button = true;
            if vel.y < 0.0 && self.hold < 0.4 {
                self.hold = 0.0;
            }
        }
        self.prev_button = button;
        Input { stick, button }
    }
}

/// Try to get from respawn `k` to the next checkpoint (or the goal).
/// Returns (success, seconds, deaths).
fn bot_segment(c: &Course, k: usize, limit: f32) -> (bool, f32, u32) {
    let l = &c.level;
    let mut sim = Sim::new(l.clone());
    sim.checkpoint = k;
    sim.add_player(0, "Bot", 0x4d96ff);
    let start = l.respawn_points()[k];
    sim.world.respawn(sim.players[0].ctl.body, start);
    let mut bot = Bot::new(&c.path, start);
    let mut deaths = 0;
    let mut was_dead = false;
    let steps = (limit / bb_sim::DT) as usize;
    let trace = std::env::var("BOT_TRACE").is_ok_and(|t| t == format!("{}:{k}", l.id) || t == format!("mini_{}:{k}", l.name));
    for f in 0..steps {
        let dead = sim.players[0].dead.is_some();
        if dead && !was_dead {
            deaths += 1;
        }
        if !dead && was_dead {
            bot = Bot::new(&c.path, sim.respawn_point());
        }
        was_dead = dead;
        if !dead {
            let i = bot.think(&sim, &c.path);
            if trace && f % 6 == 0 {
                let b = sim.world.body(sim.players[0].ctl.body).unwrap();
                println!("t{:.1} wp{} {:?} pos {:.0},{:.0} v {:.0},{:.0} g{} in {:?}", f as f32 / 60.0, bot.i, c.path[bot.i].how, b.centroid().x, b.centroid().y, b.velocity().x, b.velocity().y, sim.players[0].ctl.grounded as u8, i);
            }
            sim.set_input(0, i);
        }
        sim.step();
        let done = if k < l.checkpoints.len() { sim.checkpoint > k } else { sim.completed };
        if done {
            return (true, f as f32 * bb_sim::DT, deaths);
        }
    }
    let pos = sim.world.body(sim.players[0].ctl.body).unwrap().centroid();
    println!("  ch {} seg {k}: stuck near {pos} heading for wp {} {:?}", l.id, bot.i, c.path[bot.i]);
    (false, limit, deaths)
}

fn bot_report(n: u8) -> (usize, usize) {
    let c = campaign::course(n);
    let segs = c.level.checkpoints.len() + 1;
    let mut ok = 0;
    let mut lines = Vec::new();
    for k in 0..segs {
        let (done, t, deaths) = bot_segment(&c, k, 90.0);
        if done {
            ok += 1;
        }
        lines.push(format!("  seg {k}: {} in {t:.1}s, {deaths} pops", if done { "OK  " } else { "FAIL" }));
    }
    println!("BOT ch{n:02}: {ok}/{segs} segments\n{}", lines.join("\n"));
    (ok, segs)
}

/// `BOT_TRACE=ch01:0 cargo test ... bot_one -- --nocapture`
#[test]
fn bot_one() {
    let Ok(t) = std::env::var("BOT_TRACE") else { return };
    let (id, k) = t.split_once(':').unwrap();
    if let Some(name) = id.strip_prefix("mini_") {
        println!("{:?}", bot_segment(&mini(name), 0, 25.0));
        return;
    }
    let n: u8 = id[2..].parse().unwrap();
    let k: usize = k.parse().unwrap();
    let r = bot_segment(&campaign::course(n), k, 30.0);
    println!("{r:?}");
}

macro_rules! per_chapter {
    ($($n:literal => $rest:ident, $bot:ident;)*) => {$(
        #[test]
        fn $rest() {
            rest_check($n);
        }
        #[test]
        fn $bot() {
            let (ok, segs) = bot_report($n);
            // The bot is a playtest proxy, not a gate; it must at least get
            // out of the first section.
            assert!(ok >= 1, "bot cleared nothing in ch{:02} ({ok}/{segs})", $n);
        }
    )*};
}

per_chapter! {
    1 => rest_ch01, bot_ch01;
    2 => rest_ch02, bot_ch02;
    3 => rest_ch03, bot_ch03;
    4 => rest_ch04, bot_ch04;
    5 => rest_ch05, bot_ch05;
    6 => rest_ch06, bot_ch06;
    7 => rest_ch07, bot_ch07;
    8 => rest_ch08, bot_ch08;
    9 => rest_ch09, bot_ch09;
    10 => rest_ch10, bot_ch10;
}

// ------------------------------------------------- bot mechanics test bed

/// Tiny courses, one per assisted move, to keep the bot honest.
fn mini(name: &str) -> Course {
    let mut b = LevelBuilder::new("mini", name, Theme::Hollow);
    b.spawn(v(0.0, 40.0)).kill_y(-1200.0);
    b.ground(&[v(-400.0, 0.0), v(400.0, 0.0)], 1000.0);
    let w = |x: f32, y: f32, how: Move| Waypoint { at: v(x, y), how };
    let mut path = vec![w(0.0, 0.0, Move::Walk)];
    match name {
        "spring" => {
            b.spring(v(300.0, 0.0), 90.0, 1400.0);
            b.ground(&[v(500.0, 400.0), v(1100.0, 400.0)], 200.0);
            path.extend([w(300.0, 0.0, Move::Walk), w(650.0, 400.0, Move::Spring)]);
        }
        "trampoline" => {
            b.trampoline(v(250.0, 0.0), 90.0, 160.0, 1200.0);
            b.ground(&[v(500.0, 420.0), v(1100.0, 420.0)], 200.0);
            path.extend([w(250.0, 135.0, Move::Jump), w(650.0, 420.0, Move::Spring)]);
        }
        "rope" => {
            b.vine(v(700.0, 600.0), 340.0);
            b.ground(&[v(1250.0, 0.0), v(1900.0, 0.0)], 1000.0);
            b.kill(v(400.0, -1100.0), v(1250.0, -300.0));
            path.extend([w(360.0, 0.0, Move::Walk), w(1400.0, 0.0, Move::Rope)]);
        }
        "wind" => {
            b.wind(v(420.0, -100.0), v(620.0, 900.0), v(0.0, 1400.0));
            b.ground(&[v(700.0, 700.0), v(1200.0, 700.0)], 200.0);
            path.extend([w(380.0, 0.0, Move::Walk), w(520.0, 760.0, Move::Wind), w(800.0, 700.0, Move::Drop)]);
            b.ground(&[v(400.0, -300.0), v(700.0, -300.0)], 300.0);
        }
        "swim" => {
            b.ground(&[v(400.0, -400.0), v(1400.0, -400.0)], 600.0);
            b.water(v(400.0, -400.0), v(1400.0, -40.0));
            b.ground(&[v(1400.0, 0.0), v(1900.0, 0.0)], 1000.0);
            path.extend([w(380.0, 0.0, Move::Walk), w(1000.0, -100.0, Move::Swim), w(1500.0, 0.0, Move::Swim)]);
        }
        "ride" => {
            b.elevator(v(500.0, -13.0), v(500.0, 487.0), 160.0, 6.0);
            b.ground(&[v(620.0, 500.0), v(1100.0, 500.0)], 200.0);
            b.ground(&[v(400.0, -60.0), v(620.0, -60.0)], 600.0);
            path.extend([w(350.0, 0.0, Move::Walk), w(500.0, 0.0, Move::Ride), w(750.0, 500.0, Move::Ride)]);
        }
        "wall" => {
            b.terrain(Shape::rect(v(400.0, 0.0), v(460.0, 900.0)), Material::Sticky);
            b.terrain(Shape::rect(v(140.0, 160.0), v(200.0, 900.0)), Material::Sticky);
            b.ground(&[v(460.0, 900.0), v(900.0, 900.0)], 300.0);
            path.extend([w(300.0, 0.0, Move::Walk), w(560.0, 900.0, Move::Wall)]);
        }
        _ => panic!("{name}"),
    }
    b.goal(path.last().unwrap().at, path.last().unwrap().at + v(150.0, 200.0));
    Course { level: b.build(), path }
}

#[test]
fn bot_handles_every_assist() {
    let mut fails = Vec::new();
    for name in ["spring", "trampoline", "rope", "wind", "swim", "ride", "wall"] {
        let c = mini(name);
        let r = bot_segment(&c, 0, 25.0);
        println!("mini {name}: {r:?}");
        if !r.0 {
            fails.push(name);
        }
    }
    assert!(fails.is_empty(), "bot failed {fails:?}");
}
