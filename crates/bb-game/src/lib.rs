//! Bouncy Blobs — the Bevy app.

pub mod assets;
pub mod camera;
pub mod devtools;
pub mod flow;
pub mod fx;
pub mod hud;
pub mod input;
pub mod level_view;
pub mod menu;
pub mod palette;
pub mod party;
pub mod party_assets;
pub mod render;
pub mod sandbox;
pub mod sim;
pub mod story;

use bevy::prelude::*;

pub use bb_sim::load::layer as load_layer;

/// A cheerful colour per index (chapter buttons, confetti).
pub fn palette_cycle(i: usize) -> u32 {
    const C: [u32; 10] = [0xff5d73, 0xff9f43, 0xffd93d, 0x6bcb77, 0x4d96ff, 0x9b5de5, 0xf15bb5, 0x00c2a8, 0x5dd6ff, 0xa0e426];
    C[i % C.len()]
}

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
                menu::MenuPlugin,
                party::PartyPlugin,
                devtools::DevToolsPlugin,
            ));
    }
}
