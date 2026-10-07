//! Per-platform window, asset-path and render defaults.
//!
//! Desktop, iOS, Android and web all start through [`crate::app`]; the only
//! differences live here so the rest of the game never needs a `cfg`.

use bevy::app::PluginGroupBuilder;
use bevy::prelude::*;
#[cfg(any(target_os = "ios", target_os = "android"))]
use bevy::window::{ScreenEdge, WindowMode};

/// True on iOS and Android.
pub const IS_MOBILE: bool = cfg!(any(target_os = "ios", target_os = "android"));

/// Conservative landscape safe-area inset (logical px) for screen-edge UI.
/// Bevy 0.19 doesn't expose real insets; phones' notch / Dynamic Island and
/// rounded corners sit within ~60 px of the side edges in landscape.
pub const SAFE_SIDE: f32 = if IS_MOBILE { 60.0 } else { 0.0 };

/// `DefaultPlugins` configured for the current target.
pub fn default_plugins() -> PluginGroupBuilder {
    // Android: no GPU debug labels. Debug builds label every wgpu object, and
    // the Android emulator's Vulkan driver (vulkan.ranchu) segfaults in
    // vkSetDebugUtilsObjectNameEXT. Release builds don't label anyway.
    let mut wgpu = bevy::render::settings::WgpuSettings::default();
    if cfg!(target_os = "android") {
        wgpu.instance_flags.remove(bevy::render::settings::InstanceFlags::DEBUG | bevy::render::settings::InstanceFlags::VALIDATION);
    }
    let group = DefaultPlugins
        .set(bevy::render::RenderPlugin { render_creation: wgpu.into(), ..default() })
        .set(bevy::log::LogPlugin {
            filter: "wgpu=error,naga=warn,webrtc=warn,rtc=warn,rtc_ice=error,webrtc_ice=error,webrtc_mdns=error"
                .into(),
            ..default()
        })
        .set(WindowPlugin { primary_window: Some(primary_window()), ..default() })
        .set(AssetPlugin {
            file_path: asset_file_path(),
            // No `.meta` files ship; on web/Android probing for them costs a
            // request (a 404 console error on web) per asset.
            meta_check: if cfg!(any(target_arch = "wasm32", target_os = "android")) {
                bevy::asset::AssetMetaCheck::Never
            } else {
                bevy::asset::AssetMetaCheck::default()
            },
            ..default()
        });
    if headless() {
        // Dev screenshot runs: no window at all (nothing pops up on the
        // desktop); devtools renders the camera into an offscreen image and a
        // plain loop drives the app instead of winit.
        group
            .set(WindowPlugin {
                primary_window: None,
                exit_condition: bevy::window::ExitCondition::DontExit,
                ..default()
            })
            .disable::<bevy::winit::WinitPlugin>()
    } else {
        group
    }
}

/// True for headless dev runs (`BB_SHOT` screenshots).
pub fn headless() -> bool {
    !cfg!(any(target_arch = "wasm32", target_os = "ios", target_os = "android")) && std::env::var("BB_SHOT").is_ok()
}

/// The main window for the current target.
pub fn primary_window() -> Window {
    let window = Window {
        title: "Bouncy Blobs".into(),
        // Web: size the canvas to its parent and keep browser shortcuts
        // (scroll, context menu) from fighting the game.
        fit_canvas_to_parent: true,
        prevent_default_event_handling: true,
        canvas: Some("#bevy".into()),
        ..default()
    };

    #[cfg(any(target_os = "ios", target_os = "android"))]
    let window = Window {
        mode: WindowMode::BorderlessFullscreen(MonitorSelection::Primary),
        resizable: false,
        // iOS only; ignored elsewhere.
        recognize_rotation_gesture: true,
        prefers_home_indicator_hidden: true,
        prefers_status_bar_hidden: true,
        preferred_screen_edges_deferring_system_gestures: ScreenEdge::Bottom,
        ..window
    };

    #[cfg(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")))]
    let window = Window {
        // Matches the legacy Tauri window: 1600x900, min 1024x640.
        resolution: (1600, 900).into(),
        resize_constraints: bevy::window::WindowResizeConstraints {
            min_width: 1024.0,
            min_height: 640.0,
            ..default()
        },
        ..window
    };

    window
}

/// Root folder for `AssetServer` paths.
///
/// * Desktop dev (`cargo run`, or the bare `target/*/bouncy-blobs`):
///   `crates/bb-game/assets`.
/// * macOS `.app`: `Contents/Resources/assets` (the executable lives in
///   `Contents/MacOS`).
/// * Windows/Linux zips and iOS: `assets/` next to the executable (iOS: the
///   `.app` root).
/// * Android: ignored; Bevy reads from the APK's `assets/` root.
/// * Web: fetched relative to the page (`./assets/...`).
pub fn asset_file_path() -> String {
    #[cfg(target_os = "macos")]
    if std::env::var_os("BEVY_ASSET_ROOT").is_none()
        && std::env::var_os("CARGO_MANIFEST_DIR").is_none()
        && let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_owned()))
        && dir.join("../Resources/assets").is_dir()
    {
        return "../Resources/assets".into();
    }
    // Desktop dev: running `target/<profile>/bouncy-blobs` directly (not via
    // `cargo run`) has no CARGO_MANIFEST_DIR, so fall back to the source
    // tree when nothing ships next to the executable.
    #[cfg(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")))]
    if std::env::var_os("BEVY_ASSET_ROOT").is_none()
        && std::env::var_os("CARGO_MANIFEST_DIR").is_none()
        && let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_owned()))
        && !dir.join("assets").is_dir()
    {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
        if src.is_dir() {
            return src.to_string_lossy().into_owned();
        }
    }
    "assets".into()
}

/// Platform tweaks that need the ECS (render quirks, asset smoke test).
pub struct PlatformPlugin;

impl Plugin for PlatformPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, probe_assets).add_systems(Update, report_assets);
        // MSAA panics on some Android GPUs (bevy#8229).
        #[cfg(target_os = "android")]
        app.add_systems(Update, disable_msaa);
    }
}

/// A tiny asset every build ships, loaded once at startup to prove the asset
/// path works on this platform (logs `asset pipeline OK`).
pub const PROBE_ASSET: &str = "branding/icon.png";

#[derive(Resource)]
struct AssetProbe(Handle<Image>);

fn probe_assets(mut commands: Commands, server: Res<AssetServer>) {
    commands.insert_resource(AssetProbe(server.load(PROBE_ASSET)));
}

fn report_assets(mut commands: Commands, probe: Option<Res<AssetProbe>>, server: Res<AssetServer>) {
    let Some(probe) = probe else { return };
    match server.load_state(&probe.0) {
        bevy::asset::LoadState::Loaded => {
            info!("asset pipeline OK ({PROBE_ASSET})");
            commands.remove_resource::<AssetProbe>();
        }
        bevy::asset::LoadState::Failed(err) => {
            error!("asset pipeline FAILED loading {PROBE_ASSET}: {err}");
            commands.remove_resource::<AssetProbe>();
        }
        _ => {}
    }
}

#[cfg(target_os = "android")]
fn disable_msaa(mut commands: Commands, cams: Query<Entity, Added<Camera>>) {
    for e in &cams {
        commands.entity(e).insert(Msaa::Off);
    }
}
