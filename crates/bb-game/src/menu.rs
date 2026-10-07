//! The title screen and menus — made of softbodies.
//!
//! Every letter of the logo and every button is a jelly body in the same
//! physics world as your blob: tap a button and it squishes, roll into it
//! and it wobbles, jump on the logo and it jiggles. Labels ride on top of
//! their body (position, rotation and squash follow the jelly).

use bb_level::{LevelBuilder, NpcRole, Theme, v};
use bb_physics::{BodyDesc, BodyId, Vec2 as PVec2};
use bb_sim::BodyTag;
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::palette::{darken, hex, lighten};
use crate::render::{Style, StyleOverrides, z};
use crate::sim::{Game, Inputs, LoadLevel, UnloadLevel};
use crate::story::{CHAPTERS, StoryProgress};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Main,
    Chapters,
    Party,
    Settings,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Continue,
    Chapter(u8),
    Goto(Page),
    Kids,
    Editor,
    Sandbox,
    PartyHost,
    Color,
    ToggleFullscreen,
    Quit,
}

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
}

/// Text that rides on a softbody.
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
                (build_page, interact, follow_labels).chain().run_if(in_state(AppState::Title).and_then(resource_exists::<Game>)),
            )
            .add_systems(Update, follow_labels.run_if(not(in_state(AppState::Title)).and_then(resource_exists::<Game>)))
            .add_systems(Update, boot.run_if(in_state(AppState::Boot)));
    }
}

/// Leave Boot for the title (unless a dev env var already chose a state).
fn boot(mut next: ResMut<NextState<AppState>>, mut frames: Local<u32>) {
    *frames += 1;
    if *frames > 1 {
        next.set(AppState::Title);
    }
}

pub fn title_level() -> bb_level::Level {
    let mut b = LevelBuilder::new("title", "Title", Theme::Hollow);
    b.spawn(v(-560.0, 120.0))
        .ground(&[v(-1300.0, 0.0), v(1300.0, 0.0)], 400.0)
        .block(v(-1400.0, -400.0), v(-1300.0, 1800.0))
        .block(v(1300.0, -400.0), v(1400.0, 1800.0))
        .mushroom(v(-900.0, 0.0), 120.0, 200.0)
        .kill_y(-900.0)
        .decor("crystal", v(860.0, 0.0), 1.2, -1.0)
        .decor("glowworm", v(-300.0, 760.0), 1.4, -1.0)
        .decor("glowworm", v(500.0, 820.0), 1.0, -1.0);
    for (i, x) in [-1100.0f32, 1050.0, 700.0].iter().enumerate() {
        b.npc(&format!("w{i}"), v(*x, 60.0), NpcRole::Wanderer, "", 26.0);
    }
    b.build()
}

fn enter(mut load: MessageWriter<LoadLevel>, progress: Res<StoryProgress>, mut cam: ResMut<CameraDirector>, mut commands: Commands) {
    load.write(LoadLevel { level: title_level(), players: vec![(0, "Pip".into(), progress.pip_color)] });
    cam.target = Some(Vec2::new(0.0, 380.0));
    cam.zoom = Some(1.0);
    cam.ease = 0.0;
    commands.insert_resource(Menu { page: Page::Main, buttons: Vec::new(), letters: Vec::new(), focus: 0, pending: None, nav_cooldown: 0.0, prev_button: true });
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

/// A jelly slab with a label. Tethered to where it was put, so it wobbles
/// but never wanders off.
fn jelly_tile(game: &mut Game, center: PVec2, size: PVec2, tag: BodyTag, wobble: f32) -> BodyId {
    // Wide tiles use a uniform grid: ear-clipping a long outline makes sliver
    // triangles whose area constraints fight each other and shear the body.
    let mut d = if size.x > size.y * 1.6 {
        let cols = (size.x / 22.0).ceil() as usize;
        let rows = (size.y / 22.0).ceil().max(2.0) as usize;
        let mut d = BodyDesc::grid(center - size * 0.5, center + size * 0.5, cols, rows, size.x * size.y / 2500.0);
        // Chamfer the corners so it still reads as a soft pill.
        let (nx, ny) = (cols + 1, rows + 1);
        let cut = size.y * 0.16;
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
    d.layer = crate::load_layer::UI;
    let id = game.sim.add_body(d, tag);
    if let Some(b) = game.sim.world.body_mut(id) {
        b.anchor_home(wobble);
    }
    id
}

fn label(commands: &mut Commands, assets: &GameAssets, body: BodyId, text: &str, size: f32, color: Color) {
    commands.spawn((
        Text2d::new(text),
        TextFont { font: assets.font.clone().into(), font_size: size.into(), weight: FontWeight::BOLD, ..default() },
        TextColor(color),
        Transform::from_xyz(0.0, 0.0, z::FX - 0.5),
        BodyLabel { body, size },
        MenuEntity,
    ));
}

fn page_buttons(page: Page, progress: &StoryProgress) -> Vec<(String, Action, u32)> {
    match page {
        Page::Main => {
            let story = if progress.unlocked > 1 { format!("Continue  ·  Ch {}", progress.current) } else { "Play Story".into() };
            vec![
                (story, Action::Continue, 0xff8fab),
                ("Chapters".into(), Action::Goto(Page::Chapters), 0xffc75f),
                ("Party  (phones!)".into(), Action::Goto(Page::Party), 0x6bcb77),
                ("Kids Mode".into(), Action::Kids, 0x5dd6ff),
                ("Settings".into(), Action::Goto(Page::Settings), 0xb8a1ff),
            ]
        }
        Page::Chapters => {
            let mut v: Vec<(String, Action, u32)> = (1..=CHAPTERS)
                .filter(|c| *c <= progress.unlocked)
                .map(|c| (format!("{c}"), Action::Chapter(c), crate::palette_cycle(c as usize)))
                .collect();
            v.push(("Back".into(), Action::Goto(Page::Main), 0xd0c4e8));
            v
        }
        Page::Party => vec![
            ("Host with Phones".into(), Action::PartyHost, 0x6bcb77),
            ("Level Editor".into(), Action::Editor, 0xffc75f),
            ("Sandbox".into(), Action::Sandbox, 0xff9f43),
            ("Back".into(), Action::Goto(Page::Main), 0xd0c4e8),
        ],
        Page::Settings => vec![
            ("Blob Color".into(), Action::Color, progress.pip_color),
            ("Fullscreen".into(), Action::ToggleFullscreen, 0x5dd6ff),
            #[cfg(not(any(target_os = "ios", target_os = "android", target_arch = "wasm32")))]
            ("Quit".into(), Action::Quit, 0xff5d73),
            ("Back".into(), Action::Goto(Page::Main), 0xd0c4e8),
        ],
    }
}

fn button_style(color: u32, focused: bool) -> Style {
    let c = hex(color);
    let fill = if focused { lighten(c, 0.25) } else { c };
    Style { fill, rim: if focused { Color::WHITE } else { darken(c, 0.4) }, rim_w: if focused { 7.0 } else { 5.0 }, highlight: true, z: z::PROP + 1.0, top_rim_only: false }
}

#[allow(clippy::too_many_arguments)]
fn build_page(
    mut commands: Commands,
    mut menu: ResMut<Menu>,
    mut game: ResMut<Game>,
    assets: Res<GameAssets>,
    progress: Res<StoryProgress>,
    labels: Query<Entity, With<MenuEntity>>,
    mut overrides: ResMut<StyleOverrides>,
    mut built: Local<Option<(Page, u64)>>,
) {
    // Rebuild when the page changes or a new title world was loaded.
    let key = (menu.page, game.sim.world.time().to_bits() & 0);
    let fresh = game.is_added();
    if !fresh && built.is_some_and(|b| b.0 == key.0) {
        return;
    }
    *built = Some(key);
    for e in labels.iter() {
        commands.entity(e).despawn();
    }
    for b in menu.buttons.drain(..) {
        game.sim.remove_body(b.body);
    }
    let old_letters: Vec<BodyId> = menu.letters.drain(..).collect();
    for l in old_letters {
        game.sim.remove_body(l);
    }
    overrides.0.clear();

    // Logo: soft letter tiles.
    let logo: &[(&str, u32)] = &[("B", 0xff5d73), ("O", 0xff9f43), ("U", 0xffd93d), ("N", 0x6bcb77), ("C", 0x4d96ff), ("Y", 0x9b5de5)];
    let logo2: &[(&str, u32)] = &[("B", 0xf15bb5), ("L", 0x00c2a8), ("O", 0x5dd6ff), ("B", 0xa0e426), ("S", 0xff7eb6)];
    let (title_y, scale) = if menu.page == Page::Main { (690.0, 1.0) } else { (760.0, 0.6) };
    for (row, (letters, y)) in [(logo, title_y), (logo2, title_y - 112.0 * scale)].iter().enumerate() {
        let n = letters.len() as f32;
        for (i, (ch, col)) in letters.iter().enumerate() {
            let x = (i as f32 - (n - 1.0) * 0.5) * 104.0 * scale + row as f32 * 20.0 * scale;
            let tilt = ((i * 7 + row * 3) % 5) as f32 - 2.0;
            let id = jelly_tile(&mut game, PVec2::new(x, *y + tilt * 4.0), PVec2::splat(92.0 * scale), BodyTag::Ui, 6e-5);
            overrides.0.insert(id, Style { fill: hex(*col), rim: darken(hex(*col), 0.4), rim_w: 5.0, highlight: true, z: z::PROP + 0.5, top_rim_only: false });
            label(&mut commands, &assets, id, ch, 64.0 * scale, Color::WHITE);
            menu.letters.push(id);
        }
    }

    // Buttons.
    let items = page_buttons(menu.page, &progress);
    let grid = menu.page == Page::Chapters;
    let top = if menu.page == Page::Main { 430.0 } else { 560.0 };
    for (i, (text, action, color)) in items.into_iter().enumerate() {
        let (center, size) = if grid && !matches!(action, Action::Goto(_)) {
            let (col, row) = (i % 5, i / 5);
            (PVec2::new((col as f32 - 2.0) * 150.0, top - row as f32 * 140.0), PVec2::new(120.0, 110.0))
        } else if grid {
            (PVec2::new(0.0, top - 2.0 * 140.0 - 20.0), PVec2::new(300.0, 76.0))
        } else {
            (PVec2::new(0.0, top - i as f32 * 96.0), PVec2::new(470.0, 78.0))
        };
        let id = jelly_tile(&mut game, center, size, BodyTag::Ui, 2e-4);
        overrides.0.insert(id, button_style(color, i == 0));
        label(&mut commands, &assets, id, &text, if grid && size.x < 200.0 { 54.0 } else { 36.0 }, Color::WHITE);
        menu.buttons.push(Button { body: id, action, color });
    }
    menu.focus = 0;
}

#[allow(clippy::too_many_arguments)]
fn interact(
    mut menu: ResMut<Menu>,
    mut game: ResMut<Game>,
    time: Res<Time>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    keys: Res<ButtonInput<KeyCode>>,
    inputs: Res<Inputs>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut overrides: ResMut<StyleOverrides>,
    mut progress: ResMut<StoryProgress>,
    mut next: ResMut<NextState<AppState>>,
    mut exit: MessageWriter<AppExit>,
    mut windows_mut: Query<&mut Window>,
    mut load: MessageWriter<LoadLevel>,
) {
    let dt = time.delta_secs();
    // Fire a pending action once the squish has played.
    if let Some((action, t)) = menu.pending.as_mut() {
        *t -= dt;
        if *t <= 0.0 {
            let action = action.clone();
            menu.pending = None;
            match action {
                Action::Continue => next.set(AppState::Story),
                Action::Chapter(c) => {
                    progress.current = c;
                    next.set(AppState::Story);
                }
                Action::Goto(p) => menu.page = p,
                Action::Kids => next.set(AppState::Kids),
                Action::Editor => next.set(AppState::Editor),
                Action::Sandbox => {
                    load.write(LoadLevel { level: crate::sandbox::sandbox_level(), players: vec![(0, "Pip".into(), progress.pip_color)] });
                    next.set(AppState::Playing);
                }
                Action::PartyHost => next.set(AppState::Party),
                Action::Color => {
                    let i = bb_sim::PALETTE.iter().position(|c| *c == progress.pip_color).unwrap_or(0);
                    progress.pip_color = bb_sim::PALETTE[(i + 1) % bb_sim::PALETTE.len()];
                    if let Some(p) = game.sim.player_mut(0) {
                        p.color = progress.pip_color;
                    }
                    if let Some(b) = menu.buttons.iter_mut().find(|b| b.action == Action::Color) {
                        b.color = progress.pip_color;
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
                Action::Quit => {
                    exit.write(AppExit::Success);
                }
            }
        }
        return;
    }

    // Pointer: click or tap a jelly.
    let mut press_at: Option<Vec2> = None;
    if let (Ok((camera, cam_tf)), Some(window)) = (cam.single(), windows_mut.iter().next()) {
        let mut screen = None;
        if mouse.just_pressed(MouseButton::Left) {
            screen = window.cursor_position();
        }
        for t in touches.iter_just_pressed() {
            screen = Some(t.position());
        }
        if let Some(s) = screen {
            press_at = camera.viewport_to_world_2d(cam_tf, s).ok();
        }
    }
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
    }
    // The keyboard player also rolls around the menu; only Enter activates,
    // so jumping doesn't press buttons. Gamepads/phones use their button.
    let pad_press = inputs.slots.iter().skip(1).any(|i| i.button) && just;
    if chosen.is_none() && (keys.just_pressed(KeyCode::Enter) || pad_press) {
        chosen = Some(menu.focus);
    }
    if keys.just_pressed(KeyCode::Escape) && menu.page != Page::Main {
        menu.page = Page::Main;
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
        menu.pending = Some((action, 0.22));
    }
    // Relax any puffed button.
    for btn in &menu.buttons {
        if let Some(b) = game.sim.world.body_mut(btn.body) {
            b.rest_scale += (1.0 - b.rest_scale) * (1.0 - (-dt * 8.0).exp());
        }
    }
}

/// Labels follow their jelly: position, rotation and squash.
pub fn follow_labels(game: Res<Game>, mut q: Query<(&BodyLabel, &mut Transform, &mut Visibility)>) {
    for (l, mut tf, mut vis) in q.iter_mut() {
        let Some(b) = game.sim.world.body(l.body) else {
            *vis = Visibility::Hidden;
            continue;
        };
        *vis = if b.enabled { Visibility::Visible } else { Visibility::Hidden };
        let c = b.centroid();
        let outline: Vec<PVec2> = b.outline().collect();
        let (w, h) = crate::render::extents(&outline);
        let rest = bb_physics::Aabb::from_points(b.rest.iter().copied());
        let (rw, rh) = ((rest.max.x - rest.min.x).max(1.0), (rest.max.y - rest.min.y).max(1.0));
        tf.translation.x = c.x;
        tf.translation.y = c.y;
        tf.rotation = Quat::from_rotation_z(b.angle());
        tf.scale = Vec3::new((w / rw).clamp(0.6, 1.6), (h / rh).clamp(0.6, 1.6), 1.0);
    }
}
