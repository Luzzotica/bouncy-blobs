//! Developer hooks for automated visual checks.
//!
//! * `BB_SHOT=/path.png` — save a screenshot after `BB_SHOT_FRAME` frames
//!   (default 150) and exit.
//! * `BB_AUTOPLAY=1` — slot 0 holds right and jumps every second.
//! * `BB_START=kids` — boot straight into Kids Mode (skips the sandbox).

use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};

use crate::sim::Inputs;

pub struct DevToolsPlugin;

impl Plugin for DevToolsPlugin {
    fn build(&self, app: &mut App) {
        if std::env::var("BB_SHOT").is_ok() {
            app.add_systems(PostStartup, offscreen).add_systems(Update, shoot);
        }
        if std::env::var("BB_START").is_ok_and(|s| s == "kids") {
            app.add_systems(Startup, |mut next: ResMut<NextState<crate::flow::AppState>>| next.set(crate::flow::AppState::Kids));
        }
        if std::env::var("BB_AUTOPLAY").is_ok() {
            app.add_systems(PreUpdate, autoplay.after(crate::input::InputPlugin::gather_set()));
        }
    }
}

/// Offscreen target for screenshots: renders even when the display is
/// asleep or the session is locked (windows aren't presented then).
#[derive(Resource)]
struct ShotTarget(Handle<Image>);

fn offscreen(
    mut commands: Commands,
    mut images: ResMut<Assets<Image>>,
    cams: Query<Entity, With<crate::camera::MainCamera>>,
) {
    use bevy::camera::RenderTarget;
    use bevy::render::render_resource::TextureFormat;
    let image = Image::new_target_texture(1920, 1080, TextureFormat::Rgba8UnormSrgb, None);
    let handle = images.add(image);
    for cam in cams.iter() {
        commands.entity(cam).insert(RenderTarget::Image(handle.clone().into()));
    }
    commands.insert_resource(ShotTarget(handle));
}

fn shoot(mut commands: Commands, mut frame: Local<u32>, mut exit: MessageWriter<AppExit>, target: Option<Res<ShotTarget>>) {
    *frame += 1;
    let at: u32 = std::env::var("BB_SHOT_FRAME").ok().and_then(|s| s.parse().ok()).unwrap_or(150);
    if *frame == at {
        let path = std::env::var("BB_SHOT").unwrap();
        let shot = match &target {
            Some(t) => Screenshot::image(t.0.clone()),
            None => Screenshot::primary_window(),
        };
        commands.spawn(shot).observe(save_to_disk(path));
    }
    if *frame == at + 20 {
        exit.write(AppExit::Success);
    }
}

fn autoplay(time: Res<Time>, mut inputs: ResMut<Inputs>) {
    let t = time.elapsed_secs();
    inputs.slots[0].stick.x = 1.0;
    inputs.slots[0].button = t.fract() < 0.35;
}
