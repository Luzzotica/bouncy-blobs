//! Juice: particles and anime-style onomatopoeia driven by sim events.

use std::collections::HashMap;

use bb_sim::{Action, SimEvent, Who};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::CameraDirector;
use crate::palette::{self, hex, lighten};
use crate::render::{Shared, z};
use crate::sim::{Game, SimMsg};
use crate::softtext::SoftText;

#[derive(Component)]
pub struct Particle {
    pub vel: Vec2,
    pub life: f32,
    pub max: f32,
    pub gravity: f32,
    pub size: f32,
    pub drag: f32,
}

/// A floating word ("POP!", "BOING!"): every letter is its own jelly glyph
/// on a spring — they burst out, wobble back into the word, float and fade.
#[derive(Component)]
pub struct Word {
    pub life: f32,
    pub max: f32,
    pub vel: Vec2,
}

#[derive(Resource, Default)]
pub struct MatCache(pub HashMap<u32, Handle<ColorMaterial>>);

impl MatCache {
    pub fn get(&mut self, mats: &mut Assets<ColorMaterial>, rgb: u32) -> Handle<ColorMaterial> {
        self.0.entry(rgb).or_insert_with(|| mats.add(ColorMaterial::from(hex(rgb)))).clone()
    }
}

pub struct FxPlugin;

impl Plugin for FxPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MatCache>()
            .add_systems(Update, (react.run_if(resource_exists::<Game>), animate))
            .add_systems(PostUpdate, clear.run_if(resource_removed::<Game>));
    }
}

/// Cheap deterministic noise so bursts look varied without an RNG resource.
fn hash(n: u32) -> f32 {
    let mut x = n.wrapping_mul(0x9E37_79B9) ^ 0x85EB_CA6B;
    x ^= x >> 15;
    x = x.wrapping_mul(0x2C1B_3C6D);
    x ^= x >> 12;
    (x & 0xFFFF) as f32 / 65535.0
}

pub struct Burst {
    pub pos: Vec2,
    pub color: u32,
    pub count: u32,
    pub speed: f32,
    pub size: f32,
    pub life: f32,
    pub gravity: f32,
    /// Particles start on a ring of this radius moving inward (reform).
    pub implode: f32,
}

pub fn burst(commands: &mut Commands, shared: &Shared, cache: &mut MatCache, mats: &mut Assets<ColorMaterial>, b: Burst, seed: u32) {
    let mat = cache.get(mats, b.color);
    for k in 0..b.count {
        let a = (k as f32 + hash(seed + k) * 0.8) / b.count as f32 * std::f32::consts::TAU;
        let dir = Vec2::new(a.cos(), a.sin());
        let sp = b.speed * (0.5 + hash(seed * 7 + k) * 0.8);
        let size = b.size * (0.6 + hash(seed * 13 + k) * 0.8);
        let (pos, vel) = if b.implode > 0.0 { (b.pos + dir * b.implode, -dir * b.implode / b.life) } else { (b.pos, dir * sp + Vec2::Y * sp * 0.3) };
        commands.spawn((
            Mesh2d(shared.circle.clone()),
            MeshMaterial2d(mat.clone()),
            Transform::from_xyz(pos.x, pos.y, z::FX + hash(seed + k * 3) * 0.1).with_scale(Vec3::splat(size)),
            Particle { vel, life: b.life, max: b.life, gravity: b.gravity, size, drag: if b.implode > 0.0 { 0.0 } else { 1.2 } },
        ));
    }
}

/// A directional spray: `count` particles leaving `pos` mostly along
/// `drift` (the motion of what collided), fanned by `spread` radians.
#[allow(clippy::too_many_arguments)]
pub fn spray(commands: &mut Commands, shared: &Shared, cache: &mut MatCache, mats: &mut Assets<ColorMaterial>, pos: Vec2, drift: Vec2, spread: f32, color: u32, count: u32, size: f32, seed: u32) {
    let mat = cache.get(mats, color);
    let base = drift.to_angle();
    let sp = drift.length();
    for k in 0..count {
        let a = base + (hash(seed + k * 5) - 0.5) * spread;
        let vel = Vec2::from_angle(a) * sp * (0.45 + hash(seed * 7 + k) * 0.8);
        let sz = size * (0.6 + hash(seed * 13 + k) * 0.8);
        commands.spawn((
            Mesh2d(shared.circle.clone()),
            MeshMaterial2d(mat.clone()),
            Transform::from_xyz(pos.x, pos.y, z::FX + hash(seed + k * 3) * 0.1).with_scale(Vec3::splat(sz)),
            Particle { vel, life: 0.5, max: 0.5, gravity: 500.0, size: sz, drag: 1.6 },
        ));
    }
}

/// Players and NPCs (the things whose collisions spray).
fn is_blob(game: &Game, id: bb_sim::BodyId) -> bool {
    matches!(game.sim.tag(id), Some(bb_sim::BodyTag::Player(_) | bb_sim::BodyTag::Npc(_)))
}

/// A body's on-screen colour (players, NPCs and style overrides).
fn body_color(game: &Game, overrides: &crate::render::StyleOverrides, id: bb_sim::BodyId) -> Option<u32> {
    if let Some(s) = overrides.0.get(&id) {
        let c = s.fill.to_srgba();
        return Some(((c.red * 255.0) as u32) << 16 | ((c.green * 255.0) as u32) << 8 | (c.blue * 255.0) as u32);
    }
    match game.sim.tag(id)? {
        bb_sim::BodyTag::Player(s) => game.sim.player(s).map(|p| p.color),
        bb_sim::BodyTag::Npc(i) => game.sim.npcs.get(i as usize).map(|n| n.color),
        _ => None,
    }
}

pub fn word(commands: &mut Commands, _assets: &GameAssets, text: &str, pos: Vec2, color: Color, size: f32) {
    let mut st = SoftText::new(text, size).color(color).at(pos).z(z::FX + 1.0).stagger(0.035);
    st.burst = size * 12.0;
    st.stiffness = 170.0;
    st.damping = 5.5;
    let life = 1.25 + text.chars().count() as f32 * 0.03;
    commands.spawn((st, Word { life, max: life, vel: Vec2::new(0.0, 80.0) }));
}

fn react(
    mut commands: Commands,
    mut events: MessageReader<SimMsg>,
    game: Res<Game>,
    shared: Res<Shared>,
    assets: Res<GameAssets>,
    mut cache: ResMut<MatCache>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    mut cam: ResMut<CameraDirector>,
    overrides: Res<crate::render::StyleOverrides>,
    held: Option<Res<crate::menu::HeldBlobs>>,
) {
    let mut bumped = std::collections::HashSet::new();
    // A title blob dragged into a tile scrapes it every frame: no spray.
    let held = |id: &bb_physics::BodyId| held.as_ref().is_some_and(|h| h.0.contains(id));
    let theme = palette::theme(game.sim.level.theme);
    let accent = theme.accent.to_srgba();
    let accent_rgb = ((accent.red * 255.0) as u32) << 16 | ((accent.green * 255.0) as u32) << 8 | (accent.blue * 255.0) as u32;
    let seed = game.tick as u32;
    for SimMsg(e) in events.read() {
        match e {
            SimEvent::Popped { pos, color, who } => {
                let p = Vec2::new(pos.x, pos.y);
                burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: p, color: *color, count: 10, speed: 420.0, size: 7.0, life: 0.6, gravity: -1600.0, implode: 0.0 }, seed);
                word(&mut commands, &assets, "POP!", p + Vec2::new(0.0, 50.0), Color::WHITE, 64.0);
                if matches!(who, Who::Player(_)) {
                    cam.shake = cam.shake.max(0.6);
                }
            }
            SimEvent::Respawned { who, pos } => {
                let color = match who {
                    Who::Player(s) => game.sim.player(*s).map_or(0xffffff, |p| p.color),
                    Who::Npc(i) => game.sim.npcs.get(*i as usize).map_or(0xffffff, |n| n.color),
                };
                burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: Vec2::new(pos.x, pos.y), color, count: 16, speed: 0.0, size: 8.0, life: 0.35, gravity: 0.0, implode: 90.0 }, seed);
            }
            SimEvent::Checkpoint { pos, .. } => {
                let p = Vec2::new(pos.x, pos.y + 40.0);
                burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: p, color: accent_rgb, count: 26, speed: 380.0, size: 7.0, life: 1.2, gravity: -300.0, implode: 0.0 }, seed);
                word(&mut commands, &assets, "Checkpoint!", p + Vec2::new(0.0, 90.0), lighten(theme.glow, 0.3), 46.0);
            }
            SimEvent::Pickup { pos, .. } => {
                burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: Vec2::new(pos.x, pos.y), color: 0xfff3a3, count: 7, speed: 220.0, size: 4.0, life: 0.4, gravity: 0.0, implode: 0.0 }, seed);
            }
            SimEvent::Impact { pos, speed, body } => {
                // Landing on something: splash in the blob's colour, thrown
                // along its direction of travel.
                if *speed > 520.0 && is_blob(&game, *body) && !held(body) {
                    if let (Some(col), Some(b)) = (body_color(&game, &overrides, *body), game.sim.world.body(*body)) {
                        let v = b.velocity();
                        let n = ((*speed - 400.0) / 120.0).clamp(2.0, 8.0) as u32;
                        let drift = Vec2::new(v.x, v.y) * 0.18 + Vec2::Y * speed * 0.22;
                        spray(&mut commands, &shared, &mut cache, &mut mats, Vec2::new(pos.x, pos.y), drift, 1.6, col, n, 6.0, seed);
                    }
                }
            }
            SimEvent::Bump { a, b, pos, normal, speed } => {
                // Two blobs collide: each sheds a few drops of its own colour,
                // carried by the pair's shared motion and flung out sideways.
                let key = if a.index < b.index { (*a, *b) } else { (*b, *a) };
                if *speed > 260.0 && (is_blob(&game, *a) || is_blob(&game, *b)) && !held(a) && !held(b) && bumped.insert(key) {
                    let va = game.sim.world.body(*a).map_or(bb_sim::Vec2::ZERO, |x| x.velocity());
                    let vb = game.sim.world.body(*b).map_or(bb_sim::Vec2::ZERO, |x| x.velocity());
                    let shared_v = (va + vb) * 0.5;
                    let side = bb_sim::Vec2::new(-normal.y, normal.x) * speed.min(900.0) * 0.35;
                    let n = ((*speed - 200.0) / 140.0).clamp(2.0, 7.0) as u32;
                    for (k, (id, sgn)) in [(*a, 1.0f32), (*b, -1.0)].into_iter().enumerate() {
                        let Some(col) = body_color(&game, &overrides, id) else { continue };
                        let d = shared_v * 0.3 + side * sgn + *normal * sgn * speed * 0.2;
                        spray(&mut commands, &shared, &mut cache, &mut mats, Vec2::new(pos.x, pos.y), Vec2::new(d.x, d.y), 1.1, col, n, 5.5, seed + k as u32 * 97);
                    }
                }
            }
            SimEvent::Spring { index } => {
                if let Some(s) = game.sim.springs.get(*index) {
                    let p = Vec2::new(s.def.pos.x, s.def.pos.y + 40.0);
                    word(&mut commands, &assets, "BOING!", p + Vec2::new(0.0, 40.0), hex(0xff8fb1), 52.0);
                }
            }
            SimEvent::Goal { .. } => {
                if let Some(g) = &game.sim.level.goal {
                    let c = g.center();
                    for (k, col) in palette_cycle().iter().enumerate() {
                        burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: Vec2::new(c.x, c.y), color: *col, count: 10, speed: 700.0, size: 7.0, life: 1.8, gravity: -900.0, implode: 0.0 }, seed + k as u32 * 31);
                    }
                    word(&mut commands, &assets, "YAY!", Vec2::new(c.x, c.y + 140.0), Color::WHITE, 90.0);
                }
            }
            SimEvent::Action { who: Who::Player(s), action: Action::Grab } => {
                if let Some(b) = game.sim.player(*s).and_then(|p| game.sim.world.body(p.ctl.body)) {
                    let c = b.centroid();
                    word(&mut commands, &assets, "grab!", Vec2::new(c.x, c.y + 60.0), hex(0xc6f68d), 34.0);
                }
            }
            SimEvent::Phew { body } => {
                if let Some(b) = game.sim.world.body(*body) {
                    let c = b.centroid();
                    burst(&mut commands, &shared, &mut cache, &mut mats, Burst { pos: Vec2::new(c.x, c.y), color: 0xfff3a3, count: 8, speed: 200.0, size: 4.0, life: 0.6, gravity: 0.0, implode: 0.0 }, seed + 7);
                    word(&mut commands, &assets, "phew!", Vec2::new(c.x, c.y + 60.0), hex(0xc6f68d), 36.0);
                }
            }
            SimEvent::NpcFreed { index } => {
                if let Some(b) = game.sim.npcs.get(*index as usize).and_then(|n| game.sim.world.body(n.ctl.body)) {
                    let c = b.centroid();
                    word(&mut commands, &assets, "Free!", Vec2::new(c.x, c.y + 70.0), hex(0xfff3a3), 48.0);
                }
            }
            _ => {}
        }
    }
}

fn palette_cycle() -> [u32; 6] {
    [0xff5d73, 0xffd93d, 0x6bcb77, 0x4d96ff, 0x9b5de5, 0xff9f43]
}

fn animate(
    mut commands: Commands,
    time: Res<Time>,
    mut particles: Query<(Entity, &mut Particle, &mut Transform), Without<Word>>,
    mut words: Query<(Entity, &mut Word, &mut SoftText), Without<Particle>>,
) {
    let dt = time.delta_secs();
    for (e, mut p, mut tf) in particles.iter_mut() {
        p.life -= dt;
        if p.life <= 0.0 {
            commands.entity(e).despawn();
            continue;
        }
        p.vel.y += p.gravity * dt;
        let drag = (1.0 - p.drag * dt).max(0.0);
        p.vel *= drag;
        tf.translation.x += p.vel.x * dt;
        tf.translation.y += p.vel.y * dt;
        let t = (p.life / p.max).clamp(0.0, 1.0);
        tf.scale = Vec3::splat(p.size * (0.3 + 0.7 * t));
    }
    for (e, mut w, mut st) in words.iter_mut() {
        w.life -= dt;
        if w.life <= 0.0 {
            commands.entity(e).despawn();
            continue;
        }
        // Float up, slowing; fade over the last moments.
        let v = w.vel;
        st.offset += v * dt;
        w.vel *= (1.0 - 1.5 * dt).max(0.0);
        st.alpha = (w.life / 0.35).clamp(0.0, 1.0);
    }
}

fn clear(mut commands: Commands, q: Query<Entity, Or<(With<Particle>, With<Word>)>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
