//! Party modes: Race, King of the Hill, Chained Together.
//!
//! Rules match the 2.x game (see docs/BevyPort.md parity notes): a countdown
//! with frozen input, a timed round, then results. Chained Together now ties
//! players with real ropes instead of spring tethers.

use bb_physics::{Anchor, RopeDesc, RopeId, Vec2, geom};

use crate::Sim;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ModeKind {
    Race,
    Koth,
    Chained,
}

impl ModeKind {
    pub fn name(self) -> &'static str {
        match self {
            ModeKind::Race => "Race",
            ModeKind::Koth => "King of the Hill",
            ModeKind::Chained => "Chained Together",
        }
    }

    pub fn time_limit(self) -> f32 {
        match self {
            ModeKind::Race => 120.0,
            ModeKind::Koth => 90.0,
            ModeKind::Chained => 180.0,
        }
    }

    /// Best mode for a level: hills → KOTH, goal → Race.
    pub fn for_level(level: &bb_level::Level) -> ModeKind {
        if !level.hills.is_empty() && level.goal.is_none() { ModeKind::Koth } else { ModeKind::Race }
    }
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum MatchPhase {
    Countdown(f32),
    Playing,
    Results(f32),
    Over,
}

pub const KOTH_TARGET: f32 = 50.0;
const SOLE_RATE: f32 = 2.0;
const CONTESTED_RATE: f32 = 1.0;
const COUNTDOWN: f32 = 3.0;
const RESULTS: f32 = 5.0;
pub const CHAIN_LENGTH: f32 = 320.0;

#[derive(Clone, Debug)]
pub struct Match {
    pub kind: ModeKind,
    pub phase: MatchPhase,
    pub time: f32,
    pub time_limit: f32,
    /// (slot, score) sorted by slot.
    pub scores: Vec<(u8, f32)>,
    pub winner: Option<u8>,
    /// Chained: did the team make it?
    pub team_won: Option<bool>,
    pub hill: usize,
    pub next_hill_move: f32,
    pub last_hill_move: f32,
    pub king: Option<u8>,
    chains: Vec<RopeId>,
    rng: u32,
}

impl Match {
    pub fn new(kind: ModeKind) -> Match {
        Match {
            kind,
            phase: MatchPhase::Countdown(COUNTDOWN),
            time: 0.0,
            time_limit: kind.time_limit(),
            scores: Vec::new(),
            winner: None,
            team_won: None,
            hill: 0,
            next_hill_move: 0.0,
            last_hill_move: -999.0,
            king: None,
            chains: Vec::new(),
            rng: 0x1234_5678,
        }
    }

    pub fn time_remaining(&self) -> f32 {
        (self.time_limit - self.time).max(0.0)
    }

    pub fn active_hill<'a>(&self, sim: &'a Sim) -> Option<&'a bb_level::Shape> {
        sim.level.hills.get(self.hill)
    }

    /// Spread players over the spawn and (for chained) tie them together.
    pub fn start(&mut self, sim: &mut Sim) {
        let base = sim.level.spawn;
        let bodies: Vec<_> = sim.players.iter().map(|p| p.ctl.body).collect();
        for (k, body) in bodies.iter().enumerate() {
            let off = (k as f32 - (bodies.len() as f32 - 1.0) * 0.5) * 78.0;
            sim.world.respawn(*body, base + Vec2::new(off, 30.0));
        }
        for p in sim.players.iter_mut() {
            p.ctl.reset();
            p.finished = false;
            p.dead = None;
        }
        self.scores = sim.players.iter().map(|p| (p.slot, 0.0)).collect();
        self.scores.sort_by_key(|s| s.0);
        if self.kind == ModeKind::Chained {
            for w in bodies.windows(2) {
                let (Some(a), Some(b)) = (Anchor::centre(&sim.world, w[0]), Anchor::centre(&sim.world, w[1])) else { continue };
                let mut d = RopeDesc::new(a, b).length(CHAIN_LENGTH);
                d.spacing = 16.0;
                d.mass = 0.3;
                let id = sim.world.add_rope(d);
                if let Some(r) = sim.world.rope(id).map(|r| r.body) {
                    if let Some(rb) = sim.world.body_mut(r) {
                        rb.layer = crate::load::layer::ROPE;
                        rb.mask = crate::load::layer::WORLD | crate::load::layer::PROP;
                    }
                    sim.tags.insert(r, crate::BodyTag::Rope);
                }
                self.chains.push(id);
            }
        }
        sim.input_frozen = true;
        self.phase = MatchPhase::Countdown(COUNTDOWN);
    }

    /// Remove chains etc. when the match ends.
    pub fn cleanup(&mut self, sim: &mut Sim) {
        for c in self.chains.drain(..) {
            if let Some(body) = sim.world.rope(c).map(|r| r.body) {
                sim.tags.remove(&body);
            }
            sim.world.remove_rope(c);
        }
        sim.input_frozen = false;
    }

    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Advance the match by one fixed step (call after `Sim::step`).
    pub fn update(&mut self, sim: &mut Sim, dt: f32) {
        match self.phase {
            MatchPhase::Countdown(t) => {
                let t = t - dt;
                if t <= 0.0 {
                    self.phase = MatchPhase::Playing;
                    sim.input_frozen = false;
                } else {
                    self.phase = MatchPhase::Countdown(t);
                }
            }
            MatchPhase::Playing => self.play(sim, dt),
            MatchPhase::Results(t) => {
                let t = t - dt;
                self.phase = if t <= 0.0 { MatchPhase::Over } else { MatchPhase::Results(t) };
            }
            MatchPhase::Over => {}
        }
    }

    fn finish(&mut self, sim: &mut Sim, winner: Option<u8>) {
        self.winner = winner;
        self.phase = MatchPhase::Results(RESULTS);
        sim.input_frozen = true;
    }

    fn play(&mut self, sim: &mut Sim, dt: f32) {
        self.time += dt;
        let timed_out = self.time >= self.time_limit;
        let mut players: Vec<(u8, Vec2)> = sim
            .players
            .iter()
            .filter(|p| p.dead.is_none())
            .filter_map(|p| sim.world.body(p.ctl.body).map(|b| (p.slot, b.centroid())))
            .collect();
        players.sort_by_key(|p| p.0);
        match self.kind {
            ModeKind::Race => {
                let goal = sim.level.goal.as_ref().map(|g| g.outline());
                if let Some(g) = goal {
                    if let Some((slot, _)) = players.iter().find(|(_, c)| geom::point_in_polygon(*c, &g)) {
                        let s = *slot;
                        self.finish(sim, Some(s));
                        return;
                    }
                }
                if timed_out {
                    let best = players.iter().max_by(|a, b| a.1.x.total_cmp(&b.1.x).then(b.0.cmp(&a.0))).map(|p| p.0);
                    self.finish(sim, best);
                }
            }
            ModeKind::Koth => {
                let n = sim.level.hills.len();
                if n >= 2 {
                    if self.next_hill_move <= 0.0 {
                        self.next_hill_move = self.time + 8.0 + self.rand() * 5.0;
                    } else if self.time >= self.next_hill_move {
                        let mut k = (self.rand() * (n - 1) as f32) as usize;
                        if k >= self.hill {
                            k += 1;
                        }
                        self.hill = k.min(n - 1);
                        self.last_hill_move = self.time;
                        self.next_hill_move = self.time + 8.0 + self.rand() * 5.0;
                    }
                }
                self.king = None;
                if let Some(hill) = sim.level.hills.get(self.hill).map(|h| h.outline()) {
                    let on: Vec<u8> = players.iter().filter(|(_, c)| geom::point_in_polygon(*c, &hill)).map(|p| p.0).collect();
                    let rate = if on.len() == 1 { SOLE_RATE } else { CONTESTED_RATE };
                    if on.len() == 1 {
                        self.king = Some(on[0]);
                    }
                    for s in on {
                        if let Some(e) = self.scores.iter_mut().find(|e| e.0 == s) {
                            e.1 += rate * dt;
                        }
                    }
                }
                if let Some(&(s, _)) = self.scores.iter().find(|e| e.1 >= KOTH_TARGET) {
                    self.finish(sim, Some(s));
                } else if timed_out {
                    let best = self
                        .scores
                        .iter()
                        .filter(|e| e.1 > 0.0)
                        .max_by(|a, b| a.1.total_cmp(&b.1).then(b.0.cmp(&a.0)))
                        .map(|e| e.0);
                    self.finish(sim, best);
                }
            }
            ModeKind::Chained => {
                let goal = sim.level.goal.as_ref().map(|g| g.outline());
                let all_in = goal.is_some_and(|g| {
                    !sim.players.is_empty()
                        && sim.players.iter().all(|p| sim.world.body(p.ctl.body).is_some_and(|b| geom::point_in_polygon(b.centroid(), &g)))
                });
                if all_in {
                    self.team_won = Some(true);
                    let first = players.first().map(|p| p.0);
                    self.finish(sim, first);
                } else if timed_out {
                    self.team_won = Some(false);
                    self.finish(sim, None);
                }
            }
        }
    }
}
