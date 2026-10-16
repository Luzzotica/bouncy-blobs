//! The title screen and menus — made of softbodies.
//!
//! Every letter of the logo and every button is a jelly body in the same
//! physics world as your blob: tap a button and it squishes, roll into it
//! and it wobbles, jump on the logo and it jiggles. Every letter of every
//! label is its own glyph riding the jelly's deformation (see
//! [`crate::softtext`]), and the whole page falls in from above on entry.

use bb_level::{LevelBuilder, NpcRole, Theme, v};
use bb_physics::{BodyDesc, BodyId, Vec2 as PVec2};
use bb_sim::BodyTag;
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::audio::{Groove, MusicBeat};
use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::palette::{darken, hex, lighten};
use crate::render::{Style, StyleOverrides, z};
use crate::dropin::{DropIn, DropStyle};
use crate::sim::{Game, Inputs, LoadLevel, UnloadLevel};
use crate::ownership::{BuyRequest, Feature, Ownership, RestoreRequest, WishlistRequest};
use crate::softtext::{Ride, SoftText};
use crate::story::{CHAPTERS, StoryProgress};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Main,
    Play,
    Chapters,
    Party,
    Settings,
    /// "Get the full game": why it's locked, Buy, (iOS) Restore, Back.
    Unlock(Lock),
}

/// What a locked tile needs the full game for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    Host,
    Sandbox,
    Kids,
    /// The Story tile on the Play page (the chapter it would start).
    Story(u8),
    /// A tile on the Chapters page.
    Chapter(u8),
}

impl Lock {
    /// The friendly line on the unlock page.
    pub fn reason(self) -> String {
        match self {
            Lock::Host => "Own it to host. Friends can always join you.".into(),
            Lock::Sandbox => "Sandbox comes with the full game.".into(),
            Lock::Kids => "Kids Mode comes with the full game.".into(),
            Lock::Story(c) | Lock::Chapter(c) => format!("Chapter {c} and the rest of Pip's story come with the full game."),
        }
    }

    /// The page the locked tile was on.
    pub fn back(self) -> Page {
        match self {
            Lock::Host | Lock::Sandbox => Page::Party,
            Lock::Kids | Lock::Story(_) => Page::Play,
            Lock::Chapter(_) => Page::Chapters,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Continue,
    Chapter(u8),
    Goto(Page),
    Kids,
    Sandbox,
    PartyHost,
    JoinFriend,
    Color,
    ToggleFullscreen,
    ToggleStreamer,
    Quit,
    /// A tile that needs the full game: opens its unlock page.
    Locked(Lock),
    Buy,
    Restore,
    /// The demo's "Wishlist Now": the game's Steam page.
    Wishlist,
}

/// Lock `action` if this player can't do it yet (the demo gate).
pub fn gate(action: Action, own: &Ownership, progress: &StoryProgress) -> Action {
    let need = match &action {
        Action::Continue => Some((Feature::Chapter(progress.current), Lock::Story(progress.current))),
        Action::Chapter(c) => Some((Feature::Chapter(*c), Lock::Chapter(*c))),
        Action::Kids => Some((Feature::Kids, Lock::Kids)),
        Action::PartyHost => Some((Feature::Host, Lock::Host)),
        Action::Sandbox => Some((Feature::Sandbox, Lock::Sandbox)),
        _ => None,
    };
    match need {
        Some((f, l)) if !own.allows(f) => Action::Locked(l),
        _ => action,
    }
}

/// The muted colour of a locked tile.
fn muted(c: u32) -> u32 {
    let (g, k) = (0x8a8199u32, 0.6f32);
    let ch = |x: u32, s: u32| ((((x >> s) & 0xff) as f32) * (1.0 - k) + (((g >> s) & 0xff) as f32) * k) as u32;
    (ch(c, 16) << 16) | (ch(c, 8) << 8) | ch(c, 0)
}

/// The small line under a page's tiles (only where something is locked;
/// never a popup).
pub fn page_hint(page: Page, own: &Ownership) -> Option<String> {
    match page {
        Page::Party if !own.allows(Feature::Host) => Some(crate::menu::Lock::Host.reason()),
        Page::Chapters if !own.full() => Some(match own.scope.story_chapters.max(1) {
            1 => format!("Chapter 1 is free. Own it for all {CHAPTERS}."),
            2 => format!("Chapters 1 and 2 are free. Own it for all {CHAPTERS}."),
            n => format!("Chapters 1 to {n} are free. Own it for all {CHAPTERS}."),
        }),
        Page::Unlock(l) => Some(l.reason()),
        _ => None,
    }
}

/// A padlock riding a locked tile.
#[derive(Component)]
struct LockBadge {
    body: BodyId,
    offset: Vec2,
    anchor: Option<bb_physics::RestAnchor>,
}

/// A page's hint line.
#[derive(Component)]
struct MenuHint;

/// The unlock page's purchase status line.
#[derive(Component)]
struct MenuStatus;

/// A jelly button.
#[derive(Clone, Debug)]
pub struct Button {
    pub body: BodyId,
    pub action: Action,
    pub color: u32,
}

#[derive(Resource)]
pub struct Menu {
    pub page: Page,
    pub buttons: Vec<Button>,
    pub letters: Vec<BodyId>,
    pub focus: usize,
    /// Action fired after the squish animation.
    pub pending: Option<(Action, f32)>,
    pub nav_cooldown: f32,
    pub prev_button: bool,
    /// The page's fall-in choreography.
    pub drop: DropIn,
    /// Tiles from the previous page, falling out of view: (body, seconds left).
    pub falling: Vec<(BodyId, f32)>,
}

/// Text that rides on a softbody (one [`SoftText`] glyph per letter).
#[derive(Component)]
pub struct BodyLabel {
    pub body: BodyId,
    pub size: f32,
}

#[derive(Component)]
struct MenuEntity;

pub struct MenuPlugin;

impl Plugin for MenuPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::Title), enter)
            .add_systems(OnExit(AppState::Title), exit)
            .add_systems(
                Update,
                (build_page, interact, menu_blobs, place_badges, buy_status).chain().run_if(in_state(AppState::Title).and_then(title_world)),
            )
            .add_systems(Update, boot.run_if(in_state(AppState::Boot)));
    }
}

/// The title's own world is loaded (not the level we're coming back from).
fn title_world(game: Option<Res<Game>>) -> bool {
    game.is_some_and(|g| g.sim.level.id == TITLE_ID)
}

/// Leave Boot for the title (unless a dev env var already chose a state).
fn boot(mut next: ResMut<NextState<AppState>>, mut frames: Local<u32>) {
    *frames += 1;
    if *frames > 1 {
        next.set(AppState::Title);
    }
}

/// Level id of the title screen's world.
pub const TITLE_ID: &str = "title";

/// The v2 home screen: an open cave where soft blobs are launched up from
/// below, arc across the screen bumping into the logo, the buttons and each
/// other, and fall back out the bottom to be launched again.
pub fn title_level() -> bb_level::Level {
    let mut b = LevelBuilder::new(TITLE_ID, "Title", Theme::Hollow);
    b.spawn(v(0.0, -2000.0))
        .kill_y(-8000.0)
        .decor("glowworm", v(-300.0, 760.0), 1.4, -1.0)
        .decor("glowworm", v(500.0, 820.0), 1.0, -1.0);
    for i in 0..MENU_BLOBS {
        b.npc(&format!("m{i}"), v(-600.0 + i as f32 * 240.0, -600.0), NpcRole::Huddle, "", BLOB_R);
    }
    b.build()
}

/// Collision layer for the previous page's tiles while they fall away.
const FALLING_LAYER: u32 = 1 << 9;
/// Collision layer for the new page's tiles while they drop in: they bump
/// the old page's tiles and the launched blobs, never each other.
const INCOMING_LAYER: u32 = 1 << 10;

/// The menu blob playground (v2 `menuBlobs.ts`).
const MENU_BLOBS: usize = 6;
const BLOB_R: f32 = 36.0;
const BLOB_COLORS: [u32; 8] = [0x4ac8c8, 0xff6b7d, 0x5a9cff, 0xffd54a, 0xff7bd5, 0x8fe36b, 0xb98cff, 0xff9d4a];
/// Visible world area at the menu camera (centre 0,380; zoom 1).
const VIEW_BOTTOM: f32 = 380.0 - crate::camera::VIEW_H * 0.5;
const VIEW_HALF_W: f32 = crate::camera::VIEW_W * 0.5;

#[derive(Default)]
pub struct Launcher {
    seed: u32,
    /// Blob being dragged by the pointer.
    held: Option<BodyId>,
    started: bool,
    /// Seconds each blob has been sitting still (on a button or letter).
    resting: std::collections::HashMap<BodyId, f32>,
    /// Where each blob was a moment ago (catches one wedged between
    /// buttons, which jitters too much to count as resting).
    anchor: std::collections::HashMap<BodyId, (PVec2, f32)>,
}

impl Launcher {
    fn rand(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (self.seed >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Launch velocity: up to an apex 55–90% of the screen height.
    fn launch_vel(&mut self, g: f32) -> PVec2 {
        let apex = crate::camera::VIEW_H * (0.55 + self.rand() * 0.35);
        PVec2::new((self.rand() * 2.0 - 1.0) * 260.0, (2.0 * g * apex).sqrt())
    }

    /// New random colour (the first blob is always you, in Pip's colour).
    fn recolor(&mut self, overrides: &mut StyleOverrides, body: BodyId, pip: Option<u32>) {
        let c = hex(pip.unwrap_or(BLOB_COLORS[(self.rand() * BLOB_COLORS.len() as f32) as usize % BLOB_COLORS.len()]));
        overrides.0.insert(body, Style { fill: c, rim: darken(c, 0.35), rim_w: 4.5, highlight: true, z: z::PLAYER, top_rim_only: false });
    }
}

/// Launch, recycle and drag the menu blobs.
#[allow(clippy::too_many_arguments)]
fn menu_blobs(
    mut game: ResMut<Game>,
    mut st: Local<Launcher>,
    mut overrides: ResMut<StyleOverrides>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    windows: Query<&Window>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    (menu, time, progress): (Res<Menu>, Res<Time>, Res<StoryProgress>),
) {
    let g = game.sim.tuning.gravity.gravity;
    let ids: Vec<BodyId> = game.sim.npcs.iter().map(|n| n.ctl.body).collect();
    if game.is_added() || !st.started {
        st.started = true;
        st.held = None;
        if st.seed == 0 {
            st.seed = 0x9e37_79b9;
        }
        for n in game.sim.npcs.iter_mut() {
            n.scripted = true;
        }
        // Seed the screen mid-flight so it's lively from the first frame.
        for &id in &ids {
            let at = PVec2::new((st.rand() * 2.0 - 1.0) * (VIEW_HALF_W - 120.0), VIEW_BOTTOM + 120.0 + st.rand() * 500.0);
            let vel = st.launch_vel(g) * 0.6;
            game.sim.world.respawn(id, at);
            if let Some(b) = game.sim.world.body_mut(id) {
                b.params.limits.poppable = false;
                b.add_velocity(vel);
            }
            st.recolor(&mut overrides, id, (Some(&id) == ids.first()).then_some(progress.pip_color));
        }
    }

    // Pointer: grab a blob (not a button) and fling it.
    let pointer = (|| {
        let (camera, tf) = cam.single().ok()?;
        let w = windows.iter().next()?;
        let screen = touches.iter().next().map(|t| t.position()).or_else(|| w.cursor_position())?;
        camera.viewport_to_world_2d(tf, screen).ok()
    })();
    let down = mouse.pressed(MouseButton::Left) || touches.iter().next().is_some();
    let just = mouse.just_pressed(MouseButton::Left) || touches.iter_just_pressed().next().is_some();
    if !down {
        st.held = None;
    } else if just && menu.pending.is_none() {
        if let Some(p) = pointer {
            let p = PVec2::new(p.x, p.y);
            st.held = ids.iter().copied().find(|&id| game.sim.world.body(id).is_some_and(|b| b.centroid().distance(p) < BLOB_R * 1.6));
        }
    }
    if let (Some(id), Some(p)) = (st.held, pointer) {
        if let Some(b) = game.sim.world.body_mut(id) {
            // Velocity servo toward the pointer (bounded, so it's stable);
            // letting go keeps the speed: a throw.
            let mut want = (PVec2::new(p.x, p.y) - b.centroid()) * 14.0;
            if want.length() > 2800.0 {
                want = want.normalize() * 2800.0;
            }
            let v = b.velocity();
            b.add_velocity(want - v);
        }
    }

    // A blob that lands on a button or letter sits a moment, then hops off.
    let dt = time.delta_secs();
    for &id in &ids {
        if st.held == Some(id) {
            continue;
        }
        let slow = game.sim.world.body(id).is_some_and(|b| b.velocity().length() < 90.0);
        let t = st.resting.entry(id).or_insert(0.0);
        *t = if slow { *t + dt } else { 0.0 };
        if *t > 0.8 {
            *t = 0.0;
            let side = if st.rand() < 0.5 { -1.0 } else { 1.0 };
            let up = 700.0 + st.rand() * 500.0;
            if let Some(b) = game.sim.world.body_mut(id) {
                b.add_velocity(PVec2::new(side * (150.0 + st.rand() * 250.0), up));
            }
        }
    }

    // Recycle anything that left the screen (or got wedged somewhere).
    for &id in &ids {
        if st.held == Some(id) {
            continue;
        }
        let Some(c) = game.sim.world.body(id).map(|b| b.centroid()) else { continue };
        let wedged = {
            let a = st.anchor.entry(id).or_insert((c, 0.0));
            if a.0.distance(c) > 60.0 {
                *a = (c, 0.0);
                false
            } else {
                a.1 += dt;
                a.1 > 1.6
            }
        };
        if wedged {
            st.anchor.remove(&id);
        }
        if wedged || c.y < VIEW_BOTTOM - 200.0 || c.x.abs() > VIEW_HALF_W + 260.0 || c.y > 2600.0 {
            let x = (st.rand() * 2.0 - 1.0) * (VIEW_HALF_W - 80.0);
            let vel = st.launch_vel(g);
            game.sim.world.respawn(id, PVec2::new(x, VIEW_BOTTOM - BLOB_R - 30.0));
            if let Some(b) = game.sim.world.body_mut(id) {
                b.add_velocity(vel);
            }
            st.recolor(&mut overrides, id, (Some(&id) == ids.first()).then_some(progress.pip_color));
        }
    }
}

fn enter(mut load: MessageWriter<LoadLevel>, mut cam: ResMut<CameraDirector>, mut commands: Commands) {
    load.write(LoadLevel { level: title_level(), players: vec![] });
    cam.target = Some(Vec2::new(0.0, 380.0));
    cam.zoom = Some(1.0);
    cam.ease = 0.0;
    commands.insert_resource(Menu {
        page: Page::Main,
        buttons: Vec::new(),
        letters: Vec::new(),
        focus: 0,
        pending: None,
        nav_cooldown: 0.0,
        prev_button: true,
        drop: DropIn::new(DropStyle::MENU),
        falling: Vec::new(),
    });
}

fn exit(mut commands: Commands, labels: Query<Entity, With<MenuEntity>>, mut cam: ResMut<CameraDirector>, mut unload: MessageWriter<UnloadLevel>, mut overrides: ResMut<StyleOverrides>) {
    commands.remove_resource::<Menu>();
    for e in labels.iter() {
        commands.entity(e).despawn();
    }
    *cam = CameraDirector::default();
    overrides.0.clear();
    unload.write(UnloadLevel);
}

fn rounded_rect(center: PVec2, size: PVec2, r: f32) -> Vec<PVec2> {
    let h = size * 0.5;
    let r = r.min(h.x).min(h.y);
    let mut pts = Vec::new();
    for (c, a0) in [(PVec2::new(h.x - r, -h.y + r), -90.0f32), (PVec2::new(h.x - r, h.y - r), 0.0), (PVec2::new(-h.x + r, h.y - r), 90.0), (PVec2::new(-h.x + r, -h.y + r), 180.0)] {
        for k in 0..=4 {
            let a = (a0 + k as f32 * 22.5).to_radians();
            pts.push(center + c + PVec2::new(a.cos(), a.sin()) * r);
        }
    }
    pts
}

/// The shape of every jelly tile and button: a soft pill (wide tiles) or a
/// rounded square, weightless and unpoppable. Shared with the pause menu so
/// its buttons are the very same jelly.
pub fn tile_desc(center: PVec2, size: PVec2) -> BodyDesc {
    // Wide tiles use a uniform grid: ear-clipping a long outline makes sliver
    // triangles whose area constraints fight each other and shear the body.
    let mut d = if size.x > size.y * 1.6 {
        let cols = (size.x / 22.0).ceil() as usize;
        let rows = (size.y / 22.0).ceil().max(2.0) as usize;
        let mut d = BodyDesc::grid(center - size * 0.5, center + size * 0.5, cols, rows, size.x * size.y / 2500.0);
        // Chamfer the corners so it still reads as a soft pill.
        let (nx, ny) = (cols + 1, rows + 1);
        // Keep the corner inside its cell's diagonal: pulled any further,
        // the outline notches in while the cell's triangles still cover the
        // corner, and the fill pokes out past the rim.
        let cell = (size.x / cols as f32).min(size.y / rows as f32);
        let cut = (size.y * 0.16).min(cell * 0.45);
        for (ix, iy, dx, dy) in [(0, 0, 1.0, 1.0), (nx - 1, 0, -1.0, 1.0), (0, ny - 1, 1.0, -1.0), (nx - 1, ny - 1, -1.0, -1.0)] {
            d.positions[iy * nx + ix] += PVec2::new(dx, dy) * cut;
        }
        d
    } else {
        let outline = rounded_rect(center, size, size.y.min(size.x) * 0.3);
        BodyDesc::mesh_from_outline(&outline, 18.0, size.x * size.y / 2500.0)
    };
    d.params.shape_compliance = Some(2e-4);
    d.params.edge_compliance = 2e-5;
    d.params.tri_compliance = 2e-5;
    d.params.internal_damping = 2.5;
    d.params.gravity_scale = 0.0;
    d.params.limits.poppable = false;
    d
}

/// Button size and label size on the menus (the pause menu matches).
pub const BUTTON_H: f32 = 76.0;
pub const BUTTON_FONT: f32 = 36.0;

/// Home-spring compliance for logo letters and buttons. Soft enough that a
/// tile can be pushed or dragged well away from its spot and wobble back
/// (a spring, not an anchor); stiffer values snap them home in a frame.
pub const LETTER_SPRING: f32 = 2.5e-4;
pub const BUTTON_SPRING: f32 = 7e-4;

/// A jelly slab with a label. Tethered to where it was put, so it wobbles
/// but never wanders off.
pub fn jelly_tile(game: &mut Game, center: PVec2, size: PVec2, tag: BodyTag, wobble: f32) -> BodyId {
    let mut d = tile_desc(center, size);
    d.layer = crate::load_layer::UI;
    let id = game.sim.add_body(d, tag);
    if let Some(b) = game.sim.world.body_mut(id) {
        b.anchor_home(wobble);
        // Hover swell and click puff scale the tether too.
        b.home_scales = true;
    }
    id
}

fn label(commands: &mut Commands, assets: &GameAssets, body: BodyId, text: &str, size: f32, color: Color) {
    label_with(commands, assets, body, text, size, color, MenuEntity);
}

/// A label riding on a jelly body, tagged with `marker` for cleanup. Each
/// letter is its own glyph mapped through the jelly's deformation.
pub fn label_with<M: Component>(commands: &mut Commands, _assets: &GameAssets, body: BodyId, text: &str, size: f32, color: Color, marker: M) -> Entity {
    commands
        .spawn((
            SoftText::new(text, size).ride(Ride::Game(body)).color(color).z(z::FX - 0.5).stagger(0.025),
            BodyLabel { body, size },
            marker,
        ))
        .id()
}

/// Jiggle the glyphs of whatever label rides `body`.
pub fn kick_label(labels: &mut Query<&mut SoftText>, body: BodyId, strength: f32) {
    for mut t in labels.iter_mut() {
        if t.body() == Some(body) {
            t.kick(strength);
        }
    }
}

fn page_buttons(page: Page, progress: &StoryProgress, own: &Ownership) -> Vec<(String, Action, u32)> {
    let mut v = page_tiles(page, progress, own);
    for t in v.iter_mut() {
        t.1 = gate(t.1.clone(), own, progress);
        if matches!(t.1, Action::Locked(_)) {
            t.2 = muted(t.2);
        }
    }
    v
}

fn page_tiles(page: Page, progress: &StoryProgress, own: &Ownership) -> Vec<(String, Action, u32)> {
    match page {
        Page::Main => {
            let mut v = vec![("Play".into(), Action::Goto(Page::Play), 0xff8fab)];
            // The demo invites a wishlist (the Steam page) right on the title.
            if !own.full() {
                v.push(("Wishlist Now".into(), Action::Wishlist, WISHLIST_COLOR));
            }
            v.push(("Settings".into(), Action::Goto(Page::Settings), 0xb8a1ff));
            #[cfg(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")))]
            v.push(("Quit".into(), Action::Quit, 0xff5d73));
            v
        }
        Page::Play => {
            let story = if progress.unlocked > 1 { format!("Story  ·  Ch {}", progress.current) } else { "Story".into() };
            let mut v = vec![(story, Action::Continue, 0xff8fab)];
            if progress.unlocked > 1 {
                v.push(("Chapters".into(), Action::Goto(Page::Chapters), 0xffc75f));
            }
            v.push(("Kids Mode".into(), Action::Kids, 0x5dd6ff));
            v.push(("Multiplayer".into(), Action::Goto(Page::Party), 0x6bcb77));
            v.push(("Back".into(), Action::Goto(Page::Main), 0xd0c4e8));
            v
        }
        Page::Chapters => {
            // The demo also shows the chapters that come with the full game
            // (locked); free chapters not reached yet stay hidden.
            let mut v: Vec<(String, Action, u32)> = (1..=CHAPTERS)
                .filter(|c| *c <= progress.unlocked || !own.allows(Feature::Chapter(*c)))
                .map(|c| (format!("{c}"), Action::Chapter(c), crate::palette_cycle(c as usize)))
                .collect();
            v.push(("Back".into(), Action::Goto(Page::Play), 0xd0c4e8));
            v
        }
        Page::Party => vec![
            ("Host with Phones".into(), Action::PartyHost, 0x6bcb77),
            ("Join a Friend".into(), Action::JoinFriend, 0x5dd6ff),
            ("Sandbox".into(), Action::Sandbox, 0xff9f43),
            ("Back".into(), Action::Goto(Page::Play), 0xd0c4e8),
        ],
        Page::Settings => vec![
            ("Blob Color".into(), Action::Color, progress.pip_color),
            ("Fullscreen".into(), Action::ToggleFullscreen, 0x5dd6ff),
            (streamer_label(), Action::ToggleStreamer, 0xffc75f),
            ("Back".into(), Action::Goto(Page::Main), 0xd0c4e8),
        ],
        Page::Unlock(l) => {
            let mut v = vec![("Get the Full Game".into(), Action::Buy, 0xffc75f)];
            if crate::ownership::NATIVE_STORE {
                v.push(("Restore Purchases".into(), Action::Restore, 0x5dd6ff));
            }
            v.push(("Back".into(), Action::Goto(l.back()), 0xd0c4e8));
            v
        }
    }
}

/// The "Wishlist Now" tile: Steam's blue.
pub const WISHLIST_COLOR: u32 = 0x66c0f4;

/// Streamer mode hides room codes and QR codes (net/ui.rs).
fn streamer_label() -> String {
    format!("Streamer Mode  ·  {}", if crate::net::ui::streamer() { "On" } else { "Off" })
}

pub fn button_style(color: u32, focused: bool) -> Style {
    let c = hex(color);
    let fill = if focused { lighten(c, 0.25) } else { c };
    Style { fill, rim: if focused { Color::WHITE } else { darken(c, 0.4) }, rim_w: if focused { 7.0 } else { 5.0 }, highlight: false, z: z::PROP + 1.0, top_rim_only: false }
}

#[allow(clippy::too_many_arguments)]
fn build_page(
    mut commands: Commands,
    mut menu: ResMut<Menu>,
    mut game: ResMut<Game>,
    assets: Res<GameAssets>,
    progress: Res<StoryProgress>,
    labels: Query<(Entity, &BodyLabel), With<MenuEntity>>,
    mut overrides: ResMut<StyleOverrides>,
    mut built: Local<Option<(Page, (bool, crate::ownership::DemoScope))>>,
    (own, mut meshes, mut mats, hints, mut badge_mesh): (Res<Ownership>, ResMut<Assets<Mesh>>, ResMut<Assets<ColorMaterial>>, Query<Entity, With<MenuHint>>, Local<Option<BadgeMeshes>>),
) {
    // Coming back from a level, the old level's Game is still around for a
    // frame or two: never build the menu into it.
    if game.sim.level.id != TITLE_ID {
        return;
    }
    // Rebuild when the page changes, a new title world was loaded, or the
    // gates moved (buying lifts the locks live).
    let key = (menu.page, (own.full(), own.scope));
    let fresh = game.is_added();
    if !fresh && *built == Some(key) {
        return;
    }
    *built = Some(key);
    if fresh {
        // Body ids from another world mean nothing here (and could alias
        // this world's new tiles): forget them rather than tumbling them.
        menu.falling.clear();
        menu.buttons.clear();
        menu.letters.clear();
    }
    // The old page doesn't vanish: its tiles let go and tumble out of view
    // (labels riding along) while the new page drops in.
    let m = &mut *menu;
    let leaving: Vec<BodyId> = m.buttons.drain(..).map(|b| b.body).chain(m.letters.drain(..)).collect();
    for (k, id) in leaving.into_iter().enumerate() {
        if let Some(b) = game.sim.world.body_mut(id) {
            b.home = None;
            b.params.gravity_scale = 1.6;
            // Still jelly as they fall: they pile into and bounce off each
            // other (and the launched blobs), but pass through the new page.
            b.layer = FALLING_LAYER;
            b.mask = FALLING_LAYER | INCOMING_LAYER | crate::load_layer::NPC;
            let side = if k % 2 == 0 { 1.0 } else { -1.0 };
            b.add_velocity(PVec2::new(side * (60.0 + (k * 37 % 90) as f32), 180.0 + (k * 53 % 140) as f32));
            b.add_spin(side * (1.0 + (k % 3) as f32 * 0.6));
        }
        menu.falling.push((id, 1.6));
    }
    let keep: Vec<BodyId> = menu.falling.iter().map(|f| f.0).collect();
    for (e, l) in labels.iter() {
        if !keep.contains(&l.body) {
            commands.entity(e).despawn();
        }
    }
    overrides.0.retain(|id, _| keep.contains(id) || game.sim.npcs.iter().any(|n| n.ctl.body == *id));
    for e in hints.iter() {
        commands.entity(e).despawn();
    }
    menu.drop.clear();
    // The first page rains in fast; a new page drops in slower, so it
    // arrives above the old one tumbling out — bumping it (and the blobs)
    // on the way down.
    let style = if fresh { DropStyle::MENU } else { DropStyle::MENU_PAGE };
    menu.drop.style = style.colliding(INCOMING_LAYER, FALLING_LAYER | crate::load_layer::NPC);

    // Logo: soft letter tiles.
    let logo: &[(&str, u32)] = &[("B", 0xff5d73), ("O", 0xff9f43), ("U", 0xffd93d), ("N", 0x6bcb77), ("C", 0x4d96ff), ("Y", 0x9b5de5)];
    let logo2: &[(&str, u32)] = &[("B", 0xf15bb5), ("L", 0x00c2a8), ("O", 0x5dd6ff), ("B", 0xa0e426), ("S", 0xff7eb6)];
    // v2 layout: logo top-left with a slight tilt, buttons down the left.
    let left = -VIEW_HALF_W + 48.0;
    let (title_y, scale) = if menu.page == Page::Main { (735.0, 0.82) } else { (760.0, 0.55) };
    for (row, (letters, y)) in [(logo, title_y), (logo2, title_y - 100.0 * scale)].iter().enumerate() {
        for (i, (ch, col)) in letters.iter().enumerate() {
            let x = left + 46.0 * scale + i as f32 * 98.0 * scale + row as f32 * 26.0 * scale;
            // Tilted up to the right (v2's -2° title), plus a hand-placed wobble.
            let tilt = ((i * 7 + row * 3) % 5) as f32 - 2.0;
            let rise = i as f32 * 4.0 * scale;
            let id = jelly_tile(&mut game, PVec2::new(x, *y + rise + tilt * 3.0), PVec2::splat(88.0 * scale), BodyTag::Ui, LETTER_SPRING);
            overrides.0.insert(id, Style { fill: hex(*col), rim: darken(hex(*col), 0.4), rim_w: 5.0, highlight: true, z: z::PROP + 0.5, top_rim_only: false });
            label(&mut commands, &assets, id, ch, 60.0 * scale, Color::WHITE);
            menu.letters.push(id);
        }
    }

    // Buttons.
    let items = page_buttons(menu.page, &progress, &own);
    let badge = badge_mesh.get_or_insert_with(|| BadgeMeshes::new(&mut meshes, &mut mats)).clone();
    let grid = menu.page == Page::Chapters;
    let top = if menu.page == Page::Main { 470.0 } else { 560.0 };
    for (i, (text, action, color)) in items.into_iter().enumerate() {
        let (center, size) = if grid && !matches!(action, Action::Goto(_)) {
            let (col, row) = (i % 5, i / 5);
            (PVec2::new(left + 60.0 + col as f32 * 140.0, top - row as f32 * 130.0), PVec2::new(116.0, 106.0))
        } else if grid {
            (PVec2::new(left + 150.0, top - 2.0 * 130.0 - 20.0), PVec2::new(300.0, 76.0))
        } else {
            let w = 400.0;
            (PVec2::new(left + w * 0.5, top - i as f32 * 100.0), PVec2::new(w, BUTTON_H))
        };
        let id = jelly_tile(&mut game, center, size, BodyTag::Ui, BUTTON_SPRING);
        overrides.0.insert(id, button_style(color, i == 0));
        let font = if grid && size.x < 200.0 { 54.0 } else { BUTTON_FONT };
        if matches!(action, Action::Locked(_)) {
            // A padlock rides the tile; the label makes room for it.
            let small = size.x < 200.0;
            let (text_at, lock_at, scale) = if small {
                (Vec2::new(-12.0, 8.0), Vec2::new(size.x * 0.5 - 30.0, -size.y * 0.5 + 30.0), 0.85)
            } else {
                (Vec2::new(-18.0, 0.0), Vec2::new(size.x * 0.5 - 36.0, 2.0), 1.0)
            };
            commands.spawn((
                SoftText::new(text.clone(), font).ride(Ride::Game(id)).at(text_at).color(Color::WHITE).z(z::FX - 0.5).stagger(0.025),
                BodyLabel { body: id, size: font },
                MenuEntity,
            ));
            spawn_badge(&mut commands, &badge, id, lock_at, scale);
        } else {
            label(&mut commands, &assets, id, &text, font, Color::WHITE);
        }
        menu.buttons.push(Button { body: id, action, color });
    }
    // The page's hint line (and the unlock page's status line).
    if let Some(hint) = page_hint(menu.page, &own) {
        let unlock = matches!(menu.page, Page::Unlock(_));
        let rows = menu.buttons.len() as f32;
        let (at, size, wrap) = if unlock {
            (Vec2::new(260.0, 520.0), 40.0, 640.0)
        } else if grid {
            (Vec2::new(left + 330.0, top - 2.0 * 130.0 - 110.0), 28.0, 640.0)
        } else {
            // Wrapped to the tile column so it never runs off the left edge.
            (Vec2::new(left + 200.0, top - rows * 100.0 + 4.0), 28.0, 400.0)
        };
        commands.spawn((SoftText::new(hint, size).at(at).wrap(wrap).color(Color::srgb(1.0, 0.93, 0.75)).z(z::FX - 0.5).stagger(0.012), MenuHint, MenuEntity));
        if unlock {
            commands.spawn((
                SoftText::new(own.buy.line(own.owned), 30.0).at(Vec2::new(260.0, 400.0)).wrap(760.0).color(Color::WHITE).z(z::FX - 0.5).stagger(0.012),
                MenuStatus,
                MenuHint,
                MenuEntity,
            ));
        }
    }
    // Everything rains in from the bottom up — bottom button first, the
    // logo's top row last, left to right — so nothing ever falls through
    // something that has already landed.
    let n = menu.buttons.len();
    let step = if grid { 0.025 } else { 0.045 };
    let mut t = 0.0;
    for k in 0..n {
        let id = menu.buttons[n - 1 - k].body;
        menu.drop.add(&mut game.sim.world, id, t);
        t += step;
    }
    let row1 = logo.len();
    let order: Vec<BodyId> = menu.letters[row1..].iter().chain(&menu.letters[..row1]).copied().collect();
    for id in order {
        menu.drop.add(&mut game.sim.world, id, t);
        t += 0.03;
    }
    menu.focus = 0;
}

#[allow(clippy::too_many_arguments)]
fn interact(
    mut menu: ResMut<Menu>,
    mut game: ResMut<Game>,
    time: Res<Time>,
    (mouse, touches): (Res<ButtonInput<MouseButton>>, Res<Touches>),
    keys: Res<ButtonInput<KeyCode>>,
    inputs: Res<Inputs>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut overrides: ResMut<StyleOverrides>,
    mut progress: ResMut<StoryProgress>,
    mut next: ResMut<NextState<AppState>>,
    mut exit: MessageWriter<AppExit>,
    mut windows_mut: Query<&mut Window>,
    mut load: MessageWriter<LoadLevel>,
    join: Option<Res<crate::online::JoinDialog>>,
    mut commands: Commands,
    (mut labels, label_bodies, beat, mut pointer, own, mut buys, mut restores, mut wishes): (
        Query<&mut SoftText>,
        Query<(Entity, &BodyLabel)>,
        Res<MusicBeat>,
        ResMut<crate::menu_feel::MenuPointer>,
        Res<Ownership>,
        MessageWriter<BuyRequest>,
        MessageWriter<RestoreRequest>,
        MessageWriter<WishlistRequest>,
    ),
) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    // Remove the previous page's tiles once they've fallen away.
    {
        let mut gone = Vec::new();
        menu.falling.retain_mut(|(id, t)| {
            *t -= dt;
            if *t <= 0.0 {
                gone.push(*id);
                false
            } else {
                true
            }
        });
        for id in gone {
            game.sim.remove_body(id);
            overrides.0.remove(&id);
            for (e, l) in label_bodies.iter() {
                if l.body == id {
                    commands.entity(e).despawn();
                }
            }
        }
    }
    {
        let m = &mut *menu;
        m.drop.update(&mut game.sim.world, dt);
        // The logo dances to the music: each letter bobs inside its jelly
        // tile on its own beat (the tiles themselves stay put).
        if m.drop.done() {
            for (i, &id) in m.letters.iter().enumerate() {
                let groove = Groove::of(i);
                if !beat.crossed(groove) {
                    continue;
                }
                let big = groove == Groove::Downbeat;
                kick_label(&mut labels, id, if big { 0.9 } else { 0.55 });
            }
        }
    }
    if join.is_some() {
        return;
    }
    // Bought: the unlock page steps back to where the lock was, unlocked.
    if let Page::Unlock(l) = menu.page {
        if own.full() && menu.pending.is_none() {
            menu.page = l.back();
            return;
        }
    }
    // Fire a pending action once the squish has played.
    if let Some((action, t)) = menu.pending.as_mut() {
        *t -= dt;
        if *t <= 0.0 {
            // Gate again at the moment it fires (ownership can change).
            let action = gate(action.clone(), &own, &progress);
            menu.pending = None;
            match action {
                Action::Continue => next.set(AppState::Story),
                Action::Chapter(c) => {
                    progress.current = c;
                    next.set(AppState::Story);
                }
                Action::Goto(p) => menu.page = p,
                Action::Kids => next.set(AppState::Kids),
                Action::Sandbox => {
                    load.write(LoadLevel { level: crate::sandbox::sandbox_level(), players: vec![(0, "Pip".into(), progress.pip_color)] });
                    next.set(AppState::Playing);
                }
                Action::PartyHost => next.set(AppState::Party),
                Action::JoinFriend => commands.insert_resource(crate::online::JoinDialog::default()),
                Action::Color => {
                    let i = bb_sim::PALETTE.iter().position(|c| *c == progress.pip_color).unwrap_or(0);
                    progress.pip_color = bb_sim::PALETTE[(i + 1) % bb_sim::PALETTE.len()];
                    if let Some(p) = game.sim.player_mut(0) {
                        p.color = progress.pip_color;
                    }
                    let focus = menu.focus;
                    if let Some((i, b)) = menu.buttons.iter_mut().enumerate().find(|(_, b)| b.action == Action::Color) {
                        // The button itself shows the colour you picked...
                        b.color = progress.pip_color;
                        overrides.0.insert(b.body, button_style(b.color, i == focus));
                    }
                    // ...and so does the first launched blob (that's you).
                    if let Some(id) = game.sim.npcs.first().map(|n| n.ctl.body) {
                        let c = hex(progress.pip_color);
                        overrides.0.insert(id, Style { fill: c, rim: darken(c, 0.35), rim_w: 4.5, highlight: true, z: z::PLAYER, top_rim_only: false });
                    }
                    if let Some(body) = game.sim.player(0).map(|p| p.ctl.body) {
                        let c = hex(progress.pip_color);
                        overrides.0.insert(body, Style { fill: c, rim: darken(c, 0.35), rim_w: 4.5, highlight: true, z: z::PLAYER, top_rim_only: false });
                    }
                }
                Action::ToggleFullscreen => {
                    for mut w in windows_mut.iter_mut() {
                        w.mode = if matches!(w.mode, bevy::window::WindowMode::Windowed) {
                            bevy::window::WindowMode::BorderlessFullscreen(bevy::window::MonitorSelection::Current)
                        } else {
                            bevy::window::WindowMode::Windowed
                        };
                    }
                }
                Action::ToggleStreamer => {
                    crate::net::ui::set_streamer(!crate::net::ui::streamer());
                    let want = streamer_label();
                    if let Some(body) = menu.buttons.iter().find(|b| b.action == Action::ToggleStreamer).map(|b| b.body) {
                        for (e, l) in label_bodies.iter() {
                            if l.body == body {
                                if let Ok(mut t) = labels.get_mut(e) {
                                    t.text = want.clone();
                                }
                            }
                        }
                    }
                }
                Action::Quit => {
                    exit.write(AppExit::Success);
                }
                Action::Locked(l) => menu.page = Page::Unlock(l),
                Action::Buy => {
                    buys.write(BuyRequest);
                }
                Action::Restore => {
                    restores.write(RestoreRequest);
                }
                Action::Wishlist => {
                    wishes.write(WishlistRequest);
                }
            }
        }
        return;
    }

    // Pointer: click or tap a jelly.
    // A click is a press + release that didn't drag the tile (menu_feel).
    let _ = (&mouse, &touches, &cam);
    let press_at: Option<Vec2> = pointer.take_click();
    let mut chosen: Option<usize> = None;
    if let Some(p) = press_at {
        let p = PVec2::new(p.x, p.y);
        if let Some(hit) = game.sim.world.pick(p, crate::load_layer::UI) {
            if let Some(i) = menu.buttons.iter().position(|b| b.body == hit) {
                chosen = Some(i);
            } else if menu.letters.contains(&hit) {
                // Poke a letter: it boings.
                if let Some(b) = game.sim.world.body_mut(hit) {
                    b.add_velocity(PVec2::new(0.0, 500.0));
                    b.add_spin(4.0);
                }
                kick_label(&mut labels, hit, 1.0);
            }
        }
    }

    // Keyboard / gamepad / phone focus navigation (any slot).
    menu.nav_cooldown = (menu.nav_cooldown - dt).max(0.0);
    let stick = inputs.slots.iter().fold(Vec2::ZERO, |a, i| a + Vec2::new(i.stick.x, i.stick.y));
    let pressed = inputs.slots.iter().any(|i| i.button) || keys.any_pressed([KeyCode::Enter, KeyCode::Space]);
    let just = pressed && !menu.prev_button;
    menu.prev_button = pressed;
    let n = menu.buttons.len();
    if n > 0 && menu.nav_cooldown <= 0.0 && (stick.y.abs() > 0.5 || stick.x.abs() > 0.5) {
        let step: i32 = if menu.page == Page::Chapters && stick.x.abs() > stick.y.abs() { stick.x.signum() as i32 } else { -stick.y.signum() as i32 };
        let old = menu.focus;
        menu.focus = ((menu.focus as i32 + step).rem_euclid(n as i32)) as usize;
        menu.nav_cooldown = 0.22;
        for (i, b) in menu.buttons.iter().enumerate() {
            if i == old || i == menu.focus {
                overrides.0.insert(b.body, button_style(b.color, i == menu.focus));
            }
        }
        if let Some(b) = menu.buttons.get(menu.focus).and_then(|b| game.sim.world.body_mut(b.body)) {
            b.add_velocity(PVec2::new(0.0, 120.0));
        }
        if let Some(b) = menu.buttons.get(menu.focus) {
            kick_label(&mut labels, b.body, 0.5);
        }
    }
    // The keyboard player also rolls around the menu; only Enter activates,
    // so jumping doesn't press buttons. Gamepads/phones use their button.
    let pad_press = inputs.slots.iter().skip(1).any(|i| i.button) && just;
    if chosen.is_none() && (keys.just_pressed(KeyCode::Enter) || pad_press) {
        chosen = Some(menu.focus);
    }
    if keys.just_pressed(KeyCode::Escape) && menu.page != Page::Main {
        menu.page = match menu.page {
            Page::Chapters | Page::Party => Page::Play,
            Page::Unlock(l) => l.back(),
            _ => Page::Main,
        };
        return;
    }

    if let Some(i) = chosen {
        let (body, action) = (menu.buttons[i].body, menu.buttons[i].action.clone());
        if let Some(b) = game.sim.world.body_mut(body) {
            // Squish: shove the top down and puff briefly.
            let c = b.centroid();
            for k in 0..b.len() {
                if b.x[k].y > c.y {
                    b.v[k].y -= 520.0;
                }
            }
            b.rest_scale = 1.08;
        }
        kick_label(&mut labels, body, 1.2);
        menu.pending = Some((action, 0.22));
    }
    // Relax any puffed button.
    for btn in &menu.buttons {
        if let Some(b) = game.sim.world.body_mut(btn.body) {
            // Hovered buttons swell a little (5%); everything relaxes back.
            let want = if pointer.hovered() == Some(btn.body) { 1.05 } else { 1.0 };
            b.rest_scale += (want - b.rest_scale) * (1.0 - (-dt * 8.0).exp());
        }
    }
}

/// The padlock's meshes (made once).
#[derive(Clone)]
struct BadgeMeshes {
    parts: Vec<(Handle<Mesh>, Handle<ColorMaterial>, Vec2, f32)>,
}

impl BadgeMeshes {
    fn new(meshes: &mut Assets<Mesh>, mats: &mut Assets<ColorMaterial>) -> BadgeMeshes {
        let gold = hex(0xffd93d);
        let rim = darken(gold, 0.55);
        let (gold, rim) = (mats.add(ColorMaterial::from(gold)), mats.add(ColorMaterial::from(rim)));
        // A shackle (ring) half hidden behind the body, each with a dark rim
        // like the jelly tiles, and a keyhole.
        let parts = vec![
            (meshes.add(Annulus::new(4.5, 13.5)), rim.clone(), Vec2::new(0.0, 8.0), 0.00),
            (meshes.add(Rectangle::new(36.0, 30.0)), rim.clone(), Vec2::new(0.0, -4.0), 0.01),
            (meshes.add(Annulus::new(7.0, 11.0)), gold.clone(), Vec2::new(0.0, 8.0), 0.02),
            (meshes.add(Rectangle::new(30.0, 24.0)), gold, Vec2::new(0.0, -4.0), 0.03),
            (meshes.add(Circle::new(3.6)), rim.clone(), Vec2::new(0.0, -1.5), 0.04),
            (meshes.add(Rectangle::new(3.0, 7.0)), rim, Vec2::new(0.0, -6.0), 0.04),
        ];
        BadgeMeshes { parts }
    }
}

fn spawn_badge(commands: &mut Commands, m: &BadgeMeshes, body: BodyId, offset: Vec2, scale: f32) {
    commands
        .spawn((LockBadge { body, offset, anchor: None }, Transform::from_scale(Vec3::splat(scale)), Visibility::Hidden, MenuEntity))
        .with_children(|p| {
            for (mesh, mat, at, dz) in &m.parts {
                p.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(mat.clone()), Transform::from_xyz(at.x, at.y, *dz)));
            }
        });
}

/// Padlocks ride their tiles (wobble, drop-in, tumble out) and go with them.
fn place_badges(mut commands: Commands, game: Res<Game>, menu: Res<Menu>, mut badges: Query<(Entity, &mut LockBadge, &mut Transform, &mut Visibility)>) {
    for (e, mut b, mut tf, mut vis) in badges.iter_mut() {
        let live = menu.buttons.iter().any(|x| x.body == b.body) || menu.falling.iter().any(|f| f.0 == b.body);
        let Some(body) = game.sim.world.body(b.body).filter(|_| live) else {
            commands.entity(e).despawn();
            continue;
        };
        let off = b.offset;
        let anchor = *b.anchor.get_or_insert_with(|| body.rest_anchor(PVec2::new(off.x, off.y)));
        let (p, f) = body.anchor_pose(&anchor);
        let (angle, _) = crate::softtext::decompose(f);
        tf.translation = Vec3::new(p.x, p.y, z::FX - 0.6);
        tf.rotation = Quat::from_rotation_z(angle);
        *vis = if body.enabled { Visibility::Inherited } else { Visibility::Hidden };
    }
}

/// Keep the unlock page's status line current.
fn buy_status(own: Res<Ownership>, mut status: Query<&mut SoftText, With<MenuStatus>>) {
    if !own.is_changed() {
        return;
    }
    let line = own.buy.line(own.owned);
    for mut t in status.iter_mut() {
        if t.text != line {
            t.text = line.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ownership::Owned;

    fn own(owned: Owned) -> Ownership {
        Ownership { owned, ..Default::default() }
    }

    const PAGES: [Page; 10] = [
        Page::Main,
        Page::Play,
        Page::Chapters,
        Page::Party,
        Page::Settings,
        Page::Unlock(Lock::Host),
        Page::Unlock(Lock::Sandbox),
        Page::Unlock(Lock::Kids),
        Page::Unlock(Lock::Story(2)),
        Page::Unlock(Lock::Chapter(10)),
    ];

    #[test]
    fn every_menu_label_has_glyphs() {
        let progress = StoryProgress { unlocked: CHAPTERS, current: 3, pip_color: 0xff5d73 };
        for o in [Owned::Full, Owned::Demo] {
            let own = own(o);
            for page in PAGES {
                for (text, _, _) in page_buttons(page, &progress, &own) {
                    assert!(crate::softtext::missing_glyphs(&text).is_empty(), "{text:?}");
                }
                for text in page_hint(page, &own).into_iter().chain([own.buy.line(o)]) {
                    assert!(crate::softtext::missing_glyphs(&text).is_empty(), "{text:?}");
                }
            }
        }
        for b in [
            crate::ownership::BuyStatus::Starting,
            crate::ownership::BuyStatus::InBrowser,
            crate::ownership::BuyStatus::InStore,
            crate::ownership::BuyStatus::Verifying,
            crate::ownership::BuyStatus::Restoring,
        ] {
            assert!(crate::softtext::missing_glyphs(&b.line(Owned::Demo)).is_empty(), "{b:?}");
        }
    }

    fn actions(page: Page, progress: &StoryProgress, o: Owned) -> Vec<Action> {
        page_buttons(page, progress, &own(o)).into_iter().map(|t| t.1).collect()
    }

    #[test]
    fn demo_locks_host_and_sandbox_but_never_join() {
        let p = StoryProgress { unlocked: 1, current: 1, pip_color: 0 };
        let demo = actions(Page::Party, &p, Owned::Demo);
        assert!(demo.contains(&Action::Locked(Lock::Host)));
        assert!(demo.contains(&Action::Locked(Lock::Sandbox)));
        assert!(demo.contains(&Action::JoinFriend));
        assert_eq!(actions(Page::Party, &p, Owned::Unknown), demo);
        let full = actions(Page::Party, &p, Owned::Full);
        assert!(full.contains(&Action::PartyHost) && full.contains(&Action::Sandbox) && full.contains(&Action::JoinFriend));
    }

    #[test]
    fn demo_story_is_two_chapters_and_kids_is_free() {
        let fresh = StoryProgress { unlocked: 1, current: 1, pip_color: 0 };
        let play = actions(Page::Play, &fresh, Owned::Demo);
        assert!(play.contains(&Action::Continue) && play.contains(&Action::Kids));
        // Chapter 1 done: chapter 2 is still free.
        let one = StoryProgress { unlocked: 2, current: 2, pip_color: 0 };
        assert!(actions(Page::Play, &one, Owned::Demo).contains(&Action::Continue));
        // Chapter 2 done: the Story tile would start chapter 3, so it's locked.
        let done = StoryProgress { unlocked: 3, current: 3, pip_color: 0 };
        let play = actions(Page::Play, &done, Owned::Demo);
        assert!(play.contains(&Action::Locked(Lock::Story(3))));
        assert!(play.contains(&Action::Goto(Page::Chapters)));
        assert!(actions(Page::Play, &done, Owned::Full).contains(&Action::Continue));
    }

    #[test]
    fn demo_chapters_page_shows_the_rest_locked() {
        let done = StoryProgress { unlocked: 3, current: 3, pip_color: 0 };
        let ch = actions(Page::Chapters, &done, Owned::Demo);
        assert_eq!(&ch[..2], &[Action::Chapter(1), Action::Chapter(2)]);
        for c in 3..=CHAPTERS {
            assert!(ch.contains(&Action::Locked(Lock::Chapter(c))), "{c}");
        }
        assert!(page_hint(Page::Chapters, &own(Owned::Demo)).is_some_and(|h| h.starts_with("Chapters 1 and 2 are free")));
        // Owners see what they've reached, all open.
        let full = actions(Page::Chapters, &done, Owned::Full);
        assert_eq!(full, vec![Action::Chapter(1), Action::Chapter(2), Action::Chapter(3), Action::Goto(Page::Play)]);
    }

    #[test]
    fn demo_title_offers_wishlist_and_owners_dont_see_it() {
        let p = StoryProgress { unlocked: 1, current: 1, pip_color: 0 };
        for o in [Owned::Demo, Owned::Unknown] {
            let main = page_buttons(Page::Main, &p, &own(o));
            assert_eq!(main[1], ("Wishlist Now".to_string(), Action::Wishlist, WISHLIST_COLOR));
        }
        assert!(!actions(Page::Main, &p, Owned::Full).contains(&Action::Wishlist));
    }

    #[test]
    fn unlock_page_buys_and_goes_back() {
        let p = StoryProgress { unlocked: 1, current: 1, pip_color: 0 };
        let a = actions(Page::Unlock(Lock::Host), &p, Owned::Demo);
        assert_eq!(a.first(), Some(&Action::Buy));
        assert_eq!(a.last(), Some(&Action::Goto(Page::Party)));
        assert_eq!(a.contains(&Action::Restore), crate::ownership::NATIVE_STORE);
        assert_eq!(Lock::Chapter(3).back(), Page::Chapters);
        assert_eq!(Lock::Story(2).back(), Page::Play);
        // No hint (no nagging) on pages with nothing locked.
        assert_eq!(page_hint(Page::Main, &own(Owned::Demo)), None);
        assert_eq!(page_hint(Page::Party, &own(Owned::Full)), None);
    }

    #[test]
    fn locked_tiles_look_muted() {
        let p = StoryProgress { unlocked: 1, current: 1, pip_color: 0 };
        let demo = page_buttons(Page::Party, &p, &own(Owned::Demo));
        let full = page_buttons(Page::Party, &p, &own(Owned::Full));
        assert_ne!(demo[0].2, full[0].2);
        assert_eq!(demo[1].2, full[1].2);
    }
}
