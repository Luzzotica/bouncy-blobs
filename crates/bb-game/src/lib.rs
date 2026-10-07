//! Bouncy Blobs — the Bevy app.

pub mod assets;
pub mod camera;
pub mod devtools;
pub mod flow;
pub mod fx;
pub mod hud;
pub mod input;
pub mod level_view;
pub mod palette;
pub mod render;
pub mod sandbox;
pub mod sim;
pub mod story;

use bevy::prelude::*;

pub fn run() {
    app().run();
}

pub fn app() -> App {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "Bouncy Blobs".into(),
            fit_canvas_to_parent: true,
            prevent_default_event_handling: true,
            ..default()
        }),
        ..default()
    }))
    .add_plugins(GamePlugin);
    app
}

/// Everything except the windowing/render defaults, so tests can run the
/// game headless with `MinimalPlugins`.
pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(ClearColor(Color::srgb(0.1, 0.07, 0.14)))
            .add_plugins((
                assets::AssetsPlugin,
                flow::FlowPlugin,
                fx::FxPlugin,
                hud::HudPlugin,
                sim::SimPlugin,
                input::InputPlugin,
                camera::CameraPlugin,
                render::RenderPlugin,
                level_view::LevelViewPlugin,
                sandbox::SandboxPlugin,
                story::StoryPlugin,
                devtools::DevToolsPlugin,
            ));
    }
}
