//! Engine-side spring-pad state machines (Phase 5 of the JS→Rust
//! manager migration). Replaces `src/game/springPadManager.ts`.
//!
//! Each spring pad is a kinematic static surface (the plate) plus a
//! state machine (loaded → firing → reloading → loaded). When a blob
//! hull particle enters the front-face detection band, the pad
//! transitions to `firing`: the plate extends outward along
//! `launch_dir` at `fire_speed` while reporting that velocity to the
//! engine's surface (so collisions impart the impulse correctly).
//! Once fully extended, it transitions to `reloading` and slowly
//! retracts; once retracted, back to `loaded`.
//!
//! All state lives in the engine and is snapshotted, so cross-tab
//! sims agree bit-for-bit on every state transition and plate pose.
//! JS-side springPadManager.ts becomes a thin loader (`add_spring_pad`)
//! + event drainer (`take_spring_pad_fire_events` → VFX/SFX).

use crate::fx::{Fx, FxVec2};
use crate::types::SurfaceMaterial;

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum SpringPadState {
    Loaded,
    Firing,
    Reloading,
}

#[derive(Clone, Debug)]
pub struct SpringPad {
    /// Caller-provided gameplay id. Echoed back in fire events.
    pub id: u32,
    /// Index in `world.static_surfaces` for the kinematic plate.
    pub surface_idx: usize,
    /// Plate-local launch direction (unit vector). Precomputed at add
    /// time from def.rotation.
    pub launch_dir: FxVec2,
    /// Perpendicular to launch_dir (90° CCW). Used for the front-face
    /// detection's perpendicular tolerance check.
    pub perp_dir: FxVec2,
    /// Plate's polygon in WORLD space at offset = 0 (fully extended).
    /// Never mutates after add — the live poly is `base_poly - launch_dir * offset`.
    pub base_poly: Vec<FxVec2>,
    /// Plate width along launch_dir (= def.width).
    pub width: Fx,
    /// Plate half-width perpendicular to launch_dir (= def.height * PLATE_WIDTH_SCALE / 2).
    pub half_height_perp: Fx,
    /// Plate center in world space (= def.x, def.y).
    pub center: FxVec2,
    pub state: SpringPadState,
    /// Retraction along -launch_dir. 0 = fully extended; max_compress = fully cocked.
    pub offset: Fx,
    pub max_compress: Fx,
    pub reload_speed: Fx, // units per second
    pub fire_speed: Fx,
    /// Seconds remaining before the pad can fire again after a transition
    /// from firing → reloading. Counts down each tick.
    pub cooldown: Fx,
}

// Constants — mirror springPadManager.ts.
const PLATE_THICKNESS_RAW: i64 = 72;
const PLATE_WIDTH_SCALE_RAW: i64 = 8;
fn max_compress_frac() -> Fx { Fx::from_f64(0.7) }
fn reload_time() -> Fx { Fx::from_f64(0.45) }
fn cooldown_time() -> Fx { Fx::from_f64(0.05) }
fn trigger_forward() -> Fx { Fx::from_int(22) }
fn trigger_backward() -> Fx { Fx::from_int(4) }
fn trigger_side_pad() -> Fx { Fx::from_int(4) }
fn default_fire_speed() -> Fx { Fx::from_int(1100) }
fn min_fire_speed() -> Fx { Fx::from_int(500) }
fn max_fire_speed() -> Fx { Fx::from_int(2500) }

use crate::world::SoftBodyWorld;
use crate::types::StaticSurface;
use crate::layers::{LAYER_BLOB, LAYER_ALL};

impl SoftBodyWorld {
    /// Register a spring pad. The plate is added as a kinematic static
    /// surface; the engine tracks the per-tick state machine in
    /// `world.spring_pads`. Returns the spring's index for ID-based
    /// queries.
    pub fn add_spring_pad(
        &mut self,
        id: u32,
        x: Fx, y: Fx,
        width: Fx, height: Fx,
        rotation: Fx,
        fire_speed_override: Option<Fx>,
    ) -> u32 {
        let cos_r = crate::math::cos_fx(rotation);
        let sin_r = crate::math::sin_fx(rotation);
        let launch_dir = FxVec2::new(cos_r, sin_r);
        let perp_dir = FxVec2::new(-sin_r, cos_r);
        // Plate-local rectangle: x ∈ [width/2 - thickness, width/2], y ∈ [-h/2, h/2]
        let hw = width / Fx::from_int(2);
        let plate_thickness = Fx::from_int(PLATE_THICKNESS_RAW as i32);
        let plate_width_scale = Fx::from_int(PLATE_WIDTH_SCALE_RAW as i32);
        let hh = (height * plate_width_scale) / Fx::from_int(2);
        let front_x = hw;
        let back_x = hw - plate_thickness;
        let local_corners = [
            FxVec2::new(back_x, -hh),
            FxVec2::new(front_x, -hh),
            FxVec2::new(front_x, hh),
            FxVec2::new(back_x, hh),
        ];
        let base_poly: Vec<FxVec2> = local_corners.iter().map(|c| FxVec2::new(
            x + cos_r * c.x - sin_r * c.y,
            y + sin_r * c.x + cos_r * c.y,
        )).collect();
        // Register the static surface in the engine. Initial pose: fully cocked.
        let max_compress = width * max_compress_frac();
        let initial_offset = max_compress;
        let initial_poly: Vec<FxVec2> = base_poly.iter().map(|p| FxVec2::new(
            p.x - launch_dir.x * initial_offset,
            p.y - launch_dir.y * initial_offset,
        )).collect();
        let surface = StaticSurface {
            poly: initial_poly,
            material: SurfaceMaterial::Default,
            id: Some(format!("spring:{}", id)),
            prev_poly: None,
            velocity: Some(FxVec2::ZERO),
            layer: LAYER_BLOB,
            mask: LAYER_ALL,
        };
        self.static_surfaces.push(surface);
        let surface_idx = self.static_surfaces.len() - 1;
        let raw_fire = fire_speed_override.unwrap_or_else(default_fire_speed);
        let fire_speed = raw_fire.max(min_fire_speed()).min(max_fire_speed());
        let reload_speed = max_compress / reload_time();
        self.spring_pads.push(SpringPad {
            id,
            surface_idx,
            launch_dir,
            perp_dir,
            base_poly,
            width,
            half_height_perp: hh,
            center: FxVec2::new(x, y),
            state: SpringPadState::Loaded,
            offset: initial_offset,
            max_compress,
            reload_speed,
            fire_speed,
            cooldown: Fx::ZERO,
        });
        (self.spring_pads.len() - 1) as u32
    }

    pub fn clear_spring_pads(&mut self) {
        self.spring_pads.clear();
        // NOTE: the static surfaces created for spring pads aren't
        // individually removed here — callers should rebuild the world
        // when reloading levels. (Matches JS behaviour: createGame()
        // tears down the whole world.)
    }

    pub fn spring_pad_count(&self) -> usize { self.spring_pads.len() }

    pub fn spring_pad_state(&self, idx: usize) -> u32 {
        match self.spring_pads.get(idx).map(|s| s.state) {
            Some(SpringPadState::Loaded) => 0,
            Some(SpringPadState::Firing) => 1,
            Some(SpringPadState::Reloading) => 2,
            None => 0,
        }
    }

    pub fn spring_pad_offset(&self, idx: usize) -> f64 {
        self.spring_pads.get(idx).map(|s| s.offset.to_f64()).unwrap_or(0.0)
    }

    /// Drain pending fire events (loaded → firing transitions this
    /// step). Returns the gameplay IDs of pads that just fired so JS
    /// can spawn VFX/SFX.
    pub fn take_spring_pad_fire_events(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.pending_spring_pad_fires)
    }

    /// Per-step update. Called from `step()`. Advances each pad's
    /// state machine, recomputes the plate's poly + velocity, and
    /// writes the new pose into `static_surfaces` so subsequent
    /// collision resolution sees the kinematic plate at its new
    /// position with the right velocity.
    pub fn update_spring_pads(&mut self, dt: Fx) {
        let n = self.spring_pads.len();
        for i in 0..n {
            // Decrement cooldown.
            let cd_old = self.spring_pads[i].cooldown;
            let cd_new = if cd_old > Fx::ZERO { (cd_old - dt).max(Fx::ZERO) } else { Fx::ZERO };
            self.spring_pads[i].cooldown = cd_new;

            // Front-face touch check.
            let touched = self.spring_pad_front_face_touched(i);

            let state_old = self.spring_pads[i].state;
            if state_old == SpringPadState::Loaded && cd_new <= Fx::ZERO && touched {
                self.spring_pads[i].state = SpringPadState::Firing;
                let id = self.spring_pads[i].id;
                self.pending_spring_pad_fires.push(id);
            }

            // Advance offset based on state.
            let mut vel_along_launch = Fx::ZERO;
            let state = self.spring_pads[i].state;
            if state == SpringPadState::Firing {
                let new_offset = self.spring_pads[i].offset - self.spring_pads[i].fire_speed * dt;
                vel_along_launch = self.spring_pads[i].fire_speed;
                if new_offset <= Fx::ZERO {
                    self.spring_pads[i].offset = Fx::ZERO;
                    self.spring_pads[i].state = SpringPadState::Reloading;
                    self.spring_pads[i].cooldown = cooldown_time();
                    vel_along_launch = Fx::ZERO;
                } else {
                    self.spring_pads[i].offset = new_offset;
                }
            } else if state == SpringPadState::Reloading {
                let new_offset = self.spring_pads[i].offset + self.spring_pads[i].reload_speed * dt;
                vel_along_launch = -self.spring_pads[i].reload_speed;
                if new_offset >= self.spring_pads[i].max_compress {
                    self.spring_pads[i].offset = self.spring_pads[i].max_compress;
                    self.spring_pads[i].state = SpringPadState::Loaded;
                    vel_along_launch = Fx::ZERO;
                } else {
                    self.spring_pads[i].offset = new_offset;
                }
            }

            // Write live poly + surface velocity.
            let offset = self.spring_pads[i].offset;
            let launch_dir = self.spring_pads[i].launch_dir;
            let surface_idx = self.spring_pads[i].surface_idx;
            let base_poly = self.spring_pads[i].base_poly.clone();
            let surface = &mut self.static_surfaces[surface_idx];
            // Capture prev_poly so the engine's CCD surface-sweep sees
            // this kinematic delta and resolves it without ghosting.
            surface.prev_poly = Some(surface.poly.clone());
            for (j, p) in surface.poly.iter_mut().enumerate() {
                p.x = base_poly[j].x - launch_dir.x * offset;
                p.y = base_poly[j].y - launch_dir.y * offset;
            }
            surface.velocity = Some(FxVec2::new(
                launch_dir.x * vel_along_launch,
                launch_dir.y * vel_along_launch,
            ));
        }
    }

    /// Test if any blob hull particle is in the spring's front-face
    /// detection band. Mirrors the JS frontFaceTouched.
    fn spring_pad_front_face_touched(&self, spring_idx: usize) -> bool {
        let s = &self.spring_pads[spring_idx];
        let hw = s.width / Fx::from_int(2);
        // Front face at plate-local x = hw - offset.
        let front_local_x = hw - s.offset;
        let bw = trigger_backward();
        let fw = trigger_forward();
        let side_max = s.half_height_perp + trigger_side_pad();
        for r in &self.blob_ranges {
            if r.inactive { continue; }
            for &idx in &r.hull {
                let p = self.pos[idx as usize];
                let rx = p.x - s.center.x;
                let ry = p.y - s.center.y;
                let local_x = s.launch_dir.x * rx + s.launch_dir.y * ry;
                let local_y = s.perp_dir.x * rx + s.perp_dir.y * ry;
                if local_y.abs() > side_max { continue; }
                let dx = local_x - front_local_x;
                if dx >= -bw && dx <= fw { return true; }
            }
        }
        false
    }
}

// Snapshot serde — captures the mutable bits only.
// surface_idx, launch_dir, perp_dir, base_poly, width, half_height_perp,
// center, max_compress, reload_speed, fire_speed are all immutable post-init.
use crate::snapshot::{SnapWriter, SnapReader};

pub(crate) fn serialize_spring_pads(pads: &[SpringPad], w: &mut SnapWriter) {
    w.u32(pads.len() as u32);
    for s in pads {
        w.u8(match s.state {
            SpringPadState::Loaded => 0,
            SpringPadState::Firing => 1,
            SpringPadState::Reloading => 2,
        });
        w.fx(s.offset);
        w.fx(s.cooldown);
    }
}

pub(crate) fn restore_spring_pads(pads: &mut [SpringPad], r: &mut SnapReader) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    if n != pads.len() { return Err("snapshot: spring_pad count mismatch"); }
    for s in pads.iter_mut() {
        s.state = match r.u8()? {
            0 => SpringPadState::Loaded,
            1 => SpringPadState::Firing,
            2 => SpringPadState::Reloading,
            _ => return Err("snapshot: bad spring_pad state"),
        };
        s.offset = r.fx()?;
        s.cooldown = r.fx()?;
    }
    Ok(())
}
