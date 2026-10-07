//! Physics playground used during development (`--sandbox`).
//!
//! Dev env vars:
//! * `BB_LEVEL=chNN` — play campaign chapter NN instead of the sandbox.
//! * `BB_CHECKPOINT=k` — start at respawn point k (0 = level spawn).
//! * `BB_ZOOM=z` — camera zoom-out factor (e.g. 3 for an overview).
//! * `BB_CAM=x,y` — pin the camera at a world position.

use bb_level::{LevelBuilder, PropKind, RopeEnd, RopeStyle, Theme, v};
use bevy::prelude::*;

use crate::sim::LoadLevel;

pub struct SandboxPlugin;

impl Plugin for SandboxPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, start)
            .add_systems(PostUpdate, start_at_checkpoint.run_if(resource_added::<crate::sim::Game>));
    }
}

pub fn sandbox_level() -> bb_level::Level {
    let mut b = LevelBuilder::new("sandbox", "Sandbox", Theme::Fungus);
    b.spawn(v(0.0, 120.0))
        .ground(&[v(-1200.0, 0.0), v(400.0, 0.0), v(700.0, 120.0), v(1400.0, 120.0)], 400.0)
        .block(v(-1300.0, -400.0), v(-1200.0, 800.0))
        .mushroom(v(-500.0, 0.0), 110.0, 170.0)
        .bridge(v(1400.0, 120.0), v(1900.0, 120.0), 26.0, 0.4)
        .ground(&[v(1900.0, 120.0), v(2600.0, 120.0)], 520.0)
        .vine(v(2300.0, 700.0), 330.0)
        .spring(v(2550.0, 120.0), 90.0, 1500.0)
        .crusher(v(-850.0, 520.0), 120.0, 400.0, 0.0)
        .slab(v(900.0, 420.0), v(260.0, 40.0), 0.3)
        .prop("box", PropKind::Block, v(200.0, 200.0), v(70.0, 70.0), 1.2, "#ffd166")
        .ball(v(-100.0, 300.0), 34.0, "#06d6a0")
        .rope(RopeEnd::World { at: v(200.0, 650.0) }, RopeEnd::Body { id: "box".into() }, 380.0, RopeStyle::Rope)
        .spikes(v(2650.0, 120.0), v(2900.0, 120.0))
        .ground(&[v(2600.0, 120.0), v(3400.0, 120.0)], 520.0)
        .checkpoint(v(1700.0, 160.0))
        .pickup_arc(v(-200.0, 60.0), v(300.0, 60.0), 160.0, 5)
        .water(v(-1200.0, 0.0), v(-700.0, 180.0))
        .goal(v(3200.0, 120.0), v(3350.0, 320.0))
        .npc("pal", v(-300.0, 100.0), bb_level::NpcRole::Follower, "", 28.0)
        .decor("crystal", v(-1000.0, 0.0), 1.0, -1.0)
        .kill_y(-800.0);
    b.build()
}

fn start(mut load: MessageWriter<LoadLevel>, mut dir: ResMut<crate::camera::CameraDirector>) {
    let level = std::env::var("BB_LEVEL")
        .ok()
        .and_then(|id| {
            let l = bb_level::campaign::by_id(&id);
            if l.is_none() {
                warn!("BB_LEVEL={id}: no such chapter, using the sandbox");
            }
            l
        })
        .unwrap_or_else(sandbox_level);
    if let Some(z) = std::env::var("BB_ZOOM").ok().and_then(|s| s.parse::<f32>().ok()) {
        dir.zoom = Some(z);
    }
    if let Some((x, y)) = std::env::var("BB_CAM").ok().and_then(|s| {
        let (x, y) = s.split_once(',')?;
        Some((x.trim().parse::<f32>().ok()?, y.trim().parse::<f32>().ok()?))
    }) {
        dir.target = Some(Vec2::new(x, y));
    }
    load.write(LoadLevel { level, players: vec![(0, "Pip".into(), 0xff5d73)] });
}

/// `BB_CHECKPOINT=k`: move everyone to respawn point k right after loading.
fn start_at_checkpoint(mut game: ResMut<crate::sim::Game>) {
    let Some(k) = std::env::var("BB_CHECKPOINT").ok().and_then(|s| s.parse::<usize>().ok()) else { return };
    let sim = &mut game.sim;
    let pts = sim.level.respawn_points();
    sim.checkpoint = k.min(pts.len() - 1);
    let at = sim.respawn_point();
    let bodies: Vec<_> = sim.players.iter().map(|p| p.ctl.body).collect();
    for (i, b) in bodies.into_iter().enumerate() {
        sim.world.respawn(b, at + bb_sim::Vec2::new(i as f32 * 20.0, 30.0));
    }
}
