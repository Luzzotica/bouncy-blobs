//! Bouncy Blobs — the Bevy app.

pub mod achievements;
pub mod assets;
pub mod audio;
pub mod camera;
pub mod devtools;
pub mod editor;
pub mod flow;
pub mod fx;
pub mod hud;
pub mod input;
pub mod kids;
pub mod level_view;
pub mod menu;
pub mod net;
pub mod online;
pub mod palette;
pub mod party;
pub mod party_assets;
pub mod pause;
pub mod render;
pub mod sandbox;
pub mod save;
pub mod sim;
pub mod story;
pub mod story_iface;

use bevy::prelude::*;

pub use bb_sim::load::layer as load_layer;

/// A cheerful colour per index (chapter buttons, confetti).
pub fn palette_cycle(i: usize) -> u32 {
    const C: [u32; 10] = [0xff5d73, 0xff9f43, 0xffd93d, 0x6bcb77, 0x4d96ff, 0x9b5de5, 0xf15bb5, 0x00c2a8, 0x5dd6ff, 0xa0e426];
    C[i % C.len()]
}

/// Where assets live: `BEVY_ASSET_ROOT` if set, `assets/` beside the
/// executable when packaged, else (dev builds) this crate's source folder.
fn asset_root() -> String {
    if let Ok(root) = std::env::var("BEVY_ASSET_ROOT") {
        return format!("{root}/assets");
    }
    let beside_exe = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("assets"))).filter(|p| p.exists());
    if beside_exe.is_some() || cfg!(any(target_os = "ios", target_os = "android", target_arch = "wasm32")) || !cfg!(debug_assertions) {
        return "assets".into();
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/assets").into()
}

pub fn run() {
    app().run();
}

pub fn app() -> App {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(bevy::log::LogPlugin { filter: "wgpu=error,naga=warn,webrtc=warn,rtc=warn,rtc_ice=error,webrtc_ice=error,webrtc_mdns=error".into(), ..default() }).set(bevy::asset::AssetPlugin { file_path: asset_root(), ..default() }).set(WindowPlugin {
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
            ))
            .add_plugins((
                story::StoryPlugin,
                menu::MenuPlugin,
                party::PartyPlugin,
                pause::PausePlugin,
                achievements::AchievementsPlugin,
                devtools::DevToolsPlugin,
                audio::GameAudioPlugin,
                kids::KidsPlugin,
                editor::EditorPlugin,
                net::NetPlugin,
                online::OnlinePlugin,
            ));
    }
}
