//! In-level HUD: glow-drop counter. Each digit is its own glyph and the
//! ones that change bounce and jiggle.

use bb_sim::SimEvent;
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::sim::{Game, SimMsg};
use crate::softtext::JiggleText;

#[derive(Component)]
struct HudRoot;

#[derive(Component)]
struct DropCounter;

pub struct HudPlugin;

impl Plugin for HudPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, spawn.run_if(resource_added::<Game>))
            .add_systems(Update, update.run_if(resource_exists::<Game>))
            .add_systems(PostUpdate, despawn.run_if(resource_removed::<Game>));
    }
}

fn spawn(mut commands: Commands, assets: Res<GameAssets>, game: Res<Game>) {
    // Menus, lobbies and cutscene stages have no glow drops: no HUD.
    // Capture mode: a clean screen.
    if game.sim.level.pickups.is_empty() || crate::capture::on() {
        return;
    }
    commands
        .spawn((
            HudRoot,
            Node { position_type: PositionType::Absolute, left: px(24.0 + crate::platform::SAFE_SIDE), top: px(18.0), column_gap: px(10.0), align_items: AlignItems::Center, ..default() },
        ))
        .with_children(|p| {
            p.spawn((
                Node { width: px(26.0), height: px(32.0), border_radius: BorderRadius::all(px(13.0)), ..default() },
                BackgroundColor(Color::srgb(1.0, 0.95, 0.64)),
            ));
            let font = TextFont { font: assets.font.clone().into(), font_size: 34.0.into(), weight: FontWeight::BOLD, ..default() };
            p.spawn((Node::default(), JiggleText::new(format!("0 / {}", game.sim.collected.len()), font, Color::WHITE).shadow(TextShadow::default()), DropCounter));
        });
}

fn update(game: Res<Game>, mut events: MessageReader<SimMsg>, mut q: Query<&mut JiggleText, With<DropCounter>>) {
    let changed = events.read().any(|SimMsg(e)| matches!(e, SimEvent::Pickup { .. }));
    if !changed && !game.is_added() {
        return;
    }
    let got = game.sim.collected.iter().filter(|c| **c).count();
    let total = game.sim.collected.len();
    for mut t in q.iter_mut() {
        t.text = format!("{got} / {total}");
    }
}

fn despawn(mut commands: Commands, q: Query<Entity, With<HudRoot>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
