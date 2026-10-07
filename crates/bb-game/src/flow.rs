//! Top-level app flow.

use bevy::prelude::*;

#[derive(States, Default, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AppState {
    /// Loading / splash.
    #[default]
    Boot,
    /// Softbody title screen + menus.
    Title,
    /// Story mode: cutscenes and campaign levels.
    Story,
    /// Free play of a single level (sandbox, level select replays, editor test).
    Playing,
    /// Kids Mode.
    Kids,
    /// Party modes (race / KOTH) with phones.
    Party,
    /// Level editor.
    Editor,
}

pub struct FlowPlugin;

impl Plugin for FlowPlugin {
    fn build(&self, app: &mut App) {
        app.init_state::<AppState>();
    }
}
