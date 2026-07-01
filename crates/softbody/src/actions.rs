//! Engine-side action tween state machines (Phase 7 of the JS→Rust migration).
//! Replaces `src/game/actionManager.ts` and the kinematic half of
//! `src/game/platformMover.ts`.
//!
//! An action animates one or more targets (a shape point, a whole shape's
//! particles, a platform surface, or a spike pose) between a closed pose and an
//! open pose, driven by source triggers (modes: continuous / switch / oneShot /
//! timer). All tween/clock state lives in the engine and is snapshotted, so the
//! kinematic writes replay bit-identically after a rollback.

use crate::fx::{Fx, FxVec2};
use crate::math::{cos_fx, sin_fx};
use crate::world::SoftBodyWorld;

const FX_ONE_RAW: i64 = 1i64 << 32;
fn pi() -> Fx { Fx::from_f64(core::f64::consts::PI) }
fn two_pi() -> Fx { Fx::from_f64(core::f64::consts::PI * 2.0) }

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ActionMode { Continuous, Switch, OneShot, Timer }
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Easing { Linear, EaseOut, EaseInOut }
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Direction { Open, Close }
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum RunState { Closed, Opening, Open, Closing }

/// Rest data for a shape whose particles move/rotate rigidly (immutable).
#[derive(Clone, Debug, Default)]
pub struct RigidRest {
    pub centroid: FxVec2,
    pub offsets: Vec<FxVec2>,
    pub anchored: Vec<bool>,
    pub particle_ids: Vec<usize>,
}

#[derive(Clone, Debug)]
pub enum TargetKind {
    ShapePoint { particle: usize },
    MoveShape { rest: RigidRest },
    RotateShape { rest: RigidRest },
    Platform { static_idx: usize, local_poly: Vec<FxVec2> },
    Spike { spike_id: u32 },
}

#[derive(Clone, Debug)]
pub struct Tween {
    pub start: FxVec2,
    pub end: FxVec2,
    pub start_rot: Fx,
    pub end_rot: Fx,
    pub duration: Fx,
    pub elapsed: Fx,
    pub easing: Easing,
}

#[derive(Clone, Debug)]
pub struct ActionTargetRt {
    pub kind: TargetKind,
    // Closed + open poses (immutable, precomputed at register time).
    pub closed: FxVec2,
    pub closed_rot: Fx,
    pub open: FxVec2,
    pub open_rot: Fx,
    // Mutable runtime.
    pub cur: FxVec2,
    pub cur_rot: Fx,
    pub tween: Option<Tween>,
    /// Platform-only: last translation offset, for kinematic velocity diff.
    pub last_offset: FxVec2,
}

#[derive(Clone, Debug)]
pub struct GameAction {
    pub id: u32,
    pub mode: ActionMode,
    pub require_all: bool,
    pub easing: Easing,
    pub delay: Fx,
    pub duration: Fx,
    pub interval: Fx,
    pub source_trigger_ids: Vec<u32>,
    pub targets: Vec<ActionTargetRt>,
    // Mutable runtime.
    pub state: RunState,
    pub prev_activated: bool,
    pub pending_fire_at: Option<Fx>,
    pub pending_direction: Option<Direction>,
    pub consumed: bool,
    pub timer_bootstrapped: bool,
}

impl Default for GameAction {
    fn default() -> Self {
        GameAction {
            id: 0, mode: ActionMode::Continuous, require_all: false, easing: Easing::Linear,
            delay: Fx::ZERO, duration: Fx::ONE, interval: Fx::ONE,
            source_trigger_ids: Vec::new(), targets: Vec::new(),
            state: RunState::Closed, prev_activated: false,
            pending_fire_at: None, pending_direction: None,
            consumed: false, timer_bootstrapped: false,
        }
    }
}

fn ease(t: Fx, kind: Easing) -> Fx {
    match kind {
        Easing::Linear => t,
        Easing::EaseOut => { let om = Fx::ONE - t; Fx::ONE - om * om }
        Easing::EaseInOut => {
            let half = Fx::from_f64(0.5);
            if t < half {
                Fx::from_int(2) * t * t
            } else {
                let a = Fx::from_int(-2) * t + Fx::from_int(2);
                Fx::ONE - (a * a) / Fx::from_int(2)
            }
        }
    }
}

/// Truncated modulo (matches JS `%`).
fn fmod(x: Fx, m: Fx) -> Fx {
    let q = x / m;
    let qt = Fx::from_raw((q.raw() / FX_ONE_RAW) * FX_ONE_RAW);
    x - qt * m
}

impl SoftBodyWorld {
    // ---- registration (called by TS at level load) ----

    pub fn add_game_action(
        &mut self, id: u32, mode: u8, require_all: bool, easing: u8,
        delay: Fx, duration: Fx, interval: Fx, source_trigger_ids: Vec<u32>,
    ) -> u32 {
        let mode = match mode { 1 => ActionMode::Switch, 2 => ActionMode::OneShot, 3 => ActionMode::Timer, _ => ActionMode::Continuous };
        let easing = match easing { 1 => Easing::EaseOut, 2 => Easing::EaseInOut, _ => Easing::Linear };
        self.game_actions.push(GameAction {
            id, mode, require_all, easing,
            delay: delay.max(Fx::ZERO),
            duration: duration.max(Fx::from_f64(0.001)),
            interval: interval.max(Fx::from_f64(0.1)),
            source_trigger_ids, targets: Vec::new(),
            ..Default::default()
        });
        (self.game_actions.len() - 1) as u32
    }

    fn push_target(&mut self, action_idx: usize, kind: TargetKind, closed: FxVec2, closed_rot: Fx, open: FxVec2, open_rot: Fx) {
        if let Some(a) = self.game_actions.get_mut(action_idx) {
            a.targets.push(ActionTargetRt {
                kind, closed, closed_rot, open, open_rot,
                // last_offset seeds at the closed pose so the platform's first
                // finite-difference velocity is 0 (not a huge cur−0 spike).
                cur: closed, cur_rot: closed_rot, tween: None, last_offset: closed,
            });
        }
    }

    pub fn action_add_target_shape_point(&mut self, action_idx: usize, particle: usize, end_x: Fx, end_y: Fx) {
        let closed = self.pos.get(particle).copied().unwrap_or(FxVec2::ZERO);
        self.push_target(action_idx, TargetKind::ShapePoint { particle }, closed, Fx::ZERO, FxVec2::new(end_x, end_y), Fx::ZERO);
    }

    pub fn action_add_target_move_shape(&mut self, action_idx: usize, particle_ids: Vec<usize>, end_x: Fx, end_y: Fx) {
        let rest = self.snapshot_rigid_rest(&particle_ids);
        let closed = rest.centroid;
        self.push_target(action_idx, TargetKind::MoveShape { rest }, closed, Fx::ZERO, FxVec2::new(end_x, end_y), Fx::ZERO);
    }

    pub fn action_add_target_rotate_shape(&mut self, action_idx: usize, particle_ids: Vec<usize>, end_rotation: Fx) {
        let rest = self.snapshot_rigid_rest(&particle_ids);
        self.push_target(action_idx, TargetKind::RotateShape { rest }, FxVec2::ZERO, Fx::ZERO, FxVec2::ZERO, end_rotation);
    }

    pub fn action_add_target_platform(
        &mut self, action_idx: usize, static_idx: usize,
        base_x: Fx, base_y: Fx, base_rot: Fx, local_poly: Vec<FxVec2>,
        end_x: Fx, end_y: Fx, end_rot: Fx,
    ) {
        self.push_target(action_idx, TargetKind::Platform { static_idx, local_poly },
            FxVec2::new(base_x, base_y), base_rot, FxVec2::new(end_x, end_y), end_rot);
    }

    pub fn action_add_target_spike(
        &mut self, action_idx: usize, spike_id: u32,
        base_x: Fx, base_y: Fx, base_rot: Fx, end_x: Fx, end_y: Fx, end_rot: Fx,
    ) {
        self.push_target(action_idx, TargetKind::Spike { spike_id },
            FxVec2::new(base_x, base_y), base_rot, FxVec2::new(end_x, end_y), end_rot);
    }

    fn snapshot_rigid_rest(&self, particle_ids: &[usize]) -> RigidRest {
        if particle_ids.is_empty() { return RigidRest::default(); }
        let mut sx = Fx::ZERO; let mut sy = Fx::ZERO; let mut count = 0i32;
        for &id in particle_ids {
            if let Some(p) = self.pos.get(id) { sx = sx + p.x; sy = sy + p.y; count += 1; }
        }
        if count == 0 { return RigidRest::default(); }
        let inv = Fx::ONE / Fx::from_int(count);
        let centroid = FxVec2::new(sx * inv, sy * inv);
        let mut offsets = Vec::with_capacity(particle_ids.len());
        let mut anchored = Vec::with_capacity(particle_ids.len());
        for &id in particle_ids {
            match self.pos.get(id) {
                Some(p) => { offsets.push(FxVec2::new(p.x - centroid.x, p.y - centroid.y)); anchored.push(self.inv_mass[id].is_zero()); }
                None => { offsets.push(FxVec2::ZERO); anchored.push(true); }
            }
        }
        RigidRest { centroid, offsets, anchored, particle_ids: particle_ids.to_vec() }
    }

    pub fn clear_game_actions(&mut self) { self.game_actions.clear(); self.action_clock = Fx::ZERO; }
    pub fn game_action_count(&self) -> usize { self.game_actions.len() }
    pub fn game_action_state(&self, idx: usize) -> u32 {
        match self.game_actions.get(idx).map(|a| a.state) {
            Some(RunState::Closed) => 0, Some(RunState::Opening) => 1, Some(RunState::Open) => 2, Some(RunState::Closing) => 3, None => 0,
        }
    }
    /// Animated pose of a target: [x, y, rot]. For the renderer to follow.
    pub fn game_action_target_pose(&self, action_idx: usize, target_idx: usize) -> Option<[f64; 3]> {
        let a = self.game_actions.get(action_idx)?;
        let t = a.targets.get(target_idx)?;
        Some([t.cur.x.to_f64(), t.cur.y.to_f64(), t.cur_rot.to_f64()])
    }
    pub fn take_action_fire_events(&mut self) -> Vec<u32> { std::mem::take(&mut self.pending_action_fires) }

    // ---- per-step update ----

    pub fn update_game_actions(&mut self, dt: Fx) {
        self.action_clock = self.action_clock + dt;
        let n = self.game_actions.len();
        for i in 0..n {
            let mut a = std::mem::take(&mut self.game_actions[i]);
            self.tick_action(&mut a, dt);
            self.game_actions[i] = a;
        }
    }

    fn tick_action(&mut self, a: &mut GameAction, dt: Fx) {
        self.tick_sources(a);
        self.tick_pending(a);
        self.tick_tweens(a, dt);
    }

    fn tick_sources(&mut self, a: &mut GameAction) {
        let now_activated = if a.source_trigger_ids.is_empty() {
            false
        } else if a.require_all {
            a.source_trigger_ids.iter().all(|&id| self.game_trigger_pressed_by_id(id))
        } else {
            a.source_trigger_ids.iter().any(|&id| self.game_trigger_pressed_by_id(id))
        };
        let rising = !a.prev_activated && now_activated;
        let falling = a.prev_activated && !now_activated;
        let delay = a.delay;
        match a.mode {
            ActionMode::Continuous => {
                if rising { self.schedule_fire(a, Direction::Open, delay); }
                if falling {
                    if a.pending_direction == Some(Direction::Open) {
                        a.pending_fire_at = None; a.pending_direction = None;
                    } else {
                        self.schedule_fire(a, Direction::Close, Fx::ZERO);
                    }
                }
            }
            ActionMode::Switch => {
                if rising && a.pending_direction.is_none() {
                    let wants_open = a.state == RunState::Closed || a.state == RunState::Closing;
                    self.schedule_fire(a, if wants_open { Direction::Open } else { Direction::Close }, delay);
                }
            }
            ActionMode::OneShot => {
                if rising && !a.consumed { self.schedule_fire(a, Direction::Open, delay); a.consumed = true; }
            }
            ActionMode::Timer => {
                if !a.timer_bootstrapped { self.schedule_fire(a, Direction::Open, delay); a.timer_bootstrapped = true; }
            }
        }
        a.prev_activated = now_activated;
    }

    fn schedule_fire(&self, a: &mut GameAction, direction: Direction, delay: Fx) {
        a.pending_fire_at = Some(self.action_clock + delay);
        a.pending_direction = Some(direction);
    }

    fn tick_pending(&mut self, a: &mut GameAction) {
        let (fire_at, direction) = match (a.pending_fire_at, a.pending_direction) {
            (Some(f), Some(d)) => (f, d),
            _ => return,
        };
        if self.action_clock < fire_at { return; }
        a.pending_fire_at = None;
        a.pending_direction = None;
        a.state = if direction == Direction::Open { RunState::Opening } else { RunState::Closing };
        let duration = a.duration;
        let easing = a.easing;
        let two = two_pi();
        let pi_v = pi();
        for t in a.targets.iter_mut() {
            let (end, raw_end_rot) = if direction == Direction::Open {
                (t.open, t.open_rot)
            } else {
                (t.closed, t.closed_rot)
            };
            // Shortest-arc rotation from cur_rot to raw_end_rot.
            let mut delta = fmod(raw_end_rot - t.cur_rot, two);
            if delta > pi_v { delta = delta - two; }
            else if delta <= (Fx::ZERO - pi_v) { delta = delta + two; }
            let end_rot = t.cur_rot + delta;
            t.tween = Some(Tween {
                start: t.cur, end, start_rot: t.cur_rot, end_rot,
                duration, elapsed: Fx::ZERO, easing,
            });
        }
        self.pending_action_fires.push(a.id);
    }

    fn tick_tweens(&mut self, a: &mut GameAction, dt: Fx) {
        let mut still_tweening = false;
        // Advance tweens (writes cur), collecting apply commands.
        for t in a.targets.iter_mut() {
            if let Some(tw) = t.tween.as_mut() {
                tw.elapsed = tw.elapsed + dt;
                let frac = (tw.elapsed / tw.duration).min(Fx::ONE);
                let k = ease(frac, tw.easing);
                t.cur = FxVec2::new(
                    tw.start.x + (tw.end.x - tw.start.x) * k,
                    tw.start.y + (tw.end.y - tw.start.y) * k,
                );
                t.cur_rot = tw.start_rot + (tw.end_rot - tw.start_rot) * k;
                if frac >= Fx::ONE { t.tween = None; } else { still_tweening = true; }
            }
        }
        // Apply each target to the world (needs &mut self).
        let count = a.targets.len();
        for i in 0..count {
            // Clone the small bits needed (kind data) to release the &a borrow.
            let kind = a.targets[i].kind.clone();
            let cur = a.targets[i].cur;
            let cur_rot = a.targets[i].cur_rot;
            let mut last_offset = a.targets[i].last_offset;
            self.apply_target(&kind, cur, cur_rot, &mut last_offset, dt);
            a.targets[i].last_offset = last_offset;
        }

        if !still_tweening && a.targets.iter().all(|t| t.tween.is_none()) {
            if a.state == RunState::Opening {
                a.state = RunState::Open;
                if a.mode == ActionMode::Timer { self.schedule_fire(a, Direction::Close, Fx::ZERO); }
            } else if a.state == RunState::Closing {
                a.state = RunState::Closed;
                if a.mode == ActionMode::Timer {
                    let cycle_work = Fx::from_int(2) * a.duration;
                    let hold = (a.interval - cycle_work).max(Fx::ZERO);
                    self.schedule_fire(a, Direction::Open, hold);
                }
            }
        }
    }

    fn apply_target(&mut self, kind: &TargetKind, cur: FxVec2, cur_rot: Fx, last_offset: &mut FxVec2, dt: Fx) {
        match kind {
            TargetKind::ShapePoint { particle } => {
                self.set_particle_kinematic(*particle, cur.x, cur.y, dt);
            }
            TargetKind::RotateShape { rest } => {
                let cos = cos_fx(cur_rot);
                let sin = sin_fx(cur_rot);
                for i in 0..rest.particle_ids.len() {
                    if rest.anchored[i] { continue; }
                    let off = rest.offsets[i];
                    let tx = rest.centroid.x + off.x * cos - off.y * sin;
                    let ty = rest.centroid.y + off.x * sin + off.y * cos;
                    self.set_particle_kinematic(rest.particle_ids[i], tx, ty, dt);
                }
            }
            TargetKind::MoveShape { rest } => {
                for i in 0..rest.particle_ids.len() {
                    if rest.anchored[i] { continue; }
                    let off = rest.offsets[i];
                    self.set_particle_kinematic(rest.particle_ids[i], cur.x + off.x, cur.y + off.y, dt);
                }
            }
            TargetKind::Platform { static_idx, local_poly } => {
                self.apply_platform_pose(*static_idx, local_poly, cur, cur_rot, last_offset, dt);
            }
            TargetKind::Spike { spike_id } => {
                self.set_spike_pose(*spike_id, cur.x, cur.y, cur_rot);
            }
        }
    }

    fn set_particle_kinematic(&mut self, pid: usize, x: Fx, y: Fx, dt: Fx) {
        if pid >= self.pos.len() { return; }
        let old = self.pos[pid];
        let safe_dt = dt.max(Fx::from_f64(1e-4));
        let vx = (x - old.x) / safe_dt;
        let vy = (y - old.y) / safe_dt;
        self.pos[pid] = FxVec2::new(x, y);
        self.vel[pid] = FxVec2::new(vx, vy);
    }

    fn apply_platform_pose(&mut self, static_idx: usize, local_poly: &[FxVec2], cur: FxVec2, rot: Fx, last_offset: &mut FxVec2, dt: Fx) {
        if static_idx >= self.static_surfaces.len() { return; }
        let cos = cos_fx(rot);
        let sin = sin_fx(rot);
        let safe_dt = dt.max(Fx::from_f64(1e-4));
        let surface = &mut self.static_surfaces[static_idx];
        surface.prev_poly = Some(surface.poly.clone());
        let np = surface.poly.len().min(local_poly.len());
        for j in 0..np {
            let lx = local_poly[j].x;
            let ly = local_poly[j].y;
            surface.poly[j].x = cur.x + lx * cos - ly * sin;
            surface.poly[j].y = cur.y + lx * sin + ly * cos;
        }
        let vx = (cur.x - last_offset.x) / safe_dt;
        let vy = (cur.y - last_offset.y) / safe_dt;
        surface.velocity = Some(FxVec2::new(vx, vy));
        *last_offset = cur;
    }
}

// ---- snapshot serde (mutable bits only) ----
use crate::snapshot::{SnapWriter, SnapReader};

fn w_opt_fx(w: &mut SnapWriter, v: Option<Fx>) {
    match v { None => w.u8(0), Some(f) => { w.u8(1); w.fx(f); } }
}
fn r_opt_fx(r: &mut SnapReader) -> Result<Option<Fx>, &'static str> {
    match r.u8()? { 0 => Ok(None), 1 => Ok(Some(r.fx()?)), _ => Err("snapshot: bad opt fx") }
}

pub(crate) fn serialize_game_actions(actions: &[GameAction], clock: Fx, w: &mut SnapWriter) {
    w.fx(clock);
    w.u32(actions.len() as u32);
    for a in actions {
        w.u8(match a.state { RunState::Closed => 0, RunState::Opening => 1, RunState::Open => 2, RunState::Closing => 3 });
        w.bool(a.prev_activated);
        w_opt_fx(w, a.pending_fire_at);
        match a.pending_direction { None => w.u8(0), Some(Direction::Open) => w.u8(1), Some(Direction::Close) => w.u8(2) }
        w.bool(a.consumed);
        w.bool(a.timer_bootstrapped);
        w.u32(a.targets.len() as u32);
        for t in &a.targets {
            w.fx(t.cur.x); w.fx(t.cur.y); w.fx(t.cur_rot);
            w.fx(t.last_offset.x); w.fx(t.last_offset.y);
            match &t.tween {
                None => w.u8(0),
                Some(tw) => {
                    w.u8(1);
                    w.fx(tw.start.x); w.fx(tw.start.y);
                    w.fx(tw.end.x); w.fx(tw.end.y);
                    w.fx(tw.start_rot); w.fx(tw.end_rot);
                    w.fx(tw.duration); w.fx(tw.elapsed);
                    w.u8(match tw.easing { Easing::Linear => 0, Easing::EaseOut => 1, Easing::EaseInOut => 2 });
                }
            }
        }
    }
}

pub(crate) fn restore_game_actions(actions: &mut [GameAction], r: &mut SnapReader) -> Result<Fx, &'static str> {
    let clock = r.fx()?;
    let n = r.u32()? as usize;
    if n != actions.len() { return Err("snapshot: game_action count mismatch"); }
    for a in actions.iter_mut() {
        a.state = match r.u8()? { 0 => RunState::Closed, 1 => RunState::Opening, 2 => RunState::Open, 3 => RunState::Closing, _ => return Err("snapshot: bad action state") };
        a.prev_activated = r.bool()?;
        a.pending_fire_at = r_opt_fx(r)?;
        a.pending_direction = match r.u8()? { 0 => None, 1 => Some(Direction::Open), 2 => Some(Direction::Close), _ => return Err("snapshot: bad action dir") };
        a.consumed = r.bool()?;
        a.timer_bootstrapped = r.bool()?;
        let tn = r.u32()? as usize;
        if tn != a.targets.len() { return Err("snapshot: action target count mismatch"); }
        for t in a.targets.iter_mut() {
            let cx = r.fx()?; let cy = r.fx()?; t.cur = FxVec2::new(cx, cy); t.cur_rot = r.fx()?;
            let lx = r.fx()?; let ly = r.fx()?; t.last_offset = FxVec2::new(lx, ly);
            t.tween = match r.u8()? {
                0 => None,
                1 => {
                    let sx = r.fx()?; let sy = r.fx()?; let ex = r.fx()?; let ey = r.fx()?;
                    let sr = r.fx()?; let er = r.fx()?; let du = r.fx()?; let el = r.fx()?;
                    let ez = match r.u8()? { 0 => Easing::Linear, 1 => Easing::EaseOut, 2 => Easing::EaseInOut, _ => return Err("snapshot: bad easing") };
                    Some(Tween { start: FxVec2::new(sx, sy), end: FxVec2::new(ex, ey), start_rot: sr, end_rot: er, duration: du, elapsed: el, easing: ez })
                }
                _ => return Err("snapshot: bad tween tag"),
            };
        }
    }
    Ok(clock)
}
