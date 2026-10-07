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
    /// Trapped NPCs become followers once freed.
    pub following: bool,
    timer: f32,
    target: Vec2,
    stuck_for: f32,
    rng: u32,
}

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
        }
        if def.role == NpcRole::Trapped {
            b.anchor_home(5e-7);
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
        let Some(b) = sim.world.body(n.ctl.body) else { continue };
        let c = b.centroid();
        let v = b.velocity();
        n.timer -= dt;
        let nearest = players.iter().copied().min_by(|a, b| a.distance(c).total_cmp(&b.distance(c)));
        let mut input = Input::default();
        match n.role {
            NpcRole::Trapped if !n.following => {
                if nearest.is_some_and(|p| p.distance(c) < n.ctl.radius + 48.0) {
                    n.following = true;
                    freed.push(n.index);
                }
                // Wriggle hopefully.
                if n.timer <= 0.0 {
                    n.timer = 0.6 + n.rand();
                    input.button = true;
                }
            }
            NpcRole::Glimmer => {
                // Hover near the nearest player (or home), bobbing.
                let anchor = nearest.map(|p| p + Vec2::new(-70.0, 90.0)).unwrap_or(n.home);
                let bob = Vec2::new(0.0, (sim.time * 2.3 + n.index as f32).sin() * 12.0);
                let want = (anchor + bob - c) * 4.0 - v;
                let bm = sim.world.body_mut(n.ctl.body).unwrap();
                bm.add_accel(want * 6.0);
                continue;
            }
            NpcRole::Huddle | NpcRole::Granny | NpcRole::Reg if !n.following => {
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
                if d.length() > 1100.0 {
                    // Lost: hop back to the group.
                    let at = p + Vec2::new(-80.0, 80.0);
                    sim.world.respawn(n.ctl.body, at);
                    n.ctl.reset();
                    continue;
                }
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
                b.home = None;
            }
        }
        sim.events.push(SimEvent::NpcFreed { index: i });
    }
}
