//! Camera: frames every local player (co-op), leads in the direction of
//! travel, zooms out as players spread, and can be driven by cutscenes.

use bevy::camera::ScalingMode;
use bevy::prelude::*;

use crate::sim::Game;

/// Minimum visible world area; the window's aspect adds to one axis.
/// (Shared with level design: `bb_level::metrics::MAX_HAZARD_DEPTH` is
/// derived from this framing.)
pub const VIEW_W: f32 = bb_level::metrics::VIEW_W;
pub const VIEW_H: f32 = bb_level::metrics::VIEW_H;
/// The view centre sits this far above the followed blob.
pub const CAM_LIFT: f32 = bb_level::metrics::CAM_LIFT;

#[derive(Component)]
pub struct MainCamera;

/// Everything that places the main camera this frame ([`follow`], capture
/// framing). Runs before Bevy recomputes the projection's area, so systems
/// that size themselves to the view (the cave backdrop) can run after both
/// and never see a half-updated camera.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct CameraFraming;

/// Overrides follow behaviour (cutscenes, menus, kids mode).
#[derive(Resource, Default, Clone)]
pub struct CameraDirector {
    pub target: Option<Vec2>,
    pub zoom: Option<f32>,
    /// Seconds to ease in (0 = snap).
    pub ease: f32,
    pub shake: f32,
    /// A world box that must stay on screen whatever the shot (cutscenes:
    /// Pip, padded and stretched ahead of where Pip is going). The camera
    /// zooms out to fit it, and only pans toward it once fully zoomed out.
    pub keep: Option<Rect>,
    /// Fraction of the screen's height covered at the top and at the
    /// bottom (the cutscene letterbox); `keep` stays clear of it.
    pub cover: f32,
}

/// The furthest the camera zooms out to keep [`CameraDirector::keep`] in
/// view (as far as gameplay ever zooms out).
pub const KEEP_MAX_ZOOM: f32 = 2.2;

pub struct CameraPlugin;

impl Plugin for CameraPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<CameraDirector>()
            .add_systems(Startup, spawn_camera)
            .configure_sets(
                PostUpdate,
                CameraFraming.before(bevy::camera::CameraUpdateSystems).before(bevy::transform::TransformSystems::Propagate),
            )
            .add_systems(PostUpdate, follow.in_set(CameraFraming));
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

/// Where the camera should look when a blob at `p` is at (or in) the exit
/// cave: a point between the blob and the middle of the tunnel, so the
/// mouth, its glow, and the blob all stay on screen. `None` when not near.
pub fn exit_framing(level: &bb_level::Level, p: Vec2, completed: bool) -> Option<Vec2> {
    let m = level.mouths.iter().find(|m| m.kind == bb_level::MouthKind::Exit)?;
    let (lo, hi) = m.interior();
    let (lo, hi) = (Vec2::new(lo.x, lo.y), Vec2::new(hi.x, hi.y));
    let mid_y = (lo.y + hi.y) * 0.5;
    // How far into the approach / tunnel the blob is (0 = 500 px out).
    let f = m.facing.signum();
    let into = (p.x - m.pos.x) * f;
    let near_y = p.y > lo.y - 200.0 && p.y < hi.y + 200.0;
    let w = if completed { 1.0 } else { ((into + 500.0) / 600.0).clamp(0.0, 1.0) };
    if w <= 0.0 || (!near_y && !completed) {
        return None;
    }
    // Look at the blob, pulled towards a point just inside the mouth.
    let focus = Vec2::new(m.pos.x + f * (m.size.x * 0.25), mid_y + 40.0);
    let blob = Vec2::new(p.x, p.y + CAM_LIFT);
    Some(blob.lerp(focus, 0.55 * w))
}

/// Half the visible world at zoom 1 for a projection (its real aspect;
/// the design minimum before the first frame has been laid out).
pub fn view_half(o: &OrthographicProjection) -> Vec2 {
    let s = o.area.half_size() / o.scale.max(1e-4);
    if s.x > 1.0 && s.y > 1.0 { s } else { Vec2::new(VIEW_W, VIEW_H) * 0.5 }
}

/// The zoom at which a view centred on `at` (half extents `half` at zoom
/// 1) shows all of `keep`.
pub fn zoom_to_fit(at: Vec2, keep: Rect, half: Vec2) -> f32 {
    ((keep.max - at).max(at - keep.min) / half).max_element()
}

/// Frame a shot (`target`, `zoom`) so `keep` is in it: zoom out as far as
/// `max_zoom`, then slide the shot toward the box (the box wins over the
/// shot's centre). Returns the new centre and zoom.
pub fn fit_shot(target: Vec2, zoom: f32, keep: Rect, half: Vec2, max_zoom: f32) -> (Vec2, f32) {
    let z = zoom.max(zoom_to_fit(target, keep, half));
    if z <= max_zoom {
        return (target, z);
    }
    let h = half * max_zoom.max(zoom);
    let clamp = |v: f32, lo: f32, hi: f32| if lo > hi { (lo + hi) * 0.5 } else { v.clamp(lo, hi) };
    let t = Vec2::new(clamp(target.x, keep.max.x - h.x, keep.min.x + h.x), clamp(target.y, keep.max.y - h.y, keep.min.y + h.y));
    (t, max_zoom.max(zoom).max(zoom_to_fit(t, keep, half)))
}

pub fn follow(
    game: Option<Res<Game>>,
    interp: Option<Res<crate::sim::Interp>>,
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
                .filter_map(|p| game.sim.world.body(p.ctl.body).map(|b| (p.ctl.body, b)))
                .map(|(id, b)| {
                    // Follow where the blob is DRAWN (interpolated), so the
                    // camera and the blob move in lockstep.
                    let c = b.centroid();
                    let v = b.velocity();
                    let off = interp.as_ref().map_or(Vec2::ZERO, |i| i.offset(game, id));
                    (Vec2::new(c.x, c.y) + off, Vec2::new(v.x, v.y))
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
                let mut t = (min + max) * 0.5 + lead + Vec2::new(0.0, CAM_LIFT);
                // Walking into the exit cave (or done): settle on the mouth
                // so the tunnel and the blob inside it both stay framed,
                // instead of leading off into the rock.
                let centre = (min + max) * 0.5;
                if let Some(c) = exit_framing(&game.sim.level, centre, game.sim.completed) {
                    t = c;
                }
                target = Some(t);
                let spread = max - min;
                zoom = zoom.max((spread.x / (VIEW_W * 0.7)).max(spread.y / (VIEW_H * 0.65))).clamp(1.0, 2.2);
            } else {
                let p = game.sim.respawn_point();
                target = Some(Vec2::new(p.x, p.y + 80.0));
            }
        }
    }
    let Some(mut target) = target else { return };
    // The usable view at zoom 1: the window's real aspect, less the bars.
    let half = match proj.as_ref() {
        Projection::Orthographic(o) => view_half(o),
        _ => Vec2::new(VIEW_W, VIEW_H) * 0.5,
    } * Vec2::new(1.0, 1.0 - 2.0 * dir.cover.clamp(0.0, 0.45));
    if let Some(keep) = dir.keep {
        (target, zoom) = fit_shot(target, zoom, keep, half, KEEP_MAX_ZOOM.max(zoom));
    }
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
            // Direct control (BB_CAM / BB_ZOOM pins): snap.
            o.scale = zoom;
        } else {
            // Zooming out to keep the box in view is quicker than settling in.
            let rate = if dir.keep.is_some() && zoom > o.scale { 6.0 } else { 2.5 };
            o.scale += (zoom - o.scale) * (1.0 - (-dt * rate).exp());
        }
        // Wherever the eased camera actually is this frame, the box (without
        // its lead) is never cut off.
        if let Some(keep) = dir.keep {
            let core = Rect::from_center_half_size(keep.center(), (keep.half_size() - Vec2::splat(KEEP_SLACK)).max(Vec2::ZERO));
            o.scale = o.scale.max(zoom_to_fit(next, core, half).min(KEEP_MAX_ZOOM.max(zoom)));
        }
    }
}

/// How much of [`CameraDirector::keep`]'s padding the eased camera may eat
/// into before it's forced out (the rest is a safe margin).
pub const KEEP_SLACK: f32 = 40.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shot_zooms_out_to_keep_the_box() {
        let half = Vec2::new(VIEW_W, VIEW_H) * 0.5;
        let pip = Rect::from_center_half_size(Vec2::new(0.0, 60.0), Vec2::splat(100.0));
        // Already in frame: the shot is untouched.
        assert_eq!(fit_shot(Vec2::new(0.0, 100.0), 0.6, pip, half, KEEP_MAX_ZOOM), (Vec2::new(0.0, 100.0), 0.6));
        // Looking up at the sky: zoom out until Pip is in.
        let (t, z) = fit_shot(Vec2::new(0.0, 500.0), 1.0, pip, half, KEEP_MAX_ZOOM);
        assert_eq!(t, Vec2::new(0.0, 500.0));
        assert!(z > 1.0 && z <= KEEP_MAX_ZOOM && zoom_to_fit(t, pip, half) <= z + 1e-4);
        // Too far even fully out: the shot slides toward Pip.
        let (t, z) = fit_shot(Vec2::new(0.0, 3000.0), 1.8, pip, half, KEEP_MAX_ZOOM);
        assert!((z - KEEP_MAX_ZOOM).abs() < 1e-4 && t.y < 3000.0);
        assert!(zoom_to_fit(t, pip, half) <= z + 1e-4, "Pip still out of frame");
    }

    /// The blob stays on screen all the way into every exit cave.
    #[test]
    fn exit_cave_keeps_the_blob_framed() {
        for level in bb_level::campaign::campaign() {
            let Some(m) = level.mouths.iter().find(|m| m.kind == bb_level::MouthKind::Exit) else { continue };
            let f = m.facing.signum();
            for k in 0..=24 {
                let d = -700.0 + k as f32 * 50.0;
                if d > m.size.x - 40.0 {
                    break;
                }
                let p = Vec2::new(m.pos.x + f * d, m.pos.y + 32.0);
                for done in [false, true] {
                    let c = exit_framing(&level, p, done).unwrap_or(p + Vec2::new(0.0, CAM_LIFT));
                    assert!((c.x - p.x).abs() < VIEW_W * 0.5 - 120.0 && (c.y - p.y).abs() < VIEW_H * 0.5 - 80.0, "{}: blob at {p} off screen (camera {c})", level.id);
                }
            }
        }
    }
}
