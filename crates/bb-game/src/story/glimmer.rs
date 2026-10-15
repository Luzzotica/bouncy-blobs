//! Glimmer the companion, story mode's tutor (met in chapter 1; see
//! `bb_sim::npc::COMPANION` for how she flies). Here: putting her into the
//! later chapters, the "I've got something to say" glow and chime, and the
//! setting that mutes her hints.

use bb_level::{Level, NpcRole, v};
use bb_sim::npc::COMPANION;
use bevy::prelude::*;

use super::bubble::{Bubble, Speaker};
use crate::render::{Shared, z};
use crate::sim::Game;

/// Whether Glimmer gives gameplay hints ("tip" lines). Saved as
/// `story.hints` (`off` mutes them; story lines are never muted).
#[derive(Resource, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompanionHints(pub bool);

impl Default for CompanionHints {
    fn default() -> Self {
        CompanionHints(crate::save::get("story.hints").is_none_or(|v| v != "off"))
    }
}

impl CompanionHints {
    pub fn toggle(&mut self) {
        self.0 = !self.0;
        crate::save::set("story.hints", if self.0 { "on" } else { "off" });
    }

    /// The pause-menu label.
    pub fn label(self) -> &'static str {
        if self.0 { "Glimmer's Hints: On" } else { "Glimmer's Hints: Off" }
    }
}

/// From chapter 2 on Glimmer starts every chapter at Pip's shoulder (in
/// chapter 1 the level places her where Pip first meets her).
pub fn join(level: &mut Level, chapter: u8) {
    if chapter < 2 || level.npcs.iter().any(|n| n.id == COMPANION) {
        return;
    }
    level.npcs.push(bb_level::Npc { id: COMPANION.into(), pos: level.spawn + v(-110.0, 130.0), role: NpcRole::Glimmer, color: String::new(), radius: 12.0 });
}

/// Seconds of "listen!" glow left before Glimmer's next line appears.
#[derive(Resource, Default)]
pub struct GlimmerAlert(pub f32);

/// Lead-in before a Glimmer line: she lights up and chimes, then speaks.
pub const ALERT_LEAD: f32 = 0.6;

#[derive(Component)]
pub struct GlimmerGlow {
    mat: Handle<ColorMaterial>,
    level: f32,
}

const GLOW: u32 = 0xfff3a3;

/// A warm pulsing light around Glimmer while she's about to talk or talking.
pub fn glow(
    mut commands: Commands,
    game: Option<Res<Game>>,
    bubbles: Query<&Bubble>,
    mut alert: ResMut<GlimmerAlert>,
    time: Res<Time>,
    shared: Option<Res<Shared>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    mut fx: Query<(&mut GlimmerGlow, &mut Transform, &mut Visibility)>,
) {
    let dt = time.delta_secs();
    alert.0 = (alert.0 - dt).max(0.0);
    let Some(shared) = shared else { return };
    if fx.is_empty() {
        let mat = mats.add(ColorMaterial { color: crate::palette::hex(GLOW).with_alpha(0.0), alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() });
        commands.spawn((Mesh2d(shared.halo.clone()), MeshMaterial2d(mat.clone()), Transform::default(), Visibility::Hidden, GlimmerGlow { mat, level: 0.0 }));
        return;
    }
    // Who's glowing: a Glimmer with a bubble up, else the companion when
    // she's about to speak.
    let at = game.as_ref().and_then(|game| {
        let glimmer = |id: &str| game.sim.npc_by_id(id).filter(|n| n.role == NpcRole::Glimmer && n.dead.is_none());
        let speaking = bubbles.iter().find_map(|b| match &b.speaker {
            Speaker::Actor(id) => glimmer(id),
            _ => None,
        });
        let n = speaking.or_else(|| (alert.0 > 0.0).then(|| glimmer(COMPANION)).flatten())?;
        game.sim.world.body(n.ctl.body).map(|b| b.centroid())
    });
    for (mut g, mut tf, mut vis) in fx.iter_mut() {
        let want = if at.is_some() { 1.0 } else { 0.0 };
        g.level += (want - g.level) * (1.0 - (-dt * 6.0).exp());
        if let Some(p) = at {
            tf.translation = Vec3::new(p.x, p.y, z::NPC - 0.05);
        }
        let t = time.elapsed_secs();
        // A quick bright "ding" while the alert runs, then a gentle breathe.
        let ding = (alert.0 / ALERT_LEAD).clamp(0.0, 1.0);
        let pulse = 0.5 + 0.5 * (t * 7.0).sin();
        let r = 70.0 + 30.0 * pulse + 60.0 * ding;
        tf.scale = Vec3::splat(r * g.level.max(0.05));
        if let Some(mut m) = mats.get_mut(&g.mat) {
            m.color = crate::palette::hex(GLOW).with_alpha(g.level * (0.35 + 0.2 * pulse + 0.3 * ding));
        }
        *vis = if g.level > 0.01 && game.is_some() { Visibility::Visible } else { Visibility::Hidden };
    }
}
