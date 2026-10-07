//! Developer hooks for automated visual checks.
//!
//! * `BB_SHOT=/path.png` — save a screenshot after `BB_SHOT_FRAME` frames
//!   (default 150) and exit. `BB_SHOT_COUNT=n BB_SHOT_EVERY=k` saves a
//!   flipbook of n shots k frames apart.
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
        if std::env::var("BB_PRESS").is_ok() {
            app.add_systems(PreUpdate, press.after(bevy::input::InputSystems));
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

fn shoot(mut commands: Commands, mut frame: Local<u32>, mut exit: MessageWriter<AppExit>, target: Option<Res<ShotTarget>>, time: Res<Time>) {
    *frame += 1;
    let env = |k: &str, d: u32| std::env::var(k).ok().and_then(|s| s.parse().ok()).unwrap_or(d);
    let at = env("BB_SHOT_FRAME", 150);
    // `BB_SHOT_COUNT=n BB_SHOT_EVERY=k`: n shots k frames apart, saved as
    // `<stem>_<i>.png` (a cheap flipbook for checking animation).
    let count = env("BB_SHOT_COUNT", 1).max(1);
    let every = env("BB_SHOT_EVERY", 5).max(1);
    let last = at + (count - 1) * every;
    if *frame >= at && *frame <= last && (*frame - at) % every == 0 {
        let path = std::env::var("BB_SHOT").unwrap();
        let path = if count > 1 {
            let i = (*frame - at) / every;
            match path.rsplit_once('.') {
                Some((stem, ext)) => format!("{stem}_{i:02}.{ext}"),
                None => format!("{path}_{i:02}"),
            }
        } else {
            path
        };
        info!("BB_SHOT frame {} at {:.2}s", *frame, time.elapsed_secs());
        let shot = match &target {
            Some(t) => Screenshot::image(t.0.clone()),
            None => Screenshot::primary_window(),
        };
        commands.spawn(shot).observe(save_to_disk(path));
    }
    if *frame == last + 20 {
        exit.write(AppExit::Success);
    }
}

fn autoplay(time: Res<Time>, mut inputs: ResMut<Inputs>) {
    let t = time.elapsed_secs();
    inputs.slots[0].stick.x = 1.0;
    inputs.slots[0].button = t.fract() < 0.35;
}

/// `BB_PRESS=escape@60,enter@90` taps keys at given frames.
fn press(mut keys: ResMut<ButtonInput<KeyCode>>, mut frame: Local<u32>) {
    *frame += 1;
    let spec = std::env::var("BB_PRESS").unwrap_or_default();
    for item in spec.split(',') {
        let Some((k, f)) = item.split_once('@') else { continue };
        // `key@frame` taps; `key@from-to` holds.
        let (f, until) = match f.split_once('-') {
            Some((a, b)) => (a.parse::<u32>().unwrap_or(0), b.parse::<u32>().unwrap_or(0)),
            None => {
                let a = f.parse::<u32>().unwrap_or(0);
                (a, a)
            }
        };
        let key = match k {
            "escape" => KeyCode::Escape,
            "enter" => KeyCode::Enter,
            "space" => KeyCode::Space,
            "down" => KeyCode::ArrowDown,
            "right" => KeyCode::ArrowRight,
            _ => continue,
        };
        if *frame >= f && *frame <= until {
            keys.press(key);
        } else if *frame == until + 1 {
            keys.release(key);
        }
    }
}
