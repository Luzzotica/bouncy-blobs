//! Level validation: every design rule a level must follow, in plain words.
//!
//! The pure-geometry rules live in [`bb_level::lint`]; this adds the ones
//! that need the simulation (raycasts, resting at respawns). The campaign
//! tests (`crates/bb-level/tests/campaign.rs`) assert these same functions,
//! and `cargo run -p bb-level --example validate -- <file>` prints them.

use bb_level::blueprint::{Blueprint, Course, Move};
use bb_level::lint::{self, Finding};
use bb_level::{Level, NpcRole, metrics};

use crate::{Sim, Vec2};


pub struct Options<'a> {
    /// Drop a blob at every respawn point and check it comes to rest (slow-ish).
    pub rest: bool,
    /// Does a story script id have words? (bb-game's `level_lines` /
    /// `cutscene`; `None` skips the check.)
    pub has_script: Option<&'a dyn Fn(&str) -> bool>,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Options { rest: true, has_script: None }
    }
}

/// Every rule.
pub fn validate(course: &Course, bp: Option<&Blueprint>, opts: &Options) -> Vec<Finding> {
    let mut out = lint::lint(course, bp);
    out.extend(hazard_depth(course));
    out.extend(path_metrics(course));
    out.extend(decor_grounded(&course.level));
    if opts.rest {
        out.extend(rest_at_respawns(&course.level));
    }
    if let Some(f) = opts.has_script {
        out.extend(story_lines(&course.level, f));
    }
    out
}

/// Every story trigger (and the intro / outro) has words written for it.
pub fn story_lines(l: &Level, has: &dyn Fn(&str) -> bool) -> Vec<Finding> {
    let mut out = Vec::new();
    for t in &l.story {
        if !has(&t.script) {
            out.push(Finding::error(
                "story-lines",
                format!("story trigger `{}` has no lines: add them to `level_lines` in crates/bb-game/src/story/scripts.rs", t.script),
            ));
        }
    }
    for id in [&l.intro, &l.outro] {
        if !id.is_empty() && !has(id) {
            out.push(Finding::error("story-lines", format!("cutscene `{id}` doesn't exist: add it to `cutscene` in crates/bb-game/src/story/scripts.rs")));
        }
    }
    out
}

fn pt(p: Vec2) -> String {
    format!("({:.0}, {:.0})", p.x, p.y)
}

/// Rule 1: danger is always visible. No spike strip / kill zone sits
/// deeper than `MAX_HAZARD_DEPTH` below the critical path (with nothing
/// solid between). Standing on a pushed prop doesn't count.
pub fn hazard_depth(c: &Course) -> Vec<Finding> {
    let l = &c.level;
    let sim = Sim::new(l.clone());
    let mut out = Vec::new();
    for (name, a, b) in lint::floor_hazards(l) {
        let mut worst: Option<(f32, Vec2)> = None;
        for (p, how) in lint::path_samples(c) {
            if p.x < a.x || p.x > b.x || how == Move::Prop {
                continue;
            }
            let hy = a.y + (b.y - a.y) * (p.x - a.x) / (b.x - a.x).max(1e-3);
            let depth = p.y - hy;
            if depth <= 0.0 || depth > 2500.0 {
                continue;
            }
            // Only if it's really what's beneath you (nothing solid between).
            if sim.world.raycast(p + Vec2::new(0.0, 4.0), Vec2::NEG_Y, depth - 8.0, crate::load::layer::WORLD, None).is_some() {
                continue;
            }
            if worst.is_none_or(|(d, _)| depth > d) {
                worst = Some((depth, p));
            }
        }
        if let Some((d, p)) = worst {
            if d > metrics::MAX_HAZARD_DEPTH + 1.0 {
                out.push(Finding::error(
                    "hazard-depth",
                    format!(
                        "{name} is {d:.0} px below the path at {} (max {:.0}, MAX_HAZARD_DEPTH): raise the pit floor so the danger stays on screen",
                        pt(p),
                        metrics::MAX_HAZARD_DEPTH
                    ),
                ));
            }
        }
    }
    out
}

/// Airborne horizontal reach for a jump that lands `rise` px higher.
pub fn reach(rise: f32) -> f32 {
    let (v0, g) = (930.0f32, 1800.0f32);
    let t = |h: f32| (v0 + (v0 * v0 - 2.0 * g * h).max(0.0).sqrt()) / g;
    (420.0 * t(rise) / t(0.0)).min(620.0)
}

/// Ground (or a prop) within `depth` below `p`.
pub fn ground_below(sim: &Sim, p: Vec2, depth: f32) -> bool {
    let mask = crate::load::layer::WORLD | crate::load::layer::PROP;
    sim.world.raycast(p + Vec2::new(0.0, 100.0), Vec2::NEG_Y, 100.0 + depth, mask, None).is_some()
}

/// The critical path respects the controller metrics: jumps rise at most
/// 190 px and fit the reach, drops really drop, walks have ground underfoot
/// and aren't sheer. Assisted moves (springs, ropes, rides…) are skipped.
pub fn path_metrics(c: &Course) -> Vec<Finding> {
    let sim = Sim::new(c.level.clone());
    let mut out = Vec::new();
    let rule = "path";
    for (i, w) in c.path.windows(2).enumerate() {
        let (a, b) = (w[0].at, w[1].at);
        let rise = b.y - a.y;
        let dx = (b.x - a.x).abs();
        let tag = format!("waypoint {} ({:?} {} → {})", i + 2, w[1].how, pt(a), pt(b));
        if w[1].how.assisted() {
            continue;
        }
        if !ground_below(&sim, b, 60.0) {
            out.push(Finding::error(rule, format!("{tag}: no ground at the landing")));
        }
        match w[1].how {
            Move::Jump => {
                if rise > 190.0 {
                    out.push(Finding::error(rule, format!("{tag}: the jump rises {rise:.0} px (max 190)")));
                }
                if dx > reach(rise) {
                    out.push(Finding::error(rule, format!("{tag}: the jump is {dx:.0} px across (reach {:.0} for that rise)", reach(rise))));
                }
            }
            Move::Drop => {
                if rise > 20.0 || dx > 620.0 {
                    out.push(Finding::error(rule, format!("{tag}: not a drop (rise {rise:.0}, across {dx:.0})")));
                }
            }
            _ => {
                let steps = (dx / 30.0).ceil().max(1.0) as usize;
                for k in 0..=steps {
                    let p = a.lerp(b, k as f32 / steps as f32);
                    if !ground_below(&sim, p, 160.0) {
                        out.push(Finding::error(rule, format!("{tag}: a gap underfoot at x={:.0} (use jump/drop, or close the gap)", p.x)));
                        break;
                    }
                }
                if rise / dx.max(1.0) > 1.2 {
                    out.push(Finding::error(rule, format!("{tag}: too steep to roll up")));
                }
            }
        }
    }
    out
}

/// Rule 7: ground decor (crystals, mushrooms, toys) stands on something.
pub fn decor_grounded(l: &Level) -> Vec<Finding> {
    let sim = Sim::new(l.clone());
    let solid = lint::solids(l);
    let mut out = Vec::new();
    for d in &l.decor {
        if !matches!(d.kind.as_str(), "crystal" | "mushroom" | "sock" | "crayon" | "block_letters") {
            continue;
        }
        let down = sim.world.raycast(d.pos + Vec2::new(0.0, 30.0), Vec2::NEG_Y, 70.0, crate::load::layer::WORLD, None);
        let inside = solid.iter().any(|s| lint::point_in_polygon(d.pos + Vec2::new(0.0, 30.0 * d.scale), s));
        if down.is_none() || inside {
            out.push(Finding::error("decor", format!("{} at {} is {}", d.kind, pt(d.pos), if inside { "buried in rock" } else { "floating in the air" })));
        }
    }
    out
}

/// A blob dropped at every respawn point settles on the ground there
/// (doesn't pop, fall out, slide off or end up inside rock).
pub fn rest_at_respawns(l: &Level) -> Vec<Finding> {
    let mut l = l.clone();
    l.npcs.retain(|npc| npc.role != NpcRole::Follower);
    let solid = lint::solids(&l);
    let mut out = Vec::new();
    for (k, at) in l.respawn_points().iter().enumerate() {
        let what = if k == 0 { "the spawn".to_string() } else { format!("checkpoint {k}") };
        let mut sim = Sim::new(l.clone());
        sim.checkpoint = k;
        sim.add_player(0, "Pip", 0xff5d73);
        let body = sim.players[0].ctl.body;
        sim.world.respawn(body, *at);
        let mut grounded_late = false;
        let mut popped = None;
        for f in 0..300 {
            sim.step();
            if sim.players[0].dead.is_some() {
                popped = Some(f);
                break;
            }
            if f > 240 && sim.players[0].ctl.grounded {
                grounded_late = true;
            }
        }
        let rule = "respawn";
        if let Some(f) = popped {
            out.push(Finding::error(rule, format!("{what} at {}: Pip pops {:.1} s after respawning", pt(*at), f as f32 / 60.0)));
            continue;
        }
        let b = sim.world.body(body).unwrap();
        let c = b.centroid();
        if !c.is_finite() || c.y <= l.kill_y {
            out.push(Finding::error(rule, format!("{what} at {}: Pip falls out of the level", pt(*at))));
        } else if !grounded_late {
            out.push(Finding::error(rule, format!("{what} at {}: Pip isn't resting on ground after 5 s (now at {})", pt(*at), pt(c))));
        } else if c.distance(*at) > 260.0 {
            out.push(Finding::error(rule, format!("{what} at {}: Pip slides away to {}", pt(*at), pt(c))));
        } else if b.velocity().length() > 120.0 {
            out.push(Finding::error(rule, format!("{what} at {}: Pip is still moving after 5 s", pt(*at))));
        } else if solid.iter().any(|s| lint::point_in_polygon(c, s)) {
            out.push(Finding::error(rule, format!("{what} at {}: Pip ends up inside rock", pt(*at))));
        }
    }
    out
}
