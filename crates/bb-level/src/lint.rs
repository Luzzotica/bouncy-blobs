//! Level design rules that are pure geometry (no physics): story structure,
//! nothing buried in rock, cave bookends, no-cheese ceilings and clean
//! seams. `bb_sim::validate` adds the rules that need the simulation and
//! runs everything; the campaign tests assert the same functions.
//!
//! Campaign-only rules (checkpoint counts, chapter themes, …) apply when the
//! level id is a chapter id (`ch01` … `ch10`).

use glam::Vec2;

use crate::blueprint::{Blueprint, Course, Move, Piece, PieceSpan, Waypoint};
use crate::builder::metrics;
use crate::types::*;

const R: f32 = metrics::PLAYER_R;

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Error,
    Warning,
}

/// One broken rule, in plain words.
#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub severity: Severity,
    /// Short rule name (`hazard-depth`, `seam`, …).
    pub rule: &'static str,
    pub message: String,
    /// The blueprint piece to look at (0-based), when known.
    pub piece: Option<usize>,
}

impl Finding {
    pub fn error(rule: &'static str, message: impl Into<String>) -> Finding {
        Finding { severity: Severity::Error, rule, message: message.into(), piece: None }
    }
    pub fn warning(rule: &'static str, message: impl Into<String>) -> Finding {
        Finding { severity: Severity::Warning, rule, message: message.into(), piece: None }
    }
    pub fn at_piece(mut self, i: usize) -> Finding {
        self.piece = Some(i);
        self
    }
}

impl std::fmt::Display for Finding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self.severity {
            Severity::Error => "error",
            Severity::Warning => "warning",
        };
        write!(f, "{s} [{}]: {}", self.rule, self.message)
    }
}

/// Chapter number when the level is a campaign chapter.
pub fn chapter_number(l: &Level) -> Option<u8> {
    crate::campaign::number(&l.id)
}

/// Every pure-geometry rule.
pub fn lint(course: &Course, bp: Option<&Blueprint>) -> Vec<Finding> {
    let mut out = Vec::new();
    out.extend(story_structure(course));
    out.extend(buried_items(course));
    out.extend(caves(course));
    out.extend(vine_ceilings(course));
    out.extend(seams(course, bp));
    out
}

// ------------------------------------------------------------- geometry

/// Solid polygons (terrain that isn't one-way, and jelly).
pub fn solids(l: &Level) -> Vec<Vec<Vec2>> {
    l.terrain.iter().filter(|t| !t.one_way).map(|t| t.shape.outline()).chain(l.jelly.iter().map(|j| j.shape.outline())).collect()
}

pub fn point_in_polygon(p: Vec2, poly: &[Vec2]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn closest_on_segment(p: Vec2, a: Vec2, b: Vec2) -> Vec2 {
    let ab = b - a;
    let t = ((p - a).dot(ab) / ab.length_squared().max(1e-9)).clamp(0.0, 1.0);
    a + ab * t
}

pub fn dist_to_poly(p: Vec2, poly: &[Vec2]) -> f32 {
    (0..poly.len()).map(|i| closest_on_segment(p, poly[i], poly[(i + 1) % poly.len()]).distance(p)).fold(f32::MAX, f32::min)
}

/// Inside (or within `margin` of) any of the solids.
pub fn embedded(solids: &[Vec<Vec2>], p: Vec2, margin: f32) -> bool {
    solids.iter().any(|s| point_in_polygon(p, s) || dist_to_poly(p, s) < margin)
}

fn bounds(poly: &[Vec2]) -> (Vec2, Vec2) {
    poly.iter().fold((Vec2::splat(f32::MAX), Vec2::splat(f32::MIN)), |(a, b), p| (a.min(*p), b.max(*p)))
}

pub fn nearest_wp(path: &[Waypoint], p: Vec2) -> usize {
    path.iter().enumerate().min_by(|a, b| a.1.at.distance(p).total_cmp(&b.1.at.distance(p))).map_or(0, |x| x.0)
}

fn pt(p: Vec2) -> String {
    format!("({:.0}, {:.0})", p.x, p.y)
}

// ---------------------------------------------------- story structure

/// Campaign chapters: intro/outro ids, 3-5 checkpoints, 30-60 drops, a
/// goal, 2+ story beats named `chNN_…`, 8000+ px of travel, checkpoints in
/// path order no more than 4800 px apart. Any level: a goal.
pub fn story_structure(c: &Course) -> Vec<Finding> {
    let l = &c.level;
    let mut out = Vec::new();
    let rule = "structure";
    if l.goal.is_none() && l.modes.contains(&Mode::Story) {
        out.push(Finding::error(rule, "the level has no goal (add an exit_cave or a goal piece)"));
    }
    let Some(_) = chapter_number(l) else { return out };
    let id = &l.id;
    if l.intro != format!("{id}_intro") || l.outro != format!("{id}_outro") {
        out.push(Finding::error(rule, format!("intro/outro should be {id}_intro / {id}_outro (found {:?} / {:?})", l.intro, l.outro)));
    }
    if !(3..=5).contains(&l.checkpoints.len()) {
        out.push(Finding::error(rule, format!("{} checkpoints (a chapter has 3 to 5)", l.checkpoints.len())));
    }
    if !(30..=60).contains(&l.pickups.len()) {
        out.push(Finding::error(rule, format!("{} glow drops (a chapter has 30 to 60)", l.pickups.len())));
    }
    if l.story.len() < 2 {
        out.push(Finding::error(rule, "needs at least 2 mid-level story beats (say pieces)"));
    }
    for s in &l.story {
        if !s.script.starts_with(&format!("{id}_")) {
            out.push(Finding::error(rule, format!("story trigger `{}` should be named {id}_something", s.script)));
        }
    }
    if c.path.len() < 2 {
        out.push(Finding::error(rule, "no critical path (add wp pieces from the spawn to the goal)"));
        return out;
    }
    let travel: f32 = c.path.windows(2).map(|w| w[0].at.distance(w[1].at)).sum();
    if travel < 8000.0 {
        out.push(Finding::error(rule, format!("only {travel:.0} px of critical path (a chapter has 8000+)")));
    }
    if let Some(goal) = &l.goal {
        let mut stops: Vec<usize> = l.respawn_points().iter().map(|p| nearest_wp(&c.path, *p)).collect();
        stops.push(nearest_wp(&c.path, goal.center()));
        for w in stops.windows(2) {
            if w[0] >= w[1] {
                out.push(Finding::error(rule, format!("checkpoints are out of path order (nearest waypoints {stops:?})")));
                break;
            }
            let seg: f32 = c.path[w[0]..=w[1]].windows(2).map(|p| p[0].at.distance(p[1].at)).sum();
            if seg > 4800.0 {
                out.push(Finding::error(rule, format!("{seg:.0} px of path between respawns near {} and {} (max 4800: add a checkpoint)", pt(c.path[w[0]].at), pt(c.path[w[1]].at))));
            }
        }
    }
    out
}

// ------------------------------------------------------- buried items

/// Drops, the goal, checkpoints and waypoints must not sit in rock.
pub fn buried_items(c: &Course) -> Vec<Finding> {
    let l = &c.level;
    let solid = solids(l);
    let rule = "buried";
    let mut out = Vec::new();
    for (i, p) in l.pickups.iter().enumerate() {
        if embedded(&solid, *p, 12.0) {
            out.push(Finding::error(rule, format!("glow drop {} at {} is inside (or within 12 px of) rock or jelly", i + 1, pt(*p))));
        }
    }
    if let Some(g) = &l.goal {
        let g = g.center();
        if embedded(&solid, g, 40.0) {
            out.push(Finding::error(rule, format!("the goal at {} is buried", pt(g))));
        }
    }
    for cp in &l.checkpoints {
        if embedded(&solid, cp.pos, 30.0) {
            out.push(Finding::error(rule, format!("checkpoint at {} is embedded in rock (its respawn point is 40 px above the surface you give)", pt(cp.pos))));
        }
    }
    for w in &c.path {
        if embedded(&solid, w.at + Vec2::new(0.0, R), 20.0) {
            out.push(Finding::error(rule, format!("waypoint {:?} at {} is inside rock (waypoints are feet positions on a surface)", w.how, pt(w.at))));
        }
    }
    out
}

// ---------------------------------------------------------------- caves

const CAMPAIGN_THEMES: [Theme; 10] =
    [Theme::Hollow, Theme::Drip, Theme::Fungus, Theme::Vines, Theme::Stoneworks, Theme::Lake, Theme::Chimney, Theme::Toys, Theme::CaveIn, Theme::Well];

/// Rule 10: chapters start beside a sealed entry cave and end in an exit
/// cave glowing with the neighbouring chapters' colours; the goal is inside
/// the exit tunnel; tunnels are open air; no "sun" lights.
pub fn caves(c: &Course) -> Vec<Finding> {
    let l = &c.level;
    let Some(n) = chapter_number(l) else { return Vec::new() };
    let rule = "caves";
    let mut out = Vec::new();
    let i = n as usize - 1;
    if l.theme != CAMPAIGN_THEMES[i] {
        out.push(Finding::error(rule, format!("chapter {n} should use theme {:?}", CAMPAIGN_THEMES[i])));
    }
    let entry: Vec<_> = l.mouths.iter().filter(|m| m.kind == MouthKind::Entry).collect();
    let exit: Vec<_> = l.mouths.iter().filter(|m| m.kind == MouthKind::Exit).collect();
    if entry.len() != 1 || exit.len() != 1 {
        out.push(Finding::error(rule, format!("needs exactly one entry_cave and one exit_cave (found {} and {})", entry.len(), exit.len())));
        return out;
    }
    let prev = if i == 0 { Theme::Hollow } else { CAMPAIGN_THEMES[i - 1] };
    if entry[0].theme != prev {
        out.push(Finding::error(rule, format!("the entry cave should glow {prev:?} (the previous chapter)")));
    }
    if i + 1 < CAMPAIGN_THEMES.len() {
        if exit[0].theme != CAMPAIGN_THEMES[i + 1] {
            out.push(Finding::error(rule, format!("the exit cave should glow {:?} (the next chapter)", CAMPAIGN_THEMES[i + 1])));
        }
    } else if !exit[0].daylight {
        out.push(Finding::error(rule, "the last chapter's exit opens onto daylight (\"daylight\": true)"));
    }
    if let Some(g) = &l.goal {
        let (lo, hi) = exit[0].interior();
        let g = g.center();
        if !(g.x > lo.x && g.x < hi.x && g.y > lo.y && g.y < hi.y) {
            out.push(Finding::error(rule, format!("the goal {} isn't inside the exit tunnel", pt(g))));
        }
    }
    if l.decor.iter().any(|d| d.kind == "sun") {
        out.push(Finding::error(rule, "no round \"sun\" lights: the light at the end is the exit cave"));
    }
    let solid = solids(l);
    for m in [entry[0], exit[0]] {
        let p = m.pos + Vec2::new(m.facing * 120.0, R + 10.0);
        if embedded(&solid, p, 8.0) {
            out.push(Finding::error(rule, format!("the {:?} cave mouth at {} is filled with rock", m.kind, pt(m.pos))));
        }
    }
    out
}

// --------------------------------------------------------------- hazards

/// Floor hazards: spike strips whose teeth point up, and kill zones (top
/// edge). Each as a line (left to right).
pub fn floor_hazards(l: &Level) -> Vec<(String, Vec2, Vec2)> {
    let mut v: Vec<(String, Vec2, Vec2)> =
        l.spikes.iter().filter(|s| (s.b - s.a).perp().y > 0.0 && s.b.x > s.a.x).map(|s| (format!("spikes {}→{}", pt(s.a), pt(s.b)), s.a, s.b)).collect();
    for z in &l.zones {
        if matches!(z.kind, ZoneKind::Kill) {
            let (lo, hi) = z.shape.bounds();
            v.push((format!("kill zone {}..{}", pt(lo), pt(hi)), Vec2::new(lo.x, hi.y), hi));
        }
    }
    v
}

/// Points along the critical path every ~20 px (feet positions).
pub fn path_samples(c: &Course) -> Vec<(Vec2, Move)> {
    let mut out = Vec::new();
    for w in c.path.windows(2) {
        let n = ((w[1].at - w[0].at).length() / 20.0).ceil().max(1.0) as usize;
        for k in 0..=n {
            out.push((w[0].at.lerp(w[1].at, k as f32 / n as f32), w[1].how));
        }
    }
    out
}

/// Rule 5: wherever the path swings over a spike pit on a vine / rope, at
/// least 40% of the roof over the pit carries spikes (no ceiling crawl).
pub fn vine_ceilings(c: &Course) -> Vec<Finding> {
    let l = &c.level;
    let ceiling: Vec<(f32, f32)> = l.spikes.iter().filter(|s| (s.b - s.a).perp().y < 0.0).map(|s| (s.a.x.min(s.b.x), s.a.x.max(s.b.x))).collect();
    let mut out = Vec::new();
    for w in c.path.windows(2) {
        if w[1].how != Move::Rope {
            continue;
        }
        let (x0, x1) = (w[0].at.x.min(w[1].at.x), w[0].at.x.max(w[1].at.x));
        for (name, a, b) in floor_hazards(l) {
            let (o0, o1) = (a.x.max(x0), b.x.min(x1));
            if o1 - o0 < 150.0 {
                continue;
            }
            let covered: f32 = ceiling.iter().map(|(c0, c1)| (c1.min(o1) - c0.max(o0)).max(0.0)).sum();
            if covered < (o1 - o0) * 0.4 {
                out.push(Finding::error(
                    "no-cheese",
                    format!("the rope crossing {x0:.0}..{x1:.0} over {name} has only {covered:.0} of {:.0} px of ceiling spiked (add roof_spikes)", o1 - o0),
                ));
            }
        }
    }
    out
}

// ---------------------------------------------------------------- seams

/// How close two floor ends must be to count as meant to meet.
pub const SEAM_SNAP: f32 = 16.0;

/// A walkable top surface a piece makes: its polyline, left to right.
fn surfaces(p: &Piece, bottom: f32) -> Vec<(Vec<Vec2>, &'static str)> {
    let _ = bottom;
    match p {
        Piece::Floor(top) => vec![(top.clone(), "floor")],
        Piece::Ledge { x0, x1, y } => vec![(vec![Vec2::new(*x0, *y), Vec2::new(*x1, *y)], "floor")],
        Piece::Shelf { x0, x1, y, .. } => vec![(vec![Vec2::new(*x0, *y), Vec2::new(*x1, *y)], "shelf")],
        Piece::Ground { top, .. } => vec![(top.clone(), "ground")],
        Piece::EntryCave { x_far, x_face, y, .. } => {
            let d = 260.0 * (x_far - x_face).signum();
            vec![(vec![Vec2::new(x_face.min(x_face + d), *y), Vec2::new(x_face.max(x_face + d), *y)], "cave")]
        }
        Piece::ExitCave { x_face, x_far, y, .. } => {
            let d = 560.0 * (x_far - x_face).signum();
            vec![(vec![Vec2::new(x_face.min(x_face + d), *y), Vec2::new(x_face.max(x_face + d), *y)], "cave")]
        }
        _ => Vec::new(),
    }
}

/// Clean seams (Sterling: "the platforms don't mesh together perfectly").
///
/// * **near-miss joint**: two floors whose ends nearly meet but don't line
///   up (a few px gap or overlap, at a step too, or a tiny step): make them
///   meet exactly, or merge.
/// * **overlapping floors**: two floors covering the same stretch at about
///   the same height.
/// * **flush joint**: two plain floors meet exactly at the same height:
///   merge them into one `floor` (one fewer seam).
/// * **rock in jelly**: rock pokes into a jelly skin or block (it shoves the
///   jelly about; end walls at the rock core under the skin, `y - 26`).
/// * **overlapping jelly**: jelly bodies from different pieces overlap.
pub fn seams(c: &Course, bp: Option<&Blueprint>) -> Vec<Finding> {
    let l = &c.level;
    let mut out = Vec::new();
    let spans = bp.map(|b| b.expand_traced().1);
    let owner_j = |j: usize| spans.as_ref().and_then(|s| s.iter().position(|sp: &PieceSpan| sp.jelly.contains(&j)));
    let owner_t = |t: usize| spans.as_ref().and_then(|s| s.iter().position(|sp: &PieceSpan| sp.terrain.contains(&t)));

    if let Some(bp) = bp {
        // Floor joints, piece against piece.
        let surf: Vec<(usize, Vec<Vec2>, &str)> =
            bp.pieces.iter().enumerate().flat_map(|(i, p)| surfaces(p, bp.bottom).into_iter().map(move |(s, k)| (i, s, k))).collect();
        for (a, (ia, sa, ka)) in surf.iter().enumerate() {
            for (ib, sb, kb) in &surf[a + 1..] {
                if ia == ib || sa.len() < 2 || sb.len() < 2 {
                    continue;
                }
                let (a0, a1) = (sa[0], *sa.last().unwrap());
                let (b0, b1) = (sb[0], *sb.last().unwrap());
                // Which ends face each other.
                for (p, q) in [(a1, b0), (b1, a0)] {
                    let d = q - p;
                    // Far apart, or a clean step (same x, different height).
                    if d.x.abs() >= SEAM_SNAP || (d.x.abs() < 0.01 && d.y.abs() >= SEAM_SNAP) {
                        continue;
                    }
                    let (first, second) = if p == a1 { (*ia, *ib) } else { (*ib, *ia) };
                    if d.length() < 0.01 {
                        if *ka == "floor" && *kb == "floor" {
                            out.push(
                                Finding::warning(
                                    "seam",
                                    format!("flush joint at {}: pieces {} and {} are two floors meeting at the same height; merge them into one floor (one fewer seam)", pt(p), first + 1, second + 1),
                                )
                                .at_piece(second),
                            );
                        }
                    } else {
                        out.push(
                            Finding::error(
                                "seam",
                                format!(
                                    "near-miss joint: piece {} ends at {} and piece {} starts at {} ({:+.1}, {:+.1} px): make the ends meet exactly (or merge them)",
                                    first + 1,
                                    pt(p),
                                    second + 1,
                                    pt(q),
                                    d.x,
                                    d.y
                                ),
                            )
                            .at_piece(second),
                        );
                    }
                }
                // Same stretch, about the same height.
                let (lo, hi) = (a0.x.max(b0.x), a1.x.min(b1.x));
                if hi - lo > 1.0 {
                    let at = |s: &[Vec2], x: f32| {
                        s.windows(2).find(|w| w[0].x <= x && x <= w[1].x && w[1].x > w[0].x).map(|w| w[0].y + (w[1].y - w[0].y) * (x - w[0].x) / (w[1].x - w[0].x))
                    };
                    let mid = (lo + hi) * 0.5;
                    if let (Some(ya), Some(yb)) = (at(sa, mid), at(sb, mid)) {
                        if (ya - yb).abs() < metrics::SKIN + 4.0 {
                            out.push(
                                Finding::error(
                                    "seam",
                                    format!("overlapping floors: pieces {} and {} both cover x {lo:.0}..{hi:.0} at about y {ya:.0}", ia + 1, ib + 1),
                                )
                                .at_piece(*ib),
                            );
                        }
                    }
                }
            }
        }
    }

    // Rock poking into jelly.
    let rocks: Vec<(usize, Vec<Vec2>, (Vec2, Vec2))> = l
        .terrain
        .iter()
        .enumerate()
        .filter(|(_, t)| !t.one_way)
        .map(|(i, t)| {
            let o = t.shape.outline();
            let b = bounds(&o);
            (i, o, b)
        })
        .collect();
    let jellies: Vec<(Vec<Vec2>, (Vec2, Vec2))> = l.jelly.iter().map(|j| {
        let o = j.shape.outline();
        let b = bounds(&o);
        (o, b)
    }).collect();
    for (ji, (jo, (jlo, jhi))) in jellies.iter().enumerate() {
        for (ti, to, (tlo, thi)) in &rocks {
            if tlo.x > jhi.x || thi.x < jlo.x || tlo.y > jhi.y || thi.y < jlo.y {
                continue;
            }
            // Sample the jelly's inside (2 px in from its edge).
            let mut hits = 0;
            let mut first = None;
            let mut y = jlo.y + 2.0;
            while y <= jhi.y - 2.0 {
                let mut x = jlo.x + 2.0;
                while x <= jhi.x - 2.0 {
                    let p = Vec2::new(x, y);
                    if point_in_polygon(p, jo) && dist_to_poly(p, jo) > 2.0 && point_in_polygon(p, to) {
                        hits += 1;
                        first.get_or_insert(p);
                    }
                    x += 3.0;
                }
                y += 3.0;
            }
            if hits >= 3 {
                let who = owner_t(*ti).map(|i| format!(" (piece {})", i + 1)).unwrap_or_default();
                let mut f = Finding::error(
                    "seam",
                    format!(
                        "rock{who} pokes into a jelly skin near {} (~{} px²): jelly can't share space with rock; stop the rock at the core under the skin (26 px below the surface)",
                        pt(first.unwrap()),
                        hits * 9
                    ),
                );
                if let Some(i) = owner_t(*ti).or(owner_j(ji)) {
                    f = f.at_piece(i);
                }
                out.push(f);
            }
        }
    }

    // Jelly overlapping jelly from another piece (tiles of one floor overlap
    // a few px on purpose; different pieces shouldn't).
    if spans.is_some() {
        for (a, (ao, (alo, ahi))) in jellies.iter().enumerate() {
            for (b, (bo, (blo, bhi))) in jellies.iter().enumerate().skip(a + 1) {
                if owner_j(a) == owner_j(b) || blo.x > ahi.x || bhi.x < alo.x || blo.y > ahi.y || bhi.y < alo.y {
                    continue;
                }
                let (lo, hi) = (alo.max(*blo), ahi.min(*bhi));
                // Skins lapping at a joint (see `metrics::SEAM_LAP`) are fine.
                if hi.x - lo.x <= metrics::SEAM_LAP + 0.5 {
                    continue;
                }
                let mut hits = 0;
                let mut y = lo.y + 1.0;
                while y <= hi.y - 1.0 {
                    let mut x = lo.x + 1.0;
                    while x <= hi.x - 1.0 {
                        let p = Vec2::new(x, y);
                        if point_in_polygon(p, ao) && point_in_polygon(p, bo) && dist_to_poly(p, ao) > 1.0 && dist_to_poly(p, bo) > 1.0 {
                            hits += 1;
                        }
                        x += 2.0;
                    }
                    y += 2.0;
                }
                if hits >= 3 {
                    let (pa, pb) = (owner_j(a).unwrap_or(0), owner_j(b).unwrap_or(0));
                    out.push(
                        Finding::error(
                            "seam",
                            format!("overlapping jelly: pieces {} and {} overlap near {} (~{} px²); jelly bodies shove each other, so line them up edge to edge", pa + 1, pb + 1, pt((lo + hi) * 0.5), hits * 4),
                        )
                        .at_piece(pb),
                    );
                }
            }
        }
    }
    out
}
