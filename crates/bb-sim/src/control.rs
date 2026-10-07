//! The blob controller shared by players and NPCs.
//!
//! Input is deliberately tiny (a stick and ONE button) so a phone is a full
//! controller:
//! * stick ←/→ rolls (tread on the outline) with air control;
//! * button = **expand**: press on the ground to jump (variable height —
//!   release early for a hop), hold to stay puffed up (floats in wind and
//!   water, pushes things around);
//! * touching a vine while airborne grabs it; stick swings and climbs;
//!   the button lets go with a boost;
//! * on sticky surfaces you cling; the button wall-jumps.

use bb_physics::{Anchor, BodyDesc, BodyId, Collider, Joint, JointId, Vec2, World};


/// A straight port of the 2.x blob (`src/physics/slimeBlob.ts` + its Rust
/// engine), scaled from the 48 px TS blob to our 32 px one: every length and
/// acceleration × 2/3, times unchanged. TS forces were per particle with
/// hull mass 0.06, so they're stored here as accelerations (force / 0.06).
pub mod tune {
    use bb_physics::Vec2;
    /// Length scale from the TS world (48 px blob → 32 px).
    pub const L: f32 = 2.0 / 3.0;
    pub const RADIUS: f32 = 32.0;
    /// TS `circle16`.
    pub const SEGMENTS: usize = 16;
    pub const MASS: f32 = 1.0;
    /// TS world gravity 980 × 4.
    pub const GRAVITY: f32 = 3920.0 * L;
    /// TS MOVE_FORCE 240; × 0.6 in the air, × 0.4 touching a wall/ceiling.
    pub const MOVE_ACCEL: f32 = 240.0 / 0.06 * L;
    pub const AIR_MOVE: f32 = 0.6;
    pub const NONFLOOR_MOVE: f32 = 0.4;
    /// TS DOWN_FORCE 180: stick down presses you into the floor / falls faster.
    pub const DOWN_ACCEL: f32 = 180.0 / 0.06 * L;
    /// TS UP_FORCE 96: stick up is a gentle float (≈ 40% less gravity).
    pub const UP_ACCEL: f32 = 96.0 / 0.06 * L;
    /// Clambering up something overhead (ledge / roof / blob above).
    pub const LEDGE_UP_MULT: f32 = 12.0;
    /// Up on a vertical wall is weaker so you can't shoot straight up it.
    pub const WALL_CLIMB_MULT: f32 = 0.35;
    /// Expand: the jump IS the swell pushing off the ground.
    pub const EXPAND_SCALE: f32 = 3.0;
    pub const EXPAND_RATE_PRESS: f32 = 28.0;
    pub const EXPAND_RATE_RELEASE: f32 = 18.0;
    pub const EXPAND_SPRING_MULT: f32 = 1.45;
    /// Stick down squashes the rest shape wide and flat.
    pub const SQUASH_X: f32 = 0.35;
    pub const SQUASH_Y: f32 = 0.30;
    /// Sticky walls: cling, then the button launches along the stick.
    pub const STICK_MIN_CONTACTS: usize = 2;
    pub const STICK_RELEASE_GRACE: f32 = 0.25;
    pub const STICK_JUMP: f32 = 1400.0 * L;
    /// Softbody (TS Tuning × PLAYER_K_MULT 0.92 / hull mass 0.06).
    pub const SPRING_K: f32 = 55.0 * 0.92 / 0.06;
    pub const SPRING_DAMP: f32 = 3.5 / 0.06;
    pub const PRESSURE_K: f32 = 0.12 / 0.06 / (L * L);
    pub const SHAPE_K: f32 = 132.0 * 0.92 / 0.06;
    pub const SHAPE_DAMP: f32 = 1.5 / 0.06;
    // 3.0 additions (no TS equivalent): vines and swimming. Tuned against
    // the 1800 px/s² world gravity; launches scale by √(gravity ratio).
    pub const SWING_ACCEL: f32 = 1100.0;
    pub const CLIMB_INTERVAL: f32 = 0.09;
    pub const GRAB_COOLDOWN: f32 = 0.35;
    pub const ROPE_JUMP: Vec2 = Vec2::new(380.0, 720.0);
    pub const SWIM_KICK: f32 = 720.0;
    pub const JUMP_BUFFER: f32 = 0.12;
}

#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct Input {
    /// Stick, each axis in [-1, 1], +y up.
    pub stick: Vec2,
    /// The one button (expand / jump / let go).
    pub button: bool,
}

#[derive(Clone, Debug)]
pub struct Grab {
    pub rope: usize,
    pub node: u32,
    pub joint: JointId,
}

#[derive(Clone, Debug)]
pub struct Controller {
    pub body: BodyId,
    pub radius: f32,
    pub input: Input,
    prev_button: bool,
    pub expand: f32,
    pub grounded: bool,
    pub ground_normal: Vec2,
    jump_buffer: f32,
    pub grab: Option<Grab>,
    grab_cooldown: f32,
    climb_timer: f32,
    pub stuck: Option<Vec2>,
    /// Movement strength multiplier (NPCs are a bit slower).
    pub strength: f32,
    /// Scripted puff: inflate toward this scale without jumping.
    pub puff: Option<f32>,
    /// Fraction of the outline under water this step (set by the runtime).
    pub in_water: f32,
    /// Average normal of everything we're touching.
    pub contact_normal: Vec2,
    /// Touching anything / something on our upper half / sticky contacts.
    pub touching: bool,
    pub overhead: bool,
    sticky_count: usize,
    sticky_normal: Vec2,
    stick_grace: f32,
    /// 0..1 squash amount (stick down).
    pub crouch: f32,
    swim_cooldown: f32,
    /// Rest-scale target while the button is held (Kids Mode puffs a
    /// picked-up blob bigger than a normal expand).
    pub expand_scale: f32,
}

/// What the controller did this step (for sounds and animation).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Jump,
    WallJump,
    Grab,
    Release,
}

impl Controller {
    pub fn spawn(world: &mut World, at: Vec2, radius: f32, layer_bits: u32) -> Controller {
        let mut d = BodyDesc::blob(at, radius, tune::SEGMENTS, tune::MASS * (radius / tune::RADIUS).powi(2));
        // The 2.x force model (springs + pressure + shape matching); see `tune`.
        d.params.forces = Some(bb_physics::ForceModel {
            spring_k: tune::SPRING_K,
            spring_damp: tune::SPRING_DAMP,
            shear: 0.85,
            pressure_k: tune::PRESSURE_K,
            shape_k: tune::SHAPE_K,
            shape_damp: tune::SHAPE_DAMP,
        });
        d.params.linear_damping = 0.0;
        d.params.internal_damping = 0.0;
        d.params.radius = 2.0;
        d.params.material = bb_physics::Material { static_friction: 1.0, dynamic_friction: 0.8, restitution: 0.0 };
        d.layer = layer_bits;
        let body = world.add_body(d);
        Controller {
            body,
            radius,
            input: Input::default(),
            prev_button: false,
            expand: 1.0,
            grounded: false,
            ground_normal: Vec2::Y,
            jump_buffer: 0.0,
            grab: None,
            grab_cooldown: 0.0,
            climb_timer: 0.0,
            stuck: None,
            strength: 1.0,
            puff: None,
            in_water: 0.0,
            swim_cooldown: 0.0,
            contact_normal: Vec2::Y,
            touching: false,
            overhead: false,
            sticky_count: 0,
            sticky_normal: Vec2::Y,
            stick_grace: 0.0,
            crouch: 0.0,
            expand_scale: tune::EXPAND_SCALE,
        }
    }

    pub fn reset(&mut self) {
        self.prev_button = self.input.button;
        self.expand = 1.0;
        self.grounded = false;
        self.jump_buffer = 0.0;
        self.crouch = 0.0;
        self.grab = None;
        self.stuck = None;
    }

    pub fn release_grab(&mut self, world: &mut World) {
        if let Some(g) = self.grab.take() {
            world.remove_joint(g.joint);
            self.grab_cooldown = tune::GRAB_COOLDOWN;
        }
    }

    /// Apply input before the physics step (2.x `SlimeBlob.update`).
    pub fn pre_step(&mut self, world: &mut World, ropes: &[crate::RopeState], dt: f32) -> Option<Action> {
        let mut action = None;
        let pressed = self.input.button && !self.prev_button;
        self.prev_button = self.input.button;
        self.grab_cooldown = (self.grab_cooldown - dt).max(0.0);
        self.stick_grace = (self.stick_grace - dt).max(0.0);
        self.jump_buffer = if pressed { tune::JUMP_BUFFER } else { (self.jump_buffer - dt).max(0.0) };
        let stick = self.input.stick.clamp_length_max(1.0);
        let strength = self.strength;
        let g_world = world.config.gravity;
        let Some(body) = world.body(self.body) else { return None };
        if !body.enabled {
            return None;
        }
        let vel = body.velocity();
        // The player blob falls at 2.x's (scaled) gravity whatever the level's.
        let g_len = g_world.length().max(1.0);
        let g_scale = tune::GRAVITY / g_len;
        let down = g_world / g_len;
        let up = -down;
        let right = Vec2::new(-down.y, down.x);

        // Expand ramp (press is faster than release), as 2.x.
        let mut target = self.puff.unwrap_or(if self.input.button { self.expand_scale } else { 1.0 });
        if self.stuck.is_some() || self.grab.is_some() {
            target = target.min(1.3);
        }
        let rate = if target > self.expand { tune::EXPAND_RATE_PRESS } else { tune::EXPAND_RATE_RELEASE };
        let step = rate * dt;
        self.expand = if (target - self.expand).abs() <= step { target } else { self.expand + step * (target - self.expand).signum() };

        // Rope swinging (3.0).
        if let Some(g) = self.grab.clone() {
            if pressed {
                self.release_grab(world);
                let dir = if stick.x.abs() > 0.2 { stick.x.signum() } else { vel.x.signum() };
                let b = world.body_mut(self.body).unwrap();
                b.add_velocity(Vec2::new(dir * tune::ROPE_JUMP.x, tune::ROPE_JUMP.y) * g_scale.sqrt());
                self.jump_buffer = 0.0;
                return Some(Action::Release);
            }
            self.climb_timer -= dt;
            if stick.y.abs() > 0.5 && self.climb_timer <= 0.0 {
                self.climb_timer = tune::CLIMB_INTERVAL;
                if let Some(r) = ropes.get(g.rope).and_then(|r| world.rope(r.rope)) {
                    let n = world.body(r.body).map_or(0, |b| b.len()) as i64;
                    let next = (g.node as i64 - stick.y.signum() as i64).clamp(1, (n - 1).max(1)) as u32;
                    if next != g.node {
                        let rb = r.body;
                        world.remove_joint(g.joint);
                        let anchor = Anchor::centre(world, self.body).unwrap();
                        let joint = world.add_joint(Joint::pin(anchor, Anchor::particle(rb, next)).with_compliance(2e-6));
                        self.grab = Some(Grab { rope: g.rope, node: next, joint });
                    }
                }
            }
            let b = world.body_mut(self.body).unwrap();
            b.params.gravity_scale = g_scale;
            b.add_accel(Vec2::new(stick.x * tune::SWING_ACCEL * strength, 0.0));
            b.rest_scale = self.expand;
            b.squash = Vec2::ONE;
            return None;
        }

        let b = world.body_mut(self.body).unwrap();
        b.rest_scale = self.expand;

        // ── Sticky walls: cling (no gravity, held still) until the button
        // launches you along the stick (or straight off the wall).
        if self.stuck.is_none() && self.stick_grace <= 0.0 && self.sticky_count >= tune::STICK_MIN_CONTACTS {
            self.stuck = Some(self.sticky_normal);
        }
        if let Some(n) = self.stuck {
            let n = if self.sticky_count > 0 { self.sticky_normal } else { n };
            self.stuck = Some(n);
            b.params.gravity_scale = 0.0;
            b.add_velocity(-vel);
            b.squash = Vec2::ONE;
            if pressed {
                let mut aim = stick;
                if aim.length() < 0.1 {
                    aim = n;
                } else {
                    aim = aim.normalize();
                    let into = aim.dot(n);
                    if into < 0.0 {
                        aim -= n * into;
                        aim = if aim.length() < 0.05 { n } else { aim.normalize() };
                    }
                }
                b.add_velocity(aim * tune::STICK_JUMP * strength);
                b.params.gravity_scale = g_scale;
                self.stuck = None;
                self.stick_grace = tune::STICK_RELEASE_GRACE;
                self.jump_buffer = 0.0;
                return Some(Action::WallJump);
            }
            return None;
        }
        b.params.gravity_scale = g_scale;

        // Springs stiffen while expanding.
        b.spring_scale = if self.input.button { tune::EXPAND_SPRING_MULT } else { 1.0 };

        // Contact frame: +1 floor, ~0 wall, -1 ceiling.
        let on_floor = self.grounded;
        let up_dot = if self.touching { self.contact_normal.dot(up) } else if on_floor { 1.0 } else { 0.0 };

        // Lateral: along the gravity-relative floor tangent; full on a floor,
        // throttled on walls/ceilings and in the air.
        let lateral = if on_floor { 1.0 } else if self.touching { tune::NONFLOOR_MOVE } else { tune::AIR_MOVE };
        b.add_accel(right * stick.x * tune::MOVE_ACCEL * strength * lateral);

        // Stick down: press into the floor (fall faster) and squash flat.
        // Stick up: float — gentle in the air, a clamber when something's
        // overhead, weaker up a bare wall.
        if stick.y < -0.1 {
            b.add_accel(down * tune::DOWN_ACCEL * -stick.y * strength);
        } else if stick.y > 0.1 {
            let mult = if self.overhead { tune::LEDGE_UP_MULT } else { 1.0 };
            let climb = if self.touching && up_dot.abs() < 0.5 && !self.overhead { tune::WALL_CLIMB_MULT } else { 1.0 };
            b.add_accel(up * tune::UP_ACCEL * mult * climb * stick.y * strength);
        }
        self.crouch = (-stick.y).max(0.0);
        // Squash in the gravity frame (wide along `right`, flat along `up`).
        let sx = 1.0 + tune::SQUASH_X * self.crouch;
        let sy = 1.0 - tune::SQUASH_Y * self.crouch;
        b.squash = Vec2::new((right.x * sx).abs() + (up.x * sy).abs(), (right.y * sx).abs() + (up.y * sy).abs());

        if pressed && (self.touching || on_floor) && self.puff.is_none() {
            action = Some(Action::Jump);
        }

        // Swim kick (3.0): in water the button kicks you up and out.
        self.swim_cooldown = (self.swim_cooldown - dt).max(0.0);
        let pushing_bank = self.input.button && stick.x.abs() > 0.5 && vel.x.abs() < 60.0;
        if self.in_water > 0.2 && !on_floor && (self.jump_buffer > 0.0 || pushing_bank) && self.swim_cooldown <= 0.0 {
            let vy = vel.y.max(0.0);
            b.add_velocity(Vec2::new(stick.x * 120.0, tune::SWIM_KICK * g_scale.sqrt() * strength - vy));
            self.jump_buffer = 0.0;
            self.swim_cooldown = 0.45;
            return Some(Action::Jump);
        }
        action
    }

    /// Read contacts after the physics step.
    pub fn post_step(&mut self, world: &mut World, ropes: &[crate::RopeState], sticky: &dyn Fn(Collider) -> bool, _dt: f32) -> Option<Action> {
        let Some(body) = world.body(self.body) else { return None };
        if !body.enabled {
            return None;
        }
        let vel = body.velocity();
        let mut ground = Vec2::ZERO;
        let mut count = 0;
        let mut sticky_n = Vec2::ZERO;
        let mut sticky_count = 0;
        let mut all = Vec2::ZERO;
        let mut touching = 0;
        let mut overhead = false;
        let c0 = body.centroid();
        for c in world.contacts_of(self.body) {
            all += c.normal;
            touching += 1;
            if c.normal.y > 0.45 {
                ground += c.normal;
                count += 1;
            }
            // Something pressing on our upper half (ledge, roof, blob above).
            if c.normal.y < -0.3 || (c.point.y > c0.y + self.radius * 0.3 && c.normal.y < 0.3) {
                overhead = true;
            }
            if sticky(c.other) {
                sticky_n += c.normal;
                sticky_count += 1;
            }
        }
        self.touching = touching > 0;
        self.overhead = overhead;
        if touching > 0 {
            self.contact_normal = all.normalize_or(Vec2::Y);
        }
        self.sticky_count = sticky_count;
        if sticky_count > 0 {
            self.sticky_normal = sticky_n.normalize_or(Vec2::Y);
        }
        self.grounded = count > 0;
        if self.grounded {
            self.ground_normal = (ground / count as f32).normalize_or(Vec2::Y);
        }
        let _ = vel;
        if self.stuck.is_some() && sticky_count == 0 && !self.grounded {
            // Lost the wall (e.g. it moved away): fall.
            self.stuck = None;
        }

        // Grab a vine when touching one in the air.
        if self.grab.is_none() && !self.grounded && self.grab_cooldown <= 0.0 {
            let c = body.centroid();
            // Generous: grabbing a vine you brushed should just work.
            let reach = self.radius * self.expand.min(1.3) + 18.0;
            let mut best: Option<(usize, u32, f32)> = None;
            for (ri, r) in ropes.iter().enumerate() {
                if !r.grabbable {
                    continue;
                }
                let Some(rope) = world.rope(r.rope) else { continue };
                let Some(chain) = world.body(rope.body) else { continue };
                if !chain.aabb.expand(reach).contains(c) {
                    continue;
                }
                for (i, p) in chain.x.iter().enumerate().skip(1) {
                    let d = p.distance(c);
                    if d < reach && best.is_none_or(|b| d < b.2) {
                        best = Some((ri, i as u32, d));
                    }
                }
            }
            if let Some((ri, node, _)) = best {
                let rb = world.rope(ropes[ri].rope).unwrap().body;
                let anchor = Anchor::centre(world, self.body).unwrap();
                let joint = world.add_joint(Joint::pin(anchor, Anchor::particle(rb, node)).with_compliance(2e-6));
                self.grab = Some(Grab { rope: ri, node, joint });
                return Some(Action::Grab);
            }
        }
        None
    }
}
