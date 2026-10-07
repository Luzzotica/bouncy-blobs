//! Speech bubbles: typewriter text in a candy bubble that follows a softbody.

use bb_sim::Vec2 as PVec2;
use bevy::prelude::*;
use bevy::text::{TextBounds, TextLayoutInfo};

use super::Voice;
use crate::assets::GameAssets;
use crate::camera::MainCamera;
use crate::palette::lin;
use crate::render::{MeshBuf, Shared, empty_mesh, z};
use crate::sim::Game;

#[derive(Clone, Debug, PartialEq)]
pub enum Speaker {
    /// An NPC by level id.
    Actor(String),
    /// A player by slot.
    Player(u8),
    /// A voice from off-screen (Lulu from above).
    Offscreen,
}

#[derive(Message, Clone, Debug)]
pub struct SayRequest {
    pub speaker: Speaker,
    pub text: String,
    pub voice: Voice,
    /// Seconds the bubble stays after the text is fully shown.
    pub linger: f32,
}

#[derive(Component)]
pub struct Bubble {
    pub speaker: Speaker,
    pub text: String,
    pub shown: f32,
    pub linger: f32,
    pub age: f32,
    pub bg: Entity,
    pub label: Entity,
    pub mesh: Handle<Mesh>,
    pub size: Vec2,
    pub voice: Voice,
}

const CHARS_PER_SEC: f32 = 38.0;
const WRAP: f32 = 440.0;

pub fn spawn_bubbles(
    mut commands: Commands,
    mut reqs: MessageReader<SayRequest>,
    existing: Query<(Entity, &Bubble)>,
    assets: Res<GameAssets>,
    shared: Res<Shared>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    for r in reqs.read() {
        for (e, b) in existing.iter() {
            if b.speaker == r.speaker {
                commands.entity(b.bg).despawn();
                commands.entity(b.label).despawn();
                commands.entity(e).despawn();
            }
        }
        let mesh = meshes.add(empty_mesh());
        let bg = commands.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::FX + 2.0))).id();
        let label = commands
            .spawn((
                Text2d::new(""),
                TextFont { font: assets.font.clone().into(), font_size: 30.0.into(), weight: FontWeight::MEDIUM, ..default() },
                TextColor(Color::srgb(0.17, 0.13, 0.21)),
                TextLayout::justify(Justify::Center),
                TextBounds::new_horizontal(WRAP),
                Transform::from_xyz(0.0, 0.0, z::FX + 2.1),
            ))
            .id();
        commands.spawn((Bubble {
            speaker: r.speaker.clone(),
            text: r.text.clone(),
            shown: 0.0,
            linger: r.linger,
            age: 0.0,
            bg,
            label,
            mesh,
            size: Vec2::ZERO,
            voice: r.voice,
        },));
    }
}

fn speaker_pos(game: &Game, s: &Speaker, cam: Vec2) -> Option<(Vec2, f32)> {
    let (c, r) = match s {
        Speaker::Actor(id) => {
            let n = game.sim.npc_by_id(id)?;
            let b = game.sim.world.body(n.ctl.body)?;
            (b.centroid(), n.ctl.radius * n.ctl.expand)
        }
        Speaker::Player(slot) => {
            let p = game.sim.player(*slot)?;
            let b = game.sim.world.body(p.ctl.body)?;
            (b.centroid(), p.ctl.radius * p.ctl.expand)
        }
        Speaker::Offscreen => return Some((cam + Vec2::new(0.0, 260.0), 0.0)),
    };
    Some((Vec2::new(c.x, c.y), r))
}

#[allow(clippy::type_complexity)]
pub fn update_bubbles(
    mut commands: Commands,
    time: Res<Time>,
    game: Option<Res<Game>>,
    mut bubbles: Query<(Entity, &mut Bubble)>,
    mut texts: Query<(&mut Text2d, &TextLayoutInfo, &mut Transform), Without<MainCamera>>,
    mut bgs: Query<&mut Transform, (Without<Text2d>, Without<MainCamera>)>,
    cam: Query<&Transform, (With<MainCamera>, Without<Text2d>)>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    let dt = time.delta_secs();
    let cam_p = cam.single().map(|t| t.translation.truncate()).unwrap_or_default();
    for (e, mut b) in bubbles.iter_mut() {
        b.age += dt;
        let total = b.text.chars().count() as f32;
        b.shown = (b.shown + dt * CHARS_PER_SEC).min(total);
        let done_at = total / CHARS_PER_SEC + b.linger;
        let pos = game.as_ref().and_then(|g| speaker_pos(g, &b.speaker, cam_p));
        if b.age > done_at || pos.is_none() {
            commands.entity(b.bg).despawn();
            commands.entity(b.label).despawn();
            commands.entity(e).despawn();
            continue;
        }
        let (p, r) = pos.unwrap();
        let shown: String = b.text.chars().take(b.shown as usize).collect();
        let Ok((mut text, info, mut tf)) = texts.get_mut(b.label) else { continue };
        if text.0 != shown {
            text.0 = shown;
        }
        // Size the bubble to the FULL text so it doesn't grow as it types.
        let full = info.size.max(Vec2::new(60.0, 30.0));
        let target = if b.shown >= total || b.size == Vec2::ZERO { full } else { b.size.max(full) };
        let pop = if b.age < 0.12 { 0.6 + b.age / 0.12 * 0.5 } else if b.age < 0.2 { 1.1 - (b.age - 0.12) * 1.25 } else { 1.0 };
        let fade_out = ((done_at - b.age) / 0.25).clamp(0.0, 1.0);
        let scale = pop * (0.85 + 0.15 * fade_out);
        let anchor = p + Vec2::new(0.0, r + 46.0 + target.y * 0.5);
        tf.translation.x = anchor.x;
        tf.translation.y = anchor.y;
        tf.scale = Vec3::splat(scale);
        if (target - b.size).length() > 0.5 {
            b.size = target;
            if let Some(mut mesh) = meshes.get_mut(&b.mesh) {
                bubble_mesh(target + Vec2::new(36.0, 24.0), b.speaker == Speaker::Offscreen).write(&mut mesh);
            }
        }
        if let Ok(mut btf) = bgs.get_mut(b.bg) {
            btf.translation.x = anchor.x;
            btf.translation.y = anchor.y;
            btf.scale = Vec3::splat(scale);
        }
    }
}

fn bubble_mesh(size: Vec2, offscreen: bool) -> MeshBuf {
    let mut buf = MeshBuf::default();
    let h = size * 0.5;
    let r = 22.0f32.min(h.y);
    let mut pts = Vec::new();
    for (cx, cy, a0) in [(h.x - r, h.y - r, 0.0f32), (-h.x + r, h.y - r, 90.0), (-h.x + r, -h.y + r, 180.0), (h.x - r, -h.y + r, 270.0)] {
        for k in 0..=6 {
            let a = (a0 + k as f32 * 15.0).to_radians();
            pts.push(PVec2::new(cx + a.cos() * r, cy + a.sin() * r));
        }
    }
    let ink = lin(Color::srgb(0.17, 0.13, 0.21));
    let paper = if offscreen { lin(Color::srgb(1.0, 0.92, 0.96)) } else { lin(Color::srgb(1.0, 0.98, 0.93)) };
    // Tail.
    if !offscreen {
        let a = buf.vert(PVec2::new(-16.0, -h.y + 2.0), -0.01, ink);
        let b = buf.vert(PVec2::new(14.0, -h.y + 2.0), -0.01, ink);
        let c = buf.vert(PVec2::new(-4.0, -h.y - 28.0), -0.01, ink);
        buf.tri(a, b, c);
        let a = buf.vert(PVec2::new(-11.0, -h.y + 4.0), 0.002, paper);
        let b = buf.vert(PVec2::new(9.0, -h.y + 4.0), 0.002, paper);
        let c = buf.vert(PVec2::new(-4.0, -h.y - 20.0), 0.002, paper);
        buf.tri(a, b, c);
    }
    buf.ring(&pts, 0.0, 4.0, 0.0, ink);
    buf.fan(&pts, PVec2::ZERO, 0.001, paper, paper);
    buf
}
