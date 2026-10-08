//! Everything grooves to the music: idle characters and the floating
//! amoebas hop on the beat, each on its own part of the bar (see
//! [`Groove`]), so a scene ripples with the song like Mario's dancing
//! enemies. Mushroom caps and the title logo read the same beat clock
//! (`render.rs`, `menu.rs`).

use bevy::prelude::*;
use bb_physics::Vec2 as PVec2;

use crate::audio::{Groove, MusicBeat};
use crate::sim::Game;

pub struct DancePlugin;

impl Plugin for DancePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, dance.run_if(resource_exists::<Game>));
    }
}

fn dance(mut game: ResMut<Game>, beat: Res<MusicBeat>) {
    if game.paused {
        return;
    }
    let g = &mut *game;
    // Idle characters: a little bounce on their beat (never while following
    // you, freed, scripted for a cutscene, or in the air).
    for n in g.sim.npcs.iter() {
        if n.dead.is_some() || n.scripted || n.following || !n.ctl.grounded || n.ctl.grab.is_some() {
            continue;
        }
        let groove = Groove::of(n.index as usize);
        if beat.crossed(groove) {
            if let Some(b) = g.sim.world.body_mut(n.ctl.body) {
                let up = if groove == Groove::Downbeat { 260.0 } else { 170.0 };
                b.add_velocity(PVec2::new(0.0, up));
            }
        }
    }
    // Amoebas bob on the off-beats.
    for (i, id) in g.sim.amoebas.iter().enumerate() {
        let Some(id) = id else { continue };
        if beat.crossed(Groove::of(i + 2)) {
            if let Some(b) = g.sim.world.body_mut(*id) {
                b.add_velocity(PVec2::new(0.0, 70.0));
            }
        }
    }
}
