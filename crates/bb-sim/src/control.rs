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


pub mod tune {
    use bb_physics::Vec2;
    pub const RADIUS: f32 = 32.0;
    pub const SEGMENTS: usize = 22;
    pub const MASS: f32 = 1.0;
    pub const GROUND_ACCEL: f32 = 2400.0;
    pub const AIR_ACCEL: f32 = 1300.0;
    pub const TREAD_ACCEL: f32 = 1500.0;
    pub const MAX_SPEED: f32 = 560.0;
    pub const JUMP_SPEED: f32 = 930.0;
    pub const JUMP_CUT: f32 = 0.5;
    pub const COYOTE: f32 = 0.1;
    pub const JUMP_BUFFER: f32 = 0.12;
    pub const EXPAND_SCALE: f32 = 1.28;
    pub const EXPAND_RATE: f32 = 14.0;
    pub const RELAX_RATE: f32 = 7.0;
    pub const SWING_ACCEL: f32 = 1100.0;
    pub const CLIMB_INTERVAL: f32 = 0.09;
    pub const GRAB_COOLDOWN: f32 = 0.35;
    pub const ROPE_JUMP: Vec2 = Vec2::new(380.0, 720.0);
    pub const WALL_JUMP: Vec2 = Vec2::new(560.0, 860.0);
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
    since_ground: f32,
    jump_buffer: f32,
    jumping: bool,
    pub grab: Option<Grab>,
    grab_cooldown: f32,
    climb_timer: f32,
    pub stuck: Option<Vec2>,
    /// Movement strength multiplier (NPCs are a bit slower).
    pub strength: f32,
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
        // Shape matching is what makes a blob feel rigid: at 720 Hz substeps
        // a compliance around 1e-5 snaps ~50% back to shape every substep.
        // 3e-3 gives a ~1.5× squash on a hard landing and still recovers.
        d.params.volume_compliance = 1e-6;
        d.params.shape_compliance = Some(3e-3);
        d.params.edge_compliance = 1e-5;
        d.params.internal_damping = 3.0;
        d.params.linear_damping = 0.0;
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
            since_ground: 1.0,
            jump_buffer: 0.0,
            jumping: false,
            grab: None,
            grab_cooldown: 0.0,
            climb_timer: 0.0,
            stuck: None,
            strength: 1.0,
        }
    }

    pub fn reset(&mut self) {
        self.prev_button = self.input.button;
        self.expand = 1.0;
        self.grounded = false;
        self.since_ground = 1.0;
        self.jump_buffer = 0.0;
        self.jumping = false;
        self.grab = None;
        self.stuck = None;
    }

    pub fn release_grab(&mut self, world: &mut World) {
        if let Some(g) = self.grab.take() {
            world.remove_joint(g.joint);
            self.grab_cooldown = tune::GRAB_COOLDOWN;
        }
    }

    /// Apply input before the physics step.
    pub fn pre_step(&mut self, world: &mut World, ropes: &[crate::RopeState], dt: f32) -> Option<Action> {
        let mut action = None;
        let pressed = self.input.button && !self.prev_button;
        let released = !self.input.button && self.prev_button;
        self.prev_button = self.input.button;
        self.grab_cooldown = (self.grab_cooldown - dt).max(0.0);
        if pressed {
            self.jump_buffer = tune::JUMP_BUFFER;
        } else {
            self.jump_buffer = (self.jump_buffer - dt).max(0.0);
        }
        let stick = self.input.stick.clamp_length_max(1.0);
        let strength = self.strength;
        let Some(body) = world.body(self.body) else { return None };
        if !body.enabled {
            return None;
        }
        let vel = body.velocity();

        // Expand / relax.
        let target = if self.input.button { tune::EXPAND_SCALE } else { 1.0 };
        let rate = if target > self.expand { tune::EXPAND_RATE } else { tune::RELAX_RATE };
        self.expand += (target - self.expand) * (1.0 - (-rate * dt).exp());

        // Rope swinging.
        if let Some(g) = self.grab.clone() {
            if pressed {
                self.release_grab(world);
                let dir = if stick.x.abs() > 0.2 { stick.x.signum() } else { vel.x.signum() };
                let b = world.body_mut(self.body).unwrap();
                b.add_velocity(Vec2::new(dir * tune::ROPE_JUMP.x, tune::ROPE_JUMP.y));
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
            b.add_accel(Vec2::new(stick.x * tune::SWING_ACCEL * strength, 0.0));
            b.rest_scale = self.expand;
            return None;
        }

        let b = world.body_mut(self.body).unwrap();
        b.rest_scale = self.expand;

        // Sticky cling + wall jump.
        if let Some(n) = self.stuck {
            b.params.gravity_scale = 0.12;
            if self.jump_buffer > 0.0 {
                b.add_velocity(-vel * 0.8);
                b.add_velocity(Vec2::new(n.x.signum() * tune::WALL_JUMP.x, tune::WALL_JUMP.y));
                self.jump_buffer = 0.0;
                self.stuck = None;
                self.jumping = true;
                b.params.gravity_scale = 1.0;
                return Some(Action::WallJump);
            }
        } else {
            b.params.gravity_scale = 1.0;
        }

        // Run: direct accel (speed-limited) + tread so the outline rolls.
        let accel = if self.grounded { tune::GROUND_ACCEL } else { tune::AIR_ACCEL } * strength;
        let along = if self.grounded { self.ground_normal.perp() * -1.0 } else { Vec2::X };
        let along = if along.x < 0.0 { -along } else { along };
        let speed_along = vel.dot(along);
        let want = stick.x * tune::MAX_SPEED * strength;
        let push = if stick.x.abs() > 0.05 {
            let headroom = if want > 0.0 { (want - speed_along).max(0.0) } else { (want - speed_along).min(0.0) };
            (headroom / tune::MAX_SPEED).clamp(-1.0, 1.0) * accel
        } else if self.grounded {
            // Gentle braking so blobs don't skate forever.
            (-speed_along / tune::MAX_SPEED).clamp(-1.0, 1.0) * accel * 0.35
        } else {
            0.0
        };
        b.add_accel(along * push);
        if self.grounded && stick.x.abs() > 0.05 {
            let c = b.centroid();
            for k in 0..b.boundary.len() {
                let i = b.boundary[k] as usize;
                let r = b.x[i] - c;
                // Clockwise tangent rolls right for +x.
                let t = Vec2::new(r.y, -r.x).normalize_or_zero();
                b.add_point_accel(i, t * stick.x * tune::TREAD_ACCEL * strength);
            }
        }

        // Jump.
        let can_jump = self.grounded || self.since_ground < tune::COYOTE;
        if self.jump_buffer > 0.0 && can_jump && !self.jumping {
            let vy = vel.y.max(0.0);
            b.add_velocity(Vec2::new(0.0, tune::JUMP_SPEED * strength - vy));
            self.jump_buffer = 0.0;
            self.jumping = true;
            self.since_ground = 1.0;
            action = Some(Action::Jump);
        }
        if self.jumping && released && vel.y > 0.0 {
            b.add_velocity(Vec2::new(0.0, -vel.y * (1.0 - tune::JUMP_CUT)));
            self.jumping = false;
        }
        action
    }

    /// Read contacts after the physics step.
    pub fn post_step(&mut self, world: &mut World, ropes: &[crate::RopeState], sticky: &dyn Fn(Collider) -> bool, dt: f32) -> Option<Action> {
        let Some(body) = world.body(self.body) else { return None };
        if !body.enabled {
            return None;
        }
        let vel = body.velocity();
        let mut ground = Vec2::ZERO;
        let mut count = 0;
        let mut stick_n: Option<Vec2> = None;
        for c in world.contacts_of(self.body) {
            if c.normal.y > 0.45 {
                ground += c.normal;
                count += 1;
            }
            if sticky(c.other) && c.normal.y < 0.6 {
                stick_n = Some(c.normal);
            }
        }
        let was = self.grounded;
        self.grounded = count > 0;
        if self.grounded {
            self.ground_normal = (ground / count as f32).normalize_or(Vec2::Y);
            self.since_ground = 0.0;
            if vel.y <= 50.0 {
                self.jumping = false;
            }
        } else {
            self.since_ground += dt;
        }
        let _ = was;
        self.stuck = if self.grounded { None } else { stick_n };

        // Grab a vine when touching one in the air.
        if self.grab.is_none() && !self.grounded && self.grab_cooldown <= 0.0 {
            let c = body.centroid();
            let reach = self.radius * self.expand + 8.0;
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
                self.jumping = false;
                return Some(Action::Grab);
            }
        }
        None
    }
}
