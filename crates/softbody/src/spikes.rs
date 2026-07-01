//! Engine-side spikes / death zones / kill-plane / respawn (Phase 8 of the
//! JS→Rust migration). Replaces the gameplay of `src/game/spikeManager.ts`
//! (rendering stays in TS).
//!
//! Each tick: tick invulnerability + (timer-mode) respawn timers, then test
//! every player blob's hull against spike OBBs and death-zone AABBs, and its
//! centroid against the kill plane. A hit routes through `kill_player`
//! (instant respawn / park-offscreen) and emits a kill event. NPC blobs below
//! the plane are retired. All state is keyed by the stable `gameplay_id` and
//! snapshotted so host and guest agree.

use crate::fx::{Fx, FxVec2};
use crate::math::{cos_fx, sin_fx};
use crate::types::BlobId;
use crate::world::SoftBodyWorld;

#[derive(Copy, Clone, Debug, PartialEq)]
pub enum DeathMode { Instant, NoRespawn, Timer }

#[derive(Clone, Debug)]
pub struct Spike {
    pub id: u32,
    pub base: FxVec2,
    pub base_rot: Fx,
    pub w: Fx,
    pub h: Fx,
    // mutable (action-driven live pose):
    pub live: FxVec2,
    pub live_rot: Fx,
}

#[derive(Copy, Clone, Debug)]
pub struct DeathZone { pub center: FxVec2, pub half: FxVec2 }

#[derive(Clone, Debug)]
pub struct DeadPlayer {
    pub gameplay_id: u32,
    pub death_pos: FxVec2,
    pub respawn_timer: Fx,
}

fn respawn_invuln() -> Fx { Fx::from_f64(1.5) }
fn koth_respawn_time() -> Fx { Fx::from_int(3) }
fn dead_offscreen_y() -> Fx { Fx::from_int(-9999) }
fn never() -> Fx { Fx::from_int(1_000_000) }

impl SoftBodyWorld {
    // ---- registration ----
    pub fn set_death_mode(&mut self, mode: u8) {
        self.death_mode = match mode { 1 => DeathMode::NoRespawn, 2 => DeathMode::Timer, _ => DeathMode::Instant };
    }
    pub fn add_spike(&mut self, id: u32, x: Fx, y: Fx, rot: Fx, w: Fx, h: Fx) -> u32 {
        self.spikes.push(Spike { id, base: FxVec2::new(x, y), base_rot: rot, w, h, live: FxVec2::new(x, y), live_rot: rot });
        (self.spikes.len() - 1) as u32
    }
    pub fn add_death_zone(&mut self, x: Fx, y: Fx, w: Fx, h: Fx) {
        self.death_zones.push(DeathZone { center: FxVec2::new(x, y), half: FxVec2::new(w / Fx::from_int(2), h / Fx::from_int(2)) });
    }
    pub fn set_kill_below_y(&mut self, y: Fx, enabled: bool) {
        self.kill_below_y = if enabled { Some(y) } else { None };
    }
    pub fn set_spawn_points(&mut self, flat: &[Fx]) {
        self.spawn_points.clear();
        let mut i = 0;
        while i + 1 < flat.len() { self.spawn_points.push(FxVec2::new(flat[i], flat[i + 1])); i += 2; }
    }
    pub fn clear_spikes(&mut self) {
        self.spikes.clear(); self.death_zones.clear(); self.dead_players.clear(); self.invulnerable.clear();
    }
    /// Set a spike's live pose (called by the action system in Phase 7).
    pub fn set_spike_pose(&mut self, spike_id: u32, x: Fx, y: Fx, rot: Fx) {
        if let Some(s) = self.spikes.iter_mut().find(|s| s.id == spike_id) {
            s.live = FxVec2::new(x, y); s.live_rot = rot;
        }
    }

    pub(crate) fn spikes_active(&self) -> bool {
        !self.spikes.is_empty() || !self.death_zones.is_empty() || self.kill_below_y.is_some()
            || !self.dead_players.is_empty() || !self.invulnerable.is_empty()
    }

    // ---- getters / events ----
    pub fn take_kill_events(&mut self) -> Vec<f64> {
        let ev = std::mem::take(&mut self.pending_kill_events);
        let mut out = Vec::with_capacity(ev.len() * 3);
        for (gid, pos) in ev { out.push(gid as f64); out.push(pos.x.to_f64()); out.push(pos.y.to_f64()); }
        out
    }
    pub fn is_invulnerable(&self, gameplay_id: u32) -> bool {
        self.invulnerable.binary_search_by_key(&gameplay_id, |&(k, _)| k).is_ok()
    }
    pub fn is_dead(&self, gameplay_id: u32) -> bool {
        self.dead_players.binary_search_by_key(&gameplay_id, |d| d.gameplay_id).is_ok()
    }
    pub fn dead_player_respawn_timer(&self, gameplay_id: u32) -> f64 {
        match self.dead_players.binary_search_by_key(&gameplay_id, |d| d.gameplay_id) {
            Ok(i) => self.dead_players[i].respawn_timer.to_f64(),
            Err(_) => 0.0,
        }
    }
    pub fn dead_player_death_pos(&self, gameplay_id: u32) -> Option<[f64; 2]> {
        match self.dead_players.binary_search_by_key(&gameplay_id, |d| d.gameplay_id) {
            Ok(i) => { let p = self.dead_players[i].death_pos; Some([p.x.to_f64(), p.y.to_f64()]) }
            Err(_) => None,
        }
    }
    pub fn spike_live_pose(&self, idx: usize) -> Option<[f64; 3]> {
        self.spikes.get(idx).map(|s| [s.live.x.to_f64(), s.live.y.to_f64(), s.live_rot.to_f64()])
    }
    pub fn spike_count(&self) -> usize { self.spikes.len() }

    // ---- per-step update ----
    pub fn update_spikes(&mut self, dt: Fx) {
        // 1. Tick invulnerability.
        self.invulnerable.retain_mut(|(_, t)| { *t = *t - dt; *t > Fx::ZERO });

        // 2. Timer-mode respawns. Collect ids to respawn (drawing RNG) — done
        //    BEFORE the kill scan, matching spikeManager.update order so the
        //    seeded stream is consumed identically to TS.
        if self.death_mode == DeathMode::Timer {
            for d in self.dead_players.iter_mut() { d.respawn_timer = d.respawn_timer - dt; }
            let due: Vec<u32> = self.dead_players.iter().filter(|d| d.respawn_timer <= Fx::ZERO).map(|d| d.gameplay_id).collect();
            for gid in due { self.respawn_player(gid); }
        }

        // 3. Player hull vs spikes / death zones / kill plane.
        let nb = self.blob_ranges.len();
        for bi in 0..nb {
            let (role, gameplay_id, inactive) = {
                let r = &self.blob_ranges[bi];
                (r.role, r.gameplay_id, r.inactive)
            };
            if inactive { continue; }
            if role != 1 { continue; }
            if self.is_invulnerable(gameplay_id) || self.is_dead(gameplay_id) { continue; }

            let mut killed = false;
            // Spikes (OBB) against every hull particle.
            let hull: Vec<usize> = self.blob_ranges[bi].hull.iter().map(|&i| i as usize).collect();
            'spike: for s in &self.spikes {
                for &pidx in &hull {
                    if point_in_spike(self.pos[pidx], s) { killed = true; break 'spike; }
                }
            }
            // Death zones (AABB).
            if !killed {
                'zone: for z in &self.death_zones {
                    let min = FxVec2::new(z.center.x - z.half.x, z.center.y - z.half.y);
                    let max = FxVec2::new(z.center.x + z.half.x, z.center.y + z.half.y);
                    for &pidx in &hull {
                        let p = self.pos[pidx];
                        if p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y { killed = true; break 'zone; }
                    }
                }
            }
            // Kill plane (centroid).
            if !killed {
                if let Some(ky) = self.kill_below_y {
                    if self.blob_centroid(bi as BlobId).y > ky { killed = true; }
                }
            }
            if killed { self.kill_player(gameplay_id); }
        }

        // 4. NPC blobs below the kill plane → retire.
        if let Some(ky) = self.kill_below_y {
            let npcs: Vec<usize> = (0..nb).filter(|&bi| {
                let r = &self.blob_ranges[bi];
                r.role == 2 && !r.inactive
            }).collect();
            for bi in npcs {
                if self.blob_centroid(bi as BlobId).y > ky { self.remove_blob(bi as BlobId); }
            }
        }
    }

    fn kill_player(&mut self, gameplay_id: u32) {
        let blob_id = match self.blob_for_gameplay_id(gameplay_id) { Some(b) => b, None => return };
        let death_pos = self.blob_centroid(blob_id);
        match self.death_mode {
            DeathMode::Instant => {
                let spawn = self.pick_spawn();
                self.reset_blob_to_rest(blob_id, spawn);
                self.set_invuln(gameplay_id, respawn_invuln());
            }
            DeathMode::NoRespawn | DeathMode::Timer => {
                self.reset_blob_to_rest(blob_id, FxVec2::new(death_pos.x, dead_offscreen_y()));
                // Freeze the dead blob: with the range + shape `inactive` it is
                // skipped by every physics/collision/contact/trigger loop, so it
                // no longer falls back into the map under gravity nor records the
                // surface contacts that spawn colored decals. Reactivated on
                // respawn. Both flags are snapshotted, so this stays deterministic.
                self.set_blob_frozen(blob_id, true);
                let timer = if self.death_mode == DeathMode::Timer { koth_respawn_time() } else { never() };
                self.add_dead_player(DeadPlayer { gameplay_id, death_pos, respawn_timer: timer });
            }
        }
        self.pending_kill_events.push((gameplay_id, death_pos));
    }

    fn respawn_player(&mut self, gameplay_id: u32) {
        // The dead blob is frozen (inactive), so `blob_for_gameplay_id` (which
        // skips inactive) wouldn't find it — use the inactive-tolerant lookup.
        if let Some(blob_id) = self.frozen_blob_for_gameplay_id(gameplay_id) {
            self.set_blob_frozen(blob_id, false); // re-enter the simulation
            let spawn = self.pick_spawn();
            self.reset_blob_to_rest(blob_id, spawn);
        }
        if let Ok(i) = self.dead_players.binary_search_by_key(&gameplay_id, |d| d.gameplay_id) {
            self.dead_players.remove(i);
        }
        self.set_invuln(gameplay_id, respawn_invuln());
    }

    /// Toggle a blob's `inactive` flag on both its range and its shape. While
    /// inactive a blob is skipped by every physics/collision/contact/trigger and
    /// shape-match loop (they all `continue` on `inactive`); particle masses and
    /// positions are left untouched, so unfreezing + `reset_blob_to_rest` cleanly
    /// brings it back. Used to park dead players with zero physics until respawn.
    fn set_blob_frozen(&mut self, blob_id: BlobId, frozen: bool) {
        let bid = blob_id as usize;
        let si = match self.blob_ranges.get(bid) { Some(r) => r.shape_idx as usize, None => return };
        self.blob_ranges[bid].inactive = frozen;
        if let Some(sh) = self.shapes.get_mut(si) { sh.inactive = frozen; }
    }

    /// Like `blob_for_gameplay_id` but matches even a frozen (inactive) blob, so
    /// respawn can locate and reactivate a dead player's parked blob.
    fn frozen_blob_for_gameplay_id(&self, gameplay_id: u32) -> Option<BlobId> {
        self.blob_ranges.iter()
            .position(|r| r.role == 1 && r.gameplay_id == gameplay_id)
            .map(|i| i as BlobId)
    }

    /// Route a blob (identified by blob id) through the death flow — used by
    /// the crush detector (`onBlobCrushed`) so an exploded player dies/respawns
    /// the same way as a spike kill instead of teleporting away.
    pub fn kill_player_by_blob_id(&mut self, blob_id: BlobId) {
        let (role, gid) = match self.blob_ranges.get(blob_id as usize) {
            Some(r) if !r.inactive => (r.role, r.gameplay_id),
            _ => return,
        };
        if role != 1 { return; }
        if self.is_invulnerable(gid) || self.is_dead(gid) { return; }
        self.kill_player(gid);
    }

    /// Respawn all dead players (between rounds, called by Phase 9 mode logic).
    pub fn respawn_all(&mut self) {
        let ids: Vec<u32> = self.dead_players.iter().map(|d| d.gameplay_id).collect();
        for gid in ids { self.respawn_player(gid); }
    }

    fn pick_spawn(&mut self) -> FxVec2 {
        if self.spawn_points.is_empty() { return FxVec2::ZERO; }
        let r = self.rng_next_unit();
        let n = self.spawn_points.len();
        let idx = ((r * Fx::from_int(n as i32)).raw() >> 32) as usize;
        let idx = idx.min(n - 1);
        self.spawn_points[idx]
    }

    fn set_invuln(&mut self, gameplay_id: u32, t: Fx) {
        match self.invulnerable.binary_search_by_key(&gameplay_id, |&(k, _)| k) {
            Ok(i) => self.invulnerable[i].1 = t,
            Err(i) => self.invulnerable.insert(i, (gameplay_id, t)),
        }
    }
    fn add_dead_player(&mut self, d: DeadPlayer) {
        match self.dead_players.binary_search_by_key(&d.gameplay_id, |x| x.gameplay_id) {
            Ok(i) => self.dead_players[i] = d,
            Err(i) => self.dead_players.insert(i, d),
        }
    }
}

/// Transform `p` into the spike's live local space and test the tooth OBB.
fn point_in_spike(p: FxVec2, s: &Spike) -> bool {
    let dx = p.x - s.live.x;
    let dy = p.y - s.live.y;
    let cos = cos_fx(Fx::ZERO - s.live_rot);
    let sin = sin_fx(Fx::ZERO - s.live_rot);
    let local_x = dx * cos - dy * sin;
    let local_y = dx * sin + dy * cos;
    let hw = s.w / Fx::from_int(2);
    local_x >= (Fx::ZERO - hw) && local_x <= hw && local_y >= (Fx::ZERO - s.h) && local_y <= Fx::ZERO
}

// ---- snapshot serde (mutable bits only) ----
use crate::snapshot::{SnapWriter, SnapReader};

pub(crate) fn serialize_spikes(w: &mut SnapWriter, world: &SoftBodyWorld) {
    // spike live poses
    w.u32(world.spikes.len() as u32);
    for s in &world.spikes { w.fx(s.live.x); w.fx(s.live.y); w.fx(s.live_rot); }
    // invulnerable
    w.u32(world.invulnerable.len() as u32);
    for (gid, t) in &world.invulnerable { w.u32(*gid); w.fx(*t); }
    // dead players
    w.u32(world.dead_players.len() as u32);
    for d in &world.dead_players { w.u32(d.gameplay_id); w.fx(d.death_pos.x); w.fx(d.death_pos.y); w.fx(d.respawn_timer); }
    // pending kill events
    w.u32(world.pending_kill_events.len() as u32);
    for (gid, pos) in &world.pending_kill_events { w.u32(*gid); w.fx(pos.x); w.fx(pos.y); }
}

pub(crate) fn restore_spikes(r: &mut SnapReader, world: &mut SoftBodyWorld) -> Result<(), &'static str> {
    let ns = r.u32()? as usize;
    if ns != world.spikes.len() { return Err("snapshot: spike count mismatch"); }
    for s in world.spikes.iter_mut() { let x = r.fx()?; let y = r.fx()?; s.live = FxVec2::new(x, y); s.live_rot = r.fx()?; }
    let ni = r.u32()? as usize;
    world.invulnerable.clear();
    for _ in 0..ni { let gid = r.u32()?; let t = r.fx()?; world.invulnerable.push((gid, t)); }
    let nd = r.u32()? as usize;
    world.dead_players.clear();
    for _ in 0..nd {
        let gid = r.u32()?; let x = r.fx()?; let y = r.fx()?; let t = r.fx()?;
        world.dead_players.push(DeadPlayer { gameplay_id: gid, death_pos: FxVec2::new(x, y), respawn_timer: t });
    }
    let nk = r.u32()? as usize;
    world.pending_kill_events.clear();
    for _ in 0..nk { let gid = r.u32()?; let x = r.fx()?; let y = r.fx()?; world.pending_kill_events.push((gid, FxVec2::new(x, y))); }
    Ok(())
}
