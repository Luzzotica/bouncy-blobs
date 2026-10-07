// Binary snapshot/restore for SoftBodyWorld.
//
// The format is little-endian and version-prefixed. Every mutable field
// that affects subsequent physics outcomes is captured so the
// rollback netcode's "restore tick T, fast-forward to current" cycle
// reproduces the exact same state.
//
// Determinism: every `i64::to_le_bytes` / `from_le_bytes` is a fixed
// integer op, identical on every machine. There are NO floats anywhere
// in the snapshot — values that are conceptually floats (Fx) are
// captured as their underlying i64 raw bits.

use crate::fx::{Fx, FxVec2};
use crate::types::{
    BlobId, ParticleIdx, ShapeIdx, Spring, StaticSurface, SurfaceMaterial, Transform2D,
};

/// Increment when the binary layout changes in any incompatible way.
const VERSION: u32 = 1;

// ---- writer ----

pub struct SnapWriter {
    buf: Vec<u8>,
}

impl SnapWriter {
    pub fn new() -> Self { SnapWriter { buf: Vec::with_capacity(4096) } }
    pub fn finish(self) -> Vec<u8> { self.buf }

    #[inline] pub(crate) fn u8(&mut self, v: u8)   { self.buf.push(v); }
    #[inline] pub(crate) fn u32(&mut self, v: u32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] pub(crate) fn i32(&mut self, v: i32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] pub(crate) fn u64(&mut self, v: u64) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] pub(crate) fn i64(&mut self, v: i64) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] pub(crate) fn bool(&mut self, v: bool) { self.u8(if v { 1 } else { 0 }); }
    #[inline] pub(crate) fn fx(&mut self, v: Fx) { self.i64(v.raw()); }
    #[inline] fn vec2(&mut self, v: FxVec2) { self.fx(v.x); self.fx(v.y); }
    fn str(&mut self, s: &str) {
        let bytes = s.as_bytes();
        self.u32(bytes.len() as u32);
        self.buf.extend_from_slice(bytes);
    }
    fn opt_vec2(&mut self, v: Option<FxVec2>) {
        match v {
            None => self.u8(0),
            Some(p) => { self.u8(1); self.vec2(p); }
        }
    }
}

// ---- reader ----

pub struct SnapReader<'a> { buf: &'a [u8], off: usize }

impl<'a> SnapReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self { SnapReader { buf, off: 0 } }

    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        if self.off + n > self.buf.len() { return Err("snapshot: short read"); }
        let s = &self.buf[self.off..self.off + n];
        self.off += n;
        Ok(s)
    }
    pub(crate) fn u8(&mut self) -> Result<u8, &'static str> { Ok(self.take(1)?[0]) }
    pub(crate) fn u32(&mut self) -> Result<u32, &'static str> {
        let b = self.take(4)?; Ok(u32::from_le_bytes([b[0],b[1],b[2],b[3]]))
    }
    pub(crate) fn i32(&mut self) -> Result<i32, &'static str> {
        let b = self.take(4)?; Ok(i32::from_le_bytes([b[0],b[1],b[2],b[3]]))
    }
    pub(crate) fn u64(&mut self) -> Result<u64, &'static str> {
        let b = self.take(8)?; Ok(u64::from_le_bytes([b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7]]))
    }
    pub(crate) fn i64(&mut self) -> Result<i64, &'static str> {
        let b = self.take(8)?; Ok(i64::from_le_bytes([b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7]]))
    }
    pub(crate) fn bool(&mut self) -> Result<bool, &'static str> { Ok(self.u8()? != 0) }
    pub(crate) fn fx(&mut self) -> Result<Fx, &'static str> { Ok(Fx::from_raw(self.i64()?)) }
    fn vec2(&mut self) -> Result<FxVec2, &'static str> {
        let x = self.fx()?; let y = self.fx()?; Ok(FxVec2::new(x, y))
    }
    fn str(&mut self) -> Result<String, &'static str> {
        let n = self.u32()? as usize;
        let bytes = self.take(n)?;
        Ok(core::str::from_utf8(bytes).map_err(|_| "snapshot: bad utf8")?.to_string())
    }
    fn opt_vec2(&mut self) -> Result<Option<FxVec2>, &'static str> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(self.vec2()?)),
            _ => Err("snapshot: bad option tag"),
        }
    }
}

// ---- impl on SoftBodyWorld ----

use crate::world::SoftBodyWorld;

impl SoftBodyWorld {
    /// Capture every mutable field. Spring topology, particle radii,
    /// layer/mask bitmasks, and static-surface materials are
    /// IMMUTABLE post-init and are NOT captured (restoring would
    /// require knowing the original world's setup, which the caller
    /// already controls).
    pub fn serialize_state(&self) -> Vec<u8> {
        let mut w = SnapWriter::new();
        w.u32(VERSION);
        w.u64(self.tick);
        w.u32(self.rng.state());

        let n = self.pos.len();
        w.u32(n as u32);
        for i in 0..n { w.vec2(self.pos[i]); }
        for i in 0..n { w.vec2(self.vel[i]); }
        for i in 0..n { w.fx(self.mass[i]); }
        for i in 0..n { w.fx(self.inv_mass[i]); }

        // Blob ranges: inactive flag + tuning scales.
        w.u32(self.blob_ranges.len() as u32);
        for r in &self.blob_ranges {
            w.bool(r.inactive);
            w.fx(r.spring_stiffness_scale);
            w.fx(r.spring_damp_scale);
        }

        // Shapes: inactive, frame override, shape-match scale, rest_local.
        w.u32(self.shapes.len() as u32);
        for sh in &self.shapes {
            w.bool(sh.inactive);
            w.bool(sh.use_frame_override);
            w.fx(sh.frame_override.cos);
            w.fx(sh.frame_override.sin);
            w.fx(sh.frame_override.tx);
            w.fx(sh.frame_override.ty);
            w.fx(sh.shape_match_rest_scale);
            w.u32(sh.rest_local.len() as u32);
            for v in &sh.rest_local { w.vec2(*v); }
        }

        // Per-blob gravity override (sparse, indexed by blob id).
        w.u32(self.blob_gravity_override.len() as u32);
        for slot in &self.blob_gravity_override { w.opt_vec2(*slot); }

        // Per-blob pin snapshots (Vec<(BlobId, Vec<FxVec2>)>).
        w.u32(self.blob_pin_snapshots.len() as u32);
        for (bid, pts) in &self.blob_pin_snapshots {
            w.u32(*bid);
            w.u32(pts.len() as u32);
            for v in pts { w.vec2(*v); }
        }

        // Contact tracking arrays.
        write_i32_vec(&mut w, &self.blob_ground_contacts);
        write_i32_vec(&mut w, &self.blob_sticky_contact_count);
        write_vec2_vec(&mut w, &self.blob_sticky_contact_normal_sum);
        write_opt_vec2_vec(&mut w, &self.blob_ground_contact_point);
        write_opt_vec2_vec(&mut w, &self.blob_ground_contact_normal);
        write_opt_vec2_vec(&mut w, &self.blob_impact_contact_point);
        write_opt_vec2_vec(&mut w, &self.blob_impact_contact_normal);
        // Per-particle "touched this step" bitmap. Recomputed each step, but
        // gameplay (isLedgeHanging, etc.) reads it in the tick AFTER it was
        // set — so it must be captured for a post-restore tick to match.
        write_bool_vec(&mut w, &self.particle_touched_this_step);

        // Trigger-prev: sorted Vec<(String, bool)>.
        w.u32(self.trigger_prev.len() as u32);
        for (k, v) in &self.trigger_prev { w.str(k); w.bool(*v); }

        // Static surfaces: poly + velocity + prev_poly (each can change frame-to-frame).
        w.u32(self.static_surfaces.len() as u32);
        for s in &self.static_surfaces {
            w.u32(s.poly.len() as u32);
            for v in &s.poly { w.vec2(*v); }
            match s.velocity {
                None => w.u8(0),
                Some(v) => { w.u8(1); w.vec2(v); }
            }
            match &s.prev_poly {
                None => w.u8(0),
                Some(poly) => {
                    w.u8(1);
                    w.u32(poly.len() as u32);
                    for v in poly { w.vec2(*v); }
                }
            }
        }

        // Base masses (mass-scale baseline). Sorted by blob id.
        w.u32(self.base_masses.len() as u32);
        for (bid, masses) in &self.base_masses {
            w.u32(*bid);
            w.u32(masses.len() as u32);
            for m in masses { w.fx(*m); }
        }

        // Pending trigger events queued for the next take_trigger_*.
        // Captured so a rollback->replay sequence ends with the same
        // queue contents as the original run.
        w.u32(self.pending_trigger_entered.len() as u32);
        for (s, b) in &self.pending_trigger_entered { w.u32(*s); w.u32(*b); }
        w.u32(self.pending_trigger_exited.len() as u32);
        for (s, b) in &self.pending_trigger_exited { w.u32(*s); w.u32(*b); }

        // Phase 4: dynamic-item mutable state (timer + active + bumper
        // cooldown). Kind, polygon, center, radius, direction are all
        // immutable post-init so they're not snapshotted (rebuilt by
        // the caller via add_* methods at level-load time).
        crate::dynamic_items::serialize_dynamic_items(&self.dynamic_items, &mut w);

        // Phase 5: spring-pad mutable state (state machine + offset +
        // cooldown). Geometry / kinematic surface immutable.
        crate::spring_pads::serialize_spring_pads(&self.spring_pads, &mut w);

        // Phase 6: trigger charge/pressed machines.
        crate::triggers::serialize_game_triggers(&self.game_triggers, &mut w);
        w.u32(self.pending_trigger_pressed.len() as u32);
        for id in &self.pending_trigger_pressed { w.u32(*id); }
        w.u32(self.pending_trigger_released.len() as u32);
        for id in &self.pending_trigger_released { w.u32(*id); }

        // Phase 7: action tween state machines (+ global clock).
        crate::actions::serialize_game_actions(&self.game_actions, self.action_clock, &mut w);
        w.u32(self.pending_action_fires.len() as u32);
        for id in &self.pending_action_fires { w.u32(*id); }

        // Phase 8: spikes / invuln / dead players / kill events.
        crate::spikes::serialize_spikes(&mut w, self);

        // Phase 9: game-mode rules.
        crate::game_mode::serialize_game_mode(&self.game_mode, &mut w);

        w.finish()
    }

    pub fn restore_state(&mut self, buf: &[u8]) -> Result<(), &'static str> {
        let mut r = SnapReader::new(buf);
        let version = r.u32()?;
        if version != VERSION { return Err("snapshot: wrong version"); }
        self.tick = r.u64()?;
        self.rng.set_state(r.u32()?);

        let n = r.u32()? as usize;
        if n != self.pos.len() { return Err("snapshot: particle count mismatch"); }
        for i in 0..n { self.pos[i] = r.vec2()?; }
        for i in 0..n { self.vel[i] = r.vec2()?; }
        for i in 0..n { self.mass[i] = r.fx()?; }
        for i in 0..n { self.inv_mass[i] = r.fx()?; }

        let nb = r.u32()? as usize;
        if nb != self.blob_ranges.len() { return Err("snapshot: blob count mismatch"); }
        for i in 0..nb {
            self.blob_ranges[i].inactive = r.bool()?;
            self.blob_ranges[i].spring_stiffness_scale = r.fx()?;
            self.blob_ranges[i].spring_damp_scale = r.fx()?;
        }

        let ns = r.u32()? as usize;
        if ns != self.shapes.len() { return Err("snapshot: shape count mismatch"); }
        for i in 0..ns {
            let inactive = r.bool()?;
            let use_fo = r.bool()?;
            let cos = r.fx()?; let sin = r.fx()?; let tx = r.fx()?; let ty = r.fx()?;
            let sm_scale = r.fx()?;
            let rl_count = r.u32()? as usize;
            let mut rest_local = Vec::with_capacity(rl_count);
            for _ in 0..rl_count { rest_local.push(r.vec2()?); }
            let sh = &mut self.shapes[i];
            sh.inactive = inactive;
            sh.use_frame_override = use_fo;
            sh.frame_override = Transform2D { cos, sin, tx, ty };
            sh.shape_match_rest_scale = sm_scale;
            if sh.rest_local.len() == rl_count {
                sh.rest_local.copy_from_slice(&rest_local);
            } else {
                sh.rest_local = rest_local;
            }
        }

        // Per-blob gravity override
        let go_n = r.u32()? as usize;
        self.blob_gravity_override.clear();
        self.blob_gravity_override.reserve(go_n);
        for _ in 0..go_n { self.blob_gravity_override.push(r.opt_vec2()?); }

        // Pin snapshots
        let pin_n = r.u32()? as usize;
        self.blob_pin_snapshots.clear();
        for _ in 0..pin_n {
            let bid = r.u32()?;
            let nv = r.u32()? as usize;
            let mut pts = Vec::with_capacity(nv);
            for _ in 0..nv { pts.push(r.vec2()?); }
            self.blob_pin_snapshots.push((bid, pts));
        }

        // Contact tracking
        read_i32_vec(&mut r, &mut self.blob_ground_contacts)?;
        read_i32_vec(&mut r, &mut self.blob_sticky_contact_count)?;
        read_vec2_vec(&mut r, &mut self.blob_sticky_contact_normal_sum)?;
        read_opt_vec2_vec(&mut r, &mut self.blob_ground_contact_point)?;
        read_opt_vec2_vec(&mut r, &mut self.blob_ground_contact_normal)?;
        read_opt_vec2_vec(&mut r, &mut self.blob_impact_contact_point)?;
        read_opt_vec2_vec(&mut r, &mut self.blob_impact_contact_normal)?;
        read_bool_vec(&mut r, &mut self.particle_touched_this_step)?;

        // Trigger-prev
        let tp_n = r.u32()? as usize;
        self.trigger_prev.clear();
        self.trigger_prev.reserve(tp_n);
        for _ in 0..tp_n {
            let k = r.str()?;
            let v = r.bool()?;
            self.trigger_prev.push((k, v));
        }

        // Static surfaces
        let ss_n = r.u32()? as usize;
        if ss_n != self.static_surfaces.len() {
            return Err("snapshot: static_surface count mismatch");
        }
        for i in 0..ss_n {
            let pc = r.u32()? as usize;
            let mut poly = Vec::with_capacity(pc);
            for _ in 0..pc { poly.push(r.vec2()?); }
            let has_v = r.u8()?;
            let velocity = if has_v != 0 { Some(r.vec2()?) } else { None };
            let has_pp = r.u8()?;
            let prev_poly = if has_pp != 0 {
                let pn = r.u32()? as usize;
                let mut v = Vec::with_capacity(pn);
                for _ in 0..pn { v.push(r.vec2()?); }
                Some(v)
            } else { None };
            let s = &mut self.static_surfaces[i];
            s.poly = poly;
            s.velocity = velocity;
            s.prev_poly = prev_poly;
        }

        // Base masses
        let bm_n = r.u32()? as usize;
        self.base_masses.clear();
        for _ in 0..bm_n {
            let bid = r.u32()?;
            let mc = r.u32()? as usize;
            let mut masses = Vec::with_capacity(mc);
            for _ in 0..mc { masses.push(r.fx()?); }
            self.base_masses.push((bid, masses));
        }

        // Pending trigger events
        let pe_n = r.u32()? as usize;
        self.pending_trigger_entered.clear();
        self.pending_trigger_entered.reserve(pe_n);
        for _ in 0..pe_n {
            let s = r.u32()?;
            let b = r.u32()?;
            self.pending_trigger_entered.push((s as ShapeIdx, b as BlobId));
        }
        let px_n = r.u32()? as usize;
        self.pending_trigger_exited.clear();
        self.pending_trigger_exited.reserve(px_n);
        for _ in 0..px_n {
            let s = r.u32()?;
            let b = r.u32()?;
            self.pending_trigger_exited.push((s as ShapeIdx, b as BlobId));
        }

        // Phase 4: restore dynamic-item mutable state. Item count is
        // expected to match (caller adds them at level-load time, both
        // sides apply the same level data deterministically).
        crate::dynamic_items::restore_dynamic_items(&mut self.dynamic_items, &mut r)?;

        // Phase 5: restore spring-pad mutable state.
        crate::spring_pads::restore_spring_pads(&mut self.spring_pads, &mut r)?;

        // Phase 6: trigger charge/pressed machines.
        crate::triggers::restore_game_triggers(&mut self.game_triggers, &mut r)?;
        let np = r.u32()? as usize; self.pending_trigger_pressed.clear();
        for _ in 0..np { self.pending_trigger_pressed.push(r.u32()?); }
        let nr = r.u32()? as usize; self.pending_trigger_released.clear();
        for _ in 0..nr { self.pending_trigger_released.push(r.u32()?); }

        // Phase 7: action tween machines (+ clock).
        self.action_clock = crate::actions::restore_game_actions(&mut self.game_actions, &mut r)?;
        let nf = r.u32()? as usize; self.pending_action_fires.clear();
        for _ in 0..nf { self.pending_action_fires.push(r.u32()?); }

        // Phase 8: spikes / invuln / dead players / kill events.
        crate::spikes::restore_spikes(&mut r, self)?;

        // Phase 9: game-mode rules.
        crate::game_mode::restore_game_mode(&mut self.game_mode, &mut r)?;

        Ok(())
    }
}

fn write_i32_vec(w: &mut SnapWriter, v: &[i32]) {
    w.u32(v.len() as u32);
    for x in v { w.i32(*x); }
}
fn read_i32_vec(r: &mut SnapReader, out: &mut Vec<i32>) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    out.clear();
    out.reserve(n);
    for _ in 0..n { out.push(r.i32()?); }
    Ok(())
}
fn write_bool_vec(w: &mut SnapWriter, v: &[bool]) {
    w.u32(v.len() as u32);
    for b in v { w.bool(*b); }
}
fn read_bool_vec(r: &mut SnapReader, out: &mut Vec<bool>) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    out.clear();
    out.reserve(n);
    for _ in 0..n { out.push(r.bool()?); }
    Ok(())
}
fn write_vec2_vec(w: &mut SnapWriter, v: &[FxVec2]) {
    w.u32(v.len() as u32);
    for p in v { w.vec2(*p); }
}
fn read_vec2_vec(r: &mut SnapReader, out: &mut Vec<FxVec2>) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    out.clear();
    out.reserve(n);
    for _ in 0..n { out.push(r.vec2()?); }
    Ok(())
}
fn write_opt_vec2_vec(w: &mut SnapWriter, v: &[Option<FxVec2>]) {
    w.u32(v.len() as u32);
    for p in v { w.opt_vec2(*p); }
}
fn read_opt_vec2_vec(r: &mut SnapReader, out: &mut Vec<Option<FxVec2>>) -> Result<(), &'static str> {
    let n = r.u32()? as usize;
    out.clear();
    out.reserve(n);
    for _ in 0..n { out.push(r.opt_vec2()?); }
    Ok(())
}

// Unused imports (kept for clarity even when field types are stable).
#[allow(dead_code)]
fn _shut_unused(_: Spring, _: StaticSurface, _: SurfaceMaterial, _: ParticleIdx) {}

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip exactness tests.
//
// These are the canonical guard: prove that serialize_state() captures
// ENOUGH state that a snap→garbage-step→restore→step cycle produces the
// same physics as a no-rollback baseline. If they diverge, serialize is
// silently lossy — some mutable field that influences the next step
// isn't being captured. The TS-side equivalent
// `src/lib/rollbackExactness.test.ts` runs the same property at higher
// level (full Rust+wasm engine via loadLevel). When that test fails
// across game scenarios but the snapshot only differs in a handful of
// fields, this Rust-side test isolates the bug to the specific field.
//
// Run with: `cd crates && cargo test --release -p softbody -- snapshot::tests`
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::{Fx, FxVec2};
    use crate::types::{SurfaceMaterial, WorldConfig};
    use crate::world::{AddBlobParams, SoftBodyWorld};

    const FIXED_DT: Fx = Fx::from_raw((1i64 << 32) / 60);

    /// Two falling blobs above a floor — enough physics activity to
    /// exercise gravity, springs, collision, shape matching, and contact
    /// tracking in a few dozen ticks.
    fn build_world(seed: u32) -> SoftBodyWorld {
        let mut w = SoftBodyWorld::new(WorldConfig::default(), seed);

        // Floor: long horizontal static polygon.
        w.register_static_polygon(
            vec![
                FxVec2::new(Fx::from_int(-1000i32), Fx::from_int(1000i32)),
                FxVec2::new(Fx::from_int( 1000i32), Fx::from_int(1000i32)),
                FxVec2::new(Fx::from_int( 1000i32), Fx::from_int(1100i32)),
                FxVec2::new(Fx::from_int(-1000i32), Fx::from_int(1100i32)),
            ],
            SurfaceMaterial::Default,
            Some("floor".to_string()),
            None,
            None,
        );

        // Two simple hexagonal blobs above the floor.
        let hex = |cx: i32, cy: i32, sort: &str| AddBlobParams {
            hull_rest_local: (0..6).map(|i| {
                let a = (i as f64) * (core::f64::consts::TAU / 6.0);
                FxVec2::new(Fx::from_f64(a.cos() * 40.0), Fx::from_f64(a.sin() * 40.0))
            }).collect(),
            center_local: FxVec2::new(Fx::ZERO, Fx::ZERO),
            center_mass: Fx::from_int(1),
            hull_mass: Fx::from_int(1),
            spring_k: Fx::from_int(800),
            spring_damp: Fx::from_int(20),
            radial_k: Fx::from_int(400),
            radial_damp: Fx::from_int(10),
            pressure_k: Fx::from_int(50),
            shape_match_k: Fx::from_int(400),
            shape_match_damp: Fx::from_int(10),
            world_origin: FxVec2::new(Fx::from_int(cx), Fx::from_int(cy)),
            sort_key: Some(sort.to_string()),
            static_hull_indices: Vec::new(),
            static_center: false,
            pin_frame: false,
        };
        w.add_blob_from_hull(hex(-100, 0, "a"));
        w.add_blob_from_hull(hex( 100, 50, "b"));
        w
    }

    fn step_n(w: &mut SoftBodyWorld, n: usize) {
        for _ in 0..n { w.step(FIXED_DT); }
    }

    #[test]
    fn snapshot_round_trip_is_lossless_under_step() {
        let mut a = build_world(42);
        let mut b = build_world(42);

        // Run both for a while to build up real physics state (settling,
        // contacts, shape match integration).
        step_n(&mut a, 30);
        step_n(&mut b, 30);

        // Sanity: deterministic.
        let sa = a.serialize_state();
        let sb = b.serialize_state();
        assert_eq!(sa, sb, "two sims diverged BEFORE rollback test — non-deterministic sim?");

        // B: snapshot, take a destructive step (to mutate state that
        // wouldn't otherwise change in a no-op), then restore.
        let snap = b.serialize_state();
        b.step(FIXED_DT);
        b.step(FIXED_DT);
        b.restore_state(&snap).expect("restore_state returned Err");

        // After restore, B's serialized state should match what it was
        // at snapshot time. If it doesn't, the deserialization itself
        // is incomplete (some captured-but-not-restored field).
        let sb_after_restore = b.serialize_state();
        assert_eq!(snap, sb_after_restore, "serialized state differs after restore — restore is broken even within captured fields");

        // Both sims step one more tick. If the captured state is COMPLETE,
        // they'll produce the same state. If a mutable field that affects
        // step() isn't captured, B's state will differ from A's.
        a.step(FIXED_DT);
        b.step(FIXED_DT);
        let sa2 = a.serialize_state();
        let sb2 = b.serialize_state();
        if sa2 != sb2 {
            // Find first byte that differs for diagnostic.
            let n = sa2.len().min(sb2.len());
            let mut first = None;
            for i in 0..n {
                if sa2[i] != sb2[i] { first = Some(i); break; }
            }
            panic!(
                "LOSSY SNAPSHOT: after restore+step, B's state differs from A's. lenA={} lenB={} firstByteDiff={:?}",
                sa2.len(), sb2.len(), first,
            );
        }
    }

    #[test]
    fn snapshot_round_trip_immediate_restore_is_identity() {
        // Even simpler property: snap → immediately restore → snap should
        // produce IDENTICAL bytes. Catches restore-side bugs that don't
        // need a destructive step in between.
        let mut a = build_world(42);
        step_n(&mut a, 30);

        let snap1 = a.serialize_state();
        a.restore_state(&snap1).expect("restore_state returned Err");
        let snap2 = a.serialize_state();
        assert_eq!(snap1, snap2, "immediate snap→restore→snap is not an identity");
    }

    /// Mirrors what the TS-side rollbackExactness test does: blob inputs
    /// drive move-force AND toggle the shape-match-rest-scale integrator
    /// (the "expand" feature). This is the path that ACTUALLY fails in
    /// production — the simpler 2-blob fall test passes because it
    /// doesn't exercise per-tick mutable shape state.
    #[test]
    fn snapshot_round_trip_with_player_like_input() {
        let mut a = build_world(42);
        let mut b = build_world(42);

        // Drive both sims with the same scripted player inputs for 30
        // ticks. Inputs include the shape_match_rest_scale toggle that
        // simulates the "expand" button — this is the integrator the
        // TS-side rollback tests trip on.
        let drive = |w: &mut SoftBodyWorld, t: usize| {
            let force = Fx::from_int(2000);
            let dir_a = if (t / 7) % 2 == 0 {
                FxVec2::new(Fx::from_int(1), Fx::ZERO)
            } else {
                FxVec2::new(Fx::from_int(-1), Fx::ZERO)
            };
            let dir_b = FxVec2::new(Fx::ZERO, Fx::from_int(-1));
            w.apply_blob_move_force(0, dir_a, force, FIXED_DT);
            w.apply_blob_move_force(1, dir_b, force, FIXED_DT);
            // Toggle expand on/off in a pattern.
            let scale_a = if (t % 5) < 2 { Fx::from_f64(1.5) } else { Fx::ONE };
            let scale_b = if (t % 7) < 3 { Fx::from_f64(0.7) } else { Fx::ONE };
            w.set_blob_shape_match_rest_scale(0, scale_a);
            w.set_blob_shape_match_rest_scale(1, scale_b);
        };

        for t in 0..30 {
            drive(&mut a, t);
            drive(&mut b, t);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(), "non-deterministic pre-snapshot");

        // B: snapshot, destructive step, restore.
        let snap = b.serialize_state();
        // The destructive step deliberately twists shape_match_rest_scale
        // and applies wrong force, to ensure the captured state would
        // need to actively overwrite both.
        b.set_blob_shape_match_rest_scale(0, Fx::from_f64(2.0));
        b.set_blob_shape_match_rest_scale(1, Fx::from_f64(0.3));
        b.apply_blob_move_force(0, FxVec2::new(Fx::from_int(1), Fx::from_int(1)), Fx::from_int(5000), FIXED_DT);
        b.step(FIXED_DT);
        b.step(FIXED_DT);
        b.restore_state(&snap).expect("restore returned Err");

        // Both sims step forward identically with the same scripted
        // inputs. If snapshot+restore is lossless, they match.
        for t in 30..60 {
            drive(&mut a, t);
            drive(&mut b, t);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }

        let sa = a.serialize_state();
        let sb = b.serialize_state();
        if sa != sb {
            let n = sa.len().min(sb.len());
            let mut first = None;
            for i in 0..n {
                if sa[i] != sb[i] { first = Some(i); break; }
            }
            panic!(
                "LOSSY: player-like-input round-trip diverged. lenA={} lenB={} firstByteDiff={:?}",
                sa.len(), sb.len(), first,
            );
        }
    }

    /// Two fresh sims, identical squash/lean inputs per tick, must
    /// produce identical state. Catches cross-instance non-determinism
    /// in the per-tick `set_blob_squash_lean` path that motivated
    /// moving the JS `updateHullDeformation` into Rust. Within a single
    /// wasm instance two `SoftBodyWorld` values driven the same way
    /// must end at the same byte-for-byte state.
    #[test]
    fn squash_lean_per_tick_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let down = FxVec2::new(Fx::ZERO, Fx::ONE);
        // Drive squash/lean inputs that vary per tick — exactly the
        // pattern SlimeBlob.update would feed in.
        for t in 0..60 {
            let squash = Fx::from_f64(((t % 7) as f64) / 10.0);
            let lean   = Fx::from_f64((((t as i32) % 11) - 5) as f64 / 5.0);
            a.set_blob_squash_lean(0, squash, lean, down);
            a.set_blob_squash_lean(1, squash, lean, down);
            b.set_blob_squash_lean(0, squash, lean, down);
            b.set_blob_squash_lean(1, squash, lean, down);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        let sa = a.serialize_state();
        let sb = b.serialize_state();
        assert_eq!(sa, sb, "set_blob_squash_lean is not deterministic across fresh sims");
    }

    /// Snapshot → destructive squash/lean → restore → run forward with
    /// same inputs as a baseline. Engine state must match. Catches
    /// rollback-replay bugs in the new per-tick path.
    #[test]
    fn squash_lean_survives_rollback_replay() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let down = FxVec2::new(Fx::ZERO, Fx::ONE);
        let drive = |w: &mut SoftBodyWorld, t: usize| {
            let squash = Fx::from_f64(((t % 7) as f64) / 10.0);
            let lean   = Fx::from_f64((((t as i32) % 11) - 5) as f64 / 5.0);
            w.set_blob_squash_lean(0, squash, lean, down);
            w.set_blob_squash_lean(1, squash, lean, down);
        };
        for t in 0..30 {
            drive(&mut a, t); drive(&mut b, t);
            a.step(FIXED_DT); b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(), "non-deterministic pre-snapshot");

        let snap = b.serialize_state();
        // Destructive: wrong squash/lean for 2 ticks.
        b.set_blob_squash_lean(0, Fx::from_f64(0.9), Fx::from_f64(0.9), down);
        b.set_blob_squash_lean(1, Fx::from_f64(0.9), Fx::from_f64(-0.9), down);
        b.step(FIXED_DT); b.step(FIXED_DT);
        b.restore_state(&snap).expect("restore returned Err");

        for t in 30..60 {
            drive(&mut a, t); drive(&mut b, t);
            a.step(FIXED_DT); b.step(FIXED_DT);
        }
        assert_eq!(
            a.serialize_state(), b.serialize_state(),
            "squash/lean round-trip diverged after rollback+replay",
        );
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 3 zone-force API tests.
    //
    // These verify the foundation that Phases 4-6 (dynamicItemManager
    // / spike-zone / powerup-pickup migrations) will build on:
    //  - `blobs_overlapping_polygon` finds every blob centroid in
    //    a region, in deterministic blob_id order.
    //  - `apply_force_in_polygon` with each ForceField variant
    //    produces bit-identical results across two fresh sims
    //    (so JS-side managers can pass JS-computed force vectors
    //    in and trust the engine to do the per-blob math).
    // ─────────────────────────────────────────────────────────────────

    use crate::types::{ForceField, PointGravityFalloff};

    /// Build a wide rectangle polygon covering most of the test scene.
    fn rect_poly(min_x: i32, min_y: i32, max_x: i32, max_y: i32) -> Vec<FxVec2> {
        vec![
            FxVec2::new(Fx::from_int(min_x), Fx::from_int(min_y)),
            FxVec2::new(Fx::from_int(max_x), Fx::from_int(min_y)),
            FxVec2::new(Fx::from_int(max_x), Fx::from_int(max_y)),
            FxVec2::new(Fx::from_int(min_x), Fx::from_int(max_y)),
        ]
    }

    #[test]
    fn blobs_overlapping_polygon_finds_all_inside_in_id_order() {
        let mut w = build_world(42);
        // build_world places two hex blobs at (-100, 0) and (100, 50).
        // A wide rectangle covers both.
        let wide = rect_poly(-500, -500, 500, 500);
        let hits = w.blobs_overlapping_polygon(&wide);
        assert_eq!(hits, vec![0, 1], "expected blobs 0 and 1");
        // Tight rectangle covering only blob 0.
        let left_only = rect_poly(-200, -200, 0, 200);
        let hits = w.blobs_overlapping_polygon(&left_only);
        assert_eq!(hits, vec![0]);
        // Tight rectangle covering only blob 1.
        let right_only = rect_poly(50, -200, 200, 200);
        let hits = w.blobs_overlapping_polygon(&right_only);
        assert_eq!(hits, vec![1]);
        // Empty zone.
        let empty = rect_poly(2000, 2000, 3000, 3000);
        assert_eq!(w.blobs_overlapping_polygon(&empty), Vec::<BlobId>::new());
        // Degenerate polygon (< 3 points) → empty result.
        let two_pt = vec![FxVec2::ZERO, FxVec2::new(Fx::from_int(10), Fx::ZERO)];
        assert_eq!(w.blobs_overlapping_polygon(&two_pt), Vec::<BlobId>::new());
    }

    #[test]
    fn apply_force_in_polygon_uniform_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let zone = rect_poly(-500, -500, 500, 500);
        let force = FxVec2::new(Fx::from_int(1000), Fx::from_int(-200));
        for _ in 0..30 {
            a.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            b.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "Uniform ForceField is non-deterministic across fresh sims");
    }

    #[test]
    fn apply_force_in_polygon_radial_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let zone = rect_poly(-500, -500, 500, 500);
        let center = FxVec2::new(Fx::ZERO, Fx::ZERO);
        let strength = Fx::from_int(2000);
        let radius = Fx::from_int(400);
        for _ in 0..30 {
            a.apply_force_in_polygon(&zone, ForceField::Radial {
                center, strength, radius, falloff: PointGravityFalloff::Linear,
            }, FIXED_DT);
            b.apply_force_in_polygon(&zone, ForceField::Radial {
                center, strength, radius, falloff: PointGravityFalloff::Linear,
            }, FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "Radial ForceField (Linear falloff) is non-deterministic across fresh sims");
    }

    #[test]
    fn apply_force_in_polygon_drag_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let zone = rect_poly(-500, -500, 500, 500);
        // Get the blobs moving first.
        for _ in 0..20 {
            a.apply_blob_move_force(0, FxVec2::new(Fx::from_int(1), Fx::ZERO), Fx::from_int(3000), FIXED_DT);
            b.apply_blob_move_force(0, FxVec2::new(Fx::from_int(1), Fx::ZERO), Fx::from_int(3000), FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        // Now apply drag in the zone and verify damping is bit-equal.
        let coefficient = Fx::from_f64(2.0); // 2.0 / sec
        for _ in 0..30 {
            a.apply_force_in_polygon(&zone, ForceField::Drag { coefficient }, FIXED_DT);
            b.apply_force_in_polygon(&zone, ForceField::Drag { coefficient }, FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "Drag ForceField is non-deterministic across fresh sims");
    }

    #[test]
    fn apply_force_in_polygon_survives_rollback() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        let zone = rect_poly(-500, -500, 500, 500);
        let force = FxVec2::new(Fx::from_int(500), Fx::from_int(-100));
        for _ in 0..20 {
            a.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            b.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        let snap = b.serialize_state();
        // Destructive: apply wrong force for 2 ticks.
        b.apply_force_in_polygon(&zone, ForceField::Uniform {
            force: FxVec2::new(Fx::from_int(9999), Fx::from_int(9999)),
        }, FIXED_DT);
        b.step(FIXED_DT);
        b.step(FIXED_DT);
        b.restore_state(&snap).expect("restore returned Err");

        for _ in 20..50 {
            a.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            b.apply_force_in_polygon(&zone, ForceField::Uniform { force }, FIXED_DT);
            a.step(FIXED_DT);
            b.step(FIXED_DT);
        }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "zone-force round-trip diverged after rollback+replay");
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 4 dynamic-item tests.
    //
    // For each item kind, verify that two fresh sims with identical
    // setup produce bit-identical serialized state after 60 ticks of
    // engine stepping (which calls update_dynamic_items every step).
    // Catches per-tick non-determinism in the engine's item state
    // machines + the force application paths they call into.
    //
    // Also verifies snapshot round-trip for items (timer + active +
    // bumper cooldown all captured + restored).
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn cannon_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_cannon(0, Fx::from_int(-100), Fx::from_int(-50), Fx::from_int(80), Fx::from_int(80), Fx::from_f64(0.5));
        b.add_cannon(0, Fx::from_int(-100), Fx::from_int(-50), Fx::from_int(80), Fx::from_int(80), Fx::from_f64(0.5));
        for _ in 0..60 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "cannon is non-deterministic across fresh sims");
    }

    #[test]
    fn bumper_is_deterministic_including_cooldown() {
        // Bumper has the most state (cooldown ticks + active flag).
        // Position it at one blob's spawn so it fires on tick 1.
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_bumper(0, Fx::from_int(-100), Fx::ZERO, Fx::from_int(80));
        b.add_bumper(0, Fx::from_int(-100), Fx::ZERO, Fx::from_int(80));
        for _ in 0..60 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "bumper is non-deterministic (cooldown timer or trigger detection)");
    }

    #[test]
    fn wind_zone_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_wind_zone(0, Fx::ZERO, Fx::ZERO, Fx::from_int(500), Fx::from_int(500), Fx::ZERO);
        b.add_wind_zone(0, Fx::ZERO, Fx::ZERO, Fx::from_int(500), Fx::from_int(500), Fx::ZERO);
        for _ in 0..60 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "wind zone is non-deterministic");
    }

    #[test]
    fn conveyor_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_conveyor(0, Fx::ZERO, Fx::from_int(80), Fx::from_int(400), Fx::from_int(40), 1);
        b.add_conveyor(0, Fx::ZERO, Fx::from_int(80), Fx::from_int(400), Fx::from_int(40), 1);
        for _ in 0..60 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "conveyor is non-deterministic");
    }

    #[test]
    fn sticky_goo_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_sticky_goo(0, Fx::ZERO, Fx::ZERO, Fx::from_int(500), Fx::from_int(500));
        b.add_sticky_goo(0, Fx::ZERO, Fx::ZERO, Fx::from_int(500), Fx::from_int(500));
        for _ in 0..60 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "sticky goo (drag field) is non-deterministic");
    }

    #[test]
    fn wrecking_ball_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_wrecking_ball(0, Fx::from_int(-100), Fx::ZERO);
        b.add_wrecking_ball(0, Fx::from_int(-100), Fx::ZERO);
        for _ in 0..120 { a.step(FIXED_DT); b.step(FIXED_DT); } // 2s — covers a full period
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "wrecking ball is non-deterministic");
    }

    // ─────────────────────────────────────────────────────────────────
    // Phase 5 spring-pad tests.
    // ─────────────────────────────────────────────────────────────────

    #[test]
    fn spring_pad_is_deterministic() {
        let mut a = build_world(42);
        let mut b = build_world(42);
        // Pad just below blob A (which spawns at -100, 0 with hex radius 40).
        // Position so the blob falls onto it within ~30 ticks.
        a.add_spring_pad(0, Fx::from_int(-100), Fx::from_int(150), Fx::from_int(140), Fx::from_int(30), Fx::from_f64(-1.5708), None);
        b.add_spring_pad(0, Fx::from_int(-100), Fx::from_int(150), Fx::from_int(140), Fx::from_int(30), Fx::from_f64(-1.5708), None);
        for _ in 0..120 { a.step(FIXED_DT); b.step(FIXED_DT); } // 2s — blob lands on pad, pad fires + reloads
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "spring pad is non-deterministic across fresh sims");
    }

    #[test]
    fn spring_pad_state_machine_round_trip() {
        // Snapshot during firing, restore, replay — should converge with
        // the no-rollback baseline.
        let mut a = build_world(42);
        let mut b = build_world(42);
        a.add_spring_pad(0, Fx::from_int(-100), Fx::from_int(150), Fx::from_int(140), Fx::from_int(30), Fx::from_f64(-1.5708), None);
        b.add_spring_pad(0, Fx::from_int(-100), Fx::from_int(150), Fx::from_int(140), Fx::from_int(30), Fx::from_f64(-1.5708), None);
        for _ in 0..40 { a.step(FIXED_DT); b.step(FIXED_DT); } // blob lands, pad fires
        assert_eq!(a.serialize_state(), b.serialize_state(), "pre-rollback divergence");

        let snap = b.serialize_state();
        for _ in 0..5 { b.step(FIXED_DT); }
        b.restore_state(&snap).expect("restore returned Err");

        for _ in 40..120 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "spring-pad rollback round-trip diverged");
    }

    #[test]
    fn spring_pad_fire_events_emitted_on_state_transition() {
        let mut a = build_world(42);
        a.add_spring_pad(42, Fx::from_int(-100), Fx::from_int(150), Fx::from_int(140), Fx::from_int(30), Fx::from_f64(-1.5708), None);
        let mut fire_events = Vec::new();
        for _ in 0..120 {
            a.step(FIXED_DT);
            fire_events.extend(a.take_spring_pad_fire_events());
        }
        assert!(!fire_events.is_empty(), "expected spring pad to fire at least once");
        assert!(fire_events.iter().all(|&id| id == 42), "fire event has wrong id");
    }

    #[test]
    fn all_item_kinds_survive_rollback() {
        // Big stress test: add one of each kind, run for a while, then
        // snapshot+destructive-tick+restore+replay and confirm we end
        // exactly where the no-rollback baseline does.
        let mut a = build_world(42);
        let mut b = build_world(42);
        for w in [&mut a, &mut b] {
            w.add_cannon(0, Fx::from_int(300), Fx::from_int(300), Fx::from_int(80), Fx::from_int(80), Fx::from_f64(1.5));
            w.add_catapult(1, Fx::from_int(-300), Fx::from_int(-300), Fx::from_int(80), Fx::from_int(80));
            w.add_bumper(2, Fx::from_int(150), Fx::from_int(-200), Fx::from_int(80));
            w.add_wind_zone(3, Fx::from_int(-200), Fx::from_int(200), Fx::from_int(400), Fx::from_int(200), Fx::from_f64(0.3));
            w.add_gravity_flipper(4, Fx::from_int(-400), Fx::ZERO, Fx::from_int(200), Fx::from_int(200));
            w.add_conveyor(5, Fx::from_int(400), Fx::from_int(80), Fx::from_int(300), Fx::from_int(40), -1);
            w.add_sticky_goo(6, Fx::from_int(200), Fx::from_int(-300), Fx::from_int(200), Fx::from_int(100));
            w.add_wrecking_ball(7, Fx::from_int(-150), Fx::from_int(-150));
        }
        for _ in 0..30 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(), "pre-rollback divergence");

        let snap = b.serialize_state();
        // Destructive: step 5 extra times.
        for _ in 0..5 { b.step(FIXED_DT); }
        b.restore_state(&snap).expect("restore returned Err");

        for _ in 30..90 { a.step(FIXED_DT); b.step(FIXED_DT); }
        assert_eq!(a.serialize_state(), b.serialize_state(),
            "all-kinds rollback round-trip diverged");
    }
}
