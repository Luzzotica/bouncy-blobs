//! The in-game half of scene files (`BB_SCENE_FILE`): cast setup, player
//! inputs per cast member (written into the game's input slots, the same
//! path a keyboard, pad or phone uses), respawn events and seeded variation,
//! the camera timeline, the per-frame checks (cast members and the POP!
//! word against the frame), `length.until`, and the event log. Results go
//! to `BB_SCENE_CHECK` as JSON for `bb-scene`.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;
use std::sync::atomic::Ordering;

use bevy::camera::ScalingMode;
use bevy::prelude::*;
use serde::Serialize;
use serde_json::Value;

use crate::camera::MainCamera;
use crate::scene::{CamKey, Held, Scene};
use crate::sim::{Game, Inputs, SimMsg};

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

fn seed() -> u32 {
    std::env::var("BB_SCENE_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0)
}

fn recording() -> Option<&'static crate::replay::Recording> {
    static R: OnceLock<Option<crate::replay::Recording>> = OnceLock::new();
    R.get_or_init(|| {
        let s = scene()?;
        let p = s.replay.as_ref()?;
        // Relative to the scene file.
        let base = std::path::Path::new(&std::env::var("BB_SCENE_FILE").ok()?).parent()?.to_path_buf();
        let path = if std::path::Path::new(p).is_absolute() { std::path::PathBuf::from(p) } else { base.join(p) };
        crate::replay::load(&path.to_string_lossy()).map_err(|e| error!("scene: {e}")).ok()
    })
    .as_ref()
}

fn plan() -> &'static [Held] {
    static P: OnceLock<Vec<Held>> = OnceLock::new();
    P.get_or_init(|| scene().map_or_else(Vec::new, |s| crate::scene::input_plan(s, seed())))
}

pub struct SceneRunPlugin;

impl Plugin for SceneRunPlugin {
    fn build(&self, app: &mut App) {
        if scene().is_none() {
            return;
        }
        app.init_resource::<SceneState>()
            // After capture's Pip placement, so the cast's own spawns win.
            .add_systems(PostUpdate, setup_cast.after(crate::capture::place_pip).run_if(resource_added::<Game>))
            .add_systems(PreUpdate, drive_cast.after(crate::input::GatherInput))
            .add_systems(FixedPostUpdate, lives.run_if(resource_exists::<Game>))
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
    entered: Option<(usize, Vec2, Vec2)>,
    now: Option<(Vec2, Vec2)>,
    frozen: Option<(usize, Vec2)>,
    frames: Vec<FrameCheck>,
    events: Vec<EventRow>,
    written: bool,
    dead: HashMap<u8, bool>,
    lives: HashMap<u8, u32>,
    until_hits: u32,
    /// Seeded variation actually used, for NOTES.
    vary_log: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FrameCheck {
    pub frame: u32,
    /// Cast members' boxes in frame fractions [x0, y0, x1, y1] (y down).
    pub boxes: BTreeMap<String, [f32; 4]>,
    pub speeds: BTreeMap<String, f32>,
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
    vary: &'a [String],
    frames: &'a [FrameCheck],
    events: &'a [EventRow],
}

/// Spawn the cast: Pip is slot 0 (the stage's own player when it has one),
/// the rest are extra players in slots 1.. with their colour, shape and spawn.
fn setup_cast(mut game: ResMut<Game>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    st.follower = None;
    st.entered = None;
    st.now = None;
    if s.pip().and_then(|c| c.can_die) == Some(false) {
        game.sim.rules.players_pop = false;
    }
    if let Some(d) = s.capture("respawn_delay").and_then(|c| c.value.as_f64()) {
        game.sim.rules.respawn_delay = d as f32;
    }
    // A replay rebuilds the stage it was played on: refuse a different one.
    if let Some(r) = recording() {
        let now = crate::replay::level_hash(&game.sim.level);
        if now != r.level_hash {
            match s.allow_old_stage.as_deref().filter(|x| !x.trim().is_empty()) {
                Some(why) => st.vary_log.push(format!("replay recorded on a different version of {} (build {}); allowed: {why}", r.level, r.build)),
                None => {
                    error!(
                        "scene: the replay was recorded on build {} where {} looked different (level hash {} vs {now} now). Re-record it on this build, or set \"allow_old_stage\": \"<reason>\".",
                        r.build, r.level, r.level_hash
                    );
                    std::process::exit(3);
                }
            }
        }
    }
    // The stage brought its own Pip but this cast has none: take him out.
    if s.pip().is_none() && !s.cast.iter().any(|c| c.from_stage == Some(true)) {
        game.sim.remove_player(0);
    }
    for c in s.members() {
        let Some(slot) = s.slot_of(&c.id) else { continue };
        let color = s.color_of(c);
        if game.sim.player(slot).is_none() {
            game.sim.add_player(slot, &c.id, color);
        }
        let Some(p) = game.sim.player_mut(slot) else { continue };
        p.color = color;
        p.name = c.id.clone();
        let body = p.ctl.body;
        if let Some(sh) = c.shape.as_deref() {
            let shape = match sh {
                "star" => crate::kids::level::KidsShape::Star,
                "square" => crate::kids::level::KidsShape::Square,
                _ => crate::kids::level::KidsShape::Triangle,
            };
            if let Some(b) = game.sim.world.body_mut(body) {
                b.set_rest_shape(&shape.outline());
            }
        }
        if c.can_die == Some(false) {
            if let Some(b) = game.sim.world.body_mut(body) {
                b.params.limits.poppable = false;
            }
        }
        let replay_start = (slot == 0).then(recording).flatten().map(|r| r.start);
        if let Some([x, y]) = c.spawn.or(replay_start) {
            game.sim.world.respawn(body, bb_physics::Vec2::new(x, y));
        }
        st.events.push(EventRow { kind: "spawn", frame: None, t: -s.pre_roll, x: c.spawn.map_or(0.0, |p| p[0]), y: c.spawn.map_or(0.0, |p| p[1]), who: c.id.clone() });
    }
}

/// Write each cast member's input for this sim tick into its input slot.
fn drive_cast(mut inputs: ResMut<Inputs>, vtime: Res<Time<Virtual>>, game: Option<Res<Game>>) {
    let Some(s) = scene() else { return };
    if game.is_none() {
        return;
    }
    let tick = crate::capture::press_tick(&vtime) as i64;
    for c in s.members() {
        let Some(slot) = s.slot_of(&c.id) else { continue };
        let i = slot as usize;
        inputs.slots[i] = match (slot, recording()) {
            // Replayed on the sim's own tick count, so it lines up step for step.
            (0, Some(r)) => r.input_at(game.as_ref().map_or(0, |g| g.tick)),
            _ => crate::scene::input_at(plan(), slot, tick),
        };
        inputs.active[i] = true;
    }
}

/// New lives: respawn events and seeded respawn_x.
fn lives(mut game: ResMut<Game>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    let t = frame_now().unwrap_or(0) as f32 / 60.0;
    let slots: Vec<(u8, bool, bb_sim::BodyId)> = game.sim.players.iter().map(|p| (p.slot, p.dead.is_some(), p.ctl.body)).collect();
    for (slot, dead, body) in slots {
        let was = st.dead.insert(slot, dead).unwrap_or(false);
        if !(was && !dead) {
            continue;
        }
        let life = {
            let l = st.lives.entry(slot).or_insert(0);
            *l += 1;
            *l
        };
        let who = s.id_of_slot(slot).unwrap_or("").to_string();
        let at = s.events.iter().filter(|e| e.r#do == "respawn" && e.who == who && e.t <= t).filter_map(|e| e.at).last();
        let dx = crate::scene::respawn_shift(s, seed(), slot, life);
        if at.is_none() && dx == 0.0 {
            continue;
        }
        let Some(b) = game.sim.world.body(body) else { continue };
        let c = b.centroid();
        let [x, y] = at.unwrap_or([c.x, c.y]);
        game.sim.world.respawn(body, bb_physics::Vec2::new(x + dx, y));
        if dx != 0.0 {
            st.vary_log.push(format!("{who} life {life}: respawn x {:+.1}", dx));
        }
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

fn who_list(v: &Option<Value>) -> Vec<String> {
    match v {
        None => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    }
}

/// Centre, velocity and size (world) of a group of cast members.
fn group(game: &Game, s: &Scene, who: &[String]) -> Option<(Vec2, Vec2, Vec2)> {
    let mut lo = Vec2::splat(f32::MAX);
    let mut hi = Vec2::splat(f32::MIN);
    let mut vel = Vec2::ZERO;
    let mut n = 0.0;
    for w in who {
        let Some(slot) = s.slot_of(w) else { continue };
        let Some(p) = game.sim.player(slot).filter(|p| p.dead.is_none()) else { continue };
        let Some(b) = game.sim.world.body(p.ctl.body) else { continue };
        for x in &b.x {
            lo = lo.min(Vec2::new(x.x, x.y));
            hi = hi.max(Vec2::new(x.x, x.y));
        }
        let v = b.velocity();
        vel += Vec2::new(v.x, v.y);
        n += 1.0;
    }
    // Width of the whole group's boxes (outline points plus the skin).
    let r = 2.0;
    let d = 2.0 * bb_sim::control::tune::RADIUS;
    (n > 0.0).then(|| ((lo + hi) * 0.5, vel / n, Vec2::new((hi.x - lo.x + 2.0 * r).max(d), (hi.y - lo.y + 2.0 * r).max(d))))
}

fn scene_camera(game: Option<Res<Game>>, time: Res<Time>, mut st: ResMut<SceneState>, mut cam: Query<(&mut Transform, &mut Projection), With<MainCamera>>) {
    let Some(s) = scene() else { return };
    let Ok((mut tf, mut proj)) = cam.single_mut() else { return };
    let t = frame_now().unwrap_or(0).max(0) as f32 / 60.0;
    let floor = std::env::var("BB_SCENE_VIEW_FLOOR").ok().and_then(|v| {
        let (a, b) = v.split_once(',')?;
        Some(Vec2::new(a.parse().ok()?, b.parse().ok()?))
    });
    let moves: Vec<(usize, &CamKey)> = s.camera.iter().enumerate().filter(|(_, k)| !matches!(k.r#do.as_str(), "timescale" | "shake")).collect();
    let region = s.stage.region.map(|[x0, y0, x1, y1]| (Vec2::new((x0 + x1) * 0.5, (y0 + y1) * 0.5), Vec2::new((x1 - x0).abs(), (y1 - y0).abs())));
    let apply = |tf: &mut Transform, proj: &mut Projection, p: Vec2, v: Vec2| {
        tf.translation.x = p.x;
        tf.translation.y = p.y;
        let v = floor.map_or(v, |f| v.max(f));
        if let Projection::Orthographic(o) = proj {
            o.scaling_mode = ScalingMode::AutoMin { min_width: v.x.max(1.0), min_height: v.y.max(1.0) };
            o.scale = 1.0;
        }
    };
    let active = moves.iter().rev().find(|(_, k)| k.t <= t + 1e-6).or(moves.first()).copied();
    let Some((ki, key)) = active else {
        if let Some((p, v)) = region {
            apply(&mut tf, &mut proj, p, v);
        }
        return;
    };
    let who = {
        let w = who_list(&key.who);
        if w.is_empty() { s.members().first().map(|c| vec![c.id.clone()]).unwrap_or_default() } else { w }
    };
    let subject = game.as_ref().and_then(|g| group(g, s, &who));
    let subj = subject.map_or(Vec2::splat(2.0 * bb_sim::control::tune::RADIUS), |g| g.2);
    if let Some((p, v, _)) = subject {
        let fk = (key.r#do == "follow").then_some(key);
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
    let (cur_pos, cur_view) = st.now.unwrap_or_else(|| region.unwrap_or((subject.map_or(Vec2::ZERO, |p| p.0), Vec2::new(860.0, 860.0))));
    if st.entered.is_none_or(|e| e.0 != ki) {
        st.entered = Some((ki, cur_pos, cur_view));
        if key.r#do == "frame" {
            if let Some((p, _, _)) = subject {
                st.frozen = Some((ki, p));
            }
        }
    }
    let (_, pos0, view0) = st.entered.unwrap();
    let off = key.offset.map_or(Vec2::ZERO, |[x, y]| Vec2::new(x, y));
    let target_pos = match key.r#do.as_str() {
        "hold" | "zoom" => pos0,
        "follow" => st.follower.unwrap_or(pos0),
        _ => match key.at {
            Some([x, y]) => Vec2::new(x, y),
            None => st.frozen.filter(|f| f.0 == ki).map_or(pos0, |f| f.1) + off,
        },
    };
    // Each output frames itself: subject_width sets only the width.
    let target_view = match (key.subject_width, key.view) {
        // The group's height gets the same share of the frame height, so a
        // spread-out group (one up on a cap, one below) stays in too.
        (Some(f), _) => Vec2::new(subj.x / f, if who.len() > 1 { subj.y / f } else { 1.0 }),
        (None, Some([w, h])) => Vec2::new(w.max(1.0), h.max(1.0)),
        (None, None) => view0,
    };
    let u = match key.by {
        Some(by) if by > 0.0 => eased(key.ease.as_deref(), (t - key.t) / by),
        _ => 1.0,
    };
    let u = if ki == moves[0].0 && st.now.is_none() { 1.0 } else { u };
    let pos = pos0.lerp(target_pos, u);
    // lock_zoom: one fixed view for the whole shot; only the position moves.
    let view = match s.locked_view() {
        Some([w, h]) => Vec2::new(w, h),
        None => view0.lerp(target_view, u),
    };
    st.now = Some((pos, view));
    let mut shake = Vec2::ZERO;
    for (i, k) in s.camera.iter().enumerate().filter(|(_, k)| k.r#do == "shake") {
        let d = k.by.unwrap_or(0.6).max(0.01);
        let uu = (t - k.t) / d;
        if (0.0..1.0).contains(&uu) {
            let w = t * 60.0 + i as f32 * 7.0;
            shake += Vec2::new((w * 1.3).sin(), (w * 1.7).cos()) * k.amount.unwrap_or(8.0) * (1.0 - uu);
        }
    }
    apply(&mut tf, &mut proj, pos + shake, view);
}

fn log_events(game: Option<Res<Game>>, mut reader: MessageReader<SimMsg>, mut st: ResMut<SceneState>) {
    let Some(s) = scene() else { return };
    let Some(f) = frame_now() else {
        reader.clear();
        return;
    };
    let t = f as f32 / 60.0;
    let frame = (f >= 0).then_some(f as u32);
    let id = |slot: u8| s.id_of_slot(slot).map_or_else(|| format!("player{slot}"), String::from);
    let who_body = |b: bb_sim::BodyId| -> Option<String> {
        match game.as_ref()?.sim.tag(b)? {
            bb_sim::BodyTag::Player(i) => Some(id(i)),
            _ => None,
        }
    };
    let who_of = |w: &bb_sim::Who| match w {
        bb_sim::Who::Player(i) => Some(id(*i)),
        bb_sim::Who::Npc(_) => None,
    };
    let body_pos = |w: &bb_sim::Who| -> Vec2 {
        let g = game.as_ref();
        match w {
            bb_sim::Who::Player(i) => g.and_then(|g| g.sim.player(*i)).and_then(|p| g.and_then(|g| g.sim.world.body(p.ctl.body))).map_or(Vec2::ZERO, |b| {
                let c = b.centroid();
                Vec2::new(c.x, c.y)
            }),
            _ => Vec2::ZERO,
        }
    };
    for SimMsg(e) in reader.read() {
        use bb_sim::SimEvent as E;
        let mut rows: Vec<EventRow> = Vec::new();
        let mut row = |kind: &'static str, x: f32, y: f32, who: String| rows.push(EventRow { kind, frame, t, x, y, who });
        match e {
            E::Popped { who, pos, .. } => {
                if let Some(w) = who_of(who) {
                    row("pop", pos.x, pos.y, w.clone());
                    row("death", pos.x, pos.y, w);
                }
            }
            E::Respawned { who, pos } => {
                if let Some(w) = who_of(who) {
                    row("respawn", pos.x, pos.y, w);
                }
            }
            E::Impact { body, pos, speed } if *speed >= 220.0 => {
                if let Some(w) = who_body(*body) {
                    row("land", pos.x, pos.y, w);
                }
            }
            E::Action { who, action: bb_sim::control::Action::Jump | bb_sim::control::Action::WallJump } => {
                if let Some(w) = who_of(who) {
                    let p = body_pos(who);
                    row("jump", p.x, p.y, w);
                }
            }
            _ => {}
        }
        for r in rows {
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
    let mut boxes = BTreeMap::new();
    let mut speeds = BTreeMap::new();
    if let Some(g) = game.as_ref() {
        for c in s.members() {
            let Some(slot) = s.slot_of(&c.id) else { continue };
            let Some(p) = g.sim.player(slot).filter(|p| p.dead.is_none()) else { continue };
            let Some(b) = g.sim.world.body(p.ctl.body) else { continue };
            let r = b.params.radius;
            let (mut lo, mut hi) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
            for x in &b.x {
                lo = lo.min(Vec2::new(x.x - r, x.y - r));
                hi = hi.max(Vec2::new(x.x + r, x.y + r));
            }
            if let Some(bx) = boxify(&[lo, hi, Vec2::new(lo.x, hi.y), Vec2::new(hi.x, lo.y)]) {
                boxes.insert(c.id.clone(), bx);
                speeds.insert(c.id.clone(), b.velocity().length());
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
    st.frames.push(FrameCheck { frame, boxes, speeds, words: word_boxes });
    if frame + 1 >= limit && !st.written {
        st.written = true;
        if let Ok(path) = std::env::var("BB_SCENE_CHECK") {
            let mut vary = st.vary_log.clone();
            for (i, d) in crate::scene::input_shifts(s, seed()).iter().enumerate() {
                if *d != 0.0 {
                    vary.push(format!("input {} ({} {} at {} s): {:+.3} s", i + 1, s.inputs[i].who, s.inputs[i].r#do, s.inputs[i].t, d));
                }
            }
            let file = CheckFile { build: crate::build_info::COMMIT, seed: seed(), size: [size.x, size.y], vary: &vary, frames: &st.frames, events: &st.events };
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
}
