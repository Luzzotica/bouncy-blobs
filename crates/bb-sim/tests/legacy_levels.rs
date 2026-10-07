//! Every legacy level (copied into bb-level/assets/legacy so this is
//! hermetic) imports, loads into the sim, and runs 3 s with a player
//! without NaNs or the player dropping out of the world.

use std::path::PathBuf;

use bb_level::legacy::{ImportOptions, import_legacy_with};
use bb_sim::Sim;

fn legacy_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bb-level/assets/legacy")
}

fn legacy_files() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(legacy_dir())
        .expect("legacy dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|e| e == "json") && p.file_name().unwrap() != "manifest.json")
        .collect();
    v.sort();
    v
}

#[test]
fn all_27_legacy_levels_import_and_run() {
    let files = legacy_files();
    assert_eq!(files.len(), 27, "expected 27 legacy levels, got {}", files.len());
    let mut report = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    for f in &files {
        let stem = f.file_stem().unwrap().to_string_lossy().to_string();
        let json = std::fs::read_to_string(f).unwrap();
        let opts = ImportOptions { id: Some(stem.clone()), ..Default::default() };
        let imp = import_legacy_with(&json, &opts).unwrap_or_else(|e| panic!("{stem}: {e}"));
        let level = imp.level;
        // Round-trips through the v3 format.
        let level = bb_level::Level::from_json(&level.to_json()).unwrap();
        let mut sim = Sim::new(level);
        sim.add_player(0, "P", 0xff5d73);
        let start = sim.world.body(sim.players[0].ctl.body).unwrap().centroid();
        let mut died_at = None;
        let mut events = 0;
        for step in 0..180 {
            sim.step();
            for e in sim.drain_events() {
                events += 1;
                if matches!(e, bb_sim::SimEvent::Popped { who: bb_sim::Who::Player(0), .. }) && died_at.is_none() {
                    died_at = Some(step);
                }
            }
        }
        for (id, b) in sim.world.bodies() {
            assert!(b.x.iter().all(|p| p.is_finite()), "{stem}: NaN in body {id:?}");
        }
        let p = &sim.players[0];
        let body = sim.world.body(p.ctl.body).unwrap();
        let c = body.centroid();
        assert!(c.is_finite(), "{stem}: player NaN");
        // Rolling into a hazard late in the run is gameplay (an idle ball on a
        // 30° ramp rolls); popping in the first 1.5 s means a bad import.
        // crush-test spawns the player on a plate under a crusher on purpose.
        if let Some(s) = died_at.filter(|s| *s < 90 && stem != "crush-test") {
            failures.push(format!("{stem}: player popped at step {s} (spawn {start}, now {c}, kill_y {})", sim.level.kill_y));
        } else if c.y <= sim.level.kill_y {
            failures.push(format!("{stem}: player fell out ({c} vs kill_y {})", sim.level.kill_y));
        } else if (c - start).length() > 3000.0 {
            // Free fall for 3 s would be ~8000 px.
            failures.push(format!("{stem}: player travelled {} px", (c - start).length()));
        }
        report.push(format!("{stem}: ok ({} notes, {} bodies, {events} events, end {c:.0})", imp.notes.len(), sim.world.bodies().count()));
    }
    println!("{}", report.join("\n"));
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn plates_drive_movers() {
    use bb_level::{LevelBuilder, MoverMotion, Shape, StoryTrigger, Theme, v};
    let mut b = LevelBuilder::new("p", "P", Theme::Party);
    b.spawn(v(0.0, 60.0)).block(v(-600.0, -200.0), v(600.0, 0.0));
    b.mover(Shape::rect_at(v(400.0, 300.0), v(100.0, 20.0), 0.0), &[v(0.0, 0.0), v(0.0, 200.0)], 1.0, MoverMotion::PingPong);
    b.mover(Shape::rect_at(v(-400.0, 300.0), v(100.0, 20.0), 0.0), &[v(0.0, 0.0), v(0.0, 200.0)], 1.0, MoverMotion::PingPong);
    let mut level = b.build();
    level.movers[0].trigger = "plate1#once".into();
    level.movers[1].trigger = "elsewhere".into();
    level.story.push(StoryTrigger { shape: Shape::rect(v(-100.0, 0.0), v(100.0, 120.0)), script: "plate:plate1".into(), once: false });
    let mut sim = Sim::new(level);
    sim.add_player(0, "P", 0xffffff);
    for _ in 0..90 {
        sim.step();
        for e in sim.drain_events() {
            assert!(!matches!(e, bb_sim::SimEvent::Story { .. }), "plates don't fire story events");
        }
    }
    let y = |i: usize| {
        let s = sim.world.static_collider(sim.movers[i].id).unwrap();
        s.poly.iter().map(|p| p.y).sum::<f32>() / s.poly.len() as f32
    };
    assert!((y(0) - 500.0).abs() < 1.0, "pressed mover reached its end: {}", y(0));
    assert!((y(1) - 300.0).abs() < 1.0, "unpressed mover stayed: {}", y(1));
}

/// The converted party levels in bb-game/assets match the importer
/// (re-run `cargo run -p bb-level --example convert_legacy` if this fails).
#[test]
fn party_assets_are_up_to_date() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../bb-game/assets/levels/party");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let levels = manifest["levels"].as_array().unwrap();
    assert_eq!(levels.len(), 27);
    for e in levels {
        let id = e["id"].as_str().unwrap();
        let asset = std::fs::read_to_string(dir.join(e["file"].as_str().unwrap())).unwrap();
        let level = bb_level::Level::from_json(&asset).unwrap_or_else(|err| panic!("{id}: {err}"));
        let legacy = std::fs::read_to_string(legacy_dir().join(format!("{id}.json"))).unwrap();
        let fresh = import_legacy_with(&legacy, &ImportOptions { id: Some(id.into()), ..Default::default() }).unwrap();
        assert_eq!(level.to_json(), fresh.level.to_json(), "{id} is stale");
    }
}
