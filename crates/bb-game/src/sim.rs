//! Bevy bridge to `bb_sim::Sim`: fixed 60 Hz stepping and event fan-out.

use bb_level::Level;
use bb_sim::{Input, Sim, SimEvent};
use bevy::prelude::*;

/// The running level. Present only while a level is loaded.
#[derive(Resource)]
pub struct Game {
    pub sim: Sim,
    pub paused: bool,
    /// Elapsed fixed ticks.
    pub tick: u64,
}

impl Game {
    pub fn new(level: Level) -> Game {
        Game { sim: Sim::new(level), paused: false, tick: 0 }
    }
}

/// Sim events re-broadcast as Bevy messages for audio, fx, story, HUD.
#[derive(Message, Clone, Debug)]
pub struct SimMsg(pub SimEvent);

/// Per-slot input gathered this frame from keyboard, pads, touch, phones.
#[derive(Resource, Default)]
pub struct Inputs {
    pub slots: [Input; 16],
    pub active: [bool; 16],
}

/// Asks the app to load a level (handled by `spawn_level`).
#[derive(Message, Clone)]
pub struct LoadLevel {
    pub level: Level,
    /// Local players to add: (slot, name, colour).
    pub players: Vec<(u8, String, u32)>,
}

#[derive(Message, Clone)]
pub struct UnloadLevel;

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(Time::<Fixed>::from_hz(60.0))
            .init_resource::<Inputs>()
            .add_message::<SimMsg>()
            .add_message::<LoadLevel>()
            .add_message::<UnloadLevel>()
            .add_systems(PreUpdate, (load_levels, unload_levels))
            .add_systems(FixedUpdate, step.run_if(resource_exists::<Game>));
    }
}

fn load_levels(mut commands: Commands, mut reader: MessageReader<LoadLevel>) {
    if let Some(req) = reader.read().last() {
        let mut game = Game::new(req.level.clone());
        for (slot, name, color) in &req.players {
            game.sim.add_player(*slot, name, *color);
        }
        commands.insert_resource(game);
    }
}

fn unload_levels(mut commands: Commands, mut reader: MessageReader<UnloadLevel>) {
    if reader.read().count() > 0 {
        commands.remove_resource::<Game>();
    }
}

fn step(mut game: ResMut<Game>, inputs: Res<Inputs>, mut out: MessageWriter<SimMsg>) {
    if game.paused {
        return;
    }
    let slots: Vec<u8> = game.sim.players.iter().filter(|p| p.local).map(|p| p.slot).collect();
    for s in slots {
        let i = inputs.slots[s as usize];
        game.sim.set_input(s, i);
    }
    game.sim.step();
    game.tick += 1;
    for e in game.sim.drain_events() {
        out.write(SimMsg(e));
    }
}
