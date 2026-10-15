//! **Up & Out** — the 10-chapter story campaign, authored as code.
//!
//! Each chapter is a long, hand-built level (JellyCar length) plus its
//! *critical path*: the waypoints a player must pass, each tagged with how
//! you get there from the previous one. Tests use the path to audit jump
//! heights and gaps against the controller metrics and to drive an
//! autopilot playtest bot (see `tests/campaign.rs`).
//!
//! Waypoints are **feet positions** (on the surface you stand on).

pub(crate) use crate::builder::v;
pub use crate::blueprint::{Blueprint, Course, Move, Waypoint};
pub(crate) use glam::Vec2;
pub(crate) use record::Ch;
pub(crate) use crate::types::*;

mod record;

mod ch01;
mod ch02;
mod ch03;
mod ch04;
mod ch05;
mod ch06;
mod ch07;
mod ch08;
mod ch09;
mod ch10;

pub const CHAPTERS: u8 = 10;

/// Chapter `n` (1-based) with its critical path.
pub fn course(n: u8) -> Course {
    recorded(n).1
}

/// Chapter `n` from the Rust builders, recorded as a blueprint.
pub fn recorded(n: u8) -> (Blueprint, Course) {
    match n {
        1 => ch01::build(),
        2 => ch02::build(),
        3 => ch03::build(),
        4 => ch04::build(),
        5 => ch05::build(),
        6 => ch06::build(),
        7 => ch07::build(),
        8 => ch08::build(),
        9 => ch09::build(),
        10 => ch10::build(),
        _ => panic!("no chapter {n} (1..={CHAPTERS})"),
    }
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
    let n: u8 = id.strip_prefix("ch")?.parse().ok()?;
    (1..=CHAPTERS).contains(&n).then(|| chapter(n))
}

