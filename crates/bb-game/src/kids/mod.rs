//! Kids Mode: a pure playground for toddlers (legacy `KidsMode.tsx`).
//!
//! * One player blob plus 8 shape friends (star / square / triangle) who
//!   wander and puff on their own. Friends are sim *players* (slots 1–8)
//!   driven by this module, so they get palette colours and faces.
//! * Tap or drag any blob to pick it up: its whole body glides to the
//!   finger (a critically damped servo on the centre, every sim step, kept
//!   inside the room), puffed while held, gently tossed on release. It says
//!   its colour (or shape / letter / note, depending on the learn mode).
//! * Tap empty space left / right of centre to roll that way.
//! * PUFF (or Space) puffs everyone and fires the learn-mode lesson:
//!   ABC → next letter, Music → next Twinkle note, Shape → morph into the
//!   next shape, Color → say the colour.
//! * Colour chips on the floor tray recolour the player and sing the colour.
//! * Nothing pops. A tap on HOME (or Escape / B / Select) goes back to the
//!   title.

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
use crate::sim::{Game, Inputs, InstallGame};
use fx::{Glyph, Particles};
use lessons::{KidsVoice, LearnMode};
use level::{KIDS_SHAPES, KidsShape};
use ui::{UiItem, UiKind};

/// Grab hit radius from a blob's centroid (legacy 110 × 2/3).
pub const TAP_HIT_R: f32 = 74.0;
pub const PICK_PUFF_SEC: f32 = 0.95;
/// Drag: the held friend's centre closes this fraction of the gap to the
/// finger per second...
pub const FOLLOW_RATE: f32 = 14.0;
/// ...its velocity settles onto that this fast (4× = critically damped: it
/// arrives without overshooting or ringing)...
pub const GRIP_RATE: f32 = 4.0 * FOLLOW_RATE;
/// ...never faster than this (≈2 px per physics substep, so it can't
/// tunnel through anything).
pub const MAX_PULL_SPEED: f32 = 1500.0;
/// Internal damping while held: the friend wobbles a little, never jiggles.
pub const HELD_DAMPING: f32 = 10.0;
/// The finger holds a friend this close to its centre at most.
pub const GRIP_OFFSET: f32 = bb_sim::control::tune::RADIUS * 0.5;
/// Top speed of the toss on release (toddler-friendly).
pub const TOSS_CAP: f32 = 900.0;
pub const PICK_SCALE_PEAK: f32 = 1.55;
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

/// A friend held by a finger. The whole body is steered (never one rim
/// point, which spun it round the finger and tore it on walls).
#[derive(Clone, Debug)]
pub struct Grab {
    pub slot: u8,
    pub body: BodyId,
    /// Where the finger holds it, from its centre (at most [`GRIP_OFFSET`]).
    pub offset: PVec2,
    /// The finger (world).
    pub target: PVec2,
    pub pointer: u64,
    /// The body's own internal damping, restored on release.
    pub damping: f32,
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
    /// The pointer pressing HOME (it leaves when that pointer lifts).
    pub home: Option<u64>,
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
    fn new(mode: LearnMode, color: u32, friends: Vec<Friend>, ui: Vec<UiItem>) -> Kids {
        Kids {
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
        }
    }

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
            .add_systems(FixedUpdate, hold_friend.before(crate::sim::step).run_if(running.clone()))
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
    spawn_portrait_gate(&mut commands);
    hand_over(&mut commands, sim);
    commands.insert_resource(Kids::new(mode, color, friends, ui));
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

/// Starts Kids Mode's world through the sim's loader, not straight in: the
/// menu's OnExit has just asked to unload the title's world, and that unload
/// (next frame) took a Game inserted here with it, leaving Kids Mode with no
/// sim at all (no friends, chips or frame; HOME dead). The old world goes
/// now so nothing runs Kids Mode against it in the meantime.
fn hand_over(commands: &mut Commands, sim: Sim) {
    commands.remove_resource::<Game>();
    commands.insert_resource(InstallGame(Some(Game::new_with(sim))));
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
    commands.remove_resource::<InstallGame>();
    commands.remove_resource::<Game>();
    devices.touch_slot = Some(0);
    for s in 1..=8 {
        remote.0[s] = false;
    }
    *director = CameraDirector::default();
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
    mut next: ResMut<NextState<AppState>>,
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
                if lift(sim, &mut kids, id) {
                    next.set(AppState::Title);
                }
            }
        }
    }
}

/// Pointer `id` lifted: drop what it held. True when it was pressing HOME
/// (a plain click or tap goes home; no hold needed).
fn lift(sim: &mut Sim, kids: &mut Kids, id: u64) -> bool {
    if kids.grab.as_ref().is_some_and(|g| g.pointer == id) {
        release_grab(sim, kids);
    }
    if kids.side.is_some_and(|s| s.0 == id) {
        kids.side = None;
    }
    if kids.puff == Some(id) {
        kids.puff = None;
    }
    if kids.home == Some(id) {
        kids.home = None;
        return true;
    }
    false
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
        UiKind::Home => {
            kids.home = Some(pointer);
            fx.sfx.write(PlaySfx::new("ui-click", 0.7, 1.0));
        }
        UiKind::Badge => {
            fx.sfx.write(PlaySfx::new("ui-hover", 0.4, 1.2));
        }
    }
}

fn start_grab(sim: &mut Sim, kids: &mut Kids, fx: &mut LessonFx, slot: u8, body: BodyId, p: PVec2, pointer: u64) {
    let Some(g) = grab(sim, slot, body, p, pointer) else { return };
    let at = p - g.offset;
    kids.grab = Some(g);
    let color = sim.player(slot).map_or(kids.color, |pl| pl.color);
    let shape = kids.friends.iter().find(|f| f.slot == slot).map(|f| f.shape);
    fire_lesson(sim, kids, fx, LessonOpts { shape, color: Some(color), at: Some(at) });
}

/// Take hold of `body` with a finger at `p`.
pub fn grab(sim: &Sim, slot: u8, body: BodyId, p: PVec2, pointer: u64) -> Option<Grab> {
    let b = sim.world.body(body)?;
    let offset = (p - b.centroid()).clamp_length_max(GRIP_OFFSET);
    Some(Grab { slot, body, offset, target: p, pointer, damping: b.params.internal_damping })
}

/// One sim step of holding: steer the whole friend so its centre glides to
/// the finger (critically damped, speed-capped), weightless and calm, and
/// never toward a spot where any of it would be inside the room's walls,
/// floor or ceiling. Runs right before every sim step, so it holds the same
/// at any frame rate.
pub fn hold(sim: &mut Sim, g: &Grab, dt: f32) {
    let gravity = sim.world.config.gravity;
    let Some(b) = sim.world.body_mut(g.body) else { return };
    let c = b.centroid();
    let (mut lo, mut hi) = (PVec2::ZERO, PVec2::ZERO);
    for p in b.outline() {
        lo = lo.min(p - c);
        hi = hi.max(p - c);
    }
    let pad = PVec2::splat(b.params.radius + 2.0);
    let min = level::ROOM_MIN - lo + pad;
    let max = (level::ROOM_MAX - hi - pad).max(min);
    let want = (g.target - g.offset).clamp(min, max);
    let servo = ((want - c) * FOLLOW_RATE).clamp_length_max(MAX_PULL_SPEED);
    let v = b.velocity();
    b.add_velocity((servo - v) * (1.0 - (-GRIP_RATE * dt).exp()));
    b.add_accel(-gravity * b.params.gravity_scale);
    b.params.internal_damping = HELD_DAMPING;
}

/// Let go: the friend keeps the speed it was carried at (capped at
/// [`TOSS_CAP`]), without spin, and goes back to being soft.
pub fn let_go(sim: &mut Sim, g: &Grab) {
    if let Some(b) = sim.world.body_mut(g.body) {
        b.params.internal_damping = g.damping;
        let v = b.velocity();
        b.add_velocity(v.clamp_length_max(TOSS_CAP) - v);
        let w = b.angular_velocity();
        b.add_spin(-w);
    }
}

fn hold_friend(mut game: ResMut<Game>, kids: Res<Kids>) {
    if game.paused {
        return;
    }
    if let Some(g) = &kids.grab {
        hold(&mut game.sim, g, bb_sim::DT);
    }
}

fn release_grab(sim: &mut Sim, kids: &mut Kids) {
    let Some(g) = kids.grab.take() else { return };
    let_go(sim, &g);
    if let Some(f) = kids.friends.iter_mut().find(|f| f.slot == g.slot) {
        f.puff = 0.45;
    }
}

// -------------------------------------------------------------------- drive

/// Per frame: friend AI, input merge, lesson on the group-puff rising edge,
/// and the keyboard / controller way home. (The held friend is steered in
/// [`hold_friend`], every sim step.)
#[allow(clippy::too_many_arguments)]
fn drive(
    time: Res<Time>,
    mut game: ResMut<Game>,
    mut kids: ResMut<Kids>,
    mut inputs: ResMut<Inputs>,
    mut next: ResMut<NextState<AppState>>,
    mut fx: LessonFx,
    keys: Res<ButtonInput<KeyCode>>,
    pads: Query<&Gamepad>,
) {
    let dt = time.delta_secs().max(1.0 / 240.0);
    let kids = &mut *kids;
    let sim = &mut game.sim;

    if keys.any_just_pressed([KeyCode::Escape, KeyCode::Backspace]) || pads.iter().any(|p| p.any_just_pressed([GamepadButton::East, GamepadButton::Select])) {
        next.set(AppState::Title);
        return;
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
        p.ctl.expand_scale = (held == Some(0)).then_some(PICK_SCALE_PEAK);
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
            scale = Some(PICK_SCALE_PEAK);
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
            scale = puffing.then(|| 1.0 + 0.55 * (f.puff / PICK_PUFF_SEC * 1.2).min(1.0));
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
///
/// Sized from what the camera actually draws into (its viewport), not the
/// window: an offscreen target has no window, and without a fit the camera
/// fell back to following the wandering friends (the room drifted, the
/// cards and PUFF went off the edges). Every frame it also takes back the
/// whole director, so nothing another screen left behind (a cutscene's
/// keep box or letterbox, a shake) can move the room.
fn fit_camera(
    windows: Query<&Window, With<PrimaryWindow>>,
    mut director: ResMut<CameraDirector>,
    mut cam: Query<(&Camera, &mut Projection), With<MainCamera>>,
) {
    let Ok((camera, mut proj)) = cam.single_mut() else { return };
    let window = windows.single().ok().map(|w| Vec2::new(w.width(), w.height()));
    let Some(aspect) = view_aspect(camera.logical_viewport_size(), window) else { return };
    let (centre, zoom) = fit_view(aspect);
    *director = CameraDirector { target: Some(centre), zoom: Some(zoom), ..default() };
    if let Projection::Orthographic(o) = proj.as_mut() {
        o.scaling_mode = ScalingMode::AutoMin { min_width: crate::camera::VIEW_W, min_height: crate::camera::VIEW_H };
        o.scale = zoom;
    }
}

/// Width / height of the view: the camera's own viewport when it has been
/// laid out, else the window's.
fn view_aspect(viewport: Option<Vec2>, window: Option<Vec2>) -> Option<f32> {
    let s = viewport.filter(|s| s.x >= 1.0 && s.y >= 1.0).or(window.filter(|s| s.x >= 1.0 && s.y >= 1.0))?;
    Some((s.x / s.y).max(0.1))
}

/// Camera centre and zoom that fit the room (`VIEW_MIN..VIEW_MAX`) exactly
/// on one axis, centred, at this aspect (`ScalingMode::AutoMin` view).
fn fit_view(aspect: f32) -> (Vec2, f32) {
    let (vw, vh) = (crate::camera::VIEW_W, crate::camera::VIEW_H);
    let (sw, sh) = if aspect > vw / vh { (vh * aspect, vh) } else { (vw, vw / aspect) };
    let size = level::VIEW_MAX - level::VIEW_MIN;
    let zoom = (size.x / sw).max(size.y / sh);
    let c = (level::VIEW_MIN + level::VIEW_MAX) * 0.5;
    (Vec2::new(c.x, c.y), zoom)
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use bevy::state::app::StatesPlugin;
    use bevy::time::TimeUpdateStrategy;

    use super::*;
    use crate::sim::{LoadLevel, SimPlugin, UnloadLevel};

    /// Frames on which `Game` appeared / went away.
    #[derive(Resource, Default)]
    struct Edges {
        frame: u32,
        added: Vec<u32>,
        removed: Vec<u32>,
    }

    fn edges(mut e: ResMut<Edges>, game: Option<Res<Game>>, mut had: Local<bool>) {
        e.frame += 1;
        let f = e.frame;
        let added = game.as_ref().is_some_and(|g| g.is_added());
        if *had && (game.is_none() || added) {
            e.removed.push(f);
        }
        if added {
            e.added.push(f);
        }
        *had = game.is_some();
    }

    /// Title → Kids from the menu: the title's OnExit unloads its world in
    /// the same transition Kids Mode starts its own. Kids Mode's world must
    /// survive that unload (it used to vanish a frame later: no friends, no
    /// chips, no frame, HOME dead), and the old world's teardown and the new
    /// one's arrival land on different frames.
    /// The room fits the view exactly (one axis edge to edge, the other
    /// inside), centred, at every shape of screen: and with no window at all
    /// (offscreen shots) the camera's own viewport still drives the fit.
    #[test]
    fn camera_fits_the_room_at_any_aspect_and_without_a_window() {
        let (vw, vh) = (crate::camera::VIEW_W, crate::camera::VIEW_H);
        let room = level::VIEW_MAX - level::VIEW_MIN;
        let mid = (level::VIEW_MIN + level::VIEW_MAX) * 0.5;
        for aspect in [16.0 / 9.0, 2000.0 / 1364.0, 4.0 / 3.0, 21.0 / 9.0, 1.0] {
            let (c, zoom) = fit_view(aspect);
            assert_eq!(c, Vec2::new(mid.x, mid.y));
            // What AutoMin shows at this aspect and zoom.
            let (sw, sh) = if aspect > vw / vh { (vh * aspect, vh) } else { (vw, vw / aspect) };
            let seen = Vec2::new(sw, sh) * zoom;
            assert!(seen.x >= room.x - 0.01 && seen.y >= room.y - 0.01, "{aspect}: room cut off ({seen} < {room:?})");
            assert!((seen.x - room.x).abs() < 0.01 || (seen.y - room.y).abs() < 0.01, "{aspect}: room not fitted ({seen})");
        }
        assert_eq!(view_aspect(Some(Vec2::new(2000.0, 1364.0)), None), Some(2000.0 / 1364.0));
        assert_eq!(view_aspect(Some(Vec2::new(2000.0, 1000.0)), Some(Vec2::new(1600.0, 900.0))), Some(2.0));
        assert_eq!(view_aspect(None, Some(Vec2::new(1600.0, 900.0))), Some(1600.0 / 900.0));
        assert_eq!(view_aspect(Some(Vec2::ZERO), None), None);
    }

    /// A friend standing in the playground, ready to be picked up (puffed
    /// while held, as in the game).
    fn friend_world() -> (Sim, BodyId, f32) {
        let mut sim = Sim::new(level::playground());
        sim.rules.players_pop = false;
        let (pos, shape) = level::friends()[2];
        let body = sim.add_player(3, "", 0xffffff).ctl.body;
        sim.world.body_mut(body).unwrap().set_rest_shape(&shape.outline());
        sim.world.respawn(body, pos);
        for _ in 0..40 {
            sim.step();
        }
        let area = sim.world.body(body).unwrap().area();
        (sim, body, area)
    }

    /// One held step, as the game runs it: the friend puffs, the servo
    /// steers, the sim steps.
    fn held_step(sim: &mut Sim, g: &Grab) {
        sim.set_input(g.slot, Input { stick: PVec2::ZERO, button: true });
        sim.player_mut(g.slot).unwrap().ctl.expand_scale = Some(PICK_SCALE_PEAK);
        hold(sim, g, bb_sim::DT);
        sim.step();
    }

    /// Not inverted, not torn, not exploding.
    fn assert_sturdy(sim: &Sim, body: BodyId, rest_area: f32, when: &str) {
        let b = sim.world.body(body).unwrap();
        assert!(b.x.iter().chain(&b.v).all(|p| p.is_finite()), "{when}: non-finite");
        let a = b.area();
        assert!(a > rest_area * 0.5 && a < rest_area * PICK_SCALE_PEAK * PICK_SCALE_PEAK * 1.5, "{when}: area {a} (rest {rest_area})");
        let c = b.centroid();
        let reach = b.outline().map(|p| p.distance(c)).fold(0.0, f32::max);
        assert!(reach < 3.0 * 56.0 * (2.0 / 3.0) * PICK_SCALE_PEAK, "{when}: torn (reach {reach})");
        assert!(b.velocity().length() < MAX_PULL_SPEED * 1.15, "{when}: speed {}", b.velocity().length());
    }

    #[test]
    fn dragged_friend_follows_firmly_without_inverting_or_jitter() {
        let (mut sim, body, rest) = friend_world();
        let c0 = sim.world.body(body).unwrap().centroid();
        let mut g = grab(&sim, 3, body, c0 + PVec2::new(40.0, 10.0), 1).unwrap();
        assert!(g.offset.length() <= GRIP_OFFSET + 1e-3);
        // Wild toddler scribbles: fast zig-zags all over the room.
        for k in 0..240 {
            let t = k as f32 * bb_sim::DT;
            g.target = PVec2::new(600.0 + (t * 9.0).sin() * 520.0, 380.0 + (t * 13.0).cos() * 280.0);
            held_step(&mut sim, &g);
            assert_sturdy(&sim, body, rest, &format!("scribble step {k}"));
        }
        // Then hold still (in open air, under the top platform): it settles
        // on the finger and stays put.
        g.target = PVec2::new(600.0, 280.0);
        let mut trail = Vec::new();
        for k in 0..90 {
            held_step(&mut sim, &g);
            assert_sturdy(&sim, body, rest, &format!("settle step {k}"));
            trail.push(sim.world.body(body).unwrap().centroid());
        }
        let c = *trail.last().unwrap();
        assert!(c.distance(g.target - g.offset) < 12.0, "didn't reach the finger: {c}");
        for w in trail[60..].windows(2) {
            assert!(w[0].distance(w[1]) < 0.75, "jitters while held still: {} -> {}", w[0], w[1]);
        }
    }

    #[test]
    fn dragging_into_walls_floor_or_ceiling_keeps_the_friend_in_the_room() {
        for (name, finger) in [("right wall", PVec2::new(5000.0, 300.0)), ("left wall", PVec2::new(-4000.0, 250.0)), ("floor", PVec2::new(600.0, -3000.0)), ("ceiling", PVec2::new(450.0, 4000.0))] {
            let (mut sim, body, rest) = friend_world();
            let c0 = sim.world.body(body).unwrap().centroid();
            let mut g = grab(&sim, 3, body, c0, 1).unwrap();
            for k in 0..150 {
                // The finger gets there fast, then keeps pushing.
                g.target = c0.lerp(finger, (k as f32 / 20.0).min(1.0));
                held_step(&mut sim, &g);
                assert_sturdy(&sim, body, rest, &format!("{name} step {k}"));
                let b = sim.world.body(body).unwrap();
                for p in b.outline() {
                    // The floor's skin may dent a little; the rock never.
                    assert!(
                        p.x > level::ROOM_MIN.x - 1.0 && p.x < level::ROOM_MAX.x + 1.0 && p.y > level::ROOM_MIN.y - 20.0 && p.y < level::ROOM_MAX.y + 1.0,
                        "{name} step {k}: {p} pushed into the rock"
                    );
                }
            }
        }
    }

    #[test]
    fn letting_go_tosses_gently() {
        let (mut sim, body, _) = friend_world();
        let c0 = sim.world.body(body).unwrap().centroid();
        let mut g = grab(&sim, 3, body, c0, 1).unwrap();
        let damping = g.damping;
        // Carry it to the left, then a hard flick: the finger tears across
        // the room at 6000 px/s.
        g.target = PVec2::new(200.0, 300.0);
        for _ in 0..90 {
            held_step(&mut sim, &g);
        }
        for k in 0..12 {
            g.target = PVec2::new(200.0 + k as f32 * 100.0, 300.0);
            held_step(&mut sim, &g);
        }
        let_go(&mut sim, &g);
        let b = sim.world.body(body).unwrap();
        assert!(b.velocity().length() <= TOSS_CAP + 1.0, "toss {}", b.velocity().length());
        assert!(b.velocity().x > 300.0, "no toss at all: {}", b.velocity());
        assert!(b.angular_velocity().abs() < 0.5, "spun: {}", b.angular_velocity());
        assert_eq!(b.params.internal_damping, damping);
    }

    #[test]
    fn a_plain_tap_on_home_goes_home() {
        let mut sim = Sim::new(level::playground());
        let ui = ui::spawn_items(&mut sim, &lessons::chip_colors());
        let mut kids = Kids::new(LearnMode::Alphabet, 0xff5d73, Vec::new(), ui);
        let home = kids.ui.iter().find(|u| u.kind == UiKind::Home).unwrap();
        // The HOME card is what a press on it hits.
        assert_eq!(sim.world.pick(home.center, bb_sim::load::layer::UI), Some(home.body));
        kids.home = Some(7);
        assert!(!lift(&mut sim, &mut kids, 8), "another finger lifting isn't a tap on HOME");
        assert!(lift(&mut sim, &mut kids, 7));
        assert_eq!(kids.home, None);
        assert!(!lift(&mut sim, &mut kids, 7));
    }

    #[test]
    fn kids_world_survives_the_title_unloading() {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, StatesPlugin, SimPlugin));
        app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)));
        app.init_state::<AppState>().init_resource::<Edges>();
        app.add_systems(Last, edges);
        // The title runs a world of its own and unloads it on exit (menu.rs).
        app.add_systems(OnEnter(AppState::Title), |mut load: MessageWriter<LoadLevel>| {
            load.write(LoadLevel { level: crate::sandbox::sandbox_level(), players: vec![(0, "Pip".into(), 0xff5d73)] });
        });
        app.add_systems(OnExit(AppState::Title), |mut unload: MessageWriter<UnloadLevel>| {
            unload.write(UnloadLevel);
        });
        app.add_systems(OnEnter(AppState::Kids), |mut commands: Commands| hand_over(&mut commands, Sim::new(level::playground())));

        app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::Title);
        for _ in 0..5 {
            app.update();
        }
        let title_id = app.world().resource::<Game>().sim.level.id.clone();
        assert_ne!(title_id, level::playground().id);

        app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::Kids);
        for _ in 0..30 {
            app.update();
        }
        let game = app.world().get_resource::<Game>().expect("Kids Mode lost its world");
        assert_eq!(game.sim.level.id, level::playground().id);
        assert!(app.world().get_resource::<InstallGame>().is_none());
        let e = app.world().resource::<Edges>();
        assert_eq!(e.added.len(), 2, "{:?}", e.added);
        assert_eq!(e.removed.len(), 1, "{:?}", e.removed);
        assert!(e.added.iter().all(|f| !e.removed.contains(f)), "removed and added in one frame: {:?} / {:?}", e.removed, e.added);
    }
}
