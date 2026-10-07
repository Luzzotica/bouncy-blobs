//! Pause menu. The game world freezes, so the jelly buttons live in their
//! own little overlay physics world that keeps wobbling.

use bb_physics::{BodyDesc, BodyId, Config, Vec2 as PVec2, World};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::camera::MainCamera;
use crate::flow::AppState;
use crate::menu::button_style;
use crate::render::{MeshBuf, Shared, Style, body_mesh, empty_mesh};
use crate::sim::{Game, Inputs, UnloadLevel};
use crate::story::cutscene::Runner;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PauseAction {
    Resume,
    Restart,
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
}

pub struct PausePlugin;

impl Plugin for PausePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, (toggle, run.run_if(resource_exists::<Pause>)).chain().run_if(in_state(AppState::Story).or_else(in_state(AppState::Playing))))
            .add_systems(OnExit(AppState::Story), close_on_exit)
            .add_systems(OnExit(AppState::Playing), close_on_exit);
    }
}

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
) {
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
    let mut world = World::new(Config { gravity: PVec2::ZERO, ..Config::default() });
    let dim = commands
        .spawn((Node { position_type: PositionType::Absolute, width: percent(100.0), height: percent(100.0), ..default() }, BackgroundColor(Color::srgba(0.05, 0.02, 0.1, 0.55)), GlobalZIndex(40)))
        .id();
    let mut items = Vec::new();
    for (i, (text, action, color)) in ITEMS.iter().enumerate() {
        let c = origin + PVec2::new(0.0, 110.0 - i as f32 * 110.0);
        let size = PVec2::new(520.0, 86.0);
        let mut d = BodyDesc::grid(c - size * 0.5, c + size * 0.5, 24, 4, 12.0);
        d.params.shape_compliance = Some(2e-4);
        d.params.edge_compliance = 2e-5;
        d.params.tri_compliance = 2e-5;
        let id = world.add_body(d);
        world.body_mut(id).unwrap().anchor_home(2e-4);
        // Pop in from below with a wobble.
        world.body_mut(id).unwrap().add_velocity(PVec2::new(0.0, 600.0 + i as f32 * 200.0));
        let mesh = meshes.add(empty_mesh());
        let vis = commands.spawn((Mesh2d(mesh.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, 300.0))).id();
        let label = commands
            .spawn((
                Text2d::new(*text),
                TextFont { font: assets.font.clone().into(), font_size: 38.0.into(), weight: FontWeight::BOLD, ..default() },
                TextColor(Color::WHITE),
                Transform::from_xyz(c.x, c.y, 301.0),
            ))
            .id();
        items.push((id, *action, *color, vis, mesh, label));
    }
    commands.insert_resource(Pause { world, items, origin, focus: 0, prev_button: true, nav: 0.0, dim });
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
    mut labels: Query<&mut Transform, With<Text2d>>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    keys: Res<ButtonInput<KeyCode>>,
    inputs: Res<Inputs>,
    windows: Query<&Window>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut next: ResMut<NextState<AppState>>,
    mut unload: MessageWriter<UnloadLevel>,
) {
    let dt = time.delta_secs().min(1.0 / 30.0);
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
        if let Ok(mut tf) = labels.get_mut(*label) {
            let c = b.centroid();
            tf.translation.x = c.x;
            tf.translation.y = c.y;
            tf.rotation = Quat::from_rotation_z(b.angle());
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
    }
    let button = inputs.slots.iter().any(|i| i.button) || keys.any_pressed([KeyCode::Enter, KeyCode::Space]);
    if button && !pause.prev_button {
        chosen = chosen.or(Some(pause.focus));
    }
    pause.prev_button = button;
    let Some(i) = chosen else { return };
    let action = pause.items[i].1;
    match action {
        PauseAction::Resume => {}
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
