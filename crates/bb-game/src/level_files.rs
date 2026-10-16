//! Level files on disk and **live reload**.
//!
//! * `BB_LEVEL_FILE=path/to/level.json` plays any level file (a blueprint,
//!   a plain level or a legacy map).
//! * `BB_LEVEL=chNN` plays a chapter. Dev (debug) builds read it from
//!   `crates/bb-game/assets/levels/campaign/chNN.json` on disk, so edits
//!   show up without recompiling; shipped builds use the compiled-in copy.
//! * Either way, a dev build **watches the file**: save it and the level
//!   reloads in place within a fraction of a second. Pip stays where it was
//!   (or, if that spot is now inside rock, goes to the nearest checkpoint).
//!   A broken file keeps the old level and says what's wrong on screen.
//!   `BB_WATCH=0` turns watching off; `BB_WATCH=1` turns it on in release.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use bb_level::Level;
use bevy::prelude::*;

use crate::sim::{Game, LoadLevel};

pub struct LevelFilesPlugin;

impl Plugin for LevelFilesPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (watch, show_problems).chain().run_if(resource_exists::<LevelWatch>))
            .add_systems(PostUpdate, place_after_reload.run_if(resource_added::<Game>.and_then(resource_exists::<ReloadAt>)));
    }
}

/// Whether this build reads levels from disk and watches them.
pub fn watching_enabled() -> bool {
    if cfg!(any(target_arch = "wasm32", target_os = "ios", target_os = "android")) {
        return false;
    }
    match std::env::var("BB_WATCH").as_deref() {
        Ok("0") => false,
        Ok(_) => true,
        Err(_) => cfg!(debug_assertions),
    }
}

/// Chapter `n`, from its file on disk in dev builds (falls back to the
/// compiled-in copy), with the path to watch when it came from disk.
pub fn campaign_level(n: u8) -> (Level, Option<PathBuf>) {
    let path = bb_level::campaign::source_path(n);
    if watching_enabled() && path.exists() {
        match bb_level::load_level_file(&path) {
            Ok(l) => {
                for w in &l.warnings {
                    warn!("{}: {w}", path.display());
                }
                return (l.course.level, Some(path));
            }
            Err(e) => error!("{}: {e}\n(using the compiled-in chapter)", path.display()),
        }
    }
    (bb_level::campaign::chapter(n), None)
}

/// `BB_LEVEL_FILE` / `BB_LEVEL`: the level to start with and the file to
/// watch. `None`: neither is set (or the file didn't load).
pub fn startup_level() -> Option<(Level, Option<PathBuf>)> {
    if let Ok(p) = std::env::var("BB_LEVEL_FILE") {
        let path = PathBuf::from(p);
        match bb_level::load_level_file(&path) {
            Ok(l) => {
                for w in &l.warnings {
                    warn!("{}: {w}", path.display());
                }
                let watch = watching_enabled().then_some(path);
                return Some((l.course.level, watch));
            }
            Err(e) => {
                error!("BB_LEVEL_FILE={}: {e}", path.display());
                return None;
            }
        }
    }
    let id = std::env::var("BB_LEVEL").ok()?;
    let Some(n) = bb_level::campaign::number(&id) else {
        warn!("BB_LEVEL={id}: no such chapter, using the sandbox");
        return None;
    };
    Some(campaign_level(n))
}

/// The level file being watched for changes.
#[derive(Resource)]
pub struct LevelWatch {
    pub path: PathBuf,
    modified: Option<SystemTime>,
    since_poll: f32,
    /// What's wrong with the file right now (shown on screen).
    problems: Vec<String>,
    shown: bool,
}

impl LevelWatch {
    pub fn new(path: PathBuf) -> LevelWatch {
        let modified = mtime(&path);
        info!("watching {} (save it to reload the level)", path.display());
        LevelWatch { path, modified, since_poll: 0.0, problems: Vec::new(), shown: true }
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Where Pip was when the level reloaded.
#[derive(Resource)]
struct ReloadAt(Vec<(u8, Vec2)>);

fn watch(mut w: ResMut<LevelWatch>, time: Res<Time>, game: Option<Res<Game>>, mut load: MessageWriter<LoadLevel>, mut commands: Commands) {
    w.since_poll += time.delta_secs();
    if w.since_poll < 0.25 {
        return;
    }
    w.since_poll = 0.0;
    let m = mtime(&w.path);
    if m.is_none() || m == w.modified {
        return;
    }
    w.modified = m;
    let text = match std::fs::read_to_string(&w.path) {
        Ok(t) => t,
        // Editors often write via a temp file + rename: try next poll.
        Err(_) => {
            w.modified = None;
            return;
        }
    };
    match bb_level::load_level_text(&text) {
        Err(e) => {
            for p in &e.problems {
                error!("{}: {p}", w.path.display());
            }
            w.problems = e.problems;
            w.shown = false;
        }
        Ok(l) => {
            for x in &l.warnings {
                warn!("{}: {x}", w.path.display());
            }
            w.problems.clear();
            w.shown = false;
            let Some(game) = game else { return };
            let sim = &game.sim;
            let players: Vec<(u8, String, u32)> = sim.players.iter().filter(|p| p.local).map(|p| (p.slot, p.name.clone(), p.color)).collect();
            let at: Vec<(u8, Vec2)> = sim
                .players
                .iter()
                .filter_map(|p| sim.world.body(p.ctl.body).map(|b| (p.slot, Vec2::new(b.centroid().x, b.centroid().y))))
                .collect();
            info!("{} changed: reloading the level", w.path.display());
            commands.insert_resource(ReloadAt(at));
            load.write(LoadLevel { level: l.course.level, players });
        }
    }
}

/// After a reload: everyone back where they were, unless that's inside rock
/// now, then the nearest respawn point. Dying respawns at the nearest one.
fn place_after_reload(mut game: ResMut<Game>, at: Res<ReloadAt>, mut commands: Commands) {
    commands.remove_resource::<ReloadAt>();
    let sim = &mut game.sim;
    let solids = bb_level::lint::solids(&sim.level);
    let pts = sim.level.respawn_points();
    for (slot, p) in &at.0 {
        let p = bb_sim::Vec2::new(p.x, p.y);
        let k = pts.iter().enumerate().min_by(|a, b| a.1.distance(p).total_cmp(&b.1.distance(p))).map_or(0, |x| x.0);
        sim.checkpoint = k;
        let free = !bb_level::lint::embedded(&solids, p, bb_level::metrics::PLAYER_R);
        let to = if free { p } else { pts[k] };
        if let Some(body) = sim.players.iter().find(|q| q.slot == *slot).map(|q| q.ctl.body) {
            sim.world.respawn(body, to);
        }
    }
}

#[derive(Component)]
struct ProblemText;

/// The current file problems, top-left (gone once the file loads again).
fn show_problems(mut w: ResMut<LevelWatch>, mut commands: Commands, old: Query<Entity, With<ProblemText>>) {
    if w.shown {
        return;
    }
    w.shown = true;
    for e in old.iter() {
        commands.entity(e).despawn();
    }
    if w.problems.is_empty() {
        return;
    }
    let name = w.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut msg = format!("{name} didn't load (still playing the last good version):");
    for p in w.problems.iter().take(6) {
        msg.push_str("\n- ");
        msg.push_str(p);
    }
    commands.spawn((
        Text::new(msg),
        TextFont { font_size: 18.0.into(), ..default() },
        TextColor(Color::srgb(1.0, 0.85, 0.6)),
        BackgroundColor(Color::srgba(0.1, 0.0, 0.05, 0.85)),
        Node { position_type: PositionType::Absolute, left: px(16.0), top: px(56.0), max_width: percent(80.0), padding: UiRect::all(px(10.0)), ..default() },
        GlobalZIndex(90),
        ProblemText,
    ));
}
