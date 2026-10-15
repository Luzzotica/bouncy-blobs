//! Shared asset handles.

use bevy::prelude::*;

#[derive(Resource, Clone)]
pub struct GameAssets {
    /// Fredoka (OFL) — rounded and bubbly. Static Bold (700) and Medium
    /// (500) instances cut from the variable font with overlapping contours
    /// merged: the variable font's overlaps rendered as holes (the "B" lost
    /// its middle bar).
    pub font: Handle<Font>,
    pub font_medium: Handle<Font>,
}

impl GameAssets {
    /// The face for a weight: Bold for 600+, Medium below.
    pub fn font_for(&self, weight: u16) -> Handle<Font> {
        if weight >= 600 { self.font.clone() } else { self.font_medium.clone() }
    }
}

pub struct AssetsPlugin;

impl Plugin for AssetsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PreStartup, load);
    }
}

fn load(mut commands: Commands, server: Res<AssetServer>) {
    commands.insert_resource(GameAssets { font: server.load("fonts/Fredoka-Bold.ttf"), font_medium: server.load("fonts/Fredoka-Medium.ttf") });
}
