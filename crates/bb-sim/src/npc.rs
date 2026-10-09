//! NPC blobs: the Huddle, followers, wanderers, and the story cast.

use bb_level::{self as lvl, NpcRole};
use bb_physics::{BodyDesc, Vec2, World};

use crate::control::{Controller, Input};
use crate::load::layer;
use crate::{RopeState, Sim, SimEvent};

#[derive(Clone, Debug)]
pub struct Npc {
    pub index: u16,
    pub id: String,
    pub role: NpcRole,
    pub color: u32,
    pub ctl: Controller,
    pub home: Vec2,
    pub dead: Option<f32>,
    /// Trapped NPCs become followers once freed. Following lasts
    /// [`FOLLOW_TIME`] (or until the player gets far away); then they settle
    /// where they are and idle like any Huddle blob.
    pub following: bool,
    /// Freed from a trap (never re-trapped).
    pub freed: bool,
    /// Seconds of following left (followers) / of drifting after the player
    /// left (Glimmer).
    pub follow_t: f32,
    /// Seconds before a settled follower (or Glimmer) can tag along again.
    rejoin: f32,
    /// Driven by a cutscene: the AI leaves `ctl.input` alone.
    pub scripted: bool,
    timer: f32,
    target: Vec2,
    stuck_for: f32,
    rng: u32,
}

/// How long a freed blob follows you before settling down.
pub const FOLLOW_TIME: f32 = 25.0;
/// Glimmer drifts over to a player near her light for this long…
pub const GLIMMER_DRIFT: f32 = 4.0;
/// …then goes home and won't come over again for this long.
const GLIMMER_REST: f32 = 9.0;

const HUDDLE_COLORS: [u32; 6] = [0x8fd3ff, 0xffb3c7, 0xc6f68d, 0xffd88a, 0xd7b8ff, 0x9ff0e1];

impl Npc {
    pub fn spawn(world: &mut World, index: u16, def: &lvl::Npc) -> Npc {
        let color = crate::parse_color(&def.color).unwrap_or(match def.role {
            NpcRole::Granny => 0x7e6bd6,
            NpcRole::Glimmer => 0xfff3a3,
            NpcRole::Reg => 0xf2f2f2,
            _ => HUDDLE_COLORS[index as usize % HUDDLE_COLORS.len()],
        });
        let radius = match def.role {
            NpcRole::Granny => def.radius.max(70.0),
            NpcRole::Glimmer => 12.0,
            _ => def.radius,
        };
        let mut ctl = if def.role == NpcRole::Reg {
            // Reg is a sock.
            let outline = sock_outline(def.pos, radius);
            let mut d = BodyDesc::blob_from_outline(&outline, 1.2);
            d.params.shape_compliance = Some(2e-6);
            d.layer = layer::NPC;
            let body = world.add_body(d);
            let mut c = Controller::spawn(world, def.pos + Vec2::new(0.0, 5000.0), 1.0, 0);
            world.remove_body(c.body);
            c.body = body;
            c.radius = radius;
            // The sock isn't a 2.x blob: a full fast swell would launch it.
            // Its hop is a small puff.
            c.expand_scale = Some(1.12);
            c
        } else {
            Controller::spawn(world, def.pos, radius, layer::NPC)
        };
        ctl.strength = 0.8;
        let b = world.body_mut(ctl.body).unwrap();
        b.params.limits.poppable = def.role != NpcRole::Glimmer;
        if def.role == NpcRole::Glimmer {
            b.params.gravity_scale = 0.0;
            b.mask = layer::WORLD;
            // (The controller would otherwise put gravity back every step,
            // and she sagged a body-length under wherever she meant to be.)
            ctl.weightless = true;
        }
        if def.role == NpcRole::Trapped {
            b.anchor_home(5e-7);
        }
        if def.role == NpcRole::Follower {
            // Followers never shove the player off a ledge.
            b.mask &= !layer::PLAYER;
        }
        Npc {
            index,
            id: def.id.clone(),
            role: def.role.clone(),
            color,
            ctl,
            home: def.pos,
            dead: None,
            following: def.role == NpcRole::Follower,
            freed: false,
            follow_t: if def.role == NpcRole::Glimmer { 0.0 } else { FOLLOW_TIME },
            rejoin: 0.0,
            scripted: false,
            timer: 1.0 + index as f32 * 0.37,
            target: def.pos,
            stuck_for: 0.0,
            rng: 0x9e37_79b9 ^ (index as u32 + 1).wrapping_mul(0x85eb_ca6b),
        }
    }

    fn rand(&mut self) -> f32 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        (self.rng >> 8) as f32 / (1u32 << 24) as f32
    }
}

fn sock_outline(at: Vec2, r: f32) -> Vec<Vec2> {
    // An L-shaped sock: leg up top, foot pointing right.
    let s = r / 30.0;
    [
        (-14.0, 40.0),
        (14.0, 40.0),
        (14.0, 0.0),
        (40.0, -4.0),
        (46.0, -16.0),
        (38.0, -28.0),
        (-6.0, -28.0),
        (-14.0, -16.0),
    ]
    .iter()
    .map(|(x, y)| at + Vec2::new(*x, *y) * s)
    .collect()
}

pub(crate) fn think(sim: &mut Sim, _ropes: &[RopeState], dt: f32) {
    let players: Vec<Vec2> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .filter_map(|p| sim.world.body(p.ctl.body).map(|b| b.centroid()))
        .collect();
    let mut freed = Vec::new();
    for n in sim.npcs.iter_mut() {
        if n.dead.is_some() {
            continue;
        }
        if n.role == NpcRole::Reg {
            // Socks stand up (scripted or not): a gentle righting spin.
            if let Some(bm) = sim.world.body_mut(n.ctl.body) {
                let (a, spin) = (bm.angle(), bm.angular_velocity());
                bm.add_spin((-a * 8.0 - spin * 2.0) * dt);
            }
        }
        let Some(b) = sim.world.body(n.ctl.body) else { continue };
        let c = b.centroid();
        let v = b.velocity();
        let nearest = players.iter().copied().min_by(|a, b| a.distance(c).total_cmp(&b.distance(c)));
        if n.role == NpcRole::Glimmer {
            // Hover by her light (home), bobbing and drifting a little (also
            // in cutscenes). A player who comes close gets a brief visit,
            // then she goes back home.
            let near_home = nearest.filter(|p| p.distance(n.home) < 420.0 && !n.scripted);
            n.follow_t = (n.follow_t - dt).max(0.0);
            n.rejoin = (n.rejoin - dt).max(0.0);
            if n.rejoin <= 0.0 && n.follow_t <= 0.0 && near_home.is_some() {
                n.follow_t = GLIMMER_DRIFT;
                n.rejoin = GLIMMER_DRIFT + GLIMMER_REST;
            }
            let t = sim.time + n.index as f32 * 1.7;
            let bob = Vec2::new(0.0, (t * 2.3).sin() * 12.0);
            let idle = n.home + bob + Vec2::new((t * 0.6).sin() * 40.0, 0.0);
            let anchor = match nearest {
                Some(p) if n.follow_t > 0.0 && !n.scripted => {
                    // Never strays far from her light.
                    n.home + (p + Vec2::new(-70.0, 90.0) - n.home).clamp_length_max(380.0) + bob
                }
                _ => idle,
            };
            let want = (anchor - c) * 4.0 - v;
            let bm = sim.world.body_mut(n.ctl.body).unwrap();
            bm.add_accel(want.clamp_length_max(900.0) * 6.0);
            if !n.scripted {
                n.ctl.input = Input::default();
            }
            continue;
        }
        if n.scripted {
            continue;
        }
        n.timer -= dt;
        let mut input = Input::default();
        n.rejoin = (n.rejoin - dt).max(0.0);
        if n.following {
            n.follow_t -= dt;
            let far = nearest.is_none_or(|p| p.distance(c) > 1100.0);
            if n.follow_t <= 0.0 || far {
                // Had enough: settle down right here.
                n.following = false;
                n.home = c;
                n.rejoin = 8.0;
                n.timer = 1.0;
            }
        } else if (n.freed || n.role == NpcRole::Follower) && n.rejoin <= 0.0 && nearest.is_some_and(|p| p.distance(c) < n.ctl.radius + 48.0) {
            // Bumped into again: tag along for another stint.
            n.following = true;
            n.follow_t = FOLLOW_TIME;
        }
        match n.role {
            NpcRole::Trapped if !n.following && !n.freed => {
                if nearest.is_some_and(|p| p.distance(c) < n.ctl.radius + 48.0) {
                    n.following = true;
                    n.freed = true;
                    n.follow_t = FOLLOW_TIME;
                    freed.push(n.index);
                }
                // Wriggle hopefully.
                if n.timer <= 0.0 {
                    n.timer = 0.6 + n.rand();
                    input.button = true;
                }
            }
            NpcRole::Huddle | NpcRole::Granny | NpcRole::Reg | NpcRole::Trapped | NpcRole::Follower if !n.following => {
                if n.timer <= 0.0 {
                    n.timer = 1.5 + n.rand() * 3.0;
                    input.button = n.rand() < 0.5;
                }
                let dx = n.home.x - c.x;
                if dx.abs() > 60.0 {
                    input.stick.x = dx.signum() * 0.5;
                }
            }
            NpcRole::Wanderer => {
                if n.timer <= 0.0 {
                    n.timer = 2.5 + n.rand() * 3.5;
                    n.target = n.home + Vec2::new((n.rand() - 0.5) * 800.0, 0.0);
                }
                let dx = n.target.x - c.x;
                if dx.abs() > 30.0 {
                    input.stick.x = dx.signum() * 0.6;
                }
                input.button = n.rand() < 0.008;
            }
            _ => {
                // Follower (or freed): keep up with the nearest player.
                let Some(p) = nearest else { continue };
                let d = p - c;
                if d.x.abs() > 90.0 {
                    input.stick.x = d.x.signum();
                }
                let pushing = input.stick.x != 0.0 && v.x.abs() < 40.0;
                n.stuck_for = if pushing { n.stuck_for + dt } else { 0.0 };
                let want_jump = (d.y > 70.0 && d.x.abs() < 400.0) || n.stuck_for > 0.25;
                input.button = want_jump && n.ctl.grounded || (n.ctl.input.button && v.y > 0.0 && d.y > 0.0);
                if n.ctl.grab.is_some() && d.y < 0.0 {
                    input.button = true;
                }
            }
        }
        n.ctl.input = input;
    }
    for i in freed {
        if let Some(n) = sim.npcs.get(i as usize) {
            if let Some(b) = sim.world.body_mut(n.ctl.body) {
                // Free to roll (and still bumps into you: chaos).
                b.home = None;
            }
        }
        sim.events.push(SimEvent::NpcFreed { index: i });
    }
}
