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
        Game::new_with(Sim::new(level))
    }

    /// Wrap an already-configured sim (rules, players, extra bodies).
    pub fn new_with(sim: Sim) -> Game {
        Game { sim, paused: false, tick: 0 }
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

/// A ready-made world to run (Kids Mode builds its own sim), installed the
/// way [`LoadLevel`] installs a level: never in the same frame as an unload,
/// so a state's `OnEnter` can hand it over while the previous state's
/// `OnExit` is still unloading (inserting `Game` straight away lost it to
/// that unload a frame later).
#[derive(Resource)]
pub struct InstallGame(pub Option<Game>);

pub struct SimPlugin;

impl Plugin for SimPlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(Time::<Fixed>::from_hz(60.0))
            .init_resource::<Inputs>()
            .add_message::<SimMsg>()
            .add_message::<LoadLevel>()
            .add_message::<UnloadLevel>()
            .add_systems(PreUpdate, (unload_levels, load_levels, install_games).chain())
            .init_resource::<Interp>()
            .add_systems(PreUpdate, update_interp)
            .add_systems(FixedUpdate, step.run_if(resource_exists::<Game>));
    }
}

/// A load waiting one frame for the previous level to be torn down.
#[derive(Resource)]
struct PendingLoad(LoadLevel);

/// Swapping levels removes the old `Game` for one frame before inserting the
/// new one, so every presentation system sees a clean removed → added edge
/// (and body ids from the old world can never alias the new one).
fn load_levels(
    mut commands: Commands,
    mut reader: MessageReader<LoadLevel>,
    mut unloads: MessageReader<UnloadLevel>,
    existing: Option<Res<Game>>,
    pending: Option<Res<PendingLoad>>,
) {
    // An unload this same frame (e.g. a state's OnExit unloading while the
    // next state's OnEnter loads) already removed the old Game: still wait a
    // frame, or the removed → added edge collapses into one frame and the old
    // level's visuals and per-body caches never get cleaned up.
    let unloaded_now = unloads.read().count() > 0;
    let req = reader.read().last().cloned();
    let req = match (req, pending) {
        (Some(r), _) => {
            commands.remove_resource::<PendingLoad>();
            r
        }
        (None, Some(p)) => {
            commands.remove_resource::<PendingLoad>();
            if existing.is_some() {
                return;
            }
            p.0.clone()
        }
        (None, None) => return,
    };
    if existing.is_some() || unloaded_now {
        commands.remove_resource::<Game>();
        commands.insert_resource(PendingLoad(req));
        return;
    }
    {
        let mut game = Game::new(req.level.clone());
        for (slot, name, color) in &req.players {
            game.sim.add_player(*slot, name, *color);
        }
        commands.insert_resource(game);
    }
}

/// Hands over an [`InstallGame`] once the old `Game` is gone and no unload
/// is in flight (same one-frame gap as [`load_levels`]).
fn install_games(
    mut commands: Commands,
    mut unloads: MessageReader<UnloadLevel>,
    existing: Option<Res<Game>>,
    install: Option<ResMut<InstallGame>>,
) {
    let unloaded_now = unloads.read().count() > 0;
    let Some(mut install) = install else { return };
    if existing.is_some() || unloaded_now {
        commands.remove_resource::<Game>();
        return;
    }
    commands.remove_resource::<InstallGame>();
    if let Some(game) = install.0.take() {
        commands.insert_resource(game);
    }
}

fn unload_levels(mut commands: Commands, mut reader: MessageReader<UnloadLevel>) {
    if reader.read().count() > 0 {
        commands.remove_resource::<Game>();
    }
}

/// Render interpolation. The sim steps at a fixed 60 Hz but frames are
/// drawn at the display rate (120 Hz on ProMotion), so moving bodies are
/// drawn between their previous and current step positions, otherwise a
/// moving blob stutters against the smooth camera and reads as doubled.
#[derive(Resource, Default)]
pub struct Interp {
    /// Centroid of each moving body before the latest step.
    pub prev: std::collections::HashMap<bb_sim::BodyId, Vec2>,
    /// 0..1: how far the display time is between the last two steps.
    pub alpha: f32,
}

impl Interp {
    /// Offset to draw `id` at (added to its current-step position).
    pub fn offset(&self, game: &Game, id: bb_sim::BodyId) -> Vec2 {
        let (Some(p), Some(b)) = (self.prev.get(&id), game.sim.world.body(id)) else { return Vec2::ZERO };
        let c = b.centroid();
        let d = Vec2::new(p.x - c.x, p.y - c.y);
        // A teleport (respawn, snap) shouldn't smear.
        if d.length() > 200.0 {
            return Vec2::ZERO;
        }
        d * (1.0 - self.alpha)
    }
}

/// Update the blend factor each frame (after fixed steps have run).
pub fn update_interp(mut interp: ResMut<Interp>, fixed: Res<Time<Fixed>>) {
    interp.alpha = fixed.overstep_fraction().clamp(0.0, 1.0);
}

fn step(mut game: ResMut<Game>, inputs: Res<Inputs>, mut out: MessageWriter<SimMsg>, mut interp: ResMut<Interp>) {
    if game.paused {
        return;
    }
    interp.prev.clear();
    for (id, b) in game.sim.world.bodies() {
        if matches!(game.sim.tag(id), Some(bb_sim::BodyTag::Jelly) | None) || !b.enabled {
            continue;
        }
        let c = b.centroid();
        interp.prev.insert(id, Vec2::new(c.x, c.y));
    }
    let slots: Vec<u8> = game.sim.players.iter().filter(|p| p.local).map(|p| p.slot).collect();
    for s in slots {
        let i = inputs.slots[s as usize];
        game.sim.set_input(s, i);
    }
    game.sim.step();
    game.tick += 1;
    if trace() {
        eprintln!("BB_SIM_TRACE tick {} hash {:016x}", game.tick, game.sim.state_hash());
    }
    for e in game.sim.drain_events() {
        out.write(SimMsg(e));
    }
}

/// `BB_SIM_TRACE=1`: print the sim's state hash after every fixed step
/// (stderr), so two runs can be diffed step by step.
pub fn trace() -> bool {
    static T: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *T.get_or_init(|| std::env::var_os("BB_SIM_TRACE").is_some())
}
