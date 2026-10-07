//! Mobile entry point. `#[bevy_main]` generates `android_main` for
//! GameActivity; on iOS `src/main.rs` calls [`main`] directly.

use bevy::prelude::*;

#[bevy_main]
pub fn main() {
    bb_game::run();
}
