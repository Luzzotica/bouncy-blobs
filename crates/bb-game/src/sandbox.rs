//! Physics playground used during development (`--sandbox`).

use bb_level::{LevelBuilder, PropKind, RopeEnd, RopeStyle, Theme, v};
use bevy::prelude::*;

use crate::flow::AppState;
use crate::sim::LoadLevel;

pub struct SandboxPlugin;

impl Plugin for SandboxPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Startup, start);
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

fn start(mut load: MessageWriter<LoadLevel>, mut next: ResMut<NextState<AppState>>) {
    match std::env::var("BB_START").as_deref() {
        Ok("story") => next.set(AppState::Story),
        Ok("sandbox") => {
            load.write(LoadLevel { level: sandbox_level(), players: vec![(0, "Pip".into(), 0xff5d73)] });
            next.set(AppState::Playing);
        }
        Ok("kids") => next.set(AppState::Kids),
        Ok("editor") => next.set(AppState::Editor),
        Ok("party") => next.set(AppState::Party),
        _ => {}
    }
}

