//! Camera: frames every local player (co-op), leads in the direction of
//! travel, zooms out as players spread, and can be driven by cutscenes.

use bevy::camera::ScalingMode;
use bevy::prelude::*;

use crate::sim::Game;

/// Minimum visible world area; the window's aspect adds to one axis.
pub const VIEW_W: f32 = 1500.0;
pub const VIEW_H: f32 = 860.0;

#[derive(Component)]
pub struct MainCamera;

/// Overrides follow behaviour (cutscenes, menus, kids mode).
#[derive(Resource, Default, Clone)]
pub struct CameraDirector {
    pub target: Option<Vec2>,
    pub zoom: Option<f32>,
    /// Seconds to ease in (0 = snap).
    pub ease: f32,
    pub shake: f32,
}

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CameraDirector>()
            .add_systems(Startup, spawn_camera)
            .add_systems(PostUpdate, follow.before(bevy::transform::TransformSystems::Propagate));
    }
}

fn spawn_camera(mut commands: Commands) {
    commands.spawn((
        Camera2d,
        MainCamera,
        Projection::Orthographic(OrthographicProjection {
            scaling_mode: ScalingMode::AutoMin { min_width: VIEW_W, min_height: VIEW_H },
            ..OrthographicProjection::default_2d()
        }),
        Transform::from_xyz(0.0, 0.0, 500.0),
    ));
}

pub fn follow(
    game: Option<Res<Game>>,
    mut dir: ResMut<CameraDirector>,
    time: Res<Time>,
    mut cam: Query<(&mut Transform, &mut Projection), With<MainCamera>>,
) {
    let Ok((mut tf, mut proj)) = cam.single_mut() else { return };
    let dt = time.delta_secs();
    let mut target = dir.target;
    let mut zoom = dir.zoom.unwrap_or(1.0);
    if target.is_none() {
        if let Some(game) = &game {
            let pts: Vec<(Vec2, Vec2)> = game
                .sim
                .players
                .iter()
                .filter(|p| p.dead.is_none())
                .filter_map(|p| game.sim.world.body(p.ctl.body))
                .map(|b| {
                    let c = b.centroid();
                    let v = b.velocity();
                    (Vec2::new(c.x, c.y), Vec2::new(v.x, v.y))
                })
                .collect();
            if !pts.is_empty() {
                let mut min = Vec2::splat(f32::MAX);
                let mut max = Vec2::splat(f32::MIN);
                let mut vel = Vec2::ZERO;
                for (p, v) in &pts {
                    min = min.min(*p);
                    max = max.max(*p);
                    vel += *v;
                }
                vel /= pts.len() as f32;
                let lead = Vec2::new((vel.x * 0.35).clamp(-220.0, 220.0), (vel.y * 0.12).clamp(-120.0, 160.0));
                target = Some((min + max) * 0.5 + lead + Vec2::new(0.0, 80.0));
                let spread = max - min;
                zoom = zoom.max((spread.x / (VIEW_W * 0.7)).max(spread.y / (VIEW_H * 0.65))).clamp(1.0, 2.2);
            } else {
                let p = game.sim.respawn_point();
                target = Some(Vec2::new(p.x, p.y + 80.0));
            }
        }
    }
    let Some(target) = target else { return };
    let k = if dir.ease <= 0.0 { 1.0 } else { 1.0 - (-dt * 4.0 / dir.ease.max(0.05)).exp() };
    let k = if dir.target.is_none() { 1.0 - (-dt * 5.0).exp() } else { k };
    let cur = tf.translation.truncate();
    let mut next = cur.lerp(target, k);
    if dir.shake > 0.0 {
        dir.shake = (dir.shake - dt * 3.0).max(0.0);
        let t = time.elapsed_secs() * 60.0;
        next += Vec2::new((t * 1.3).sin(), (t * 1.7).cos()) * dir.shake * 14.0;
    }
    tf.translation.x = next.x;
    tf.translation.y = next.y;
    if let Projection::Orthographic(o) = proj.as_mut() {
        if dir.target.is_some() && dir.zoom.is_some() && dir.ease <= 0.0 {
            // Direct control (editor): snap.
            o.scale = zoom;
        } else {
            o.scale += (zoom - o.scale) * (1.0 - (-dt * 2.5).exp());
        }
    }
}
