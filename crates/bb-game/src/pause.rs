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
}

pub struct PausePlugin;

impl Plugin for PausePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (toggle, run.run_if(resource_exists::<Pause>)).chain().run_if(in_state(AppState::Story).or_else(in_state(AppState::Playing))))
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
    editor: Option<Res<crate::editor::Editor>>,
    (state, hints): (Res<State<AppState>>, Res<crate::story::glimmer::CompanionHints>),
) {
    if editor.is_some_and(|e| e.playtesting) {
        return; // Esc returns to the editor during play-tests.
    }
    let pressed = keys.just_pressed(KeyCode::Escape) || keys.just_pressed(KeyCode::KeyP) || pads.iter().any(|p| p.just_pressed(GamepadButton::Start));
    if !pressed || runner.is_some() {
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
    commands.insert_resource(Pause { world, items, origin, focus: 0, prev_button: true, nav: 0.0, dim, drop });
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
) {
    let dt = time.delta_secs().min(1.0 / 30.0);
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
        let mut s = None;
        if mouse.just_pressed(MouseButton::Left) {
            s = w.cursor_position();
        }
        for t in touches.iter_just_pressed() {
            s = Some(t.position());
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
            let at = game.sim.respawn_point();
            let bodies: Vec<_> = game.sim.players.iter().map(|p| p.ctl.body).collect();
            for (k, b) in bodies.into_iter().enumerate() {
                game.sim.world.respawn(b, at + PVec2::new(k as f32 * 20.0, 40.0));
            }
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

#[cfg(test)]
mod tests {
    #[test]
    fn pause_labels_have_glyphs() {
        let hints = [crate::story::glimmer::CompanionHints(true).label(), crate::story::glimmer::CompanionHints(false).label()];
        for text in super::ITEMS.iter().map(|i| i.0).chain(hints) {
            assert!(crate::softtext::missing_glyphs(text).is_empty(), "{text:?}");
        }
    }
}
