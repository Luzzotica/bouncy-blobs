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

    #[inline] fn u8(&mut self, v: u8)   { self.buf.push(v); }
    #[inline] fn u32(&mut self, v: u32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn i32(&mut self, v: i32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn u64(&mut self, v: u64) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn i64(&mut self, v: i64) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn bool(&mut self, v: bool) { self.u8(if v { 1 } else { 0 }); }
    #[inline] fn fx(&mut self, v: Fx) { self.i64(v.raw()); }
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
    fn u8(&mut self) -> Result<u8, &'static str> { Ok(self.take(1)?[0]) }
    fn u32(&mut self) -> Result<u32, &'static str> {
        let b = self.take(4)?; Ok(u32::from_le_bytes([b[0],b[1],b[2],b[3]]))
    }
    fn i32(&mut self) -> Result<i32, &'static str> {
        let b = self.take(4)?; Ok(i32::from_le_bytes([b[0],b[1],b[2],b[3]]))
    }
    fn u64(&mut self) -> Result<u64, &'static str> {
        let b = self.take(8)?; Ok(u64::from_le_bytes([b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7]]))
    }
    fn i64(&mut self) -> Result<i64, &'static str> {
        let b = self.take(8)?; Ok(i64::from_le_bytes([b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7]]))
    }
    fn bool(&mut self) -> Result<bool, &'static str> { Ok(self.u8()? != 0) }
    fn fx(&mut self) -> Result<Fx, &'static str> { Ok(Fx::from_raw(self.i64()?)) }
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
