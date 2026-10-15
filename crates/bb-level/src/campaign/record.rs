//! Transitional: the old Rust chapter builders, recorded as blueprints.
//! Every call appends a [`Piece`] and expands it right away, so the
//! recorded blueprint expands to exactly what the code built.

use glam::Vec2;

use crate::blueprint::{Blueprint, Course, Expander, Move, Piece};
use crate::types::*;

pub(crate) struct Ch {
    pub bp: Blueprint,
    e: Expander,
}

impl Ch {
    pub fn new(n: u8, name: &str, theme: Theme, bottom: f32) -> Ch {
        let id = format!("ch{n:02}");
        let bp = Blueprint {
            blueprint: crate::blueprint::BLUEPRINT_VERSION,
            id: id.clone(),
            name: name.into(),
            theme,
            about: Vec::new(),
            bottom,
            kill_y: bottom + 200.0,
            spawn: Vec2::ZERO,
            intro: format!("{id}_intro"),
            outro: format!("{id}_outro"),
            pieces: Vec::new(),
        };
        let e = Expander::new(&bp);
        Ch { bp, e }
    }

    pub fn finish(self) -> (Blueprint, Course) {
        (self.bp, self.e.finish())
    }

    pub fn about(&mut self, lines: &[&str]) -> &mut Self {
        self.bp.about = lines.iter().map(|s| s.to_string()).collect();
        self
    }

    pub fn add(&mut self, p: Piece) -> &mut Self {
        self.e.apply(&p);
        self.bp.pieces.push(p);
        self
    }

    pub fn spawn(&mut self, p: Vec2) -> &mut Self {
        self.bp.spawn = p;
        self.e.b.spawn(p);
        self
    }

    pub fn section(&mut self, s: &str) -> &mut Self {
        self.add(Piece::Section(s.into()))
    }
    pub fn note(&mut self, s: &str) -> &mut Self {
        self.add(Piece::Note(s.into()))
    }
    pub fn wp(&mut self, how: Move, x: f32, y: f32) -> &mut Self {
        self.add(Piece::Wp(how, x, y))
    }

    pub fn floor(&mut self, top: &[Vec2]) -> &mut Self {
        self.add(Piece::Floor(top.to_vec()))
    }
    pub fn ledge(&mut self, x0: f32, x1: f32, y: f32) -> &mut Self {
        self.add(Piece::Ledge { x0, x1, y })
    }
    pub fn shelf(&mut self, x0: f32, x1: f32, y: f32, depth: f32) -> &mut Self {
        self.add(Piece::Shelf { x0, x1, y, depth })
    }
    pub fn ground(&mut self, top: &[Vec2], depth: f32) -> &mut Self {
        self.add(Piece::Ground { top: top.to_vec(), depth, material: Material::Ground, wobble: 0.5 })
    }
    pub fn ground_with(&mut self, top: &[Vec2], depth: f32, material: Material, wobble: f32) -> &mut Self {
        self.add(Piece::Ground { top: top.to_vec(), depth, material, wobble })
    }
    pub fn roof(&mut self, bottom: &[Vec2]) -> &mut Self {
        self.add(Piece::Roof(bottom.to_vec()))
    }
    pub fn ceiling(&mut self, bottom: &[Vec2], height: f32) -> &mut Self {
        self.add(Piece::Ceiling { bottom: bottom.to_vec(), height })
    }
    pub fn wall(&mut self, x0: f32, x1: f32, y0: f32, y1: f32) -> &mut Self {
        self.add(Piece::Wall { x0, x1, y0, y1 })
    }
    pub fn block_mat(&mut self, min: Vec2, max: Vec2, material: Material) -> &mut Self {
        self.add(Piece::Block { min, max, material })
    }
    pub fn stone(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.block_mat(min, max, Material::Stone)
    }
    pub fn poly(&mut self, points: &[Vec2]) -> &mut Self {
        self.add(Piece::Poly { points: points.to_vec(), material: Material::Ground })
    }
    pub fn poly_mat(&mut self, points: &[Vec2], material: Material) -> &mut Self {
        self.add(Piece::Poly { points: points.to_vec(), material })
    }
    pub fn one_way_top(&mut self, x0: f32, x1: f32, y: f32, thick: f32) -> &mut Self {
        self.add(Piece::OneWay { x0, x1, y, thick })
    }
    pub fn jelly(&mut self, min: Vec2, max: Vec2, wobble: f32) -> &mut Self {
        self.add(Piece::Jelly { min, max, wobble })
    }
    pub fn entry_cave(&mut self, x_far: f32, x_face: f32, y: f32, top: f32, theme: Theme) -> &mut Self {
        self.add(Piece::EntryCave { x_far, x_face, y, top, theme })
    }
    pub fn exit_cave(&mut self, x_face: f32, x_far: f32, y: f32, top: f32, theme: Theme) -> &mut Self {
        self.add(Piece::ExitCave { x_face, x_far, y, top, theme, daylight: false })
    }
    pub fn exit_cave_daylight(&mut self, x_face: f32, x_far: f32, y: f32, top: f32, theme: Theme) -> &mut Self {
        self.add(Piece::ExitCave { x_face, x_far, y, top, theme, daylight: true })
    }

    pub fn bridge(&mut self, a: Vec2, b: Vec2, thick: f32, stiffness: f32) -> &mut Self {
        self.add(Piece::Bridge { a, b, thick, stiffness })
    }
    pub fn slab(&mut self, center: Vec2, size: Vec2, stiffness: f32) -> &mut Self {
        self.add(Piece::Slab { center, size, stiffness })
    }
    pub fn lily(&mut self, surface: Vec2, width: f32) -> &mut Self {
        self.add(Piece::Lily { surface, width })
    }
    pub fn prop(&mut self, id: &str, kind: PropKind, center: Vec2, size: Vec2, mass: f32, color: &str) -> &mut Self {
        self.prop_pinned(id, kind, center, size, mass, color, false)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn prop_pinned(&mut self, id: &str, kind: PropKind, center: Vec2, size: Vec2, mass: f32, color: &str, pinned: bool) -> &mut Self {
        self.add(Piece::Prop(Prop {
            id: id.into(),
            kind,
            center,
            size,
            angle: 0.0,
            mass,
            material: Material::Ground,
            color: color.into(),
            pinned,
        }))
    }
    pub fn crate_box(&mut self, at: Vec2, size: f32) -> &mut Self {
        self.add(Piece::Crate { at, size })
    }
    pub fn ball(&mut self, at: Vec2, radius: f32, color: &str) -> &mut Self {
        self.add(Piece::Ball { at, radius, color: color.into() })
    }
    pub fn seesaw(&mut self, id: &str, pivot: Vec2, length: f32, mass: f32) -> &mut Self {
        self.add(Piece::Seesaw { id: id.into(), pivot, length, mass })
    }

    pub fn mover_mat(&mut self, shape: Shape, path: &[Vec2], period: f32, motion: MoverMotion, material: Material) -> &mut Self {
        self.add(Piece::Mover(Mover {
            id: String::new(),
            shape,
            path: path.to_vec(),
            motion,
            period,
            phase: 0.0,
            material,
            trigger: String::new(),
            lethal: false,
            spiked: false,
        }))
    }
    pub fn mover(&mut self, shape: Shape, path: &[Vec2], period: f32, motion: MoverMotion) -> &mut Self {
        self.mover_mat(shape, path, period, motion, Material::Stone)
    }
    pub fn elevator(&mut self, a: Vec2, b: Vec2, width: f32, period: f32) -> &mut Self {
        self.elevator_phase(a, b, width, period, 0.0)
    }
    pub fn elevator_phase(&mut self, a: Vec2, b: Vec2, width: f32, period: f32, phase: f32) -> &mut Self {
        self.add(Piece::Elevator { a, b, width, period, phase })
    }
    pub fn piston(&mut self, x: f32, roof: f32, floor: f32, phase: f32, spiked: bool) -> &mut Self {
        self.add(Piece::Piston { x, roof, floor, phase, spiked })
    }
    pub fn blade(&mut self, center: Vec2, size: Vec2, speed: f32) -> &mut Self {
        self.add(Piece::Blade { center, size, speed })
    }
    pub fn drip_hazard(&mut self, top: Vec2, fall: f32, radius: f32, phase: f32) -> &mut Self {
        self.add(Piece::Drip { top, fall, radius, phase })
    }
    pub fn conveyor(&mut self, at: Vec2, length: f32, speed: f32) -> &mut Self {
        self.add(Piece::Conveyor { at, length, speed })
    }

    pub fn vine(&mut self, top: Vec2, length: f32) -> &mut Self {
        self.add(Piece::Vine { top, length, knob: false })
    }
    pub fn vine_knob(&mut self, top: Vec2, length: f32) -> &mut Self {
        self.add(Piece::Vine { top, length, knob: true })
    }
    pub fn rope(&mut self, from: RopeEnd, to: RopeEnd, length: f32, style: RopeStyle) -> &mut Self {
        self.add(Piece::Rope { from, to, length, style, knob: false })
    }
    pub fn rope_knob(&mut self, from: RopeEnd, to: RopeEnd, length: f32, style: RopeStyle) -> &mut Self {
        self.add(Piece::Rope { from, to, length, style, knob: true })
    }

    pub fn zone(&mut self, min: Vec2, max: Vec2, kind: ZoneKind) -> &mut Self {
        self.add(Piece::Zone { min, max, kind })
    }
    pub fn water(&mut self, min: Vec2, max: Vec2) -> &mut Self {
        self.add(Piece::Water { min, max })
    }
    pub fn current(&mut self, min: Vec2, max: Vec2, flow: Vec2) -> &mut Self {
        self.add(Piece::Current { min, max, flow })
    }
    pub fn wind(&mut self, min: Vec2, max: Vec2, accel: Vec2) -> &mut Self {
        self.add(Piece::Wind { min, max, accel })
    }

    pub fn spring(&mut self, at: Vec2, angle: f32, power: f32) -> &mut Self {
        self.add(Piece::Spring { at, angle, power })
    }
    pub fn spikes(&mut self, a: Vec2, b: Vec2) -> &mut Self {
        self.add(Piece::Spikes { a, b })
    }
    pub fn ceiling_spikes(&mut self, x0: f32, x1: f32, y: f32) -> &mut Self {
        self.add(Piece::CeilingSpikes { x0, x1, y })
    }
    pub fn roof_spikes(&mut self, x0: f32, x1: f32, gaps: &[f32], keep: f32) -> &mut Self {
        self.add(Piece::RoofSpikes { x0, x1, gaps: gaps.to_vec(), keep })
    }
    pub fn trampoline(&mut self, base: Vec2, height: f32, cap: f32, power: f32) -> &mut Self {
        self.add(Piece::Trampoline { base, height, cap, power })
    }
    pub fn shroom(&mut self, x: f32, base: f32, cap: f32, power: f32, shape: MushroomShape) -> &mut Self {
        self.add(Piece::Shroom { x, base, cap, power, shape })
    }
    pub fn tramp(&mut self, x: f32, base: f32, cap: f32, power: f32) -> &mut Self {
        self.add(Piece::Tramp { x, base, cap, power })
    }

    pub fn launch_plate(&mut self, center: Vec2, radius: f32, speed: f32, angle: f32, clockwise: bool) -> &mut Self {
        self.add(Piece::LaunchPlate { center, radius, speed, angle, clockwise })
    }
    pub fn seed_pod(&mut self, base: Vec2, height: f32, angle: f32, sweep: f32, power: f32) -> &mut Self {
        self.add(Piece::SeedPod { base, height, angle, sweep, power })
    }
    pub fn gadget(&mut self, pos: Vec2, kind: GadgetKind) -> &mut Self {
        self.add(Piece::Gadget(Gadget { id: String::new(), pos, kind }))
    }
    pub fn balloon(&mut self, at: Vec2, duration: f32) -> &mut Self {
        self.add(Piece::Balloon { at, duration })
    }
    pub fn crane(&mut self, home: Vec2, drop: Vec2, travel: f32) -> &mut Self {
        self.add(Piece::Crane { home, drop, travel })
    }

    pub fn cp(&mut self, x: f32, y: f32) -> &mut Self {
        self.add(Piece::Checkpoint(Vec2::new(x, y)))
    }
    pub fn pickup(&mut self, at: Vec2) -> &mut Self {
        self.add(Piece::Pickup(at))
    }
    pub fn pickups(&mut self, a: Vec2, b: Vec2, n: usize) -> &mut Self {
        self.add(Piece::Pickups { a, b, n })
    }
    pub fn pickup_arc(&mut self, a: Vec2, b: Vec2, h: f32, n: usize) -> &mut Self {
        self.add(Piece::PickupArc { a, b, h, n })
    }
    pub fn drops(&mut self, x0: f32, x1: f32, y: f32, n: usize) -> &mut Self {
        self.add(Piece::Drops { x0, x1, y, n })
    }
    pub fn npc(&mut self, id: &str, pos: Vec2, role: NpcRole, color: &str, radius: f32) -> &mut Self {
        self.add(Piece::Npc(Npc { id: id.into(), pos, role, color: color.into(), radius }))
    }
    pub fn say(&mut self, x0: f32, x1: f32, y: f32, script: &str) -> &mut Self {
        self.add(Piece::Say { x0, x1, y, script: script.into() })
    }
    pub fn story(&mut self, min: Vec2, max: Vec2, script: &str) -> &mut Self {
        self.add(Piece::Story { min, max, script: script.into() })
    }
    pub fn decor(&mut self, kind: &str, at: Vec2, scale: f32, depth: f32) -> &mut Self {
        self.add(Piece::Decor { kind: kind.into(), at, scale, depth })
    }
    pub fn scatter(&mut self, kind: &str, x0: f32, x1: f32, y: f32, step: f32, depth: f32) -> &mut Self {
        self.add(Piece::Scatter { kind: kind.into(), x0, x1, y, step, depth })
    }
    pub fn hang(&mut self, kind: &str, x0: f32, x1: f32, step: f32) -> &mut Self {
        self.add(Piece::Hang { kind: kind.into(), x0, x1, step })
    }
}
