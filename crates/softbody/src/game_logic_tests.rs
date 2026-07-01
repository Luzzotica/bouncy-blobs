//! Integration tests for the Phase 6-9 game-logic migration (triggers,
//! actions, spikes, modes). Mirrors the behavior the TS managers had, plus
//! determinism + snapshot-rollback round-trips.
#![cfg(test)]

use crate::fx::{Fx, FxVec2};
use crate::types::{BlobResult, SurfaceMaterial, WorldConfig};
use crate::world::AddBlobParams;
use crate::world::SoftBodyWorld;

fn fx(n: i32) -> Fx { Fx::from_int(n) }
fn dt() -> Fx { Fx::ONE / Fx::from_int(60) }

fn world_zero_g(seed: u32) -> SoftBodyWorld {
    let mut cfg = WorldConfig::default();
    cfg.gravity = FxVec2::ZERO;
    cfg.substeps = 4;
    SoftBodyWorld::new(cfg, seed)
}

/// Add a small square blob at `origin` and tag its role/gameplay id.
fn add_blob(w: &mut SoftBodyWorld, origin: FxVec2, role: u8, gameplay_id: u32, sort: &str) -> BlobResult {
    let hull = vec![
        FxVec2::new(fx(-20), fx(-20)), FxVec2::new(fx(20), fx(-20)),
        FxVec2::new(fx(20), fx(20)), FxVec2::new(fx(-20), fx(20)),
    ];
    let res = w.add_blob_from_hull(AddBlobParams {
        hull_rest_local: hull,
        center_local: FxVec2::ZERO,
        center_mass: crate::tuning::CENTER_MASS,
        hull_mass: crate::tuning::HULL_MASS,
        spring_k: crate::tuning::SPRING_K,
        spring_damp: crate::tuning::SPRING_DAMP,
        radial_k: crate::tuning::RADIAL_K,
        radial_damp: crate::tuning::RADIAL_DAMP,
        pressure_k: crate::tuning::PRESSURE_K,
        shape_match_k: crate::tuning::SHAPE_MATCH_K,
        shape_match_damp: crate::tuning::SHAPE_MATCH_DAMP,
        world_origin: origin,
        sort_key: Some(sort.into()),
        static_hull_indices: Vec::new(),
        static_center: false,
        pin_frame: false,
    });
    w.set_blob_role(res.blob_id, role, gameplay_id);
    res
}

/// Register an axis-aligned box trigger polygon centred at (cx,cy). Returns its shape_idx.
fn box_trigger(w: &mut SoftBodyWorld, cx: i32, cy: i32, hw: i32, hh: i32) -> u32 {
    let poly = vec![
        FxVec2::new(fx(cx - hw), fx(cy - hh)), FxVec2::new(fx(cx + hw), fx(cy - hh)),
        FxVec2::new(fx(cx + hw), fx(cy + hh)), FxVec2::new(fx(cx - hw), fx(cy + hh)),
    ];
    w.register_trigger_polygon(poly, None)
}

// ---------- Phase 6: triggers ----------

#[test]
fn trigger_charges_then_presses_and_releases() {
    let mut w = world_zero_g(1);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p"); // player on the trigger
    let sidx = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(7, sidx, Fx::from_f64(0.5), false);

    // Not yet charged.
    w.step(dt());
    assert!(!w.game_trigger_pressed(0), "should still be charging");
    // Charge for >0.5s.
    for _ in 0..40 { w.step(dt()); }
    assert!(w.game_trigger_pressed(0), "should be pressed after charge");
    assert!(w.game_trigger_pressed_by_id(7));

    // Move the blob far away → occupancy empties → unpress.
    w.teleport_blob(0, FxVec2::new(fx(10000), fx(0)));
    w.step(dt());
    assert!(!w.game_trigger_pressed(0), "should release when vacated");
}

#[test]
fn trigger_immediate_press_and_npc_filter() {
    let mut w = world_zero_g(2);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 2, 0, "npc"); // an NPC on it
    let sidx = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(1, sidx, Fx::ZERO, true); // charge 0 (immediate) but ignore NPCs
    w.step(dt());
    assert!(!w.game_trigger_pressed(0), "ignore_npcs should reject the NPC");

    // A second trigger that accepts NPCs presses immediately.
    let s2 = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(2, s2, Fx::ZERO, false);
    w.step(dt());
    assert!(w.game_trigger_pressed(1), "non-ignoring trigger should press on NPC immediately");
}

#[test]
fn tiny_trigger_inside_a_blob_still_fires() {
    // A trigger small enough to sit entirely inside the blob — no blob hull
    // point lands inside it, so it only fires via the trigger-vertex-in-blob
    // check. The default square blob spans ±20 around origin; a 10×10 trigger
    // at the centre has no blob point inside but its corners are in the blob.
    let mut w = world_zero_g(11);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    let sidx = box_trigger(&mut w, 0, 0, 5, 5); // 10×10 box at origin
    w.add_game_trigger(1, sidx, Fx::ZERO, false);
    w.step(dt());
    assert!(w.game_trigger_pressed(0), "a trigger inside a blob must still fire");
}

#[test]
fn structural_blob_never_presses() {
    let mut w = world_zero_g(3);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 0, 0, "struct"); // role 0 structural
    let sidx = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(1, sidx, Fx::ZERO, false);
    for _ in 0..10 { w.step(dt()); }
    assert!(!w.game_trigger_pressed(0), "structural softbody must never press a trigger");
}

// ---------- Phase 7: actions ----------

#[test]
fn action_moves_platform_when_trigger_pressed() {
    let mut w = world_zero_g(4);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    let sidx = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(1, sidx, Fx::ZERO, false); // immediate press

    // A platform static surface centred at (500, 0).
    let local = vec![FxVec2::new(fx(-50), fx(-10)), FxVec2::new(fx(50), fx(-10)), FxVec2::new(fx(50), fx(10)), FxVec2::new(fx(-50), fx(10))];
    let world_poly: Vec<FxVec2> = local.iter().map(|p| FxVec2::new(p.x + fx(500), p.y)).collect();
    let static_idx = w.register_static_polygon(world_poly, SurfaceMaterial::Default, Some("plat".into()), None, None);

    // Continuous action: open to (500, -300) over 0.2s when trigger 1 is pressed.
    let aidx = w.add_game_action(10, 0, false, 0, Fx::ZERO, Fx::from_f64(0.2), Fx::ONE, vec![1]);
    w.action_add_target_platform(aidx as usize, static_idx, fx(500), fx(0), Fx::ZERO, local, fx(500), fx(-300), Fx::ZERO);

    // Drive the action open (trigger pressed → tween).
    for _ in 0..30 { w.step(dt()); }
    // Platform poly should have translated up toward y ~ -300.
    let cy: f64 = {
        let surf = &w.static_surfaces[static_idx];
        surf.poly.iter().map(|p| p.y.to_f64()).sum::<f64>() / surf.poly.len() as f64
    };
    assert!(cy < -200.0, "platform should have opened upward, got cy={:.1}", cy);
}

// ---------- Phase 8: spikes ----------

#[test]
fn spike_kills_player_and_respawns_instant() {
    let mut w = world_zero_g(5);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    w.set_death_mode(0); // instant
    w.set_spawn_points(&[fx(2000), fx(2000)]);
    // Spike OBB covering the origin: base at (0,30), height 60 (teeth point up to y=-30 local).
    w.add_spike(1, fx(0), fx(40), Fx::ZERO, fx(80), fx(80));
    w.step(dt());
    let ev = w.take_kill_events();
    assert_eq!(ev.len(), 3, "one kill event (gid,x,y)");
    assert_eq!(ev[0], 0.0, "gameplay id 0 killed");
    assert!(w.is_invulnerable(0), "respawn grants invulnerability");
    // Blob teleported near the spawn point.
    let c = w.blob_centroid(0);
    assert!((c.x.to_f64() - 2000.0).abs() < 60.0, "respawned at spawn x");
}

#[test]
fn kill_plane_retires_npc_and_kills_player() {
    let mut w = world_zero_g(6);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    let npc = add_blob(&mut w, FxVec2::new(fx(100), fx(0)), 2, 0, "npc");
    w.set_death_mode(1); // no_respawn
    w.set_kill_below_y(fx(-500), true); // kill when centroid.y > -500 (always true here)
    w.step(dt());
    // Player dead (no respawn), npc retired.
    assert!(w.is_dead(0), "player killed by plane");
    assert!(w.blob_ranges[npc.blob_id as usize].inactive, "npc retired by plane");
}

// ---------- Phase 9: modes ----------

#[test]
fn race_finish_sets_winner() {
    let mut w = world_zero_g(7);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 5, "p");
    w.set_game_mode(0, fx(120), Fx::ZERO); // race
    w.set_goal_zone(fx(0), fx(0), fx(200), fx(200)); // goal over the blob
    w.set_mode_playing(true);
    w.step(dt());
    assert!(w.mode_decided(), "reaching the goal decides the race");
    assert_eq!(w.mode_winner(), 5, "winner is the blob's gameplay id");
}

#[test]
fn koth_scores_sole_occupant() {
    let mut w = world_zero_g(8);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 3, "p");
    w.set_game_mode(1, fx(90), fx(50)); // koth, target 50
    w.add_hill_zone(fx(0), fx(0), fx(200), fx(200));
    w.set_mode_playing(true);
    for _ in 0..60 { w.step(dt()); } // ~1s
    let s = w.mode_score(3);
    assert!(s > 1.5 && s < 2.5, "sole occupant ~2 pts/s, got {:.2}", s);
}

#[test]
fn mode_inactive_does_not_advance() {
    let mut w = world_zero_g(9);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    w.set_game_mode(1, fx(90), fx(50));
    w.add_hill_zone(fx(0), fx(0), fx(200), fx(200));
    // mode_active stays false (not playing) → no scoring / timer.
    for _ in 0..60 { w.step(dt()); }
    assert_eq!(w.mode_game_time(), 0.0, "timer frozen while not playing");
    assert_eq!(w.mode_score(0), 0.0, "no scoring while not playing");
}

// ---------- determinism + snapshot ----------

fn build_full(seed: u32) -> SoftBodyWorld {
    let mut w = world_zero_g(seed);
    add_blob(&mut w, FxVec2::new(fx(0), fx(0)), 1, 0, "p");
    let sidx = box_trigger(&mut w, 0, 0, 100, 100);
    w.add_game_trigger(1, sidx, Fx::from_f64(0.3), false);
    let local = vec![FxVec2::new(fx(-50), fx(-10)), FxVec2::new(fx(50), fx(-10)), FxVec2::new(fx(50), fx(10)), FxVec2::new(fx(-50), fx(10))];
    let world_poly: Vec<FxVec2> = local.iter().map(|p| FxVec2::new(p.x + fx(400), p.y)).collect();
    let static_idx = w.register_static_polygon(world_poly, SurfaceMaterial::Default, Some("plat".into()), None, None);
    let aidx = w.add_game_action(2, 0, false, 2, Fx::ZERO, Fx::from_f64(0.4), Fx::ONE, vec![1]);
    w.action_add_target_platform(aidx as usize, static_idx, fx(400), fx(0), Fx::ZERO, local, fx(400), fx(-200), Fx::ZERO);
    w.set_death_mode(2); // timer
    w.set_spawn_points(&[fx(0), fx(0)]);
    w.set_game_mode(1, fx(90), fx(50));
    w.add_hill_zone(fx(0), fx(0), fx(150), fx(150));
    w.add_hill_zone(fx(500), fx(0), fx(150), fx(150));
    w.set_hill_rotation(fx(1), fx(2));
    w.set_mode_playing(true);
    w
}

#[test]
fn game_logic_is_deterministic() {
    let mut a = build_full(42);
    let mut b = build_full(42);
    for _ in 0..120 { a.step(dt()); b.step(dt()); }
    assert_eq!(a.serialize_state(), b.serialize_state(), "two identical sims must match bit-for-bit");
}

#[test]
fn game_logic_snapshot_rollback_round_trip() {
    let mut a = build_full(99);
    let mut b = build_full(99);
    for _ in 0..50 { a.step(dt()); b.step(dt()); }
    assert_eq!(a.serialize_state(), b.serialize_state(), "pre-rollback divergence");
    let snap = b.serialize_state();
    // Destructive ticks on b, then restore.
    for _ in 0..7 { b.step(dt()); }
    b.restore_state(&snap).expect("restore ok");
    // Replay both to the same tick — must converge.
    for _ in 50..160 { a.step(dt()); b.step(dt()); }
    assert_eq!(a.serialize_state(), b.serialize_state(), "rollback round-trip diverged");
}
