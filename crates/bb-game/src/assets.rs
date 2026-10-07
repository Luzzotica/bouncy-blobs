//! Shared asset handles.

use bevy::prelude::*;

#[derive(Resource, Clone)]
pub struct GameAssets {
    /// Fredoka (OFL) — rounded and bubbly, variable weight.
    pub font: Handle<Font>,
}

pub struct AssetsPlugin;

impl Plugin for AssetsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PreStartup, load);
    }
}

fn load(mut commands: Commands, server: Res<AssetServer>) {
    commands.insert_resource(GameAssets { font: server.load("fonts/Fredoka.ttf") });
}
