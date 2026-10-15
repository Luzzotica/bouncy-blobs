//! Capture-only scenes (`BB_CAPTURE_SCENE`), staged for trailers. They never
//! change the real menus or levels.
//!
//! * `endcard` — the title cave (same backdrop as the title screen), the
//!   jelly BOUNCY BLOBS logo, and a blue jelly block reading "Wishlist on Steam" /
//!   "Coming October 30". No menu buttons. Pip and friends jump in from the
//!   sides and below, bounce off the logo and the block, and land on it.
//!   `BB_CAPTURE_SCENE_SEED=n` varies the choreography (takes).
//! * `logo` — the same without the block: logo and blobs in the title cave.
//! * `spikeloop` — a small stage in The Drip's look: a flat floor of spikes,
//!   Pip spawning at (0, 260) above them (the camera's job is the framing).
//!   Pair with `BB_CAPTURE_RESPAWN` (short next-life delay),
//!   `BB_CAPTURE_DROPLET_LIFE` (droplets melt before they cushion the
//!   spikes) and optionally `BB_CAPTURE_RESPAWN_AT` for x variation.
//! * `stage` — an empty posing stage for transparent stills
//!   (`BB_CAPTURE_TRANSPARENT=1`): a flat floor (hidden in transparent mode)
//!   and `BB_STAGE=solo` (Pip alone; place with `BB_CAPTURE_AT`, drive with
//!   `BB_PRESS`), `pile` (Pip and four friends dropped into a narrow funnel;
//!   `BB_CAPTURE_SCENE_SEED` varies the drop), `pile4` (the four friends
//!   only: teal, yellow, green, purple; no Pip) or `trio` (three Kids Mode
//!   shape friends: star, square, triangle).

use bb_physics::Vec2 as PVec2;
use bb_level::{LevelBuilder, NpcRole, Theme, v};
use bb_sim::BodyTag;
use bevy::prelude::*;

use crate::flow::AppState;
use crate::palette::{darken, hex};
use crate::render::{Style, StyleOverrides, z};
use crate::sim::{Game, LoadLevel};
use crate::softtext::{Ride, SoftText};

/// The scene asked for, if any.
pub fn scene() -> Option<String> {
    std::env::var("BB_CAPTURE_SCENE").ok().filter(|s| !s.is_empty())
}

pub struct CaptureScenePlugin;

impl Plugin for CaptureScenePlugin {
    fn build(&self, app: &mut App) {
        if scene().as_deref() == Some("spikeloop") {
            app.add_systems(Startup, start_spikeloop);
            return;
        }
        if scene().as_deref() == Some("stage") {
            app.add_systems(Startup, start_stage).add_systems(PostUpdate, setup_stage.run_if(resource_added::<Game>));
            return;
        }
        if !matches!(scene().as_deref(), Some("endcard" | "logo")) {
            return;
        }
        app.add_systems(Startup, start)
            .add_systems(PostUpdate, build_endcard.run_if(resource_added::<Game>))
            .add_systems(Update, launch.run_if(resource_exists::<Game>));
    }
}

/// Pip first (the default pink), then friends.
pub const BLOB_COLORS: [u32; 6] = [0xff5d73, 0x4ac8c8, 0xffd54a, 0xff9d4a, 0x8fe36b, 0xb98cff];
const BLOB_R: f32 = 36.0;

/// Block: centre and size (world units); the logo rows sit above it.
pub const BLOCK_C: Vec2 = Vec2::new(0.0, 460.0);
pub const BLOCK_SIZE: Vec2 = Vec2::new(560.0, 170.0);
const LOGO_Y: f32 = 1010.0;
const LOGO_SCALE: f32 = 1.1;

pub const WISHLIST: &str = "Wishlist on Steam";
pub const DATE: &str = "Coming October 30";

/// The endcard's world: the title's cave (same level id, so the same
/// backdrop seed and music) with the blobs parked off screen.
pub fn endcard_level() -> bb_level::Level {
    let mut b = LevelBuilder::new(crate::menu::TITLE_ID, "Endcard", Theme::Hollow);
    b.spawn(v(0.0, -2000.0))
        .kill_y(-8000.0)
        .decor("glowworm", v(-300.0, 760.0), 1.4, -1.0)
        .decor("glowworm", v(500.0, 820.0), 1.0, -1.0);
    for (i, c) in BLOB_COLORS.iter().enumerate() {
        b.npc(&format!("e{i}"), v(-3000.0 - i as f32 * 200.0, -3000.0), NpcRole::Huddle, &format!("#{c:06x}"), BLOB_R);
    }
    b.build()
}

fn start(mut load: MessageWriter<LoadLevel>, mut next: ResMut<NextState<AppState>>) {
    next.set(AppState::Playing);
    load.write(LoadLevel { level: endcard_level(), players: Vec::new() });
}

fn build_endcard(mut commands: Commands, mut game: ResMut<Game>, mut overrides: ResMut<StyleOverrides>) {
    for n in game.sim.npcs.iter_mut() {
        n.scripted = true;
    }
    // Logo: soft letter tiles (the title's colours), centred.
    let logo: &[(&str, u32)] = &[("B", 0xff5d73), ("O", 0xff9f43), ("U", 0xffd93d), ("N", 0x6bcb77), ("C", 0x4d96ff), ("Y", 0x9b5de5)];
    let logo2: &[(&str, u32)] = &[("B", 0xf15bb5), ("L", 0x00c2a8), ("O", 0x5dd6ff), ("B", 0xa0e426), ("S", 0xff7eb6)];
    let s = LOGO_SCALE;
    for (row, (letters, y)) in [(logo, LOGO_Y), (logo2, LOGO_Y - 100.0 * s)].iter().enumerate() {
        let n = letters.len() as f32;
        let x0 = -(n - 1.0) * 98.0 * s * 0.5 + row as f32 * 26.0 * s * 0.5;
        for (i, (ch, col)) in letters.iter().enumerate() {
            let x = x0 + i as f32 * 98.0 * s;
            let tilt = ((i * 7 + row * 3) % 5) as f32 - 2.0;
            let rise = i as f32 * 4.0 * s;
            let id = crate::menu::jelly_tile(&mut game, PVec2::new(x, *y + rise + tilt * 3.0), PVec2::splat(88.0 * s), BodyTag::Ui, 3e-5);
            overrides.0.insert(id, Style { fill: hex(*col), rim: darken(hex(*col), 0.4), rim_w: 5.0, highlight: true, z: z::PROP + 0.5, top_rim_only: false });
            text(&mut commands, id, ch, 60.0 * s, Vec2::ZERO);
        }
    }
    // `logo`: just the cave, the logo and the blobs (store stills).
    if scene().as_deref() == Some("logo") {
        return;
    }
    // The Wishlist block: a solid jelly slab the blobs land on.
    // Blue, so pink Pip stands out on it.
    let c = 0x4d7fe8;
    let id = crate::menu::jelly_tile(&mut game, PVec2::new(BLOCK_C.x, BLOCK_C.y), PVec2::new(BLOCK_SIZE.x, BLOCK_SIZE.y), BodyTag::Ui, 4e-5);
    overrides.0.insert(id, Style { fill: hex(c), rim: darken(hex(c), 0.4), rim_w: 6.0, highlight: true, z: z::PROP + 0.5, top_rim_only: false });
    text(&mut commands, id, WISHLIST, 54.0, Vec2::new(0.0, 26.0));
    text(&mut commands, id, DATE, 34.0, Vec2::new(0.0, -44.0));
}

fn text(commands: &mut Commands, body: bb_sim::BodyId, s: &str, size: f32, at: Vec2) {
    commands.spawn((SoftText::new(s, size).ride(Ride::Game(body)).color(Color::WHITE).z(z::FX - 0.5).at(at).stagger(0.02), crate::level_view::LevelEntity));
}

/// One blob's entrance: at sim tick `tick`, appear at `from` and fly to land
/// on the block's top at x = `land_x`, peaking at height `apex`.
#[derive(Clone, Copy, Debug)]
pub struct Entrance {
    pub blob: usize,
    pub tick: u64,
    pub from: Vec2,
    pub land_x: f32,
    pub apex: f32,
}

/// Ballistic launch velocity from `from` to `to` peaking at `apex` (y),
/// under gravity `g` (> 0, pulling down).
pub fn launch_velocity(from: Vec2, to: Vec2, apex: f32, g: f32) -> Vec2 {
    let apex = apex.max(from.y + 1.0).max(to.y + 1.0);
    let vy = (2.0 * g * (apex - from.y)).sqrt();
    let t = vy / g + (2.0 * (apex - to.y) / g).sqrt();
    Vec2::new((to.x - from.x) / t, vy)
}

/// The choreography for take `seed`: six entrances over ~2.5 s, from the
/// left, right and below, some arcing high enough to bump the logo.
pub fn entrances(seed: u32) -> Vec<Entrance> {
    // Entrances from below come up beside the block, never under it; side
    // entrances start above its top so they clear its corners.
    let mut e = vec![
        // Pip: from below-left, over the block's corner, lands centre-left.
        Entrance { blob: 0, tick: 30, from: Vec2::new(-430.0, -80.0), land_x: -40.0, apex: 820.0 },
        Entrance { blob: 1, tick: 18, from: Vec2::new(600.0, 640.0), land_x: 170.0, apex: 760.0 },
        Entrance { blob: 2, tick: 40, from: Vec2::new(-600.0, 660.0), land_x: -190.0, apex: 1050.0 },
        Entrance { blob: 3, tick: 60, from: Vec2::new(420.0, -80.0), land_x: 60.0, apex: 1000.0 },
        Entrance { blob: 4, tick: 85, from: Vec2::new(600.0, 600.0), land_x: 230.0, apex: 700.0 },
        Entrance { blob: 5, tick: 105, from: Vec2::new(-600.0, 620.0), land_x: -230.0, apex: 720.0 },
    ];
    if seed % 2 == 1 {
        // Take 2: mirrored, Pip from below-right and a little later.
        for x in e.iter_mut() {
            x.from.x = -x.from.x;
            x.land_x = -x.land_x;
        }
        e[0].tick = 36;
        e[1].tick = 22;
    }
    e
}

#[derive(Default)]
struct Launched {
    done: Vec<bool>,
    /// Ticks spent below the view (relaunched onto the block).
    lost: Vec<u32>,
}

fn launch(mut game: ResMut<Game>, mut st: Local<Launched>) {
    let seed = std::env::var("BB_CAPTURE_SCENE_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0u32);
    let plan = entrances(seed);
    if st.done.len() != plan.len() {
        st.done = vec![false; plan.len()];
        st.lost = vec![0; BLOB_COLORS.len()];
    }
    let g = game.sim.tuning.gravity.gravity;
    let tick = game.tick;
    let ids: Vec<_> = game.sim.npcs.iter().map(|n| n.ctl.body).collect();
    let top = BLOCK_C.y + BLOCK_SIZE.y * 0.5 + BLOB_R;
    for (k, e) in plan.iter().enumerate() {
        if st.done[k] || tick < e.tick {
            continue;
        }
        st.done[k] = true;
        let Some(&id) = ids.get(e.blob) else { continue };
        let vel = launch_velocity(e.from, Vec2::new(e.land_x, top), e.apex, g);
        game.sim.world.respawn(id, PVec2::new(e.from.x, e.from.y));
        if let Some(b) = game.sim.world.body_mut(id) {
            b.params.limits.poppable = false;
            let v0 = b.velocity();
            b.add_velocity(PVec2::new(vel.x, vel.y) - v0);
        }
    }
    // A blob that bounced off and fell out of view hops back onto the block.
    for (i, &id) in ids.iter().enumerate() {
        let launched = plan.iter().zip(&st.done).any(|(e, d)| *d && e.blob == i);
        let Some(c) = game.sim.world.body(id).map(|b| b.centroid()) else { continue };
        if !launched || (c.y > -250.0 && c.x.abs() < 700.0) {
            st.lost[i] = 0;
            continue;
        }
        st.lost[i] += 1;
        if st.lost[i] == 20 {
            let from = Vec2::new(if c.x < 0.0 { -430.0 } else { 430.0 }, -200.0);
            let land = (i as f32 - 2.5) * 90.0;
            let vel = launch_velocity(from, Vec2::new(land, top), 760.0, g);
            game.sim.world.respawn(id, PVec2::new(from.x, from.y));
            if let Some(b) = game.sim.world.body_mut(id) {
                let v0 = b.velocity();
                b.add_velocity(PVec2::new(vel.x, vel.y) - v0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endcard_text_has_glyphs() {
        for s in [WISHLIST, DATE, "BOUNCYBLOS"] {
            assert!(crate::softtext::missing_glyphs(s).is_empty(), "{s}: {:?}", crate::softtext::missing_glyphs(s));
        }
    }

    #[test]
    fn launch_lands_on_target() {
        let g = 2613.0;
        let (from, to) = (Vec2::new(-500.0, -200.0), Vec2::new(40.0, 430.0));
        let v = launch_velocity(from, to, 900.0, g);
        // Integrate the arc and check it passes through the target.
        let t_up = v.y / g;
        let t = t_up + (2.0 * (900.0 - to.y) / g).sqrt();
        let x = from.x + v.x * t;
        let y = from.y + v.y * t - 0.5 * g * t * t;
        assert!((x - to.x).abs() < 1.0 && (y - to.y).abs() < 1.0, "{x},{y}");
        // Peak height.
        let peak = from.y + v.y * v.y / (2.0 * g);
        assert!((peak - 900.0).abs() < 1.0);
    }

    #[test]
    fn spikeloop_is_spikes_under_pip() {
        let l = spikeloop_level();
        assert_eq!(l.spikes.len(), 2);
        assert!(l.npcs.is_empty());
        assert_eq!(l.theme, Theme::Drip);
        assert!(l.spawn.y > 100.0);
    }

    #[test]
    fn both_takes_launch_pip() {
        for seed in [0, 1] {
            assert!(entrances(seed).iter().any(|e| e.blob == 0));
        }
    }
}

// ------------------------------------------------------------------ stage

fn stage_kind() -> String {
    std::env::var("BB_STAGE").unwrap_or_else(|_| "solo".into())
}

fn stage_seed() -> u32 {
    std::env::var("BB_CAPTURE_SCENE_SEED").ok().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Friends' colours on the stage (no named characters).
pub const STAGE_COLORS: [u32; 4] = [0x4ac8c8, 0xffd54a, 0x8fe36b, 0xb98cff];

/// The posing stage: dark-cave look (so blobs get their glow), a wide
/// floor, and for `pile` a narrow funnel the friends drop into.
pub fn stage_level(kind: &str, seed: u32) -> bb_level::Level {
    let mut b = LevelBuilder::new("stage", "Stage", Theme::Hollow);
    b.spawn(v(0.0, 40.0)).kill_y(-3000.0);
    if kind == "pile" || kind == "pile4" {
        b.ground(&[v(-2000.0, 600.0), v(-170.0, 600.0), v(-110.0, 0.0), v(110.0, 0.0), v(170.0, 600.0), v(2000.0, 600.0)], 400.0);
        // Friends drop in one by one from above the funnel.
        for (i, c) in STAGE_COLORS.iter().enumerate() {
            let jitter = ((i as u32 * 7 + seed * 13) % 5) as f32 * 14.0 - 28.0;
            let y = 220.0 + i as f32 * 120.0 + (seed % 3) as f32 * 40.0;
            b.npc(&format!("s{i}"), v(jitter, y), NpcRole::Huddle, &format!("#{c:06x}"), 32.0);
        }
    } else {
        b.ground(&[v(-3000.0, 0.0), v(3000.0, 0.0)], 400.0);
    }
    b.build()
}

fn start_stage(mut load: MessageWriter<LoadLevel>, mut next: ResMut<NextState<AppState>>) {
    next.set(AppState::Playing);
    let kind = stage_kind();
    let players = if kind == "trio" || kind == "pile4" { Vec::new() } else { vec![(0u8, "Pip".to_string(), 0xff5d73u32)] };
    load.write(LoadLevel { level: stage_level(&kind, stage_seed()), players });
}

fn setup_stage(mut game: ResMut<Game>) {
    for n in game.sim.npcs.iter_mut() {
        n.scripted = true;
    }
    if stage_kind() == "trio" {
        use crate::kids::level::KidsShape;
        let seed = stage_seed();
        let spread = 72.0 + (seed % 2) as f32 * 14.0;
        let trio = [(KidsShape::Star, 0xe8c54a, -spread), (KidsShape::Square, 0x5a8ae0, 0.0), (KidsShape::Triangle, 0xd06eb0, spread)];
        for (i, (shape, color, x)) in trio.into_iter().enumerate() {
            let body = game.sim.add_player(i as u8 + 1, "", color).ctl.body;
            if let Some(b) = game.sim.world.body_mut(body) {
                b.set_rest_shape(&shape.outline());
            }
            // Take 2 drops them from different heights so they land unevenly.
            let y = 60.0 + if seed % 2 == 1 { i as f32 * 90.0 } else { 0.0 };
            game.sim.world.respawn(body, PVec2::new(x, y));
        }
    }
}

// -------------------------------------------------------------- spikeloop

/// Pip's spawn point above the spike strip in `spikeloop`.
pub const SPIKELOOP_SPAWN: (f32, f32) = (0.0, 260.0);

pub fn spikeloop_level() -> bb_level::Level {
    let mut b = LevelBuilder::new("spikeloop", "Spike loop", Theme::Drip);
    b.spawn(v(SPIKELOOP_SPAWN.0, SPIKELOOP_SPAWN.1)).kill_y(-3000.0);
    // `BB_SPIKELOOP_SLOPE=k`: the strip is a gentle tent (rise k per unit
    // x toward the middle) so pop droplets slide away off both sides and
    // never cushion the spikes; 0 = flat.
    let k = std::env::var("BB_SPIKELOOP_SLOPE").ok().and_then(|s| s.parse::<f32>().ok()).unwrap_or(0.0);
    let (l, r) = (v(-3000.0, -3000.0 * k), v(3000.0, -3000.0 * k));
    b.ground(&[l, v(0.0, 0.0), r], 600.0);
    b.spikes(l, v(0.0, 0.0));
    b.spikes(v(0.0, 0.0), r);
    b.build()
}

fn start_spikeloop(mut load: MessageWriter<LoadLevel>, mut next: ResMut<NextState<AppState>>) {
    next.set(AppState::Playing);
    load.write(LoadLevel { level: spikeloop_level(), players: vec![(0u8, "Pip".to_string(), 0xff5d73u32)] });
}
