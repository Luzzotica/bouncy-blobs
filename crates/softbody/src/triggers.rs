//! Engine-side trigger charge/pressed state machine (Phase 6 of the JS→Rust
//! manager migration). Replaces the charge logic of `src/game/triggerManager.ts`.
//!
//! A trigger is an area sensor (a registered trigger polygon). It flips
//! `pressed` once a player/NPC blob has occupied it continuously for
//! `charge_seconds` (immediately if `charge_seconds <= 0`), and unpresses the
//! instant occupancy drops to zero. Actions (Phase 7) poll the pressed state.
//!
//! Occupancy is RECOMPUTED from blob positions each step (positions are
//! snapshotted) rather than tracked via enter/exit event ordering, so it's
//! deterministic across clients without storing occupant sets — only
//! `pressed` / `charge_elapsed` / `flash_timer` are mutable state.

use crate::fx::{Fx, FxVec2};
use crate::types::ShapeIdx;
use crate::collision::{is_point_in_polygon, polygon_aabb};
use crate::world::SoftBodyWorld;

#[derive(Clone, Debug)]
pub struct GameTrigger {
    /// Numeric trigger id (TS maps its string id → u32 at load).
    pub id: u32,
    /// Index into `world.shapes` of the registered trigger polygon (immutable).
    pub shape_idx: ShapeIdx,
    /// Seconds of continuous occupancy required to press (<=0 → immediate).
    pub charge_seconds: Fx,
    /// If true, NPC blobs (role 2) cannot press this trigger.
    pub ignore_npcs: bool,
    // ---- mutable runtime ----
    pub pressed: bool,
    pub charge_elapsed: Fx,
    pub flash_timer: Fx,
}

fn flash_press() -> Fx { Fx::from_f64(0.4) }
fn flash_release() -> Fx { Fx::from_f64(0.2) }

impl SoftBodyWorld {
    /// Register a trigger charge machine over an already-registered trigger
    /// polygon (`shape_idx` from `register_trigger_polygon`). Returns its index.
    pub fn add_game_trigger(&mut self, id: u32, shape_idx: ShapeIdx, charge_seconds: Fx, ignore_npcs: bool) -> u32 {
        self.game_triggers.push(GameTrigger {
            id, shape_idx, charge_seconds, ignore_npcs,
            pressed: false, charge_elapsed: Fx::ZERO, flash_timer: Fx::ZERO,
        });
        (self.game_triggers.len() - 1) as u32
    }

    pub fn clear_game_triggers(&mut self) { self.game_triggers.clear(); }
    pub fn game_trigger_count(&self) -> usize { self.game_triggers.len() }

    pub fn game_trigger_pressed(&self, idx: usize) -> bool {
        self.game_triggers.get(idx).map(|t| t.pressed).unwrap_or(false)
    }

    /// Charge progress in [0,1] for the renderer's fill meter.
    pub fn game_trigger_charge_progress(&self, idx: usize) -> f64 {
        match self.game_triggers.get(idx) {
            None => 0.0,
            Some(t) => {
                if t.charge_seconds <= Fx::ZERO {
                    if t.pressed { 1.0 } else { 0.0 }
                } else {
                    (t.charge_elapsed / t.charge_seconds).to_f64().min(1.0)
                }
            }
        }
    }

    /// Pressed-state by gameplay id (polled by Phase 7 actions).
    pub fn game_trigger_pressed_by_id(&self, id: u32) -> bool {
        self.game_triggers.iter().find(|t| t.id == id).map(|t| t.pressed).unwrap_or(false)
    }

    pub fn take_trigger_pressed_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pending_trigger_pressed)
    }
    pub fn take_trigger_released_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pending_trigger_released)
    }

    /// Is any player/(non-ignored-)npc blob inside this trigger's polygon?
    /// Mirrors `process_trigger_events`' inside test (hull points, then center).
    fn trigger_is_occupied(&self, shape_idx: ShapeIdx, ignore_npcs: bool) -> bool {
        let sh = match self.shapes.get(shape_idx as usize) { Some(s) => s, None => return false };
        if sh.static_poly.is_empty() { return false; }
        let bbox = polygon_aabb(&sh.static_poly);
        for r in &self.blob_ranges {
            if r.inactive { continue; }
            // Role filter: players always; npcs unless ignored; structural never.
            let allowed = r.role == 1 || (r.role == 2 && !ignore_npcs);
            if !allowed { continue; }
            let mut inside = false;
            // (1) Any blob hull point (or its centre) inside the trigger area.
            for &idx in &r.hull {
                let p = self.pos[idx as usize];
                if p.x < bbox.min_x || p.x > bbox.max_x || p.y < bbox.min_y || p.y > bbox.max_y { continue; }
                if is_point_in_polygon(p, &sh.static_poly) { inside = true; break; }
            }
            if !inside {
                let c = self.pos[r.start as usize];
                if c.x >= bbox.min_x && c.x <= bbox.max_x && c.y >= bbox.min_y && c.y <= bbox.max_y
                    && is_point_in_polygon(c, &sh.static_poly) { inside = true; }
            }
            // (2) Or any TRIGGER vertex inside the blob's hull — so a trigger
            // small enough to sit entirely inside a blob (no blob point lands
            // in it) still fires. Treat the trigger corners as sim points.
            if !inside {
                let blob_poly: Vec<FxVec2> = r.hull.iter().map(|&i| self.pos[i as usize]).collect();
                if blob_poly.len() >= 3 {
                    for &v in &sh.static_poly {
                        if is_point_in_polygon(v, &blob_poly) { inside = true; break; }
                    }
                }
            }
            if inside { return true; }
        }
        false
    }

    /// Per-step update (called from `step()` before substeps). Recompute
    /// occupancy + advance the charge machine for every game trigger.
    pub fn update_game_triggers(&mut self, dt: Fx) {
        let n = self.game_triggers.len();
        let mut pressed_events: Vec<u32> = Vec::new();
        let mut released_events: Vec<u32> = Vec::new();
        for i in 0..n {
            let (id, shape_idx, charge, ignore_npcs, mut pressed, mut charge_elapsed, mut flash) = {
                let t = &self.game_triggers[i];
                (t.id, t.shape_idx, t.charge_seconds, t.ignore_npcs, t.pressed, t.charge_elapsed, t.flash_timer)
            };
            let occupied = self.trigger_is_occupied(shape_idx, ignore_npcs);
            if flash > Fx::ZERO { flash = (flash - dt).max(Fx::ZERO); }
            if occupied {
                if charge <= Fx::ZERO {
                    if !pressed { pressed = true; flash = flash_press(); pressed_events.push(id); }
                } else if !pressed {
                    charge_elapsed = charge.min(charge_elapsed + dt);
                    if charge_elapsed >= charge { pressed = true; flash = flash_press(); pressed_events.push(id); }
                }
            } else {
                charge_elapsed = Fx::ZERO;
                if pressed { pressed = false; flash = flash_release(); released_events.push(id); }
            }
            let t = &mut self.game_triggers[i];
            t.pressed = pressed;
            t.charge_elapsed = charge_elapsed;
            t.flash_timer = flash;
        }
        self.pending_trigger_pressed.extend(pressed_events);
        self.pending_trigger_released.extend(released_events);
    }
}

// ---- snapshot serde (mutable bits only) ----
use crate::snapshot::{SnapWriter, SnapReader};

pub(crate) fn serialize_game_triggers(triggers: &[GameTrigger], w: &mut SnapWriter) {
    w.u32(triggers.len() as u32);
    for t in triggers {
        w.bool(t.pressed);
        w.fx(t.charge_elapsed);
        w.fx(t.flash_timer);
    }
}

pub(crate) fn restore_game_triggers(triggers: &mut [GameTrigger], r: &mut SnapReader) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    if n != triggers.len() { return Err("snapshot: game_trigger count mismatch"); }
    for t in triggers.iter_mut() {
        t.pressed = r.bool()?;
        t.charge_elapsed = r.fx()?;
        t.flash_timer = r.fx()?;
    }
    Ok(())
}
