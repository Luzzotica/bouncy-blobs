//! Engine-side in-match game-mode rules (Phase 9 of the JS→Rust migration).
//! Replaces the deterministic rules of classicMode.ts (Race), kingOfTheHillMode.ts
//! (KOTH) and chainedMode.ts (Chained). TS keeps the lobby→countdown→playing→
//! results phase machine + HUD; it flips `mode_active` and reads winner/score/
//! timer/active-hill from here.

use crate::fx::{Fx, FxVec2};
use crate::types::BlobId;
use crate::world::SoftBodyWorld;

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ModeKind { Race, Koth, Chained }

#[derive(Copy, Clone, Debug)]
pub struct Zone { pub center: FxVec2, pub half: FxVec2 }
impl Zone {
    fn contains(&self, p: FxVec2) -> bool {
        p.x >= self.center.x - self.half.x && p.x <= self.center.x + self.half.x
            && p.y >= self.center.y - self.half.y && p.y <= self.center.y + self.half.y
    }
}

const SOLE_RATE: i32 = 2;
const CONTESTED_RATE: i32 = 1;

#[derive(Clone, Debug)]
pub struct GameModeRules {
    pub kind: ModeKind,
    pub time_limit: Fx,        // 0 = no limit
    pub target_score: Fx,      // KOTH
    pub goal_zone: Option<Zone>,   // Race / Chained
    pub hill_zones: Vec<Zone>,     // KOTH
    pub hill_rot_min: Fx,
    pub hill_rot_max: Fx,
    // ---- mutable runtime ----
    pub game_time: Fx,
    pub finished_gameplay_id: Option<u32>,  // Race
    pub scores: Vec<(u32, Fx)>,             // KOTH (sorted by gameplay_id)
    pub current_hill_index: usize,
    pub next_move_time: Option<Fx>,
    pub last_move_time: Fx,
    pub king_gameplay_id: Option<u32>,
    pub all_reached_goal: bool,             // Chained
    pub winner_gameplay_id: Option<u32>,
    pub decided: bool,
    pub mode_active: bool,
}

impl SoftBodyWorld {
    // ---- registration ----
    pub fn set_game_mode(&mut self, kind: u8, time_limit: Fx, target_score: Fx) {
        let kind = match kind { 1 => ModeKind::Koth, 2 => ModeKind::Chained, _ => ModeKind::Race };
        self.game_mode = Some(GameModeRules {
            kind, time_limit, target_score,
            goal_zone: None, hill_zones: Vec::new(),
            hill_rot_min: Fx::from_int(8), hill_rot_max: Fx::from_int(13),
            game_time: Fx::ZERO, finished_gameplay_id: None, scores: Vec::new(),
            current_hill_index: 0, next_move_time: None, last_move_time: Fx::from_int(-999),
            king_gameplay_id: None, all_reached_goal: false,
            winner_gameplay_id: None, decided: false, mode_active: false,
        });
    }
    pub fn set_goal_zone(&mut self, x: Fx, y: Fx, w: Fx, h: Fx) {
        if let Some(gm) = self.game_mode.as_mut() {
            gm.goal_zone = Some(Zone { center: FxVec2::new(x, y), half: FxVec2::new(w / Fx::from_int(2), h / Fx::from_int(2)) });
        }
    }
    pub fn add_hill_zone(&mut self, x: Fx, y: Fx, w: Fx, h: Fx) {
        if let Some(gm) = self.game_mode.as_mut() {
            gm.hill_zones.push(Zone { center: FxVec2::new(x, y), half: FxVec2::new(w / Fx::from_int(2), h / Fx::from_int(2)) });
        }
    }
    pub fn set_hill_rotation(&mut self, min: Fx, max: Fx) {
        if let Some(gm) = self.game_mode.as_mut() { gm.hill_rot_min = min; gm.hill_rot_max = max; }
    }
    pub fn set_mode_playing(&mut self, playing: bool) {
        if let Some(gm) = self.game_mode.as_mut() { gm.mode_active = playing; }
    }
    pub fn reset_mode_for_round(&mut self) {
        if let Some(gm) = self.game_mode.as_mut() {
            gm.game_time = Fx::ZERO;
            gm.finished_gameplay_id = None;
            gm.scores.clear();
            gm.current_hill_index = 0;
            gm.next_move_time = None;
            gm.last_move_time = Fx::from_int(-999);
            gm.king_gameplay_id = None;
            gm.all_reached_goal = false;
            gm.winner_gameplay_id = None;
            gm.decided = false;
        }
    }

    // ---- getters ----
    pub fn mode_winner(&self) -> i64 { self.game_mode.as_ref().and_then(|g| g.winner_gameplay_id).map(|g| g as i64).unwrap_or(-1) }
    pub fn mode_decided(&self) -> bool { self.game_mode.as_ref().map(|g| g.decided).unwrap_or(false) }
    pub fn mode_game_time(&self) -> f64 { self.game_mode.as_ref().map(|g| g.game_time.to_f64()).unwrap_or(0.0) }
    pub fn mode_time_remaining(&self) -> f64 {
        match self.game_mode.as_ref() {
            Some(g) if g.time_limit > Fx::ZERO => (g.time_limit - g.game_time).max(Fx::ZERO).to_f64(),
            _ => 0.0,
        }
    }
    pub fn mode_score(&self, gameplay_id: u32) -> f64 {
        self.game_mode.as_ref().and_then(|g| g.scores.binary_search_by_key(&gameplay_id, |&(k, _)| k).ok().map(|i| g.scores[i].1.to_f64())).unwrap_or(0.0)
    }
    pub fn mode_scores(&self) -> Vec<f64> {
        let mut out = Vec::new();
        if let Some(g) = self.game_mode.as_ref() {
            for &(gid, s) in &g.scores { out.push(gid as f64); out.push(s.to_f64()); }
        }
        out
    }
    pub fn koth_active_hill(&self) -> Option<[f64; 4]> {
        let g = self.game_mode.as_ref()?;
        let z = g.hill_zones.get(g.current_hill_index)?;
        Some([z.center.x.to_f64(), z.center.y.to_f64(), (z.half.x * Fx::from_int(2)).to_f64(), (z.half.y * Fx::from_int(2)).to_f64()])
    }
    pub fn koth_last_move_time(&self) -> f64 { self.game_mode.as_ref().map(|g| g.last_move_time.to_f64()).unwrap_or(-999.0) }
    pub fn koth_king_id(&self) -> i64 { self.game_mode.as_ref().and_then(|g| g.king_gameplay_id).map(|g| g as i64).unwrap_or(-1) }
    pub fn chained_all_reached(&self) -> bool { self.game_mode.as_ref().map(|g| g.all_reached_goal).unwrap_or(false) }

    // ---- per-step update ----
    pub fn update_game_mode(&mut self, dt: Fx) {
        let mut gm = match self.game_mode.take() { Some(g) => g, None => return };
        if !gm.mode_active { self.game_mode = Some(gm); return; }

        // Collect active player (gameplay_id, centroid), sorted by gameplay_id.
        let mut players: Vec<(u32, FxVec2)> = (0..self.blob_ranges.len()).filter_map(|bi| {
            let r = &self.blob_ranges[bi];
            if r.inactive || r.role != 1 { None } else { Some((r.gameplay_id, self.blob_centroid(bi as BlobId))) }
        }).collect();
        players.sort_by_key(|&(g, _)| g);

        gm.game_time = gm.game_time + dt;
        let timed_out = gm.time_limit > Fx::ZERO && gm.game_time >= gm.time_limit;

        match gm.kind {
            ModeKind::Race => {
                if gm.finished_gameplay_id.is_none() {
                    if let Some(goal) = gm.goal_zone {
                        for &(gid, c) in &players { if goal.contains(c) { gm.finished_gameplay_id = Some(gid); break; } }
                    }
                }
                if let Some(gid) = gm.finished_gameplay_id {
                    gm.winner_gameplay_id = Some(gid); gm.decided = true;
                } else if timed_out {
                    // furthest-right player wins.
                    let mut best: Option<(u32, Fx)> = None;
                    for &(gid, c) in &players {
                        if best.map_or(true, |(_, bx)| c.x > bx) { best = Some((gid, c.x)); }
                    }
                    gm.winner_gameplay_id = best.map(|(g, _)| g);
                    gm.decided = true;
                }
            }
            ModeKind::Koth => {
                self.maybe_rotate_hill(&mut gm);
                gm.king_gameplay_id = None;
                if let Some(hill) = gm.hill_zones.get(gm.current_hill_index).copied() {
                    let on_hill: Vec<u32> = players.iter().filter(|&&(_, c)| hill.contains(c)).map(|&(g, _)| g).collect();
                    let rate = if on_hill.len() == 1 { SOLE_RATE } else { CONTESTED_RATE };
                    for &gid in &on_hill { add_score(&mut gm.scores, gid, Fx::from_int(rate) * dt); }
                    if on_hill.len() == 1 { gm.king_gameplay_id = Some(on_hill[0]); }
                }
                if !gm.decided {
                    // target score
                    for &(gid, s) in &gm.scores { if s >= gm.target_score { gm.winner_gameplay_id = Some(gid); gm.decided = true; break; } }
                    if !gm.decided && timed_out {
                        let mut best: Option<(u32, Fx)> = None;
                        for &(gid, s) in &gm.scores {
                            if best.map_or(true, |(_, bs)| s > bs) { best = Some((gid, s)); }
                        }
                        gm.winner_gameplay_id = best.map(|(g, _)| g);
                        gm.decided = true;
                    }
                }
            }
            ModeKind::Chained => {
                if let Some(goal) = gm.goal_zone {
                    if !players.is_empty() {
                        gm.all_reached_goal = players.iter().all(|&(_, c)| goal.contains(c));
                    } else {
                        gm.all_reached_goal = false;
                    }
                }
                if gm.all_reached_goal {
                    // Team win — representative is the lowest gameplay_id.
                    gm.winner_gameplay_id = players.first().map(|&(g, _)| g);
                    gm.decided = true;
                }
            }
        }

        self.game_mode = Some(gm);
    }

    fn maybe_rotate_hill(&mut self, gm: &mut GameModeRules) {
        let n = gm.hill_zones.len();
        if n < 2 { return; }
        let lo = gm.hill_rot_min.max(Fx::from_f64(0.5));
        let hi = gm.hill_rot_max.max(lo);
        if gm.next_move_time.is_none() {
            let r = self.rng_range(lo, hi);
            gm.next_move_time = Some(gm.game_time + r);
            return;
        }
        if gm.game_time < gm.next_move_time.unwrap() { return; }
        // Pick a uniform index among the OTHER zones.
        let mut next = self.rng_int(0, n as i32 - 1) as usize; // 0 .. n-2
        if next >= gm.current_hill_index { next += 1; }
        gm.current_hill_index = next;
        gm.last_move_time = gm.game_time;
        let r = self.rng_range(lo, hi);
        gm.next_move_time = Some(gm.game_time + r);
    }

    fn rng_range(&mut self, lo: Fx, hi: Fx) -> Fx {
        let r = self.rng_next_unit();
        lo + r * (hi - lo)
    }
    /// Inclusive-min, exclusive-max integer: `min + floor(r*(max-min))`.
    fn rng_int(&mut self, min: i32, max: i32) -> i32 {
        let r = self.rng_next_unit();
        let span = max - min;
        if span <= 0 { return min; }
        let v = (r * Fx::from_int(span)).raw() >> 32;
        min + v as i32
    }
}

fn add_score(scores: &mut Vec<(u32, Fx)>, gid: u32, delta: Fx) {
    match scores.binary_search_by_key(&gid, |&(k, _)| k) {
        Ok(i) => scores[i].1 = scores[i].1 + delta,
        Err(i) => scores.insert(i, (gid, delta)),
    }
}

// ---- snapshot serde (mutable bits only) ----
use crate::snapshot::{SnapWriter, SnapReader};

pub(crate) fn serialize_game_mode(gm: &Option<GameModeRules>, w: &mut SnapWriter) {
    match gm {
        None => w.u8(0),
        Some(g) => {
            w.u8(1);
            w.fx(g.game_time);
            match g.finished_gameplay_id { None => w.u8(0), Some(v) => { w.u8(1); w.u32(v); } }
            w.u32(g.scores.len() as u32);
            for &(gid, s) in &g.scores { w.u32(gid); w.fx(s); }
            w.u32(g.current_hill_index as u32);
            match g.next_move_time { None => w.u8(0), Some(v) => { w.u8(1); w.fx(v); } }
            w.fx(g.last_move_time);
            match g.king_gameplay_id { None => w.u8(0), Some(v) => { w.u8(1); w.u32(v); } }
            w.bool(g.all_reached_goal);
            match g.winner_gameplay_id { None => w.u8(0), Some(v) => { w.u8(1); w.u32(v); } }
            w.bool(g.decided);
            w.bool(g.mode_active);
        }
    }
}

pub(crate) fn restore_game_mode(gm: &mut Option<GameModeRules>, r: &mut SnapReader) -> Result<(), &'static str> {
    let tag = r.u8()?;
    match (tag, gm.as_mut()) {
        (0, _) => Ok(()),
        (1, Some(g)) => {
            g.game_time = r.fx()?;
            g.finished_gameplay_id = match r.u8()? { 0 => None, 1 => Some(r.u32()?), _ => return Err("snapshot: bad opt") };
            let ns = r.u32()? as usize;
            g.scores.clear();
            for _ in 0..ns { let gid = r.u32()?; let s = r.fx()?; g.scores.push((gid, s)); }
            g.current_hill_index = r.u32()? as usize;
            g.next_move_time = match r.u8()? { 0 => None, 1 => Some(r.fx()?), _ => return Err("snapshot: bad opt") };
            g.last_move_time = r.fx()?;
            g.king_gameplay_id = match r.u8()? { 0 => None, 1 => Some(r.u32()?), _ => return Err("snapshot: bad opt") };
            g.all_reached_goal = r.bool()?;
            g.winner_gameplay_id = match r.u8()? { 0 => None, 1 => Some(r.u32()?), _ => return Err("snapshot: bad opt") };
            g.decided = r.bool()?;
            g.mode_active = r.bool()?;
            Ok(())
        }
        (1, None) => Err("snapshot: game_mode present in snapshot but not in world"),
        _ => Err("snapshot: bad game_mode tag"),
    }
}
