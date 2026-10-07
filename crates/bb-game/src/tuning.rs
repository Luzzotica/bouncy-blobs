//! Live blob tuning: watch `tuning.toml` and apply edits while the game runs.
//!
//! Desktop only. The file is `$BB_TUNING` if set, else the source file in
//! the repo (`crates/bb-sim/tuning.toml`) when it exists (dev builds), so
//! edits are live now AND become the compiled-in defaults on the next build.

use std::path::PathBuf;
use std::time::SystemTime;

use bevy::prelude::*;
use bb_sim::tuning::{self, Tuning};

use crate::sim::Game;

pub struct TuningPlugin;

impl Plugin for TuningPlugin {
    fn build(&self, app: &mut App) {
        let Some(path) = watched_path() else { return };
        info!("live tuning: watching {}", path.display());
        app.insert_resource(Watch { path, modified: None, poll: 0.0 }).add_systems(Update, (watch, fade_notice));
    }
}

fn watched_path() -> Option<PathBuf> {
    if cfg!(any(target_arch = "wasm32", target_os = "ios", target_os = "android")) {
        return None;
    }
    if let Ok(p) = std::env::var("BB_TUNING") {
        return Some(PathBuf::from(p));
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../bb-sim/tuning.toml"));
    dev.exists().then_some(dev)
}

#[derive(Resource)]
struct Watch {
    path: PathBuf,
    modified: Option<SystemTime>,
    poll: f32,
}

#[derive(Component)]
struct Notice(f32);

fn watch(mut commands: Commands, mut w: ResMut<Watch>, time: Res<Time>, game: Option<ResMut<Game>>, old: Query<Entity, With<Notice>>) {
    w.poll -= time.delta_secs();
    if w.poll > 0.0 {
        return;
    }
    w.poll = 0.4;
    let Ok(m) = std::fs::metadata(&w.path).and_then(|m| m.modified()) else { return };
    let first = w.modified.is_none();
    if w.modified == Some(m) {
        return;
    }
    w.modified = Some(m);
    let Ok(text) = std::fs::read_to_string(&w.path) else { return };
    let (msg, ok) = match Tuning::parse(&text) {
        Ok(t) => {
            // Startup: only matters if the file differs from the built-in.
            if first && t == Tuning::default() {
                return;
            }
            tuning::set_live(t.clone());
            if let Some(mut g) = game {
                g.sim.set_tuning(t);
            }
            info!("live tuning: reloaded {}", w.path.display());
            ("tuning reloaded".to_string(), true)
        }
        Err(e) => {
            warn!("live tuning: {} — keeping the last good tuning\n{e}", w.path.display());
            (format!("tuning.toml error (see terminal): {}", e.lines().next().unwrap_or("")), false)
        }
    };
    for e in old.iter() {
        commands.entity(e).despawn();
    }
    commands.spawn((
        Text::new(msg),
        TextFont { font_size: 18.0.into(), ..default() },
        TextColor(if ok { Color::srgb(0.7, 1.0, 0.75) } else { Color::srgb(1.0, 0.55, 0.5) }),
        Node { position_type: PositionType::Absolute, left: px(14.0), top: px(10.0), ..default() },
        GlobalZIndex(90),
        Notice(if ok { 1.8 } else { 6.0 }),
    ));
}

fn fade_notice(mut commands: Commands, time: Res<Time>, mut q: Query<(Entity, &mut Notice, &mut TextColor)>) {
    for (e, mut n, mut c) in q.iter_mut() {
        n.0 -= time.delta_secs();
        c.0.set_alpha(n.0.clamp(0.0, 0.6) / 0.6);
        if n.0 <= 0.0 {
            commands.entity(e).despawn();
        }
    }
}
