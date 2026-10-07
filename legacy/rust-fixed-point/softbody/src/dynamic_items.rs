//! Engine-side per-item state machines for dynamic-item zones
//! (cannon, catapult, bumper, wind, gravity-flipper, conveyor, sticky goo,
//! wrecking ball). Replaces `src/game/dynamicItemManager.ts` on the JS side.
//!
//! Why this moved to Rust: the JS version used `Math.cos/sin` per item per
//! frame to derive the force direction, AND used `setTimeout` (wall-clock-
//! dependent — definitely non-deterministic across browser tabs) for the
//! bumper cooldown. Living in the engine, the direction is precomputed once
//! at add time in `Fx`, and the cooldown is a tick-counted integer — both
//! bit-identical across every wasm instance.
//!
//! Forces are applied via Phase 3's `apply_force_in_polygon` API (Uniform
//! for wind/conveyor/cannon, Radial for bumper/wrecking) — no new per-tick
//! force code, just timer state + polygon dispatch.

use crate::fx::{Fx, FxVec2};
use crate::types::{ForceField, PointGravityFalloff};

#[derive(Copy, Clone, Debug)]
pub enum DynamicItemKind {
    Cannon,
    Catapult,
    Bumper,
    WindZone,
    GravityFlipper,
    ConveyorLeft,
    ConveyorRight,
    StickyGoo,
    WreckingBall,
}

#[derive(Clone, Debug)]
pub struct DynamicItem {
    pub id: u32,
    pub kind: DynamicItemKind,
    /// Precomputed AABB polygon (in CCW order). Built at add time from
    /// (x, y, w, h, rotation) and never mutates. Used by cannon /
    /// catapult / wind / conveyor / sticky / gravity_flipper to scope
    /// the force-field application.
    pub polygon: Vec<FxVec2>,
    /// Center point — used by Bumper and WreckingBall for radial force
    /// (centroid-distance + falloff).
    pub center: FxVec2,
    /// Effective radius for radial-force kinds (Bumper, WreckingBall).
    /// For Bumper this is `width/2`; for WreckingBall this is the blast
    /// radius. Unused for zone-force kinds.
    pub radius: Fx,
    /// Precomputed unit direction from rotation. Cannon, WindZone use
    /// (cos(rot), sin(rot)). Catapult uses (0, -1). Conveyor uses (±1, 0).
    pub direction: FxVec2,
    /// Accumulated time since item was created (in Fx seconds). Used by
    /// periodic kinds (Cannon, Catapult, WreckingBall) for the
    /// fire-phase mod check.
    pub timer: Fx,
    /// Visual indicator: true when actively firing this tick. Renderers
    /// query this for VFX. Not engine-state-relevant beyond display.
    pub active: bool,
    /// Bumper-only: ticks-since-last-fire countdown. Replaces the JS
    /// `setTimeout(150ms)` — counted in ticks for determinism.
    pub bumper_cooldown_ticks: i32,
}

// ─── Tuning constants — mirror the JS values in dynamicItemManager.ts ───

/// Cannon fires every N seconds.
fn cannon_period() -> Fx { Fx::from_f64(3.5) }
fn cannon_fire_duration() -> Fx { Fx::from_f64(0.15) }
fn cannon_force() -> Fx { Fx::from_int(1200) }

fn catapult_period() -> Fx { Fx::from_f64(4.0) }
fn catapult_fire_duration() -> Fx { Fx::from_f64(0.2) }
fn catapult_force() -> Fx { Fx::from_int(900) }

fn bumper_force() -> Fx { Fx::from_int(600) }
/// Bumper cooldown in ticks (was JS setTimeout(150ms) = 9 ticks at 60Hz).
const BUMPER_COOLDOWN_TICKS: i32 = 9;

fn wind_force() -> Fx { Fx::from_int(350) }
fn conveyor_force() -> Fx { Fx::from_int(250) }
fn sticky_drag_coefficient() -> Fx {
    // JS: vel *= 0.85 per frame at 60Hz. We model as `vel *= (1 -
    // coefficient * dt)`. Solve: 0.85 = 1 - c * (1/60) → c = 9.
    Fx::from_int(9)
}

fn wrecking_period() -> Fx { Fx::from_f64(5.0) }
fn wrecking_blast_radius() -> Fx { Fx::from_int(200) }
fn wrecking_force() -> Fx { Fx::from_int(800) }
fn wrecking_active_duration() -> Fx { Fx::from_f64(0.3) }

/// Anti-gravity vertical force per dt — JS used `7840 * dt` directly.
fn gravity_flipper_force() -> Fx { Fx::from_int(7840) }

/// Build an unrotated AABB polygon in world space.
pub fn build_aabb_polygon(x: Fx, y: Fx, w: Fx, h: Fx) -> Vec<FxVec2> {
    let hw = w / Fx::from_int(2);
    let hh = h / Fx::from_int(2);
    vec![
        FxVec2::new(x - hw, y - hh),
        FxVec2::new(x + hw, y - hh),
        FxVec2::new(x + hw, y + hh),
        FxVec2::new(x - hw, y + hh),
    ]
}

/// Build a rotated AABB polygon (rotation in radians, applied around (x,y)).
pub fn build_rotated_aabb_polygon(
    x: Fx, y: Fx, w: Fx, h: Fx, rotation: Fx,
) -> Vec<FxVec2> {
    let hw = w / Fx::from_int(2);
    let hh = h / Fx::from_int(2);
    let cos_r = crate::math::cos_fx(rotation);
    let sin_r = crate::math::sin_fx(rotation);
    let local = [
        FxVec2::new(-hw, -hh),
        FxVec2::new(hw, -hh),
        FxVec2::new(hw, hh),
        FxVec2::new(-hw, hh),
    ];
    local.iter().map(|p| {
        FxVec2::new(
            x + p.x * cos_r - p.y * sin_r,
            y + p.x * sin_r + p.y * cos_r,
        )
    }).collect()
}

/// Build a circular polygon approximation (16 vertices) for radial-force kinds.
pub fn build_circle_polygon(cx: Fx, cy: Fx, radius: Fx) -> Vec<FxVec2> {
    const N: usize = 16;
    let two_pi = Fx::from_f64(std::f64::consts::TAU);
    let n_fx = Fx::from_int(N as i32);
    (0..N).map(|i| {
        let t = Fx::from_int(i as i32) * two_pi / n_fx;
        let cos_t = crate::math::cos_fx(t);
        let sin_t = crate::math::sin_fx(t);
        FxVec2::new(cx + radius * cos_t, cy + radius * sin_t)
    }).collect()
}

// ─── World integration ─────────────────────────────────────────────────

use crate::world::SoftBodyWorld;

impl SoftBodyWorld {
    pub fn add_cannon(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx, rotation: Fx) -> u32 {
        let cos_r = crate::math::cos_fx(rotation);
        let sin_r = crate::math::sin_fx(rotation);
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::Cannon,
            polygon: build_rotated_aabb_polygon(x, y, w * Fx::from_f64(1.2), h * Fx::from_f64(1.2), rotation),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::new(cos_r, sin_r),
            timer: Fx::ZERO,
            active: false,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_catapult(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx) -> u32 {
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::Catapult,
            polygon: build_aabb_polygon(x, y, w, h),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::new(Fx::ZERO, Fx::from_int(-1)),
            timer: Fx::ZERO,
            active: false,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_bumper(&mut self, id: u32, x: Fx, y: Fx, radius: Fx) -> u32 {
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::Bumper,
            polygon: build_circle_polygon(x, y, radius),
            center: FxVec2::new(x, y),
            radius,
            direction: FxVec2::ZERO,
            timer: Fx::ZERO,
            active: false,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_wind_zone(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx, rotation: Fx) -> u32 {
        let cos_r = crate::math::cos_fx(rotation);
        let sin_r = crate::math::sin_fx(rotation);
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::WindZone,
            polygon: build_aabb_polygon(x, y, w, h),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::new(cos_r, sin_r),
            timer: Fx::ZERO,
            active: true,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_gravity_flipper(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx) -> u32 {
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::GravityFlipper,
            polygon: build_aabb_polygon(x, y, w, h),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::new(Fx::ZERO, Fx::from_int(-1)),
            timer: Fx::ZERO,
            active: true,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_conveyor(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx, direction: i32) -> u32 {
        let dir = if direction < 0 { DynamicItemKind::ConveyorLeft } else { DynamicItemKind::ConveyorRight };
        let dx = if direction < 0 { Fx::from_int(-1) } else { Fx::from_int(1) };
        self.dynamic_items.push(DynamicItem {
            id, kind: dir,
            polygon: build_aabb_polygon(x, y, w, h),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::new(dx, Fx::ZERO),
            timer: Fx::ZERO,
            active: true,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_sticky_goo(&mut self, id: u32, x: Fx, y: Fx, w: Fx, h: Fx) -> u32 {
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::StickyGoo,
            polygon: build_aabb_polygon(x, y, w, h),
            center: FxVec2::new(x, y),
            radius: Fx::ZERO,
            direction: FxVec2::ZERO,
            timer: Fx::ZERO,
            active: true,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn add_wrecking_ball(&mut self, id: u32, x: Fx, y: Fx) -> u32 {
        let radius = wrecking_blast_radius();
        self.dynamic_items.push(DynamicItem {
            id, kind: DynamicItemKind::WreckingBall,
            polygon: build_circle_polygon(x, y, radius),
            center: FxVec2::new(x, y),
            radius,
            direction: FxVec2::ZERO,
            timer: Fx::ZERO,
            active: false,
            bumper_cooldown_ticks: 0,
        });
        (self.dynamic_items.len() - 1) as u32
    }

    pub fn clear_dynamic_items(&mut self) { self.dynamic_items.clear(); }

    pub fn dynamic_item_count(&self) -> usize { self.dynamic_items.len() }

    /// Read the visual `active` flag for an item (for VFX).
    pub fn dynamic_item_active(&self, idx: usize) -> bool {
        self.dynamic_items.get(idx).map(|i| i.active).unwrap_or(false)
    }

    /// Step every dynamic item by `dt`. Advances timers, applies
    /// forces via the Phase 3 zone-force APIs. Called once per
    /// `world.step` from inside the engine.
    pub fn update_dynamic_items(&mut self, dt: Fx) {
        // Snapshot kinds + data first so we can release the items
        // borrow before calling self.apply_force_in_polygon.
        let n = self.dynamic_items.len();
        for i in 0..n {
            // Read mutable bits we may need to update; clone the polygon
            // so we can pass it through apply_force_in_polygon without
            // borrow conflict.
            let (kind, polygon, center, radius, direction, timer_old, cooldown_old) = {
                let it = &self.dynamic_items[i];
                (it.kind, it.polygon.clone(), it.center, it.radius, it.direction, it.timer, it.bumper_cooldown_ticks)
            };
            let mut new_active = false;
            let mut new_timer = timer_old + dt;
            let mut new_cooldown = (cooldown_old - 1).max(0);
            match kind {
                DynamicItemKind::Cannon => {
                    let period = cannon_period();
                    let phase = timer_old - Fx::from_int((timer_old / period).floor_to_i32()) * period;
                    let firing = phase < cannon_fire_duration();
                    new_active = firing;
                    if firing {
                        let f = direction.scale(cannon_force());
                        self.apply_force_in_polygon(&polygon, ForceField::Uniform { force: f }, dt);
                    }
                }
                DynamicItemKind::Catapult => {
                    let period = catapult_period();
                    let phase = timer_old - Fx::from_int((timer_old / period).floor_to_i32()) * period;
                    let firing = phase < catapult_fire_duration();
                    new_active = firing;
                    if firing {
                        let f = direction.scale(catapult_force());
                        self.apply_force_in_polygon(&polygon, ForceField::Uniform { force: f }, dt);
                    }
                }
                DynamicItemKind::Bumper => {
                    // Active for the cooldown window; fires when blob enters
                    // AND cooldown is 0.
                    new_active = cooldown_old > 0;
                    if cooldown_old == 0 {
                        // Check if any blob centroid is in our circle.
                        let hits = self.blobs_overlapping_polygon(&polygon);
                        if !hits.is_empty() {
                            // Radial push outward at full strength
                            // (JS: scale by 0.02 then applyLinearVelocityDelta).
                            // Use Linear falloff with full strength at center.
                            self.apply_force_in_polygon(&polygon, ForceField::Radial {
                                center,
                                strength: bumper_force(),
                                radius,
                                falloff: PointGravityFalloff::Linear,
                            }, Fx::from_f64(0.02));  // mirror JS's 0.02 scale (a "velocity-delta budget", not real dt)
                            new_active = true;
                            new_cooldown = BUMPER_COOLDOWN_TICKS;
                        }
                    }
                }
                DynamicItemKind::WindZone => {
                    let f = direction.scale(wind_force());
                    self.apply_force_in_polygon(&polygon, ForceField::Uniform { force: f }, dt);
                    new_active = true;
                }
                DynamicItemKind::GravityFlipper => {
                    let f = FxVec2::new(Fx::ZERO, -gravity_flipper_force());
                    self.apply_force_in_polygon(&polygon, ForceField::Uniform { force: f }, dt);
                    new_active = true;
                }
                DynamicItemKind::ConveyorLeft | DynamicItemKind::ConveyorRight => {
                    let f = direction.scale(conveyor_force());
                    self.apply_force_in_polygon(&polygon, ForceField::Uniform { force: f }, dt);
                    new_active = true;
                }
                DynamicItemKind::StickyGoo => {
                    self.apply_force_in_polygon(&polygon, ForceField::Drag {
                        coefficient: sticky_drag_coefficient(),
                    }, dt);
                    new_active = true;
                }
                DynamicItemKind::WreckingBall => {
                    let period = wrecking_period();
                    let phase = timer_old - Fx::from_int((timer_old / period).floor_to_i32()) * period;
                    let firing = phase < wrecking_active_duration();
                    new_active = firing;
                    if firing {
                        // Radial blast with linear falloff.
                        self.apply_force_in_polygon(&polygon, ForceField::Radial {
                            center,
                            strength: wrecking_force(),
                            radius,
                            falloff: PointGravityFalloff::Linear,
                        }, Fx::from_f64(0.03));
                    }
                }
            }
            let it = &mut self.dynamic_items[i];
            it.timer = new_timer;
            it.active = new_active;
            it.bumper_cooldown_ticks = new_cooldown;
        }
    }
}

// ─── Snapshot serde — mutable bits only (kind/polygon/center are immutable) ───

use crate::snapshot::{SnapWriter, SnapReader};

pub(crate) fn serialize_dynamic_items(items: &[DynamicItem], w: &mut SnapWriter) {
    w.u32(items.len() as u32);
    for it in items {
        w.fx(it.timer);
        w.bool(it.active);
        w.i32(it.bumper_cooldown_ticks);
    }
}

pub(crate) fn restore_dynamic_items(items: &mut [DynamicItem], r: &mut SnapReader) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    if n != items.len() { return Err("snapshot: dynamic_item count mismatch"); }
    for it in items.iter_mut() {
        it.timer = r.fx()?;
        it.active = r.bool()?;
        it.bumper_cooldown_ticks = r.i32()?;
    }
    Ok(())
}
