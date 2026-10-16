//! The in-game half of scene files (`BB_SCENE_FILE`): the camera timeline,
//! cast setup, respawn events, the per-frame checks (Pip and the POP! word
//! against the frame), `length.until`, and the event log (pops, landings,
//! splashes, with frame numbers). Results go to `BB_SCENE_CHECK` as JSON
//! for `bb-scene` to read.

use std::sync::OnceLock;
use std::sync::atomic::Ordering;

use bevy::camera::ScalingMode;
use bevy::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::camera::MainCamera;
use crate::scene::{CamKey, Scene};
use crate::sim::{Game, SimMsg};

pub fn scene() -> Option<&'static Scene> {
    static S: OnceLock<Option<Scene>> = OnceLock::new();
    S.get_or_init(|| {
        let path = std::env::var("BB_SCENE_FILE").ok()?;
        let text = std::fs::read_to_string(&path).map_err(|e| error!("scene: can't read {path}: {e}")).ok()?;
        crate::scene::parse(&text).map_err(|e| error!("scene: {e}")).ok()
    })
    .as_ref()
}

pub fn shows(what: &str) -> bool {
    scene().is_some_and(|s| s.show.iter().any(|x| x == what))
}

pub struct SceneRunPlugin;

impl Plugin for SceneRunPlugin {
    fn build(&self, app: &mut App) {
        if scene().is_none() {
            return;
        }
        app.init_resource::<SceneState>()
            .add_systems(PostUpdate, setup_cast.run_if(resource_added::<Game>))
            .add_systems(FixedPostUpdate, respawn_events.run_if(resource_exists::<Game>))
            .add_systems(
                PostUpdate,
                scene_camera.in_set(crate::camera::CameraFraming).after(crate::camera::follow).after(crate::capture::CaptureCamera),
            )
            .add_systems(Update, log_events)
            .add_systems(
                PostUpdate,
                check_frame.after(bevy::transform::TransformSystems::Propagate).after(bevy::camera::CameraUpdateSystems),
            );
    }
}

/// Recorded frame of this update (negative in the pre-roll), None in warm-up.
pub fn frame_now() -> Option<i64> {
    let f = crate::capture::NEXT_FRAME.load(Ordering::Relaxed);
    (f != i64::MIN).then_some(f)
}

#[derive(Resource, Default)]
struct SceneState {
    follower: Option<Vec2>,
    /// Camera at the moment the active key took over: (key index, pos, view).
    entered: Option<(usize, Vec2, Vec2)>,
    /// Where the camera is now (pos, view).
    now: Option<(Vec2, Vec2)>,
    /// `frame` keys freeze Pip's position when they take over.
    frozen: Option<(usize, Vec2)>,
    frames: Vec<FrameCheck>,
    events: Vec<EventRow>,
    written: bool,
    was_dead: bool,
    until_hits: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct FrameCheck {
    pub frame: u32,
    /// Pip's box in frame fractions [x0, y0, x1, y1] (y down); None when
    /// he isn't alive.
    pub subject: Option<[f32; 4]>,
    pub subject_speed: f32,
    /// POP! word boxes (frame fractions).
    pub words: Vec<[f32; 4]>,
}

#[derive(Serialize, Clone, Debug)]
pub struct EventRow {
    pub kind: &'static str,
    /// Recorded frame (0-based); None during the pre-roll.
    pub frame: Option<u32>,
    pub t: f32,
    pub x: f32,
    pub y: f32,
    pub who: String,
}

#[derive(Serialize)]
struct CheckFile<'a> {
    build: &'static str,
    seed: u32,
    size: [u32; 2],
    frames: &'a [FrameCheck],
    events: &'a [EventRow],
}

fn pip_body(game: &Game) -> Option<(Vec2, Vec2, f32)> {
    let p = game.sim.players.first().filter(|p| p.dead.is_none())?;
    let b = game.sim.world.body(p.ctl.body)?;
    let (c, v) = (b.centroid(), b.velocity());
    Some((Vec2::new(c.x, c.y), Vec2::new(v.x, v.y), p.ctl.radius * 2.0))
}

/// Cast setup once the stage is loaded: colour, can_die.
fn setup_cast(mut game: ResMut<Game>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    st.follower = None;
    st.entered = None;
    st.now = None;
    if let Some(p) = game.sim.player_mut(0) {
        if s.has_pip() {
            p.color = s.pip_color();
        }
    }
    if s.pip().and_then(|c| c.can_die) == Some(false) {
        game.sim.rules.players_pop = false;
    }
    if let Some(d) = s.capture("respawn_delay").and_then(|c| c.value.as_f64()) {
        game.sim.rules.respawn_delay = d as f32;
    }
}

/// `respawn` events: a life that begins after the event starts at its `at`.
fn respawn_events(mut game: ResMut<Game>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    let dead = game.sim.players.first().is_some_and(|p| p.dead.is_some());
    let began = st.was_dead && !dead;
    st.was_dead = dead;
    if !began {
        return;
    }
    let t = frame_now().unwrap_or(0) as f32 / 60.0;
    let Some([x, y]) = s.events.iter().filter(|e| e.r#do == "respawn" && e.t <= t).filter_map(|e| e.at).last() else { return };
    if let Some(b) = game.sim.players.first().map(|p| p.ctl.body) {
        game.sim.world.respawn(b, bb_physics::Vec2::new(x, y));
    }
}

fn eased(kind: Option<&str>, u: f32) -> f32 {
    let u = u.clamp(0.0, 1.0);
    match kind {
        Some("linear") => u,
        Some("cut") => 1.0,
        _ => u * u * (3.0 - 2.0 * u),
    }
}

fn lead_of(v: &Option<Value>) -> Vec2 {
    match v {
        Some(Value::Number(n)) => Vec2::new(n.as_f64().unwrap_or(0.0) as f32, 0.0),
        Some(Value::Array(a)) => Vec2::new(a.first().and_then(Value::as_f64).unwrap_or(0.0) as f32, a.get(1).and_then(Value::as_f64).unwrap_or(0.0) as f32),
        _ => Vec2::ZERO,
    }
}

/// The view (AutoMin min_width, min_height) a key asks for, if any. A
/// subject width sets only the width, so every aspect shows Pip at that
/// fraction of its own frame width.
/// With both, `subject_width` sets the width and `view[1]` is a height
/// floor (so a wide frame still shows enough height for a drop).
fn key_view(k: &CamKey, pip_d: f32) -> Option<Vec2> {
    match (k.subject_width, k.view) {
        (Some(f), v) => Some(Vec2::new(pip_d / f, v.map_or(1.0, |v| v[1].max(1.0)))),
        (None, Some([w, h])) => Some(Vec2::new(w.max(1.0), h.max(1.0))),
        (None, None) => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn scene_camera(game: Option<Res<Game>>, time: Res<Time>, mut st: ResMut<SceneState>, mut cam: Query<(&mut Transform, &mut Projection), With<MainCamera>>) {
    let Some(s) = scene() else { return };
    let Ok((mut tf, mut proj)) = cam.single_mut() else { return };
    let t = frame_now().unwrap_or(0).max(0) as f32 / 60.0;
    let pip = game.as_ref().and_then(|g| pip_body(g));
    let pip_d = pip.map_or(64.0, |p| p.2);
    // Moves (everything but timescale/shake) in time order.
    let moves: Vec<(usize, &CamKey)> = s.camera.iter().enumerate().filter(|(_, k)| !matches!(k.r#do.as_str(), "timescale" | "shake")).collect();
    let region = s.stage.region.map(|[x0, y0, x1, y1]| (Vec2::new((x0 + x1) * 0.5, (y0 + y1) * 0.5), Vec2::new((x1 - x0).abs(), (y1 - y0).abs())));
    let active = moves.iter().rev().find(|(_, k)| k.t <= t + 1e-6).or(moves.first()).copied();
    let Some((ki, key)) = active else {
        if let Some((p, v)) = region {
            tf.translation.x = p.x;
            tf.translation.y = p.y;
            if let Projection::Orthographic(o) = proj.as_mut() {
                o.scaling_mode = ScalingMode::AutoMin { min_width: v.x, min_height: v.y };
                o.scale = 1.0;
            }
        }
        return;
    };
    // Follower (always tracked so a follow key starts from a settled spot).
    if let Some((p, v, _)) = pip {
        let fk = if key.r#do == "follow" { Some(key) } else { None };
        let lead = fk.map_or(Vec2::ZERO, |k| lead_of(&k.lead));
        let off = fk.and_then(|k| k.offset).map_or(Vec2::ZERO, |[x, y]| Vec2::new(x, y));
        let target = p + v * lead + off;
        let cur = st.follower.unwrap_or(target);
        let dz = fk.and_then(|k| k.deadzone).map_or(Vec2::ZERO, |[w, h]| Vec2::new(w, h) * 0.5);
        let mut want = cur;
        for i in 0..2 {
            if target[i] > cur[i] + dz[i] {
                want[i] = target[i] - dz[i];
            } else if target[i] < cur[i] - dz[i] {
                want[i] = target[i] + dz[i];
            }
        }
        let lag = fk.and_then(|k| k.lag).unwrap_or(0.0);
        let dt = time.delta_secs();
        let a = if lag <= 0.0 || dt <= 0.0 { 1.0 } else { 1.0 - (-dt / lag).exp() };
        st.follower = Some(if fk.is_some() { cur + (want - cur) * a } else { target });
    }
    let (cur_pos, cur_view) = st.now.unwrap_or_else(|| region.unwrap_or((pip.map_or(Vec2::ZERO, |p| p.0), Vec2::new(860.0, 860.0))));
    if st.entered.is_none_or(|e| e.0 != ki) {
        st.entered = Some((ki, cur_pos, cur_view));
        if key.r#do == "frame" {
            if let Some((p, _, _)) = pip {
                st.frozen = Some((ki, p));
            }
        }
    }
    let (_, pos0, view0) = st.entered.unwrap();
    // Target of this key.
    let off = key.offset.map_or(Vec2::ZERO, |[x, y]| Vec2::new(x, y));
    let target_pos = match key.r#do.as_str() {
        "hold" | "zoom" => pos0,
        "follow" => st.follower.unwrap_or(pos0),
        _ => match key.at {
            Some([x, y]) => Vec2::new(x, y),
            None => st.frozen.filter(|f| f.0 == ki).map_or(pos0, |f| f.1) + off,
        },
    };
    let target_view = key_view(key, pip_d).unwrap_or(view0);
    let u = match key.by {
        Some(by) if by > 0.0 => eased(key.ease.as_deref(), (t - key.t) / by),
        _ => 1.0,
    };
    // The very first key snaps (nothing to come from).
    let u = if ki == moves[0].0 && st.now.is_none() { 1.0 } else { u };
    let pos = pos0.lerp(target_pos, u);
    let view = view0.lerp(target_view, u);
    st.now = Some((pos, view));
    // Shake.
    let mut shake = Vec2::ZERO;
    for (i, k) in s.camera.iter().enumerate().filter(|(_, k)| k.r#do == "shake") {
        let d = k.by.unwrap_or(0.6).max(0.01);
        let uu = (t - k.t) / d;
        if (0.0..1.0).contains(&uu) {
            let w = t * 60.0 + i as f32 * 7.0;
            shake += Vec2::new((w * 1.3).sin(), (w * 1.7).cos()) * k.amount.unwrap_or(8.0) * (1.0 - uu);
        }
    }
    tf.translation.x = pos.x + shake.x;
    tf.translation.y = pos.y + shake.y;
    if let Projection::Orthographic(o) = proj.as_mut() {
        o.scaling_mode = ScalingMode::AutoMin { min_width: view.x.max(1.0), min_height: view.y.max(1.0) };
        o.scale = 1.0;
    }
}

fn log_events(game: Option<Res<Game>>, mut reader: MessageReader<SimMsg>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    let Some(f) = frame_now() else {
        reader.clear();
        return;
    };
    let t = f as f32 / 60.0;
    let frame = (f >= 0).then_some(f as u32);
    let who_body = |b: bb_sim::BodyId| -> String {
        game.as_ref().and_then(|g| g.sim.tag(b)).map_or("other".into(), |tag| match tag {
            bb_sim::BodyTag::Player(i) => format!("player{i}"),
            bb_sim::BodyTag::Npc(i) => format!("npc{i}"),
            _ => "other".into(),
        })
    };
    for SimMsg(e) in reader.read() {
        use bb_sim::SimEvent as E;
        let row = |kind: &'static str, x: f32, y: f32, who: String| EventRow { kind, frame, t, x, y, who };
        let r = match e {
            E::Popped { who, pos, .. } => Some(row("pop", pos.x, pos.y, format!("{who:?}"))),
            E::Respawned { who, pos } => Some(row("respawn", pos.x, pos.y, format!("{who:?}"))),
            E::Impact { body, pos, speed } if *speed >= 220.0 => {
                let w = who_body(*body);
                (w != "other").then(|| {
                    let wet = game.as_ref().is_some_and(|g| {
                        g.sim.players.iter().any(|p| p.ctl.body == *body && p.ctl.in_water > 0.05) || g.sim.npcs.iter().any(|n| n.ctl.body == *body && n.ctl.in_water > 0.05)
                    });
                    row(if wet { "splash" } else { "land" }, pos.x, pos.y, w)
                })
            }
            E::Mushroom { pos, .. } => Some(row("mushroom", pos.x, pos.y, String::new())),
            E::SuperBounce { body, pos } => Some(row("bounce", pos.x, pos.y, who_body(*body))),
            E::Spring { .. } => Some(row("spring", 0.0, 0.0, String::new())),
            E::Checkpoint { pos, .. } => Some(row("checkpoint", pos.x, pos.y, String::new())),
            E::Pickup { pos, .. } => Some(row("pickup", pos.x, pos.y, String::new())),
            _ => None,
        };
        let Some(r) = r else { continue };
        // length.until: stop `plus` seconds after the count-th such event.
        if let (Some(u), Some(fr)) = (s.length.until.as_deref(), r.frame) {
            if u.strip_prefix("event:") == Some(r.kind) {
                st.until_hits += 1;
                if st.until_hits == s.length.count.unwrap_or(1) {
                    let end = fr + (s.length.plus.unwrap_or(0.0) * 60.0).round() as u32 + 1;
                    crate::capture::FRAME_LIMIT.store(end, Ordering::Relaxed);
                }
            }
        }
        st.events.push(r);
    }
}

#[allow(clippy::type_complexity)]
fn check_frame(
    game: Option<Res<Game>>,
    mut st: ResMut<SceneState>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    words: Query<(&crate::softtext::SoftText, &Children), With<crate::fx::Word>>,
    glyphs: Query<(&GlobalTransform, &Visibility), With<crate::softtext::SoftGlyph>>,
) {
    let Some(s) = scene() else { return };
    let Some(cfg) = crate::capture::config() else { return };
    let size = cfg.size;
    let Some(f) = frame_now().filter(|f| *f >= 0) else { return };
    let frame = f as u32;
    let limit = cfg.frames.min(crate::capture::FRAME_LIMIT.load(Ordering::Relaxed));
    if frame >= limit || st.frames.last().is_some_and(|x| x.frame >= frame) {
        return;
    }
    let Ok((camera, ctf)) = cam.single() else { return };
    let (w, h) = (size.x as f32, size.y as f32);
    let to_frac = |p: Vec2| -> Option<Vec2> { camera.world_to_viewport(ctf, p.extend(0.0)).ok().map(|v| Vec2::new(v.x / w, v.y / h)) };
    let boxify = |pts: &[Vec2]| -> Option<[f32; 4]> {
        let fr: Vec<Vec2> = pts.iter().filter_map(|p| to_frac(*p)).collect();
        let first = *fr.first()?;
        let (a, b) = fr.iter().fold((first, first), |(a, b), p| (a.min(*p), b.max(*p)));
        Some([a.x, a.y, b.x, b.y])
    };
    let mut subject = None;
    let mut speed = 0.0;
    if let Some(g) = game.as_ref() {
        if let Some(p) = g.sim.players.first().filter(|p| p.dead.is_none()) {
            if let Some(b) = g.sim.world.body(p.ctl.body) {
                let r = b.params.radius;
                let (mut lo, mut hi) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
                for x in &b.x {
                    lo = lo.min(Vec2::new(x.x - r, x.y - r));
                    hi = hi.max(Vec2::new(x.x + r, x.y + r));
                }
                subject = boxify(&[lo, hi, Vec2::new(lo.x, hi.y), Vec2::new(hi.x, lo.y)]);
                speed = b.velocity().length();
            }
        }
    }
    let mut word_boxes = Vec::new();
    for (txt, kids) in words.iter() {
        if txt.text.trim() != "POP!" {
            continue;
        }
        let half = txt.size * 0.45;
        let mut pts = Vec::new();
        for c in kids.iter() {
            if let Ok((gt, vis)) = glyphs.get(c) {
                if *vis == Visibility::Hidden {
                    continue;
                }
                let p = gt.translation().truncate();
                let sc = gt.scale().truncate().abs().max_element().max(0.01);
                pts.push(p - Vec2::splat(half * sc));
                pts.push(p + Vec2::splat(half * sc));
            }
        }
        if let Some(b) = boxify(&pts) {
            word_boxes.push(b);
        }
    }
    st.frames.push(FrameCheck { frame, subject, subject_speed: speed, words: word_boxes });
    if frame + 1 >= limit && !st.written {
        st.written = true;
        if let Ok(path) = std::env::var("BB_SCENE_CHECK") {
            let seed = std::env::var("BB_SCENE_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
            let file = CheckFile { build: crate::build_info::COMMIT, seed, size: [size.x, size.y], frames: &st.frames, events: &st.events };
            match serde_json::to_string(&file) {
                Ok(j) => {
                    if let Err(e) = std::fs::write(&path, j) {
                        error!("scene: can't write {path}: {e}");
                    }
                }
                Err(e) => error!("scene: {e}"),
            }
        }
    }
    let _ = s;
}
