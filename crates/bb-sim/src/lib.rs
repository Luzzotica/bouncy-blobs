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
pub mod tuning;

use std::collections::HashMap;

use bb_level::{Level, Mover, NpcRole, RopeStyle, SpringPad};
pub use bb_physics::{self as physics, BodyId, Vec2, World};
use bb_physics::{Collider, Config, Event, RopeId, StaticId};

pub use control::{Action, Controller, Input};
pub use npc::Npc;

pub const DT: f32 = 1.0 / 60.0;
/// Seconds between popping and reforming at a checkpoint.
pub const RESPAWN_DELAY: f32 = 1.1;
/// Seconds a pop's droplets lie about (plus up to 3 s of variety)…
pub const DROPLET_LIFE: f32 = 42.0;
/// …melting away over the last this-many seconds.
pub const DROPLET_MELT: f32 = 3.0;
/// At most this many droplets at once (the oldest melt first).
pub const MAX_DROPLETS: usize = 60;

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum BodyTag {
    Player(u8),
    Npc(u16),
    Prop,
    Jelly,
    Platform,
    Rope,
    Ui,
    /// An edible amoeba (index into `level.pickups`).
    Amoeba(u16),
    /// A droplet left by a popped blob (its colour, 0xRRGGBB).
    Droplet(u32),
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
    /// Plate-driven movers: 0 = authored pose, 1 = end of the path.
    pub progress: f32,
    /// Plate-driven movers: latched open (`#toggle` / `#once`).
    pub latched: bool,
    /// Plate condition last step (edge detection for `#toggle`).
    pub pressed: bool,
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
    /// Ate an amoeba: the eater turns its colour.
    Pickup { index: usize, pos: Vec2, slot: u8, color: u32 },
    Goal { slot: u8 },
    Story { script: String, slot: u8 },
    Impact { body: BodyId, pos: Vec2, speed: f32 },
    /// Two bodies hit each other (`normal` points from `b` toward `a`).
    Bump { a: BodyId, b: BodyId, pos: Vec2, normal: Vec2, speed: f32 },
    Spring { index: usize },
    Action { who: Who, action: Action },
    NpcFreed { index: u16 },
    /// A blob was squeezed next to a crush but spared.
    Phew { body: BodyId },
}

pub struct Sim {
    pub world: World,
    /// Blob feel (from `tuning.toml`); see [`Sim::set_tuning`].
    pub tuning: tuning::Tuning,
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
    /// Living amoebas, one per pickup (None once eaten).
    pub amoebas: Vec<Option<BodyId>>,
    /// Droplets from popped blobs: (body, seconds left), oldest first.
    pub droplets: Vec<(BodyId, f32)>,
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
            tuning: tuning::current(),
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
            amoebas: Vec::new(),
            droplets: Vec::new(),
            story_fired: vec![false; level.story.len()],
            completed: false,
            time: 0.0,
            events: Vec::new(),
            rules: Rules::default(),
            input_frozen: false,
            level: level.clone(),
        };
        load::load(&mut sim, &level);
        for i in 0..level.pickups.len() {
            let id = load::spawn_amoeba(&mut sim.world, level.pickups[i], i);
            sim.tags.insert(id, BodyTag::Amoeba(i as u16));
            sim.amoebas.push(Some(id));
        }
        for (i, n) in level.npcs.iter().enumerate() {
            let npc = Npc::spawn(&mut sim.world, i as u16, n);
            npc::lift_clear(&mut sim.world, npc.ctl.body);
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

    /// A popped blob bursts into a handful of small soft droplets in its
    /// colour: they fly apart, roll, can be pushed around, then melt away.
    fn spawn_droplets(&mut self, body: BodyId, pos: Vec2, color: u32) {
        let (vel, r) = self.world.body(body).map_or((Vec2::ZERO, 32.0), |b| (b.velocity(), (b.rest_area.abs() / std::f32::consts::PI).sqrt()));
        let n = 6;
        for k in 0..n {
            let a = k as f32 / n as f32 * std::f32::consts::TAU + 0.4;
            let dir = Vec2::new(a.cos(), a.sin());
            // On a ring wide enough that they don't overlap (overlap shoves
            // them apart violently).
            let rad = r * (0.28 + 0.04 * ((k * 5 % 3) as f32));
            let mut d = physics::BodyDesc::blob(pos + dir * r * 0.8, rad, 10, 0.12);
            d.params.shape_compliance = Some(3e-3);
            d.params.volume_compliance = 1e-6;
            d.params.edge_compliance = 1e-5;
            d.params.internal_damping = 3.0;
            d.params.radius = 1.5;
            // Crushable: an unbreakable droplet ground into jelly by a
            // crusher makes the jelly lurch. Popping just removes it.
            d.params.material = physics::Material { static_friction: 0.8, dynamic_friction: 0.6, restitution: 0.1 };
            d.layer = load::layer::PROP;
            let id = self.add_body(d, BodyTag::Droplet(color));
            if let Some(b) = self.world.body_mut(id) {
                b.add_velocity(vel * 0.4 + dir * 220.0 + Vec2::new(0.0, 180.0));
            }
            self.droplets.push((id, DROPLET_LIFE + (k % 3) as f32 * 1.5));
        }
        // Too many lying about: the oldest melt away first.
        let alive = self.droplets.iter().filter(|d| d.1 > DROPLET_MELT).count();
        if alive > MAX_DROPLETS {
            let mut excess = alive - MAX_DROPLETS;
            for d in self.droplets.iter_mut() {
                if excess == 0 {
                    break;
                }
                if d.1 > DROPLET_MELT {
                    d.1 = DROPLET_MELT;
                    excess -= 1;
                }
            }
        }
    }

    fn update_droplets(&mut self, dt: f32) {
        let mut gone = Vec::new();
        for (id, t) in self.droplets.iter_mut() {
            *t -= dt;
            if let Some(b) = self.world.body_mut(*id) {
                // Droplets born squeezed (e.g. under a crusher) get shoved out
                // hard; never let them fly like bullets.
                let v = b.velocity();
                let sp = v.length();
                if sp > 650.0 {
                    b.add_velocity(-v * (1.0 - 650.0 / sp));
                }
                // Melt away over the last few seconds.
                let melt = if *t < DROPLET_MELT { *t / DROPLET_MELT } else { 1.0 };
                if melt < 1.0 {
                    b.rest_scale = (0.25 + 0.75 * melt.max(0.0)).max(0.25);
                }
            }
            if *t <= 0.0 {
                gone.push(*id);
            }
        }
        self.droplets.retain(|d| d.1 > 0.0);
        for id in gone {
            self.remove_body(id);
        }
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
                    self.spawn_droplets(body, pos, color);
                }
            }
            Some(BodyTag::Npc(i)) => {
                if let Some(n) = self.npcs.get_mut(i as usize) {
                    n.dead = Some(RESPAWN_DELAY);
                    n.ctl.grab = None;
                    let color = n.color;
                    self.events.push(SimEvent::Popped { who: Who::Npc(i), pos, color });
                    self.spawn_droplets(body, pos, color);
                }
            }
            _ => {}
        }
    }

    /// Swap in new blob tuning (live edits), updating every blob body.
    pub fn set_tuning(&mut self, t: tuning::Tuning) {
        for p in &self.players {
            p.ctl.apply_tuning(&mut self.world, &t);
        }
        for n in &self.npcs {
            n.ctl.apply_tuning(&mut self.world, &t);
        }
        self.tuning = t;
    }

    pub fn step(&mut self) {
        let dt = DT;
        self.time += dt;
        self.update_droplets(dt);
        runtime::pre_step(self, dt);

        let ropes = std::mem::take(&mut self.ropes);
        for p in self.players.iter_mut() {
            if p.dead.is_none() {
                if let Some(a) = p.ctl.pre_step(&mut self.world, &ropes, &self.tuning, dt) {
                    self.events.push(SimEvent::Action { who: Who::Player(p.slot), action: a });
                }
            }
        }
        npc::think(self, &ropes, dt);
        for n in self.npcs.iter_mut() {
            if n.dead.is_none() {
                n.ctl.pre_step(&mut self.world, &ropes, &self.tuning, dt);
            }
        }

        self.world.step(dt);

        for e in self.world.drain_events() {
            match e {
                Event::Popped { body, position, .. } => self.on_popped(body, position),
                Event::Spared { body } => self.events.push(SimEvent::Phew { body }),
                Event::Impact { body, point, speed, other, normal } => {
                    if let physics::Collider::Body(o) = other {
                        self.events.push(SimEvent::Bump { a: body, b: o, pos: point, normal, speed });
                    }
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

/// Amoeba colours: bright, edible-looking, all distinct from black stone.
pub const AMOEBA_COLORS: [u32; 8] = [0x7cf5c1, 0xffe066, 0xff8fd8, 0x8fd3ff, 0xc6a3ff, 0xffb36b, 0xa6f56a, 0xff7a8a];

pub fn amoeba_color(index: usize) -> u32 {
    AMOEBA_COLORS[(index * 3 + index / 7) % AMOEBA_COLORS.len()]
}

/// The 12-colour player palette shared with the phone controller.
pub const PALETTE: [u32; 12] = [
    0xff5d73, 0xff9f43, 0xffd93d, 0x6bcb77, 0x4d96ff, 0x9b5de5, 0xf15bb5, 0x00c2a8, 0x5dd6ff, 0xa0e426, 0xff7eb6, 0xb8a1ff,
];
