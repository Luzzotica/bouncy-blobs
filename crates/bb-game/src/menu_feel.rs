//! Menu feel, on the title screen and the party lobby:
//!
//! * **Parallax:** the camera leans a little toward the mouse, so the cave
//!   background's layers slide past each other at their own depths.
//! * **Drag:** grab a button or logo letter and pull it; it stretches with
//!   you and springs back home when you let go (its home tether, loosened
//!   while held). A press that doesn't move is still a click: menus read
//!   [`MenuPointer::take_click`] instead of a raw mouse press.

use bb_physics::{BodyId, Vec2 as PVec2};
use bevy::prelude::*;

use crate::camera::{CameraDirector, MainCamera};
use crate::flow::AppState;
use crate::sim::Game;

/// How far the camera leans at the window edges (world px).
const LEAN: Vec2 = Vec2::new(70.0, 28.0);
/// Screen px a press may move and still count as a click.
const CLICK_SLOP: f32 = 12.0;
/// Particles within this distance of the grab point follow the pointer.
const GRAB_RADIUS: f32 = 48.0;
/// The home tether is this many times looser while held.
const LOOSEN: f32 = 80.0;

#[derive(Resource, Default)]
pub struct MenuPointer {
    drag: Option<Drag>,
    click: Option<Vec2>,
    /// The camera target someone else set (the menu's resting view).
    base: Option<Vec2>,
    /// What we last wrote into the director.
    written: Option<Vec2>,
    lean: Vec2,
    /// The button/letter tile under the mouse (none while dragging).
    hovered: Option<BodyId>,
}

struct Drag {
    body: BodyId,
    /// Grabbed particles and their offset from the grab point.
    grip: Vec<(usize, PVec2)>,
    start_screen: Vec2,
    moved: bool,
    compliance: f32,
}

impl MenuPointer {
    /// A completed click (press and release without dragging), in world
    /// space. Each click is handed out once.
    pub fn take_click(&mut self) -> Option<Vec2> {
        self.click.take()
    }

    /// The tile the mouse is over, for a hover effect.
    pub fn hovered(&self) -> Option<BodyId> {
        self.hovered
    }

    /// True while a button/letter is being dragged.
    pub fn dragging(&self) -> bool {
        self.drag.as_ref().is_some_and(|d| d.moved)
    }
}

pub struct MenuFeelPlugin;

impl Plugin for MenuFeelPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<MenuPointer>().add_systems(
            PreUpdate,
            (lean, drag)
                .after(bevy::input::InputSystems)
                .run_if(resource_exists::<Game>.and_then(in_state(AppState::Title).or_else(in_state(AppState::Party)))),
        )
        .add_systems(OnExit(AppState::Title), reset)
        .add_systems(OnExit(AppState::Party), reset);
    }
}

fn reset(mut p: ResMut<MenuPointer>) {
    *p = MenuPointer::default();
}

fn lean(mut p: ResMut<MenuPointer>, mut dir: ResMut<CameraDirector>, windows: Query<&Window>, time: Res<Time>) {
    // Only lean a menu's fixed view (the party match follows players).
    if dir.target != p.written {
        p.base = dir.target;
        p.lean = Vec2::ZERO;
    }
    let Some(base) = p.base else { return };
    let want = windows
        .iter()
        .next()
        .and_then(|w| w.cursor_position().map(|c| (c / w.size().max(Vec2::ONE)) * 2.0 - 1.0))
        .map_or(Vec2::ZERO, |n| Vec2::new(n.x * LEAN.x, -n.y * LEAN.y));
    let k = 1.0 - (-time.delta_secs() * 3.0).exp();
    let l = p.lean;
    p.lean = l + (want - l) * k;
    let t = base + p.lean;
    dir.target = Some(t);
    p.written = Some(t);
}

#[allow(clippy::too_many_arguments)]
fn drag(
    mut p: ResMut<MenuPointer>,
    mut game: ResMut<Game>,
    mouse: Res<ButtonInput<MouseButton>>,
    touches: Res<Touches>,
    windows: Query<&Window>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
) {
    // A click is only good for the frame it happened in.
    p.click = None;
    let Ok((camera, tf)) = cam.single() else { return };
    let Some(window) = windows.iter().next() else { return };
    let touch = touches.iter().next().map(|t| t.position());
    let screen = touch.or_else(|| window.cursor_position());
    let world = |s: Vec2| camera.viewport_to_world_2d(tf, s).ok();
    let pressed = mouse.just_pressed(MouseButton::Left) || touches.iter_just_pressed().next().is_some();
    let released = mouse.just_released(MouseButton::Left) || touches.iter_just_released().next().is_some();
    let held = mouse.pressed(MouseButton::Left) || touch.is_some();
    let release_at = touches.iter_just_released().next().map(|t| t.position()).or(screen);
    // Hover (mouse only; touch has no hover).
    p.hovered = if touch.is_none() && p.drag.is_none() {
        window.cursor_position().and_then(world).and_then(|w| game.sim.world.pick(PVec2::new(w.x, w.y), crate::load_layer::UI))
    } else {
        None
    };

    if pressed {
        if let Some(s) = screen {
            p.drag = None;
            if let Some(w) = world(s) {
                let at = PVec2::new(w.x, w.y);
                let hit = game.sim.world.pick(at, crate::load_layer::UI).filter(|id| game.sim.world.body(*id).is_some_and(|b| b.home.is_some()));
                match hit {
                    Some(body) => {
                        let b = game.sim.world.body(body).unwrap();
                        let mut grip: Vec<(usize, PVec2)> = b.x.iter().enumerate().filter(|(_, x)| x.distance(at) < GRAB_RADIUS).map(|(i, x)| (i, *x - at)).collect();
                        if grip.is_empty() {
                            if let Some(i) = game.sim.world.nearest_particle(body, at) {
                                grip.push((i as usize, b.x[i as usize] - at));
                            }
                        }
                        p.drag = Some(Drag { body, grip, start_screen: s, moved: false, compliance: b.home_compliance });
                    }
                    // Not on a tile: a plain click on release.
                    None => {}
                }
            }
        }
    }

    if let Some(d) = p.drag.as_mut() {
        if let Some(s) = screen {
            if !d.moved && s.distance(d.start_screen) > CLICK_SLOP {
                d.moved = true;
                if let Some(b) = game.sim.world.body_mut(d.body) {
                    b.home_compliance = d.compliance * LOOSEN;
                }
            }
            if d.moved && held {
                if let (Some(w), Some(b)) = (world(s), game.sim.world.body_mut(d.body)) {
                    let at = PVec2::new(w.x, w.y);
                    for (i, off) in &d.grip {
                        // Velocity servo toward the pointer: stable, and the
                        // rest of the jelly stretches along behind.
                        let mut v = (at + *off - b.x[*i]) * 18.0;
                        if v.length() > 2600.0 {
                            v = v.normalize() * 2600.0;
                        }
                        b.v[*i] = v;
                    }
                }
            }
        }
    }

    if released {
        if let Some(d) = p.drag.take() {
            if let Some(b) = game.sim.world.body_mut(d.body) {
                b.home_compliance = d.compliance;
            }
            if !d.moved {
                p.click = release_at.and_then(world);
            }
        } else {
            p.click = release_at.and_then(world);
        }
    }
}
