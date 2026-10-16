//! **Up & Out** — the 10-chapter story campaign.
//!
//! Each chapter is a long, hand-built level (JellyCar length) plus its
//! *critical path*: the waypoints a player must pass, each tagged with how
//! you get there from the previous one. Tests use the path to audit jump
//! heights and gaps against the controller metrics and to drive an
//! autopilot playtest bot (see `tests/campaign.rs`).
//!
//! The chapters are **blueprint files** (see [`crate::blueprint`] and
//! `docs/LevelFormat.md`): `crates/bb-game/assets/levels/campaign/chNN.json`.
//! They're compiled into every build (so web, iOS and Android need no file
//! access); dev builds of the game can also read them straight off disk
//! ([`source_path`]) and reload them live.
//!
//! Waypoints are **feet positions** (on the surface you stand on).

use std::path::PathBuf;
use std::sync::OnceLock;

pub use crate::blueprint::{Blueprint, Course, Move, Waypoint};
use crate::types::Level;

pub const CHAPTERS: u8 = 10;

macro_rules! chapter_files {
    ($($n:literal),*) => {
        [$(include_str!(concat!("../../../bb-game/assets/levels/campaign/ch", $n, ".json"))),*]
    };
}

/// The chapter files as compiled in (index 0 = chapter 1).
pub const FILES: [&str; CHAPTERS as usize] = chapter_files!("01", "02", "03", "04", "05", "06", "07", "08", "09", "10");

/// Where chapter `n`'s file lives in the source tree (for dev tools and
/// live reload; shipped builds use the compiled-in copy).
pub fn source_path(n: u8) -> PathBuf {
    let crates = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or(std::path::Path::new(".."));
    crates.join("bb-game/assets/levels/campaign").join(format!("ch{n:02}.json"))
}

/// Chapter number of a campaign id ("ch01" … "ch10").
pub fn number(id: &str) -> Option<u8> {
    let n: u8 = id.strip_prefix("ch")?.parse().ok()?;
    (1..=CHAPTERS).contains(&n).then_some(n)
}

/// Chapter `n`'s blueprint (as compiled in).
pub fn blueprint(n: u8) -> Blueprint {
    assert!((1..=CHAPTERS).contains(&n), "no chapter {n} (1..={CHAPTERS})");
    Blueprint::from_json(FILES[n as usize - 1]).unwrap_or_else(|e| panic!("ch{n:02}.json: {e}"))
}

/// Chapter `n` (1-based) with its critical path.
pub fn course(n: u8) -> Course {
    static ALL: OnceLock<Vec<Course>> = OnceLock::new();
    assert!((1..=CHAPTERS).contains(&n), "no chapter {n} (1..={CHAPTERS})");
    ALL.get_or_init(|| (1..=CHAPTERS).map(|n| blueprint(n).expand()).collect())[n as usize - 1].clone()
}

/// Chapter `n` (1-based).
pub fn chapter(n: u8) -> Level {
    course(n).level
}

/// All ten chapters in order.
pub fn campaign() -> Vec<Level> {
    (1..=CHAPTERS).map(chapter).collect()
}

/// Look up a chapter by id ("ch01" … "ch10").
pub fn by_id(id: &str) -> Option<Level> {
    number(id).map(chapter)
}
