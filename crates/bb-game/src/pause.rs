//! Pause menu. The game world freezes, so the jelly buttons live in their
//! own little overlay physics world that keeps wobbling. They drop in
//! gently, and every letter of their labels rides the jelly.

use bb_physics::{BodyId, Config, Vec2 as PVec2, World};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::MainCamera;
use crate::dropin::{DropIn, DropStyle};
use crate::softtext::{self, GlyphQuery, Ride, SoftText};
use crate::flow::AppState;
use crate::menu::{BUTTON_FONT, BUTTON_H, button_style, tile_desc};
use crate::render::{MeshBuf, Shared, Style, body_mesh, empty_mesh};
use crate::sim::{Game, Inputs, UnloadLevel};
use crate::story::cutscene::Runner;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PauseAction {
    Resume,
    Restart,
    /// Story only: mute / unmute Glimmer's hints (stays open).
    Hints,
    Quit,
}

#[derive(Resource)]
struct Pause {
    world: World,
    items: Vec<(BodyId, PauseAction, u32, Entity, Handle<Mesh>, Entity)>,
    origin: PVec2,
    focus: usize,
    prev_button: bool,
    nav: f32,
    dim: Entity,
    drop: DropIn,
    /// Seconds open. Pointer presses count only after a moment: the tap
    /// that opened it (the touch pause button) isn't a choice.
    age: f32,
}

pub struct PausePlugin;

impl Plugin for PausePlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<TouchPause>()
            .add_systems(Startup, spawn_touch_button)
            .add_systems(Update, touch_button)
            .add_systems(
                Update,
                (toggle, run.run_if(resource_exists::<Pause>)).chain().after(touch_button).run_if(in_state(AppState::Story).or_else(in_state(AppState::Playing))),
            )
            .add_systems(OnExit(AppState::Story), close_on_exit)
            .add_systems(OnExit(AppState::Playing), close_on_exit);
    }
}

const HINTS_COLOR: u32 = 0x9ad0ff;

const ITEMS: [(&str, PauseAction, u32); 3] =
    [("Keep Bouncing", PauseAction::Resume, 0x6bcb77), ("Back to Checkpoint", PauseAction::Restart, 0xffc75f), ("Title Screen", PauseAction::Quit, 0xff8fab)];

#[allow(clippy::too_many_arguments)]
fn toggle(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    pads: Query<&Gamepad>,
    pause: Option<Res<Pause>>,
    runner: Option<Res<Runner>>,
    game: Option<ResMut<Game>>,
    cam: Query<&Transform, With<MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
    shared: Res<Shared>,
    assets: Res<GameAssets>,
    (state, hints, mut tapped): (Res<State<AppState>>, Res<crate::story::glimmer::CompanionHints>, ResMut<TouchPause>),
) {
    let tap = std::mem::take(&mut tapped.tapped);
    let pressed = keys.just_pressed(KeyCode::Escape) || keys.just_pressed(KeyCode::KeyP) || pads.iter().any(|p| p.just_pressed(GamepadButton::Start)) || tap;
    // B (and Backspace / Android back) only closes it: in a level B jumps.
    let back = pause.is_some() && crate::input::back_pressed(&keys, pads.iter());
    if !(pressed || back) || runner.is_some() {
        return;
    }
    let Some(mut game) = game else { return };
    if let Some(p) = pause {
        close(&mut commands, &p);
        commands.remove_resource::<Pause>();
        game.paused = false;
        return;
    }
    game.paused = true;
    let origin = cam.single().map(|t| PVec2::new(t.translation.x, t.translation.y)).unwrap_or_default();
    // Gravity exists only for the drop-in; settled buttons are weightless.
    let mut world = World::new(Config::default());
    let mut drop = DropIn::new(DropStyle::GENTLE);
    // The dim is a world-space veil *under* the buttons (a UI overlay would
    // draw over the jelly and grey it out).
    let dim = {
        let mut buf = MeshBuf::default();
        let (lo, hi) = (origin - PVec2::new(6000.0, 4000.0), origin + PVec2::new(6000.0, 4000.0));
        let col = crate::palette::lin(Color::srgba(0.05, 0.02, 0.1, 0.55));
        let i0 = buf.vert(lo, 0.0, col);
        let i1 = buf.vert(PVec2::new(hi.x, lo.y), 0.0, col);
        let i2 = buf.vert(hi, 0.0, col);
        let i3 = buf.vert(PVec2::new(lo.x, hi.y), 0.0, col);
        buf.tri(i0, i1, i2);
        buf.tri(i0, i2, i3);
        let mut mesh = empty_mesh();
        buf.write(&mut mesh);
        commands.spawn((Mesh2d(meshes.add(mesh)), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, 250.0))).id()
    };
    let mut list: Vec<(&str, PauseAction, u32)> = ITEMS.to_vec();
    if *state.get() == AppState::Story {
        list.insert(2, (hints.label(), PauseAction::Hints, HINTS_COLOR));
    }
    let mut items = Vec::new();
    for (i, (text, action, color)) in list.iter().enumerate() {
        // The same jelly pill as the title-screen buttons.
        let c = origin + PVec2::new(0.0, 100.0 - i as f32 * 100.0);
        let size = PVec2::new(480.0, BUTTON_H);
        let id = world.add_body(tile_desc(c, size));
        world.body_mut(id).unwrap().anchor_home(4e-5);
        // Bottom first, so no button ever falls through another.
        drop.add(&mut world, id, (list.len() - 1 - i) as f32 * 0.07);
        let mesh = meshes.add(empty_mesh());
        let vis = commands.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, 300.0))).id();
        let label = commands.spawn(SoftText::new(*text, BUTTON_FONT).ride(Ride::Overlay(id)).color(Color::WHITE).z(301.0).stagger(0.025)).id();
        items.push((id, *action, *color, vis, mesh, label));
    }
    let _ = &assets;
    commands.insert_resource(Pause { world, items, origin, focus: 0, prev_button: true, nav: 0.0, dim, drop, age: 0.0 });
}

fn close(commands: &mut Commands, p: &Pause) {
    for (_, _, _, vis, _, label) in &p.items {
        commands.entity(*vis).despawn();
        commands.entity(*label).despawn();
    }
    commands.entity(p.dim).despawn();
}

fn close_on_exit(mut commands: Commands, pause: Option<Res<Pause>>) {
    if let Some(p) = pause {
        close(&mut commands, &p);
        commands.remove_resource::<Pause>();
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    mut commands: Commands,
    mut pause: ResMut<Pause>,
    mut game: ResMut<Game>,
    time: Res<Time>,
    mut meshes: ResMut<Assets<Mesh>>,
    (mut labels, mut glyphs): (Query<&mut SoftText>, GlyphQuery),
    (mouse, touches): (Res<ButtonInput<MouseButton>>, Res<Touches>),
    keys: Res<ButtonInput<KeyCode>>,
    inputs: Res<Inputs>,
    windows: Query<&Window>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut next: ResMut<NextState<AppState>>,
    mut unload: MessageWriter<UnloadLevel>,
    mut hints: ResMut<crate::story::glimmer::CompanionHints>,
    mut hovered: Local<Option<BodyId>>,
) {
    let dt = time.delta_secs().min(1.0 / 30.0);
    pause.age += dt;
    {
        let p = &mut *pause;
        p.drop.update(&mut p.world, dt);
    }
    pause.world.step(dt);
    let focus = pause.focus;
    let p = &*pause;
    for (i, (id, _, color, _, mesh, label)) in p.items.iter().enumerate() {
        let Some(b) = p.world.body(*id) else { continue };
        if let Some(mut m) = meshes.get_mut(mesh) {
            let mut buf = MeshBuf::default();
            let s: Style = button_style(*color, i == focus);
            body_mesh(b, &s, &mut buf);
            buf.write(&mut m);
        }
        if let Ok(mut st) = labels.get_mut(*label) {
            softtext::pose(&mut st, Some(b), dt, &mut glyphs);
        }
    }

    // Choose by pointer, keys, pads or phones.
    let mut chosen = None;
    if let (Ok((camera, ctf)), Some(w)) = (cam.single(), windows.iter().next()) {
        // The mouse highlights the pill it's over, like the keys do.
        let over = w.cursor_position().and_then(|s| camera.viewport_to_world_2d(ctf, s).ok()).and_then(|wp| pause.world.pick(PVec2::new(wp.x, wp.y), u32::MAX));
        if over != *hovered {
            *hovered = over;
            if let Some(i) = over.and_then(|id| pause.items.iter().position(|it| it.0 == id)) {
                if i != pause.focus {
                    pause.focus = i;
                    if let Ok(mut st) = labels.get_mut(pause.items[i].5) {
                        st.kick(0.4);
                    }
                }
            }
        }
        let mut s = None;
        if mouse.just_pressed(MouseButton::Left) {
            s = w.cursor_position();
        }
        for t in touches.iter_just_pressed() {
            s = Some(t.position());
        }
        // The tap that opened the menu (the touch pause button) isn't a pick.
        if pause.age < 0.1 {
            s = None;
        }
        if let Some(wp) = s.and_then(|s| camera.viewport_to_world_2d(ctf, s).ok()) {
            if let Some(hit) = pause.world.pick(PVec2::new(wp.x, wp.y), u32::MAX) {
                chosen = pause.items.iter().position(|it| it.0 == hit);
            }
        }
    }
    pause.nav = (pause.nav - dt).max(0.0);
    let stick_y: f32 = inputs.slots.iter().map(|i| i.stick.y).sum();
    if pause.nav <= 0.0 && stick_y.abs() > 0.5 {
        let n = pause.items.len() as i32;
        pause.focus = ((pause.focus as i32 - stick_y.signum() as i32).rem_euclid(n)) as usize;
        pause.nav = 0.22;
        let id = pause.items[pause.focus].0;
        if let Some(b) = pause.world.body_mut(id) {
            b.add_velocity(PVec2::new(0.0, 150.0));
        }
        if let Ok(mut st) = labels.get_mut(pause.items[pause.focus].5) {
            st.kick(0.6);
        }
    }
    let button = inputs.slots.iter().any(|i| i.button) || keys.any_pressed([KeyCode::Enter, KeyCode::Space]);
    if button && !pause.prev_button {
        chosen = chosen.or(Some(pause.focus));
    }
    pause.prev_button = button;
    let Some(i) = chosen else { return };
    let action = pause.items[i].1;
    if action == PauseAction::Hints {
        // Flip it and stay in the menu, with the label redrawn.
        hints.toggle();
        let (body, old) = (pause.items[i].0, pause.items[i].5);
        commands.entity(old).despawn();
        pause.items[i].5 = commands.spawn(SoftText::new(hints.label(), BUTTON_FONT).ride(Ride::Overlay(body)).color(Color::WHITE).z(301.0)).id();
        if let Some(b) = pause.world.body_mut(body) {
            b.add_velocity(PVec2::new(0.0, 150.0));
        }
        return;
    }
    match action {
        PauseAction::Resume | PauseAction::Hints => {}
        PauseAction::Restart => {
            let at = game.sim.respawn_point() + PVec2::new(0.0, 40.0);
            game.sim.place_players(at);
            for p in game.sim.players.iter_mut() {
                p.dead = None;
                p.ctl.reset();
            }
        }
        PauseAction::Quit => {
            unload.write(UnloadLevel);
            next.set(AppState::Title);
        }
    }
    game.paused = false;
    close(&mut commands, &pause);
    commands.remove_resource::<Pause>();
    let _ = pause.origin;
}

/// The on-screen pause button for touch players (who have no Escape key):
/// shown in levels whenever the touch pad is, top right.
#[derive(Resource, Default)]
pub struct TouchPause {
    pub shown: bool,
    /// Tapped this frame (for [`toggle`]).
    tapped: bool,
    /// The finger that tapped it, until it lifts: never a jump, and never a
    /// press on the pause menu it opened.
    pub finger: Option<u64>,
}

#[derive(Component)]
struct TouchPauseButton;

/// Side of the round button and its gap from the screen's top-right corner
/// (logical px, clear of the notch).
const TOUCH_BUTTON: f32 = 64.0;
const TOUCH_MARGIN: f32 = 18.0;

/// Where a touch hits the pause button (a little bigger than it looks), in
/// window coordinates (y down) for a window of `size`.
pub fn touch_button_rect(size: Vec2) -> Rect {
    let c = Vec2::new(size.x - crate::platform::SAFE_SIDE - TOUCH_MARGIN - TOUCH_BUTTON * 0.5, TOUCH_MARGIN + TOUCH_BUTTON * 0.5);
    Rect::from_center_size(c, Vec2::splat(TOUCH_BUTTON + 24.0))
}

fn spawn_touch_button(mut commands: Commands) {
    let lav = |a: f32| Color::srgba(0.655, 0.545, 0.98, a);
    commands
        .spawn((
            TouchPauseButton,
            Node {
                position_type: PositionType::Absolute,
                right: px(crate::platform::SAFE_SIDE + TOUCH_MARGIN),
                top: px(TOUCH_MARGIN),
                width: px(TOUCH_BUTTON),
                height: px(TOUCH_BUTTON),
                border: UiRect::all(px(2.0)),
                border_radius: BorderRadius::MAX,
                justify_content: JustifyContent::Center,
                align_items: AlignItems::Center,
                column_gap: px(9.0),
                ..default()
            },
            BackgroundColor(Color::srgba(0.1, 0.1, 0.2, 0.35)),
            BorderColor::all(lav(0.6)),
            BoxShadow::new(lav(0.3), Val::ZERO, Val::ZERO, px(2.0), px(14.0)),
            GlobalZIndex(6),
            Visibility::Hidden,
        ))
        .with_children(|b| {
            for _ in 0..2 {
                b.spawn((Node { width: px(8.0), height: px(24.0), border_radius: BorderRadius::all(px(3.0)), ..default() }, BackgroundColor(lav(0.9))));
            }
        });
}

/// Show the touch pause button when the touch pad is up, and catch taps on it.
#[allow(clippy::too_many_arguments)]
fn touch_button(
    mut shown: ResMut<TouchPause>,
    mut q: Query<&mut Visibility, With<TouchPauseButton>>,
    state: Res<State<AppState>>,
    story: Option<Res<crate::story::StoryFlow>>,
    (runner, pause, game): (Option<Res<Runner>>, Option<Res<Pause>>, Option<Res<Game>>),
    last: Res<crate::input::LastDevice>,
    touches: Res<Touches>,
    (mouse, windows): (Res<ButtonInput<MouseButton>>, Query<&Window>),
) {
    let in_level = match state.get() {
        AppState::Playing => true,
        AppState::Story => story.is_some_and(|s| s.phase == crate::story::Phase::Level),
        _ => false,
    };
    let touch = crate::platform::IS_MOBILE || *last == crate::input::LastDevice::Touch || std::env::var_os("BB_TOUCH_PAD").is_some();
    let want = in_level && game.is_some() && runner.is_none() && pause.is_none() && touch && !crate::capture::on();
    if shown.shown != want {
        shown.shown = want;
    }
    if shown.finger.is_some_and(|f| touches.get_pressed(f).is_none()) {
        shown.finger = None;
    }
    for mut v in q.iter_mut() {
        v.set_if_neq(if want { Visibility::Visible } else { Visibility::Hidden });
    }
    shown.tapped = false;
    let Some(w) = windows.iter().next().filter(|_| want) else { return };
    let rect = touch_button_rect(w.size());
    let mouse_hit = mouse.just_pressed(MouseButton::Left) && w.cursor_position().is_some_and(|c| rect.contains(c));
    if let Some(t) = touches.iter_just_pressed().find(|t| rect.contains(t.position())) {
        shown.tapped = true;
        shown.finger = Some(t.id());
    }
    if mouse_hit {
        shown.tapped = true;
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn touch_pause_button_is_on_screen_and_off_the_touch_pad() {
        use bevy::math::Vec2;
        for size in [Vec2::new(874.0, 402.0), Vec2::new(1376.0, 1032.0), Vec2::new(1600.0, 900.0)] {
            let r = super::touch_button_rect(size);
            assert!(r.min.x >= 0.0 && r.max.x <= size.x && r.min.y >= 0.0, "{size}: pause button off screen");
            let pad = crate::input::pad_layout(size);
            assert!(r.max.y < pad.button_center.y - pad.button_radius, "{size}: pause button on the expand button");
        }
    }

    #[test]
    fn pause_labels_have_glyphs() {
        let hints = [crate::story::glimmer::CompanionHints(true).label(), crate::story::glimmer::CompanionHints(false).label()];
        for text in super::ITEMS.iter().map(|i| i.0).chain(hints) {
            assert!(crate::softtext::missing_glyphs(text).is_empty(), "{text:?}");
        }
    }
}
