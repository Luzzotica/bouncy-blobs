//! Kids Mode: a pure playground for toddlers (legacy `KidsMode.tsx`).
//!
//! * One player blob plus 8 shape friends (star / square / triangle) who
//!   wander and puff on their own. Friends are sim *players* (slots 1–8)
//!   driven by this module, so they get palette colours and faces.
//! * Tap or drag any blob to pick it up (velocity servo, puffed while held,
//!   flung on release). It says its colour (or shape / letter / note,
//!   depending on the learn mode).
//! * Tap empty space left / right of centre to roll that way.
//! * PUFF (or Space) puffs everyone and fires the learn-mode lesson:
//!   ABC → next letter, Music → next Twinkle note, Shape → morph into the
//!   next shape, Color → say the colour.
//! * Colour chips on the floor tray recolour the player and sing the colour.
//! * Nothing pops. Hold HOME for 1.5 s to leave (the parental gate).

pub mod fx;
pub mod lessons;
pub mod level;
pub mod ui;

use bb_physics::{BodyId, Vec2 as PVec2};
use bb_sim::{Input, Sim};
use bevy::camera::ScalingMode;
use bevy::ecs::system::SystemParam;
use bevy::input::touch::Touches;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use crate::audio::{AudioSettings, PlaySfx};
use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::input::{GatherInput, LocalDevices, RemoteSlots};
use crate::palette::hex;
use crate::sim::{Game, Inputs};
use fx::{Glyph, Particles};
use lessons::{KidsVoice, LearnMode};
use level::{KIDS_SHAPES, KidsShape};
use ui::{UiItem, UiKind};

/// Grab hit radius from a blob's centroid (legacy 110 × 2/3).
pub const TAP_HIT_R: f32 = 74.0;
pub const PICK_PUFF_SEC: f32 = 0.95;
pub const FOLLOW_RATE: f32 = 16.0;
pub const MAX_PULL_SPEED: f32 = 2400.0;
pub const FLING_CAP: f32 = 1600.0;
pub const PICK_SCALE_PEAK: f32 = 1.55;
pub const HOLD_SECS: f32 = 1.5;
const MOUSE: u64 = u64::MAX;

/// Despawned when Kids Mode exits.
#[derive(Component)]
pub struct KidsEntity;

#[derive(Clone, Debug)]
pub struct Friend {
    pub slot: u8,
    pub shape: KidsShape,
    pub puff: f32,
    pub wander_dir: f32,
    pub wander_t: f32,
    pub self_t: f32,
    pub self_hold: f32,
}

#[derive(Clone, Debug)]
pub struct Grab {
    pub slot: u8,
    pub body: BodyId,
    pub particle: usize,
    pub target: PVec2,
    pub last: PVec2,
    pub pv: PVec2,
    pub pointer: u64,
}

#[derive(Resource)]
pub struct Kids {
    pub mode: LearnMode,
    pub color: u32,
    pub friends: Vec<Friend>,
    pub grab: Option<Grab>,
    /// Side-tap: (pointer, -1 / +1).
    pub side: Option<(u64, f32)>,
    pub puff: Option<u64>,
    /// Hold-to-exit: (pointer, seconds held).
    pub home: Option<(u64, f32)>,
    pub ui: Vec<UiItem>,
    pub was_group: bool,
    pub abc: usize,
    pub note: usize,
    pub shape_index: usize,
    pub last_letter: f32,
    pub last_note: f32,
    /// What the corner badge shows.
    pub badge: (Glyph, Color),
    pub player_shape: Option<KidsShape>,
    /// Synthetic pointer events (world space) — the `BB_KIDS_DEMO` driver.
    injected: Vec<(u64, PVec2, Phase)>,
    rng: u32,
}

impl Kids {
    fn rand(&mut self) -> f32 {
        let mut r = crate::audio::synth::Rng(self.rng | 1);
        let v = r.f();
        self.rng = r.0;
        v
    }
}

pub struct KidsPlugin;

impl Plugin for KidsPlugin {
    fn build(&self, app: &mut App) {
        let running = in_state(AppState::Kids).and_then(resource_exists::<Kids>).and_then(resource_exists::<Game>);
        app.init_resource::<Particles>()
            .add_systems(OnEnter(AppState::Kids), (enter, fx::spawn_particle_mesh).chain())
            .add_systems(OnExit(AppState::Kids), exit)
            .add_systems(PreUpdate, (demo, pointers, drive).chain().after(GatherInput).run_if(running.clone()))
            .add_systems(Update, (ui::visuals, fx::update, fit_camera, portrait_gate).run_if(running))
            .add_systems(Update, stop_voice_on_blur.run_if(resource_exists::<KidsVoice>));
    }
}

// ------------------------------------------------------------- persistence

/// Tiny best-effort prefs file (learn mode + colour). Silent on failure and
/// a no-op on the web.
mod prefs {
    pub fn load() -> (Option<String>, Option<u32>) {
        (crate::save::get("kids.mode"), crate::save::get("kids.color").and_then(|c| bb_sim::parse_color(&c)))
    }

    pub fn save(mode: &str, color: u32) {
        crate::save::set("kids.mode", mode);
        crate::save::set("kids.color", &format!("#{color:06x}"));
    }
}

// ------------------------------------------------------------ enter / exit

fn circle_outline() -> Vec<PVec2> {
    (0..22).map(|i| PVec2::from_angle(i as f32 / 22.0 * std::f32::consts::TAU) * bb_sim::control::tune::RADIUS).collect()
}

fn enter(
    mut commands: Commands,
    server: Option<Res<AssetServer>>,
    sources: Option<ResMut<Assets<AudioSource>>>,
    mut meshes: ResMut<Assets<Mesh>>,
    shared: Res<crate::render::Shared>,
    mut devices: ResMut<LocalDevices>,
    mut remote: ResMut<RemoteSlots>,
) {
    let (mode, color) = prefs::load();
    let mode = std::env::var("BB_KIDS_MODE").ok().or(mode).and_then(|m| LearnMode::from_key(&m)).unwrap_or_default();
    let color = color.unwrap_or(lessons::PALETTE_NAMES[5].0);

    let mut sim = Sim::new(level::playground());
    sim.rules.players_pop = false;
    sim.add_player(0, "Kid", color);
    let mut friends = Vec::new();
    for (i, (pos, shape)) in level::friends().into_iter().enumerate() {
        let slot = i as u8 + 1;
        let body = sim.add_player(slot, "", lessons::PALETTE_NAMES[i % 12].0).ctl.body;
        sim.world.body_mut(body).unwrap().set_rest_shape(&shape.outline());
        sim.world.respawn(body, pos);
        friends.push(Friend {
            slot,
            shape,
            puff: 0.0,
            wander_dir: if i % 2 == 0 { 1.0 } else { -1.0 },
            wander_t: 1.2 + (i % 5) as f32 * 0.4,
            self_t: 1.8 + (i % 6) as f32 * 0.55 + (i as f32 * 0.37).fract() * 0.8,
            self_hold: 0.0,
        });
    }
    let ui = ui::spawn_items(&mut sim, &lessons::chip_colors());
    ui::spawn_overlay(&mut commands, &mut meshes, &shared, &ui);
    spawn_backdrop(&mut commands, &mut meshes, &shared);
    spawn_portrait_gate(&mut commands);
    commands.insert_resource(Game::new_with(sim));
    commands.insert_resource(Kids {
        mode,
        color,
        friends,
        grab: None,
        side: None,
        puff: None,
        home: None,
        ui,
        was_group: false,
        abc: 0,
        note: 0,
        shape_index: 0,
        last_letter: -1.0,
        last_note: -1.0,
        badge: (Glyph::Text("-"), hex(fx::INK)),
        player_shape: None,
        injected: Vec::new(),
        rng: 0x1234_5678,
    });
    if let (Some(server), Some(mut sources)) = (server, sources) {
        commands.insert_resource(KidsVoice::load(&server, &mut sources));
    }
    // Touch belongs to Kids Mode (grab / side-tap), not the floating stick;
    // friend slots are written here, not by devices.
    devices.touch_slot = None;
    for s in 1..=8 {
        remote.0[s] = true;
    }
}

fn exit(
    mut commands: Commands,
    q: Query<Entity, With<KidsEntity>>,
    voice: Option<ResMut<KidsVoice>>,
    mut devices: ResMut<LocalDevices>,
    mut remote: ResMut<RemoteSlots>,
    mut director: ResMut<CameraDirector>,
) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
    if let Some(mut v) = voice {
        v.stop(&mut commands);
    }
    commands.remove_resource::<KidsVoice>();
    commands.remove_resource::<Kids>();
    commands.remove_resource::<Game>();
    devices.touch_slot = Some(0);
    for s in 1..=8 {
        remote.0[s] = false;
    }
    *director = CameraDirector::default();
}

/// Cream paper inside the box: soft polka dots on warm paper.
fn spawn_backdrop(commands: &mut Commands, meshes: &mut Assets<Mesh>, shared: &crate::render::Shared) {
    use crate::palette::lin;
    use crate::render::MeshBuf;
    let (lo, hi) = (level::INNER_MIN - PVec2::splat(30.0), level::INNER_MAX + PVec2::splat(30.0));
    let mut buf = MeshBuf::default();
    let q = [lo, PVec2::new(hi.x, lo.y), hi, PVec2::new(lo.x, hi.y)];
    buf.fan(&q, (lo + hi) * 0.5, 0.0, lin(hex(0xfffcef)), lin(hex(0xfff3d6)));
    let dot = lin(hex(0xf6e7c4));
    let mut row = 0;
    let mut y = lo.y + 40.0;
    while y < hi.y {
        let mut x = lo.x + 40.0 + if row % 2 == 0 { 0.0 } else { 45.0 };
        while x < hi.x {
            buf.ellipse(PVec2::new(x, y), PVec2::splat(7.0), 0.0, 0.001, dot);
            x += 90.0;
        }
        y += 78.0;
        row += 1;
    }
    commands.spawn((Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, -45.0), KidsEntity));
}

// ----------------------------------------------------------------- pointers

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Down,
    Move,
    Up,
}

/// Lesson side effects: voice, particles, floaters, badge.
#[derive(SystemParam)]
pub struct LessonFx<'w, 's> {
    commands: Commands<'w, 's>,
    voice: Option<ResMut<'w, KidsVoice>>,
    settings: Res<'w, AudioSettings>,
    particles: ResMut<'w, Particles>,
    meshes: ResMut<'w, Assets<Mesh>>,
    mats: ResMut<'w, Assets<ColorMaterial>>,
    time: Res<'w, Time>,
    sfx: MessageWriter<'w, PlaySfx>,
}

#[derive(Default, Clone, Copy)]
struct LessonOpts {
    shape: Option<KidsShape>,
    color: Option<u32>,
    at: Option<PVec2>,
}

fn morph_player(sim: &mut Sim, kids: &mut Kids, shape: Option<KidsShape>) {
    if kids.player_shape == shape {
        return;
    }
    kids.player_shape = shape;
    let outline = shape.map_or_else(circle_outline, |s| s.outline());
    if let Some(b) = sim.player(0).and_then(|p| sim.world.body(p.ctl.body)).map(|b| b.centroid()) {
        let id = sim.player(0).unwrap().ctl.body;
        let body = sim.world.body_mut(id).unwrap();
        body.set_rest_shape(&outline);
        // A little hop so the morph reads as a "boing".
        body.add_velocity(PVec2::new(0.0, 260.0));
        let _ = b;
    }
}

/// The single mode-owned lesson (legacy `fireModeLesson`).
fn fire_lesson(sim: &mut Sim, kids: &mut Kids, fx: &mut LessonFx, o: LessonOpts) {
    let now = fx.time.elapsed_secs();
    let player_c = sim.player(0).and_then(|p| sim.world.body(p.ctl.body)).map_or(sim.level.spawn, |b| b.centroid());
    let at = o.at.unwrap_or(player_c);
    let paper = hex(fx::PAPER);
    let pcol = hex(kids.color);
    let Some(voice) = fx.voice.as_mut() else { return };
    let (cmds, s) = (&mut fx.commands, &*fx.settings);
    match kids.mode {
        LearnMode::Music => {
            if now - kids.last_note < lessons::NOTE_GAP {
                return;
            }
            kids.last_note = now;
            let hz = lessons::TWINKLE[kids.note % lessons::TWINKLE.len()];
            kids.note += 1;
            voice.note(cmds, hz, s);
            kids.badge = (Glyph::Note, hex(fx::LAVENDER));
            fx.particles.puff(at, hex(fx::LAVENDER), 6);
            let cols = [fx::LAVENDER, fx::PINK, fx::YELLOW, fx::GREEN, fx::PAPER];
            for _ in 0..3 + (kids.rand() * 3.0) as usize {
                let a = kids.rand() * std::f32::consts::TAU;
                let r = 70.0 + kids.rand() * 200.0;
                let mut p = at + PVec2::new(a.cos() * r, a.sin() * r + 20.0);
                p = p.clamp(level::INNER_MIN + PVec2::splat(40.0), level::INNER_MAX - PVec2::splat(40.0));
                let col = hex(cols[(kids.rand() * 5.0) as usize % 5]);
                fx.particles.sparkle(p, col, 8 + (kids.rand() * 12.0) as usize);
                let life = 0.65 + kids.rand() * 0.55;
                fx::spawn_floater(cmds, &mut fx.meshes, &mut fx.mats, Glyph::Note, p, 70.0, life, col);
            }
        }
        LearnMode::Shape => {
            let shape = o.shape.unwrap_or_else(|| {
                let sh = KIDS_SHAPES[kids.shape_index % 3];
                kids.shape_index += 1;
                sh
            });
            if o.shape.is_none() && o.at.is_none() {
                morph_player(sim, kids, Some(shape));
            }
            voice.shape(cmds, shape, s);
            let g = shape_glyph(shape);
            kids.badge = (g, hex(0x6ecf6e));
            fx.particles.sparkle(at, hex(fx::GREEN), 16);
            fx.particles.puff(at, paper, 6);
            fx::spawn_floater(cmds, &mut fx.meshes, &mut fx.mats, g, at + PVec2::new(0.0, 50.0), 90.0, 0.9, hex(0x6ecf6e));
        }
        LearnMode::Color => {
            let c = o.color.unwrap_or(kids.color);
            voice.color(cmds, c, s);
            kids.badge = (Glyph::Dot, hex(c));
            fx.particles.sparkle(at, hex(c), 16);
            fx.particles.puff(at, paper, 6);
        }
        LearnMode::Alphabet => {
            if now - kids.last_letter < lessons::LETTER_GAP {
                return;
            }
            kids.last_letter = now;
            let l = (b'A' + (kids.abc % 26) as u8) as char;
            kids.abc += 1;
            voice.letter(cmds, l, s);
            kids.badge = (Glyph::Letter(l), hex(fx::INK));
            fx.particles.sparkle(at, pcol, 16);
            fx.particles.puff(at, paper, 6);
            fx::spawn_floater(cmds, &mut fx.meshes, &mut fx.mats, Glyph::Letter(l), at + PVec2::new(0.0, 50.0), 110.0, 0.9, pcol);
        }
    }
}

fn shape_glyph(s: KidsShape) -> Glyph {
    match s {
        KidsShape::Star => Glyph::Star,
        KidsShape::Square => Glyph::Square,
        KidsShape::Triangle => Glyph::Triangle,
    }
}

fn pointers(
    touches: Res<Touches>,
    mouse: Res<ButtonInput<MouseButton>>,
    windows: Query<&Window, With<PrimaryWindow>>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut game: ResMut<Game>,
    mut kids: ResMut<Kids>,
    mut fx: LessonFx,
) {
    let Ok((camera, cam_tf)) = cam.single() else { return };
    let window = windows.single().ok();
    let width = window.map_or(1.0, |w| w.width());
    let mut evs: Vec<(u64, Vec2, Phase)> = Vec::new();
    let demo = std::mem::take(&mut kids.injected);
    for t in touches.iter_just_pressed() {
        evs.push((t.id(), t.position(), Phase::Down));
    }
    for t in touches.iter() {
        if !touches.just_pressed(t.id()) {
            evs.push((t.id(), t.position(), Phase::Move));
        }
    }
    for t in touches.iter_just_released().chain(touches.iter_just_canceled()) {
        evs.push((t.id(), t.position(), Phase::Up));
    }
    if let Some(p) = window.and_then(|w| w.cursor_position()) {
        if mouse.just_pressed(MouseButton::Left) {
            evs.push((MOUSE, p, Phase::Down));
        } else if mouse.pressed(MouseButton::Left) {
            evs.push((MOUSE, p, Phase::Move));
        }
    }
    if mouse.just_released(MouseButton::Left) {
        evs.push((MOUSE, window.and_then(|w| w.cursor_position()).unwrap_or_default(), Phase::Up));
    }

    let sim = &mut game.sim;
    let world_evs = evs
        .into_iter()
        .filter_map(|(id, screen, phase)| camera.viewport_to_world_2d(cam_tf, screen).ok().map(|w| (id, PVec2::new(w.x, w.y), phase)))
        .chain(demo);
    // The camera is static and centred on the box, so "left of the screen
    // centre" is "left of the box centre".
    let mid = (level::VIEW_MIN.x + level::VIEW_MAX.x) * 0.5;
    let _ = width;
    for (id, p, phase) in world_evs {
        let side = if p.x < mid { -1.0 } else { 1.0 };
        match phase {
            Phase::Down => {
                // 1. Chrome.
                if let Some(hit) = sim.world.pick(p, bb_sim::load::layer::UI) {
                    if let Some(item) = kids.ui.iter().find(|u| u.body == hit).cloned() {
                        ui::poke(sim, hit, p);
                        tap_ui(sim, &mut kids, &mut fx, item.kind, id);
                    }
                    continue;
                }
                // 2. A blob: inside its outline, or near its centroid.
                if kids.grab.is_none() {
                    if let Some((slot, body)) = hit_blob(sim, p) {
                        start_grab(sim, &mut kids, &mut fx, slot, body, p, id);
                        continue;
                    }
                }
                // 3. Empty space: roll left / right.
                if kids.side.is_none() {
                    kids.side = Some((id, side));
                }
            }
            Phase::Move => {
                if let Some(g) = kids.grab.as_mut().filter(|g| g.pointer == id) {
                    g.target = p;
                }
                if let Some(s) = kids.side.as_mut().filter(|s| s.0 == id) {
                    s.1 = side;
                }
            }
            Phase::Up => {
                if kids.grab.as_ref().is_some_and(|g| g.pointer == id) {
                    release_grab(sim, &mut kids);
                }
                if kids.side.is_some_and(|s| s.0 == id) {
                    kids.side = None;
                }
                if kids.puff == Some(id) {
                    kids.puff = None;
                }
                if kids.home.is_some_and(|h| h.0 == id) {
                    kids.home = None;
                }
            }
        }
    }
}

fn hit_blob(sim: &Sim, p: PVec2) -> Option<(u8, BodyId)> {
    let mask = bb_sim::load::layer::PLAYER;
    if let Some(b) = sim.world.pick(p, mask) {
        if let Some(pl) = sim.players.iter().find(|pl| pl.ctl.body == b) {
            return Some((pl.slot, b));
        }
    }
    sim.players
        .iter()
        .filter_map(|pl| sim.world.body(pl.ctl.body).map(|b| (pl.slot, pl.ctl.body, b.centroid().distance(p))))
        .filter(|h| h.2 < TAP_HIT_R)
        .min_by(|a, b| a.2.total_cmp(&b.2))
        .map(|h| (h.0, h.1))
}

fn tap_ui(sim: &mut Sim, kids: &mut Kids, fx: &mut LessonFx, kind: UiKind, pointer: u64) {
    match kind {
        UiKind::Chip(c) => {
            kids.color = c;
            if let Some(p) = sim.player_mut(0) {
                p.color = c;
            }
            prefs::save(kids.mode.key(), c);
            // The chip always sings its colour.
            if let Some(v) = fx.voice.as_mut() {
                v.color(&mut fx.commands, c, &fx.settings);
            }
            kids.badge = if kids.mode == LearnMode::Color { (Glyph::Dot, hex(c)) } else { kids.badge };
            if let Some(b) = sim.player(0).and_then(|p| sim.world.body(p.ctl.body)) {
                let at = b.centroid();
                fx.particles.sparkle(at, hex(c), 16);
                fx.particles.puff(at, hex(fx::PAPER), 6);
            }
        }
        UiKind::Mode(m) => {
            if m != LearnMode::Shape {
                morph_player(sim, kids, None);
            }
            kids.mode = m;
            prefs::save(m.key(), kids.color);
            fx.sfx.write(PlaySfx::new("ui-click", 0.7, 1.0));
        }
        UiKind::Puff => kids.puff = Some(pointer),
        UiKind::Home => kids.home = Some((pointer, 0.0)),
        UiKind::Badge => {
            fx.sfx.write(PlaySfx::new("ui-hover", 0.4, 1.2));
        }
    }
}

fn start_grab(sim: &mut Sim, kids: &mut Kids, fx: &mut LessonFx, slot: u8, body: BodyId, p: PVec2, pointer: u64) {
    let Some(particle) = sim.world.nearest_particle(body, p) else { return };
    let at = sim.world.body(body).map_or(p, |b| b.centroid());
    kids.grab = Some(Grab { slot, body, particle: particle as usize, target: p, last: p, pv: PVec2::ZERO, pointer });
    let color = sim.player(slot).map_or(kids.color, |pl| pl.color);
    let shape = kids.friends.iter().find(|f| f.slot == slot).map(|f| f.shape);
    fire_lesson(sim, kids, fx, LessonOpts { shape, color: Some(color), at: Some(at) });
}

fn release_grab(sim: &mut Sim, kids: &mut Kids) {
    let Some(g) = kids.grab.take() else { return };
    if let Some(b) = sim.world.body_mut(g.body) {
        let fling = g.pv.clamp(PVec2::splat(-FLING_CAP), PVec2::splat(FLING_CAP));
        let v = b.velocity();
        b.add_velocity(fling - v);
    }
    if let Some(f) = kids.friends.iter_mut().find(|f| f.slot == g.slot) {
        f.puff = 0.45;
    }
}

// -------------------------------------------------------------------- drive

/// Per frame: grab servo, friend AI, input merge, lesson on the group-puff
/// rising edge, the hold-to-exit timer.
fn drive(
    time: Res<Time>,
    mut game: ResMut<Game>,
    mut kids: ResMut<Kids>,
    mut inputs: ResMut<Inputs>,
    mut next: ResMut<NextState<AppState>>,
    mut fx: LessonFx,
) {
    let dt = time.delta_secs().max(1.0 / 240.0);
    let kids = &mut *kids;
    let sim = &mut game.sim;

    if let Some(h) = kids.home.as_mut() {
        h.1 += dt;
        if h.1 >= HOLD_SECS {
            kids.home = None;
            next.set(AppState::Title);
        }
    }

    // Grab: velocity servo toward the finger, never a teleport.
    if let Some(g) = kids.grab.as_mut() {
        g.pv = g.pv * 0.55 + (g.target - g.last) / dt * 0.45;
        g.last = g.target;
        if let Some(b) = sim.world.body_mut(g.body) {
            let servo = ((g.target - b.x[g.particle]) * FOLLOW_RATE).clamp_length_max(MAX_PULL_SPEED);
            let v = b.velocity();
            b.add_velocity(servo - v);
            b.v[g.particle] = servo;
        }
    }
    let held = kids.grab.as_ref().map(|g| g.slot);

    // Group puff (Space / PUFF) → everyone expands; rising edge teaches.
    let group = inputs.slots[0].button || kids.puff.is_some();
    if group && !kids.was_group {
        fire_lesson(sim, kids, &mut fx, LessonOpts::default());
    }
    kids.was_group = group;

    // Player input: keyboard + side-tap; held = puffed and still.
    let side = kids.side.map_or(0.0, |s| s.1);
    let i0 = &mut inputs.slots[0];
    i0.stick.x = (i0.stick.x + side).clamp(-1.0, 1.0);
    i0.button = group;
    if held == Some(0) {
        *i0 = Input { stick: PVec2::ZERO, button: true };
    }
    if i0.button || side != 0.0 {
        inputs.active[0] = true;
    }
    if let Some(p) = sim.player_mut(0) {
        p.ctl.expand_scale = if held == Some(0) { PICK_SCALE_PEAK } else { bb_sim::control::tune::EXPAND_SCALE };
    }

    // Friends wander and puff on their own (legacy timings).
    for k in 0..kids.friends.len() {
        let (r1, r2) = (kids.rand(), kids.rand());
        let f = &mut kids.friends[k];
        let mut input = Input::default();
        let scale;
        if held == Some(f.slot) {
            f.puff = PICK_PUFF_SEC;
            input.button = true;
            scale = PICK_SCALE_PEAK;
        } else {
            f.wander_t -= dt;
            if f.wander_t <= 0.0 {
                f.wander_dir = -f.wander_dir;
                f.wander_t = 1.4 + r1 * 2.2;
            }
            if f.self_hold > 0.0 {
                f.self_hold -= dt;
            } else {
                f.self_t -= dt;
                if f.self_t <= 0.0 {
                    f.self_hold = 0.48;
                    f.self_t = 2.0 + r2 * 2.8;
                    f.puff = f.puff.max(0.55);
                }
            }
            let puffing = f.puff > 0.0;
            scale = if puffing { 1.0 + 0.55 * (f.puff / PICK_PUFF_SEC * 1.2).min(1.0) } else { bb_sim::control::tune::EXPAND_SCALE };
            f.puff = (f.puff - dt).max(0.0);
            input.stick.x = f.wander_dir * 0.55;
            input.button = group || f.self_hold > 0.0 || puffing;
        }
        inputs.slots[f.slot as usize] = input;
        inputs.active[f.slot as usize] = false;
        if let Some(p) = sim.player_mut(f.slot) {
            p.ctl.expand_scale = scale;
        }
    }
}

// ------------------------------------------------------------------ camera

/// Static full-view framing: always fit `VIEW_MIN..VIEW_MAX` on screen.
fn fit_camera(
    windows: Query<&Window, With<PrimaryWindow>>,
    mut director: ResMut<CameraDirector>,
    mut cam: Query<&mut Projection, With<MainCamera>>,
) {
    let Ok(w) = windows.single() else { return };
    let aspect = (w.width() / w.height().max(1.0)).max(0.1);
    let (vw, vh) = (crate::camera::VIEW_W, crate::camera::VIEW_H);
    let (sw, sh) = if aspect > vw / vh { (vh * aspect, vh) } else { (vw, vw / aspect) };
    let size = level::VIEW_MAX - level::VIEW_MIN;
    let zoom = (size.x / sw).max(size.y / sh);
    let c = (level::VIEW_MIN + level::VIEW_MAX) * 0.5;
    director.target = Some(Vec2::new(c.x, c.y));
    director.zoom = Some(zoom);
    director.ease = 0.0;
    if let Ok(mut p) = cam.single_mut() {
        if let Projection::Orthographic(o) = p.as_mut() {
            o.scaling_mode = ScalingMode::AutoMin { min_width: vw, min_height: vh };
            o.scale = zoom;
        }
    }
}

// --------------------------------------------------------- portrait / blur

#[derive(Component)]
struct PortraitGate;

fn spawn_portrait_gate(commands: &mut Commands) {
    let paper = hex(fx::PAPER);
    let ink = hex(fx::INK);
    commands
        .spawn((
            Node {
                position_type: PositionType::Absolute,
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                ..default()
            },
            BackgroundColor(Color::srgba(0.06, 0.09, 0.16, 0.92)),
            Visibility::Hidden,
            GlobalZIndex(200),
            PortraitGate,
            KidsEntity,
        ))
        .with_children(|p| {
            p.spawn((
                Node {
                    flex_direction: FlexDirection::Column,
                    align_items: AlignItems::Center,
                    padding: UiRect::all(Val::Px(24.0)),
                    border: UiRect::all(Val::Px(4.0)),
                    max_width: Val::Px(360.0),
                    row_gap: Val::Px(10.0),
                    ..default()
                },
                BackgroundColor(paper),
                BorderColor::all(ink),
                UiTransform::from_rotation(Rot2::degrees(-1.2)),
            ))
            .with_children(|c| {
                c.spawn((Text::new("Turn your iPad"), TextFont { font_size: FontSize::Px(26.0), weight: FontWeight::BOLD, ..default() }, TextColor(ink)));
                c.spawn((
                    Text::new("Kids Mode plays in landscape - rotate sideways to bounce!"),
                    TextFont { font_size: FontSize::Px(16.0), ..default() },
                    TextColor(ink),
                    TextLayout::justify(Justify::Center),
                ));
            });
        });
}

fn portrait_gate(windows: Query<&Window, With<PrimaryWindow>>, mut q: Query<&mut Visibility, With<PortraitGate>>) {
    let Ok(w) = windows.single() else { return };
    let portrait = w.height() > w.width();
    for mut v in q.iter_mut() {
        let want = if portrait { Visibility::Visible } else { Visibility::Hidden };
        if *v != want {
            *v = want;
        }
    }
}

/// Silence the voice when the app goes to the background.
fn stop_voice_on_blur(mut commands: Commands, mut focus: MessageReader<bevy::window::WindowFocused>, mut voice: ResMut<KidsVoice>) {
    if focus.read().any(|f| !f.focused) {
        voice.stop(&mut commands);
    }
}

// ------------------------------------------------------------------- demo

/// `BB_KIDS_DEMO=1`: scripted taps for screenshots. At 1.0 s pick up friend
/// 2 and lift it; at 1.6 s press PUFF (everyone puffs + a lesson); hold.
fn demo(time: Res<Time>, game: Res<Game>, mut kids: ResMut<Kids>, mut t0: Local<Option<f32>>, mut step: Local<u8>) {
    if std::env::var("BB_KIDS_DEMO").is_err() {
        return;
    }
    let now = time.elapsed_secs();
    let t = now - *t0.get_or_insert(now);
    let centroid = |slot: u8| game.sim.player(slot).and_then(|p| game.sim.world.body(p.ctl.body)).map(|b| b.centroid());
    if *step == 0 && t > 1.0 {
        if let Some(c) = centroid(2) {
            kids.injected.push((1, c, Phase::Down));
            kids.injected.push((1, c, Phase::Move));
        }
        *step = 1;
    }
    if *step >= 1 {
        if let Some(g) = &kids.grab {
            let target = g.target + PVec2::new(70.0, 160.0) * time.delta_secs();
            kids.injected.push((1, target.min(PVec2::new(900.0, 560.0)), Phase::Move));
        }
    }
    if *step == 1 && t > 1.6 {
        let puff = kids.ui.iter().find(|u| u.kind == UiKind::Puff).map(|u| u.center);
        if let Some(c) = puff {
            kids.injected.push((2, c, Phase::Down));
        }
        *step = 2;
    }
}
