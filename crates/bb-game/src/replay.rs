//! Recorded human input (`BB_RECORD_INPUT=path` in a normal run) and its
//! replay in scene files (`"replay": "path"`).
//!
//! A recording is player 1's input on every sim tick (stored as changes
//! only) from the moment a level loads, plus the stage it was played on:
//! level id, a hash of the level as built, the start position and the
//! build commit. Replaying feeds the same inputs into the same input slot,
//! tick for tick, so the real simulation reproduces the run on the current
//! build. The runner refuses a replay whose stage differs from the current
//! build's unless the scene says `"allow_old_stage": "<reason>"`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Recording {
    pub version: u32,
    /// Build the run was played on.
    pub build: String,
    /// Level id ("ch03") and a hash of the level as built.
    pub level: String,
    pub level_hash: String,
    /// Player 1's centre when the level loaded.
    pub start: [f32; 2],
    /// Sim ticks recorded.
    pub ticks: u64,
    /// Input changes: [tick, stick_x, stick_y, button (0/1)].
    pub changes: Vec<[f32; 4]>,
}

impl Recording {
    /// Player 1's input on `tick` (0 = the tick after the level loaded).
    pub fn input_at(&self, tick: u64) -> bb_sim::Input {
        let i = self.changes.partition_point(|c| c[0] as u64 <= tick);
        match i.checked_sub(1).map(|j| self.changes[j]) {
            Some([_, x, y, b]) => bb_sim::Input { stick: bb_sim::Vec2::new(x, y), button: b > 0.5 },
            None => bb_sim::Input::default(),
        }
    }

    pub fn push(&mut self, tick: u64, i: bb_sim::Input) {
        let c = [tick as f32, i.stick.x, i.stick.y, if i.button { 1.0 } else { 0.0 }];
        if self.changes.last().is_none_or(|l| l[1..] != c[1..]) {
            self.changes.push(c);
        }
        self.ticks = self.ticks.max(tick + 1);
    }
}

/// A stable hash of a level as built (FNV-1a over its JSON).
pub fn level_hash(level: &bb_level::Level) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in level.to_json().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub fn load(path: &str) -> Result<Recording, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("can't read the replay {path}: {e}"))?;
    let r: Recording = serde_json::from_str(&t).map_err(|e| format!("the replay {path} isn't a Bouncy Blobs input recording: {e}"))?;
    if r.version != 1 {
        return Err(format!("the replay {path} is version {}; this build reads version 1", r.version));
    }
    Ok(r)
}

// ───────────────────────────────────────────────────────── recording

use bevy::prelude::*;

use crate::sim::{Game, Inputs};

pub struct ReplayPlugin;

impl Plugin for ReplayPlugin {
    fn build(&self, app: &mut App) {
        if std::env::var_os("BB_RECORD_INPUT").is_some() {
            app.init_resource::<Recorder>().add_systems(FixedPreUpdate, record.run_if(resource_exists::<Game>)).add_systems(Last, flush_on_exit);
        }
    }
}

#[derive(Resource, Default)]
struct Recorder {
    rec: Option<Recording>,
    level_tick0: u64,
    last_write: u64,
}

fn record(game: Res<Game>, inputs: Res<Inputs>, mut r: ResMut<Recorder>) {
    let Ok(path) = std::env::var("BB_RECORD_INPUT") else { return };
    // Only levels with a player (not cutscene stages).
    if game.sim.player(0).is_none() {
        return;
    }
    // A new level starts a new recording (the file keeps the latest one).
    if game.is_added() || r.rec.is_none() {
        let start = game.sim.player(0).and_then(|p| game.sim.world.body(p.ctl.body)).map_or([0.0, 0.0], |b| {
            let c = b.centroid();
            [c.x, c.y]
        });
        r.rec = Some(Recording { version: 1, build: crate::build_info::COMMIT.into(), level: game.sim.level.id.clone(), level_hash: level_hash(&game.sim.level), start, ..default() });
        r.level_tick0 = game.tick;
        r.last_write = 0;
        info!("recording player 1's input on {} to {path}", game.sim.level.id);
    }
    let r = r.as_mut();
    let tick = game.tick - r.level_tick0;
    let input = inputs.slots[0];
    let Some(rec) = r.rec.as_mut() else { return };
    rec.push(tick, input);
    // Save once a second (and keep going); the file always holds the run so far.
    if tick >= r.last_write + 60 {
        r.last_write = tick;
        if let Ok(j) = serde_json::to_string(rec) {
            if let Err(e) = std::fs::write(&path, j) {
                error!("can't write {path}: {e}");
            }
        }
    }
}

fn save(r: &Recorder) {
    let (Ok(path), Some(rec)) = (std::env::var("BB_RECORD_INPUT"), r.rec.as_ref()) else { return };
    if let Ok(j) = serde_json::to_string(rec) {
        if let Err(e) = std::fs::write(&path, j) {
            error!("can't write {path}: {e}");
        }
    }
}

/// Save the whole run when the game quits.
fn flush_on_exit(mut exits: MessageReader<AppExit>, r: Res<Recorder>) {
    if exits.read().next().is_some() {
        save(&r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_only_and_lookup() {
        let mut r = Recording { version: 1, ..Default::default() };
        let right = bb_sim::Input { stick: bb_sim::Vec2::new(1.0, 0.0), button: false };
        let jump = bb_sim::Input { stick: bb_sim::Vec2::new(1.0, 0.0), button: true };
        for t in 0..10 {
            r.push(t, if (4..6).contains(&t) { jump } else if t >= 2 { right } else { bb_sim::Input::default() });
        }
        assert_eq!(r.changes.len(), 4);
        assert_eq!(r.ticks, 10);
        assert_eq!(r.input_at(0), bb_sim::Input::default());
        assert_eq!(r.input_at(3), right);
        assert_eq!(r.input_at(5), jump);
        assert_eq!(r.input_at(9), right);
        let back: Recording = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }

    #[test]
    fn level_hash_is_stable_and_sensitive() {
        let a = bb_level::campaign::chapter(3);
        assert_eq!(level_hash(&a), level_hash(&bb_level::campaign::chapter(3)));
        assert_ne!(level_hash(&a), level_hash(&bb_level::campaign::chapter(2)));
    }
}
