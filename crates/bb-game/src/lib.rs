//! Bouncy Blobs — the Bevy app.

pub mod camera;
pub mod devtools;
pub mod flow;
pub mod input;
pub mod level_view;
pub mod palette;
pub mod platform;
pub mod render;
pub mod sandbox;
pub mod sim;

use bevy::prelude::*;

pub fn run() {
    app().run();
}

pub fn app() -> App {
    let mut app = App::new();
    app.add_plugins(platform::default_plugins())
        .add_plugins(platform::PlatformPlugin)
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
                flow::FlowPlugin,
                sim::SimPlugin,
                input::InputPlugin,
                camera::CameraPlugin,
                render::RenderPlugin,
                level_view::LevelViewPlugin,
                sandbox::SandboxPlugin,
                devtools::DevToolsPlugin,
            ));
    }
}
