//! Bouncy Blobs gameplay simulation, engine-agnostic.
//!
//! `Sim` owns the physics world plus the level runtime (movers, zones,
//! springs, spikes, checkpoints, pickups, goal, story triggers), the players
//! and NPCs. Bevy renders it; the netcode syncs it; tests drive it headless.

pub mod control;
pub mod load;
pub mod modes;
pub mod npc;
mod runtime;

use std::collections::HashMap;

use bb_level::{Level, Mover, NpcRole, RopeStyle, SpringPad};
pub use bb_physics::{self as physics, BodyId, Vec2, World};
use bb_physics::{Collider, Config, Event, RopeId, StaticId};

pub use control::{Action, Controller, Input};
pub use npc::Npc;

pub const DT: f32 = 1.0 / 60.0;
/// Seconds between popping and reforming at a checkpoint.
pub const RESPAWN_DELAY: f32 = 1.1;

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum BodyTag {
    Player(u8),
    Npc(u16),
    Prop,
    Jelly,
    Platform,
    Rope,
    Ui,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub slot: u8,
    pub name: String,
    /// sRGB 0xRRGGBB.
    pub color: u32,
    pub face: u8,
    pub ctl: Controller,
    /// Seconds until respawn while popped.
    pub dead: Option<f32>,
    pub pickups: u32,
    pub finished: bool,
    /// Simulated locally (true) or mirrored from a remote owner (false).
    pub local: bool,
}

#[derive(Clone, Debug)]
pub struct MoverState {
    pub def: Mover,
    pub id: StaticId,
    pub base: Vec<Vec2>,
    pub active: bool,
}

#[derive(Clone, Debug)]
pub struct RopeState {
    pub id: String,
    pub rope: RopeId,
    pub grabbable: bool,
    pub style: RopeStyle,
}

#[derive(Clone, Debug)]
pub struct SpringState {
    pub def: SpringPad,
    pub id: StaticId,
    pub cooldown: f32,
    /// 0..1 visual compression.
    pub squash: f32,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Who {
    Player(u8),
    Npc(u16),
}

#[derive(Clone, Debug, PartialEq)]
pub enum SimEvent {
    Popped { who: Who, pos: Vec2, color: u32 },
    Respawned { who: Who, pos: Vec2 },
    Checkpoint { index: usize, pos: Vec2 },
    Pickup { index: usize, pos: Vec2, slot: u8 },
    Goal { slot: u8 },
    Story { script: String, slot: u8 },
    Impact { body: BodyId, pos: Vec2, speed: f32 },
    Spring { index: usize },
    Action { who: Who, action: Action },
    NpcFreed { index: u16 },
}

pub struct Sim {
    pub world: World,
    pub level: Level,
    pub tags: HashMap<BodyId, BodyTag>,
    pub players: Vec<Player>,
    pub npcs: Vec<Npc>,
    pub props: Vec<BodyId>,
    pub jelly: Vec<(BodyId, bb_level::Material)>,
    pub platforms: Vec<BodyId>,
    pub terrain: Vec<(StaticId, bb_level::Material, bool)>,
    pub movers: Vec<MoverState>,
    pub ropes: Vec<RopeState>,
    pub springs: Vec<SpringState>,
    /// Highest checkpoint reached (index into `level.respawn_points()`).
    pub checkpoint: usize,
    pub collected: Vec<bool>,
    pub story_fired: Vec<bool>,
    pub completed: bool,
    pub time: f32,
    pub events: Vec<SimEvent>,
    /// Gameplay toggles (Kids Mode disables popping, etc.).
    pub rules: Rules,
    /// Ignore player input (match countdown / results).
    pub input_frozen: bool,
}

#[derive(Clone, Debug)]
pub struct Rules {
    pub players_pop: bool,
    pub respawn_delay: f32,
    /// Players collide with each other.
    pub player_collisions: bool,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { players_pop: true, respawn_delay: RESPAWN_DELAY, player_collisions: true }
    }
}

impl Sim {
    pub fn new(level: Level) -> Sim {
        let mut sim = Sim {
            world: World::new(Config::default()),
            tags: HashMap::new(),
            players: Vec::new(),
            npcs: Vec::new(),
            props: Vec::new(),
            jelly: Vec::new(),
            platforms: Vec::new(),
            terrain: Vec::new(),
            movers: Vec::new(),
            ropes: Vec::new(),
            springs: Vec::new(),
            checkpoint: 0,
            collected: vec![false; level.pickups.len()],
            story_fired: vec![false; level.story.len()],
            completed: false,
            time: 0.0,
            events: Vec::new(),
            rules: Rules::default(),
            input_frozen: false,
            level: level.clone(),
        };
        load::load(&mut sim, &level);
        for (i, n) in level.npcs.iter().enumerate() {
            let npc = Npc::spawn(&mut sim.world, i as u16, n);
            sim.tags.insert(npc.ctl.body, BodyTag::Npc(i as u16));
            sim.npcs.push(npc);
        }
        sim
    }

    /// Where players (re)appear now.
    pub fn respawn_point(&self) -> Vec2 {
        let pts = self.level.respawn_points();
        pts[self.checkpoint.min(pts.len() - 1)]
    }

    pub fn add_player(&mut self, slot: u8, name: &str, color: u32) -> &mut Player {
        self.remove_player(slot);
        let n = self.players.len() as f32;
        let at = self.respawn_point() + Vec2::new((n - 1.5) * 18.0, 40.0 + n * 10.0);
        let ctl = Controller::spawn(&mut self.world, at, control::tune::RADIUS, load::layer::PLAYER);
        self.tags.insert(ctl.body, BodyTag::Player(slot));
        if !self.rules.players_pop {
            self.world.body_mut(ctl.body).unwrap().params.limits.poppable = false;
        }
        if !self.rules.player_collisions {
            self.world.body_mut(ctl.body).unwrap().mask &= !load::layer::PLAYER;
        }
        self.players.push(Player {
            slot,
            name: name.into(),
            color,
            face: 0,
            ctl,
            dead: None,
            pickups: 0,
            finished: false,
            local: true,
        });
        self.players.last_mut().unwrap()
    }

    pub fn remove_player(&mut self, slot: u8) {
        if let Some(i) = self.players.iter().position(|p| p.slot == slot) {
            let mut p = self.players.remove(i);
            p.ctl.release_grab(&mut self.world);
            self.tags.remove(&p.ctl.body);
            self.world.remove_body(p.ctl.body);
        }
    }

    pub fn player(&self, slot: u8) -> Option<&Player> {
        self.players.iter().find(|p| p.slot == slot)
    }

    pub fn player_mut(&mut self, slot: u8) -> Option<&mut Player> {
        self.players.iter_mut().find(|p| p.slot == slot)
    }

    pub fn set_input(&mut self, slot: u8, input: Input) {
        let input = if self.input_frozen { Input::default() } else { input };
        if let Some(p) = self.player_mut(slot) {
            p.ctl.input = input;
        }
    }

    pub fn drain_events(&mut self) -> Vec<SimEvent> {
        std::mem::take(&mut self.events)
    }

    /// Pop a body immediately (spikes, kill zones, falling out).
    pub fn pop(&mut self, body: BodyId) {
        let Some(b) = self.world.body_mut(body) else { return };
        if !b.enabled {
            return;
        }
        if let Some(BodyTag::Player(_)) = self.tags.get(&body) {
            if !self.rules.players_pop {
                // Kids mode: no popping, just bounce home.
                let at = self.respawn_point();
                self.world.respawn(body, at);
                return;
            }
        }
        let pos = b.centroid();
        b.enabled = false;
        self.on_popped(body, pos);
    }

    fn on_popped(&mut self, body: BodyId, pos: Vec2) {
        match self.tags.get(&body).copied() {
            Some(BodyTag::Player(slot)) => {
                let delay = self.rules.respawn_delay;
                if let Some(p) = self.player_mut(slot) {
                    p.dead = Some(delay);
                    let color = p.color;
                    p.ctl.grab = None;
                    self.events.push(SimEvent::Popped { who: Who::Player(slot), pos, color });
                }
            }
            Some(BodyTag::Npc(i)) => {
                if let Some(n) = self.npcs.get_mut(i as usize) {
                    n.dead = Some(RESPAWN_DELAY);
                    n.ctl.grab = None;
                    let color = n.color;
                    self.events.push(SimEvent::Popped { who: Who::Npc(i), pos, color });
                }
            }
            _ => {}
        }
    }

    pub fn step(&mut self) {
        let dt = DT;
        self.time += dt;
        runtime::pre_step(self, dt);

        let ropes = std::mem::take(&mut self.ropes);
        for p in self.players.iter_mut() {
            if p.dead.is_none() {
                if let Some(a) = p.ctl.pre_step(&mut self.world, &ropes, dt) {
                    self.events.push(SimEvent::Action { who: Who::Player(p.slot), action: a });
                }
            }
        }
        npc::think(self, &ropes, dt);
        for n in self.npcs.iter_mut() {
            if n.dead.is_none() {
                n.ctl.pre_step(&mut self.world, &ropes, dt);
            }
        }

        self.world.step(dt);

        for e in self.world.drain_events() {
            match e {
                Event::Popped { body, position, .. } => self.on_popped(body, position),
                Event::Impact { body, point, speed, .. } => {
                    self.events.push(SimEvent::Impact { body, pos: point, speed })
                }
                _ => {}
            }
        }

        let sticky_statics: Vec<StaticId> =
            self.terrain.iter().filter(|t| t.1 == bb_level::Material::Sticky).map(|t| t.0).collect();
        let sticky_bodies: Vec<BodyId> =
            self.jelly.iter().filter(|j| j.1 == bb_level::Material::Sticky).map(|j| j.0).collect();
        let sticky = |c: Collider| match c {
            Collider::Static(s) => sticky_statics.contains(&s),
            Collider::Body(b) => sticky_bodies.contains(&b),
        };
        for p in self.players.iter_mut() {
            if p.dead.is_none() {
                if let Some(a) = p.ctl.post_step(&mut self.world, &ropes, &sticky, dt) {
                    self.events.push(SimEvent::Action { who: Who::Player(p.slot), action: a });
                }
            }
        }
        for n in self.npcs.iter_mut() {
            if n.dead.is_none() {
                n.ctl.post_step(&mut self.world, &ropes, &sticky, dt);
            }
        }
        self.ropes = ropes;

        runtime::post_step(self, dt);
    }

    /// Bodies that belong to a role, for rendering.
    pub fn tag(&self, id: BodyId) -> Option<BodyTag> {
        self.tags.get(&id).copied()
    }

    /// Add an arbitrary body (menu buttons, title letters, cutscene props).
    pub fn add_body(&mut self, desc: physics::BodyDesc, tag: BodyTag) -> BodyId {
        let id = self.world.add_body(desc);
        self.tags.insert(id, tag);
        id
    }

    pub fn remove_body(&mut self, id: BodyId) {
        self.tags.remove(&id);
        self.world.remove_body(id);
    }

    pub fn npc_by_id(&self, id: &str) -> Option<&Npc> {
        self.npcs.iter().find(|n| n.id == id)
    }

    pub fn npc_by_id_mut(&mut self, id: &str) -> Option<&mut Npc> {
        self.npcs.iter_mut().find(|n| n.id == id)
    }

    pub fn npc_role(&self, i: u16) -> Option<&NpcRole> {
        self.npcs.get(i as usize).map(|n| &n.role)
    }
}

/// Parse "#rrggbb" (or "rrggbb") into 0xRRGGBB.
pub fn parse_color(s: &str) -> Option<u32> {
    let s = s.trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    u32::from_str_radix(s, 16).ok()
}

/// The 12-colour player palette shared with the phone controller.
pub const PALETTE: [u32; 12] = [
    0xff5d73, 0xff9f43, 0xffd93d, 0x6bcb77, 0x4d96ff, 0x9b5de5, 0xf15bb5, 0x00c2a8, 0x5dd6ff, 0xa0e426, 0xff7eb6, 0xb8a1ff,
];
