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

use crate::tuning::Tuning;
use bb_physics::{Anchor, BodyDesc, BodyId, Collider, Joint, JointId, Vec2, World};


/// Fixed blob constants. Everything about the *feel* lives in
/// `tuning.toml` ([`crate::tuning::Tuning`]), live-editable while the game
/// runs. The model is the 2.x blob (slimeBlob.ts) scaled 48 → 32 px.
pub mod tune {
    pub const RADIUS: f32 = 32.0;
    /// TS `circle16`.
    pub const SEGMENTS: usize = 16;
    pub const MASS: f32 = 1.0;
    pub const CLIMB_INTERVAL: f32 = 0.09;
    pub const GRAB_COOLDOWN: f32 = 0.35;
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
    /// The vine just let go of (only it is blocked during the cooldown).
    last_rope: Option<usize>,
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
    /// Seconds of roof-cling memory left (survives a one-frame bounce).
    ceiling_t: f32,
    /// 0..1 squash amount (stick down).
    pub crouch: f32,
    swim_cooldown: f32,
    /// Override for the swell size while the button is held (Kids Mode puffs
    /// a picked-up blob bigger); `None` uses the tuning.
    pub expand_scale: Option<f32>,
    /// Ground speed (along `right`) when the last ground jump started, and
    /// how long the jump still keeps it.
    jump_carry: f32,
    jump_carry_t: f32,
    /// Floats with no gravity at all (Glimmer).
    pub weightless: bool,
    /// Seconds since the button was pressed (while it's held).
    press_t: f32,
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
        let t = crate::tuning::current();
        d.params.forces = Some(t.force_model());
        d.params.linear_damping = 0.0;
        d.params.internal_damping = 0.0;
        d.params.radius = 2.0;
        d.params.material = t.material();
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
            last_rope: None,
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
            ceiling_t: 0.0,
            crouch: 0.0,
            expand_scale: None,
            jump_carry: 0.0,
            jump_carry_t: 0.0,
            weightless: false,
            press_t: 99.0,
        }
    }

    pub fn reset(&mut self) {
        self.prev_button = self.input.button;
        self.expand = 1.0;
        self.grounded = false;
        self.jump_buffer = 0.0;
        self.crouch = 0.0;
        self.jump_carry_t = 0.0;
        self.grab = None;
        self.stuck = None;
    }

    /// Re-apply body tuning (after a live tuning edit).
    pub fn apply_tuning(&self, world: &mut World, t: &Tuning) {
        if let Some(b) = world.body_mut(self.body) {
            if b.params.forces.is_some() {
                b.params.forces = Some(t.force_model());
                b.params.material = t.material();
            }
        }
    }

    /// How much the blob is swelling *right now* (for spring / mushroom
    /// boosts): 1 just after pressing the button, fading to 0.3 while it's
    /// held puffed up, 0 when not pressed.
    pub fn swell(&self, window: f32) -> f32 {
        if !self.input.button || self.puff.is_some() {
            return 0.0;
        }
        let w = window.max(0.05);
        if self.press_t <= w { 1.0 } else { (1.0 - (self.press_t - w) / w * 0.7).max(0.3) }
    }

    /// The button went down within the last `window` seconds (still held).
    pub fn just_pressed(&self, window: f32) -> bool {
        self.input.button && self.press_t <= window
    }

    pub fn release_grab(&mut self, world: &mut World) {
        if let Some(g) = self.grab.take() {
            world.remove_joint(g.joint);
            self.last_rope = Some(g.rope);
            self.grab_cooldown = tune::GRAB_COOLDOWN;
        }
    }

    /// Apply input before the physics step (2.x `SlimeBlob.update`).
    pub fn pre_step(&mut self, world: &mut World, ropes: &[crate::RopeState], t: &Tuning, dt: f32) -> Option<Action> {
        let mut action = None;
        let pressed = self.input.button && !self.prev_button;
        self.prev_button = self.input.button;
        self.press_t = if pressed { 0.0 } else if self.input.button { self.press_t + dt } else { 99.0 };
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
        let g_scale = if self.weightless { 0.0 } else { t.gravity.gravity / g_len };
        let down = g_world / g_len;
        let up = -down;
        let right = Vec2::new(-down.y, down.x);

        // Expand ramp (press is faster than release), as 2.x.
        let mut target = self.puff.unwrap_or(if self.input.button { self.expand_scale.unwrap_or(t.jump.expand_scale) } else { 1.0 });
        if self.stuck.is_some() || self.grab.is_some() {
            target = target.min(1.3);
        }
        let rate = if target > self.expand { t.jump.expand_rate_press } else { t.jump.expand_rate_release };
        let step = rate * dt;
        self.expand = if (target - self.expand).abs() <= step { target } else { self.expand + step * (target - self.expand).signum() };

        // Rope swinging (3.0).
        if let Some(g) = self.grab.clone() {
            if pressed {
                self.release_grab(world);
                let dir = if stick.x.abs() > 0.2 { stick.x.signum() } else { vel.x.signum() };
                let b = world.body_mut(self.body).unwrap();
                b.add_velocity(Vec2::new(dir * t.vine.jump_x, t.vine.jump_y) * g_scale.sqrt());
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
            b.add_accel(Vec2::new(stick.x * t.vine.swing_accel * strength, 0.0));
            b.rest_scale = self.expand;
            b.squash = Vec2::ONE;
            return None;
        }

        let b = world.body_mut(self.body).unwrap();
        b.rest_scale = self.expand;

        // ── Sticky walls: cling (no gravity, held still) until the button
        // launches you along the stick (or straight off the wall).
        if self.stuck.is_none() && self.stick_grace <= 0.0 && self.sticky_count >= t.sticky.min_contacts {
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
                b.add_velocity(aim * t.sticky.jump * strength);
                b.params.gravity_scale = g_scale;
                self.stuck = None;
                self.stick_grace = t.sticky.release_grace;
                self.jump_buffer = 0.0;
                return Some(Action::WallJump);
            }
            return None;
        }
        b.params.gravity_scale = g_scale;

        // Springs stiffen while expanding.
        b.spring_scale = if self.input.button { t.jump.expand_spring_mult } else { 1.0 };

        // Contact frame: +1 floor, ~0 wall, -1 ceiling.
        let on_floor = self.grounded;
        let up_dot = if self.touching { self.contact_normal.dot(up) } else if on_floor { 1.0 } else { 0.0 };

        // Lateral: along the gravity-relative floor tangent; full on a floor,
        // throttled on walls/ceilings and in the air.
        // Clinging under a roof (stick up, something overhead, roof-ish
        // contact, not standing on anything).
        if self.overhead && !on_floor && up_dot < -0.3 {
            self.ceiling_t = 0.3;
        } else {
            self.ceiling_t = (self.ceiling_t - dt).max(0.0);
        }
        let under_ceiling = stick.y > 0.1 && self.ceiling_t > 0.0 && !on_floor;
        let lateral = if on_floor {
            1.0
        } else if under_ceiling {
            t.movement.ceiling
        } else if self.touching {
            t.movement.wall
        } else {
            t.movement.air
        };
        // Soft top speed: the stick pushes less as you approach max_speed in
        // the direction you're steering (gravity, slopes and springs can
        // still take you faster).
        let along = vel.dot(right) * stick.x.signum();
        let frac = (along / t.movement.max_speed).max(0.0);
        let room = (1.0 - frac * frac).clamp(0.0, 1.0);
        b.add_accel(right * stick.x * t.movement.accel * strength * lateral * room);

        // Downhill momentum: a rolling soft blob loses energy where it
        // squashes onto the floor (∝ v²; it's what caps flat speed). Going
        // downhill, refund it so slopes build real speed (unless the stick
        // is braking).
        if on_floor && t.movement.roll_refund > 0.0 {
            let n = self.ground_normal;
            let dh = down - n * down.dot(n);
            let sin = dh.length();
            if sin > 0.03 {
                let dir = dh / sin;
                let vt = vel.dot(dir).max(0.0);
                let braking = stick.x * dir.dot(right) < -0.2;
                if vt > 0.0 && !braking {
                    let full = (sin / t.movement.refund_slope.max(0.01)).min(1.0);
                    // Fades out toward refund_top so it can never run away.
                    let top = (vt / t.movement.refund_top.max(1.0)).min(1.0);
                    b.add_accel(dir * (t.movement.roll_refund * vt * vt * full * (1.0 - top * top)));
                }
            }
        }

        // A ground jump keeps its ground speed: swelling off a ramp shoves
        // along the ramp's normal, which would kill a run-up.
        self.jump_carry_t = (self.jump_carry_t - dt).max(0.0);
        if pressed && on_floor && self.puff.is_none() {
            self.jump_carry = vel.dot(right);
            self.jump_carry_t = 0.2;
        }
        if self.jump_carry_t > 0.0 && self.input.button && t.movement.jump_keep > 0.0 {
            let keep = self.jump_carry * t.movement.jump_keep;
            let cur = vel.dot(right);
            let blocked = self.touching && self.contact_normal.dot(right) * keep.signum() < -0.6;
            if !blocked && keep.abs() > 60.0 && cur * keep.signum() < keep.abs() {
                b.add_velocity(right * (keep - cur));
            }
        }

        // Stick down: press into the floor (fall faster) and squash flat.
        // Stick up: float — gentle in the air, a clamber when something's
        // overhead, weaker up a bare wall.
        if stick.y < -0.1 {
            b.add_accel(down * t.stick.down_accel * -stick.y * strength);
        } else if stick.y > 0.1 {
            if under_ceiling {
                // Just enough to stay stuck: pressing harder only adds
                // friction (it's what made ceilings crawl).
                // Plus a catch that cancels bouncing away from the roof.
                let away = (-vel.dot(up)).max(0.0);
                b.add_accel(up * (t.gravity.gravity * t.stick.ceiling_hold + away * 15.0));
            } else {
                let mult = if self.overhead { t.stick.ledge_up_mult } else { 1.0 };
                let climb = if self.touching && up_dot.abs() < 0.5 && !self.overhead { t.stick.wall_climb_mult } else { 1.0 };
                b.add_accel(up * t.stick.up_accel * mult * climb * stick.y * strength);
            }
        }
        self.crouch = (-stick.y).max(0.0);
        // Squash in the gravity frame (wide along `right`, flat along `up`).
        let sx = 1.0 + t.stick.squash_x * self.crouch;
        let sy = 1.0 - t.stick.squash_y * self.crouch;
        b.squash = Vec2::new((right.x * sx).abs() + (up.x * sy).abs(), (right.y * sx).abs() + (up.y * sy).abs());

        if pressed && (self.touching || on_floor) && self.puff.is_none() {
            action = Some(Action::Jump);
        }

        // Swim kick (3.0): in water the button kicks you up and out.
        self.swim_cooldown = (self.swim_cooldown - dt).max(0.0);
        let pushing_bank = self.input.button && stick.x.abs() > 0.5 && vel.x.abs() < 60.0;
        if self.in_water > 0.2 && !on_floor && (self.jump_buffer > 0.0 || pushing_bank) && self.swim_cooldown <= 0.0 {
            let vy = vel.y.max(0.0);
            b.add_velocity(Vec2::new(stick.x * 120.0, t.water.swim_kick * g_scale.sqrt() * strength - vy));
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
        if self.grab.is_none() && !self.grounded {
            let c = body.centroid();
            // Swept: test the path since last step, so a fast blob can't
            // pass through a vine between frames.
            let from = c - vel * _dt;
            // Generous: grabbing a vine you brushed should just work.
            let reach = self.radius * self.expand.min(1.3) + 18.0;
            let mut best: Option<(usize, u32, f32)> = None;
            for (ri, r) in ropes.iter().enumerate() {
                if !r.grabbable || (self.grab_cooldown > 0.0 && self.last_rope == Some(ri)) {
                    continue;
                }
                let Some(rope) = world.rope(r.rope) else { continue };
                let Some(chain) = world.body(rope.body) else { continue };
                let sweep = bb_physics::Aabb::from_points([from, c].into_iter()).expand(reach);
                if !chain.aabb.overlaps(&sweep) {
                    continue;
                }
                for (i, p) in chain.x.iter().enumerate().skip(1) {
                    let d = bb_physics::geom::closest_on_segment(*p, from, c).0.distance(*p);
                    if d < reach && best.is_none_or(|b| d < b.2) {
                        best = Some((ri, i as u32, d));
                    }
                }
            }
            if let Some((ri, node, _)) = best {
                let rb = world.rope(ropes[ri].rope).unwrap().body;
                // Catch gently: lose a little speed, and pre-swing the vine
                // with the blob (anchor still, grab point at our speed) so it
                // swings as a whole instead of whipping one segment.
                let catch = vel * 0.8;
                if let Some(b) = world.body_mut(self.body) {
                    b.add_velocity(catch - vel);
                }
                if let Some(chain) = world.body_mut(rb) {
                    let k = node.max(1) as f32;
                    for i in 0..chain.v.len() {
                        if chain.w[i] > 0.0 {
                            chain.v[i] = catch * (i as f32 / k).min(1.0);
                        }
                    }
                }
                let anchor = Anchor::centre(world, self.body).unwrap();
                let joint = world.add_joint(Joint::pin(anchor, Anchor::particle(rb, node)).with_compliance(2e-6));
                self.grab = Some(Grab { rope: ri, node, joint });
                return Some(Action::Grab);
            }
        }
        None
    }
}
