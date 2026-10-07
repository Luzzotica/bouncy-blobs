//! Developer hooks for automated visual checks.
//!
//! * `BB_SHOT=/path.png` — save a screenshot after `BB_SHOT_FRAME` frames
//!   (default 150) and exit.
//! * `BB_AUTOPLAY=1` — slot 0 holds right and jumps every second.

use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, save_to_disk};

use crate::sim::Inputs;

pub struct DevToolsPlugin;

impl Plugin for DevToolsPlugin {
    fn build(&self, app: &mut App) {
        if std::env::var("BB_SHOT").is_ok() {
            app.add_systems(Update, shoot);
        }
        if std::env::var("BB_AUTOPLAY").is_ok() {
            app.add_systems(PreUpdate, autoplay.after(crate::input::InputPlugin::gather_set()));
        }
    }
}

fn shoot(mut commands: Commands, mut frame: Local<u32>, mut exit: MessageWriter<AppExit>) {
    *frame += 1;
    let at: u32 = std::env::var("BB_SHOT_FRAME").ok().and_then(|s| s.parse().ok()).unwrap_or(150);
    if *frame == at {
        let path = std::env::var("BB_SHOT").unwrap();
        commands.spawn(Screenshot::primary_window()).observe(save_to_disk(path));
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
