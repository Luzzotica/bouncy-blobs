//! Bouncy Blobs — the Bevy app.

#[cfg(not(target_arch = "wasm32"))]
pub mod account;
pub mod achievements;
pub mod alive;
pub mod assets;
pub mod audio;
pub mod backdrop;
pub mod camera;
pub mod cave;
pub mod crag;
pub mod dance;
pub mod devtools;
pub mod dropin;
pub mod flow;
pub mod fx;
pub mod hud;
pub mod input;
pub mod kids;
pub mod level_view;
pub mod menu;
pub mod mouths;
pub mod net;
pub mod online;
pub mod palette;
pub mod party;
pub mod party_assets;
pub mod pause;
pub mod platform;
pub mod render;
pub mod sandbox;
pub mod save;
pub mod sim;
pub mod softtext;
pub mod story;
pub mod story_iface;
pub mod tuning;

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
    app.add_plugins(platform::default_plugins());
    if platform::headless() {
        app.add_plugins(bevy::app::ScheduleRunnerPlugin::run_loop(std::time::Duration::from_secs_f64(1.0 / 60.0)));
    }
    app
        .add_plugins(platform::PlatformPlugin)
        .add_plugins(GamePlugin);
    app
}

/// Everything except the windowing/render defaults, so tests can run the
/// game headless with `MinimalPlugins`.
pub struct GamePlugin;

impl Plugin for GamePlugin {
    fn build(&self, app: &mut App) {
        #[cfg(not(target_arch = "wasm32"))]
        app.add_plugins(account::AccountPlugin);
        app.insert_resource(ClearColor(Color::srgb(0.02, 0.015, 0.03)))
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
                backdrop::BackdropPlugin,
                cave::CavePlugin,
                alive::AlivePlugin,
                sandbox::SandboxPlugin,
                softtext::SoftTextPlugin,
            ))
            .add_plugins(mouths::MouthsPlugin)
            .add_plugins((
                story::StoryPlugin,
                menu::MenuPlugin,
                party::PartyPlugin,
                pause::PausePlugin,
                achievements::AchievementsPlugin,
                devtools::DevToolsPlugin,
                audio::GameAudioPlugin,
                kids::KidsPlugin,
                net::NetPlugin,
                online::OnlinePlugin,
                tuning::TuningPlugin,
                dance::DancePlugin,
            ));
    }
}
