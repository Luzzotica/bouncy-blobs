//! Capture mode: clean frames for trailers and social clips.
//!
//! * `BB_CAPTURE=1` — no HUD, tips, letterbox, skip hint or other screen UI.
//!   Gameplay is unchanged. Works with `BB_LEVEL`, `BB_START` and the title.
//! * `BB_CAPTURE_SIZE=1080x1920` (or `1920x1080`) — frame size. Portrait
//!   frames keep the landscape view's world height as their width (a
//!   narrower, closer view), so the game fills the frame with no bars.
//! * `BB_CAPTURE_OUT=/path/clip.mp4 BB_CAPTURE_FRAMES=n` — headless render:
//!   exactly n frames, each one a fixed slice of sim time (1/60 s at 1×,
//!   independent of the wall clock), streamed into ffmpeg (H.264, 60 fps,
//!   yuv420p, `BB_CAPTURE_CRF`, default 16). Exits when the file is done.
//!   An output ending in `.png` writes every frame as a lossless PNG
//!   (`<stem>_0001.png`, …) instead, for stills.
//! * `BB_CAPTURE_SPEED=0.25` — slow motion: 1/240 s of sim per frame. Body
//!   outlines are interpolated between sim steps so it stays smooth.
//! * `BB_CAPTURE_START=t` — pre-roll t sim ticks (1/60 s, run at 1×) before
//!   the first recorded frame.
//! * `BB_CAPTURE_CAM=follow|tight|static:x,y|reveal:x,y|followx:y`, `BB_CAPTURE_ZOOM=z`
//!   (1 = normal view, smaller = closer), `BB_CAPTURE_PULL=z0,z1` (zoom eases
//!   z0 → z1 over the clip; with `reveal:x,y` the centre also eases from Pip
//!   to x,y).
//! * `BB_CAPTURE_LIFT=px` — view centre this far above Pip (follow modes;
//!   default 200 portrait, 40 landscape).
//! * `BB_CAPTURE_TRACK=k` — follow stiffness × k (e.g. 20 to stay locked
//!   on a fast fall).
//! * `BB_CAPTURE_AT=x,y` — put Pip at x,y when the level loads (shot setup).
//! * `BB_CAPTURE_NO_PICKUPS=1` — clear the level's glow-drop amoebas at
//!   load (as if already eaten), for shots that mustn't show Pip eating one.
//! * `BB_CAPTURE_RESPAWN=s`, `BB_CAPTURE_RESPAWN_AT=x,y` — after a pop,
//!   Pip's next life comes s seconds later at x,y (`x,y;x,y;...` cycles
//!   through several; capture only, the level and checkpoints are unchanged).
//! * `BB_CAPTURE_SHOW=ui` — transparent mode keeps the jelly UI tiles and
//!   their lettering (the logo) instead of the blobs.
//! * `BB_CAPTURE_HIDE=chars` — hide characters and floating effect words
//!   (background plates).
//! * `BB_CAPTURE_UI=1` — keep screen UI (title-menu text, HUD) anyway.
//! * `BB_TAP=target@f[-g];...` — scripted touches (finger down on tick f,
//!   up after g, default f+6). Targets: `x,y` (world), `chip:green` (a Kids
//!   Mode colour chip), `blob:n` (player slot n's blob).
//! * Headless runs also write `<out>.audio.tsv`: every sound the game
//!   started during the clip (asset path, start/end in clip seconds, gain,
//!   speed, loop) so `scripts/capture.sh` can rebuild the soundtrack from
//!   the game's own clips. Playback itself is muted (nothing comes out of
//!   the speakers).
//!
//! Scripted input is `BB_PRESS` (see `devtools`); in capture mode its frame
//! numbers are sim ticks, so they mean the same thing at any speed.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bevy::camera::ScalingMode;
use bevy::prelude::*;
use bevy::render::view::screenshot::{Screenshot, ScreenshotCaptured};
use bevy::time::TimeUpdateStrategy;

use crate::camera::{CAM_LIFT, MainCamera, VIEW_H, VIEW_W};
use crate::sim::Game;

/// One sim tick (matches `Time::<Fixed>::from_hz(60.0)` in `sim`).
pub fn tick() -> Duration {
    Duration::from_secs_f64(1.0 / 60.0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CamMode {
    /// Follow Pip, Pip near the middle.
    Follow,
    /// Follow Pip closely (default zoom 0.45).
    Tight,
    /// Look at a fixed point.
    Static(Vec2),
    /// Start on Pip, ease to a fixed point over the clip (with `PULL`).
    Reveal(Vec2),
    /// Follow Pip sideways only, at a fixed centre height.
    FollowX(f32),
}

#[derive(Clone, Debug, PartialEq)]
pub struct CaptureConfig {
    pub size: UVec2,
    pub out: Option<PathBuf>,
    pub frames: u32,
    pub speed: f32,
    pub start: u32,
    pub cam: CamMode,
    pub zoom: Option<f32>,
    pub pull: Option<(f32, f32)>,
    pub at: Option<Vec2>,
    pub crf: u32,
    pub keep_ui: bool,
    /// Transparent stills: only blobs and their faces are drawn, over alpha 0.
    pub transparent: bool,
    /// Transparent mode keeps UI tiles (logo) instead of blobs.
    pub show_ui: bool,
    /// Hide characters and effect words (background plates).
    pub hide_chars: bool,
    /// Seconds from a pop to the next life (capture only; game default 1.1).
    pub respawn: Option<f32>,
    /// Where Pip comes back after each pop, cycling (capture only; not a
    /// level change).
    pub respawn_at: Vec<Vec2>,
    pub no_pickups: bool,
    /// World px the view centre sits above Pip (at zoom 1).
    pub lift: Option<f32>,
    /// Follow stiffness multiplier (higher = the camera keeps up with fast
    /// falls).
    pub track: f32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        CaptureConfig {
            size: UVec2::new(1920, 1080),
            out: None,
            frames: 300,
            speed: 1.0,
            start: 0,
            cam: CamMode::Follow,
            zoom: None,
            pull: None,
            at: None,
            crf: 16,
            keep_ui: false,
            transparent: false,
            show_ui: false,
            hide_chars: false,
            respawn: None,
            respawn_at: Vec::new(),
            no_pickups: false,
            lift: None,
            track: 1.0,
        }
    }
}

fn pair(s: &str, sep: char) -> Option<(f32, f32)> {
    let (a, b) = s.split_once(sep)?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

impl CaptureConfig {
    /// Parse from `BB_CAPTURE*` variables (`get` looks one up). `None` when
    /// capture mode is off.
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Option<CaptureConfig> {
        let flag = get("BB_CAPTURE").is_some_and(|v| !v.is_empty() && v != "0");
        let out = get("BB_CAPTURE_OUT").filter(|s| !s.is_empty()).map(PathBuf::from);
        if !flag && out.is_none() {
            return None;
        }
        let mut c = CaptureConfig { out, ..default() };
        if let Some((w, h)) = get("BB_CAPTURE_SIZE").and_then(|s| pair(&s.to_lowercase(), 'x')) {
            // Even sizes: yuv420p needs them.
            c.size = UVec2::new((w as u32).max(16) & !1, (h as u32).max(16) & !1);
        }
        let num = |k: &str| get(k).and_then(|s| s.trim().parse::<f32>().ok());
        if let Some(n) = num("BB_CAPTURE_FRAMES") {
            c.frames = (n as u32).max(1);
        }
        if let Some(s) = num("BB_CAPTURE_SPEED") {
            c.speed = s.clamp(0.01, 1.0);
        }
        if let Some(s) = num("BB_CAPTURE_START") {
            c.start = s.max(0.0) as u32;
        }
        if let Some(z) = num("BB_CAPTURE_ZOOM") {
            c.zoom = Some(z.max(0.05));
        }
        c.lift = num("BB_CAPTURE_LIFT");
        if let Some(t) = num("BB_CAPTURE_TRACK") {
            c.track = t.clamp(0.1, 100.0);
        }
        if let Some(q) = num("BB_CAPTURE_CRF") {
            c.crf = q as u32;
        }
        c.pull = get("BB_CAPTURE_PULL").and_then(|s| pair(&s, ','));
        c.at = get("BB_CAPTURE_AT").and_then(|s| pair(&s, ',')).map(|(x, y)| Vec2::new(x, y));
        c.keep_ui = get("BB_CAPTURE_UI").is_some_and(|v| v == "1");
        c.transparent = get("BB_CAPTURE_TRANSPARENT").is_some_and(|v| v == "1");
        c.show_ui = get("BB_CAPTURE_SHOW").is_some_and(|v| v == "ui");
        c.hide_chars = get("BB_CAPTURE_HIDE").is_some_and(|v| v == "chars");
        c.respawn = num("BB_CAPTURE_RESPAWN").map(|s| s.max(0.0));
        c.respawn_at = get("BB_CAPTURE_RESPAWN_AT").map(|s| s.split(';').filter_map(|p| pair(p, ',')).map(|(x, y)| Vec2::new(x, y)).collect()).unwrap_or_default();
        c.no_pickups = get("BB_CAPTURE_NO_PICKUPS").is_some_and(|v| v == "1");
        if let Some(m) = get("BB_CAPTURE_CAM") {
            let (kind, arg) = m.split_once(':').unwrap_or((m.as_str(), ""));
            let pt = pair(arg, ',').map(|(x, y)| Vec2::new(x, y));
            c.cam = match (kind, pt) {
                ("tight", _) => CamMode::Tight,
                ("static", Some(p)) => CamMode::Static(p),
                ("reveal", Some(p)) => CamMode::Reveal(p),
                ("followx", _) => arg.trim().parse().map_or(CamMode::Follow, CamMode::FollowX),
                _ => CamMode::Follow,
            };
        }
        Some(c)
    }

    pub fn portrait(&self) -> bool {
        self.size.y > self.size.x
    }

    /// Minimum world area the camera shows at zoom 1. Landscape is the game's
    /// usual view; portrait keeps the same world height as its width.
    pub fn base_view(&self) -> Vec2 {
        if self.portrait() { Vec2::new(VIEW_H, VIEW_H) } else { Vec2::new(VIEW_W, VIEW_H) }
    }

    /// Zoom at recorded frame `r` (0-based).
    pub fn zoom_at(&self, r: u32) -> f32 {
        let base = self.zoom.unwrap_or(if self.cam == CamMode::Tight { 0.45 } else { 1.0 });
        match self.pull {
            Some((z0, z1)) => z0 + (z1 - z0) * self.ease_at(r),
            None => base,
        }
    }

    /// 0..1 smooth ease over the clip (for pulls and reveals).
    pub fn ease_at(&self, r: u32) -> f32 {
        let t = (r as f32 / (self.frames.max(2) - 1) as f32).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    /// Headless (offscreen, fixed-step video render).
    pub fn headless(&self) -> bool {
        self.out.is_some()
    }
}

/// Sim time (ns) elapsed after `r` recorded frames at `speed`. Exact
/// multiples of the tick land on frame boundaries (4 frames = 1 tick at
/// 0.25×), so the fixed loop never drifts.
pub fn sim_nanos_after(r: u64, speed: f32, tick: Duration) -> u64 {
    let t = tick.as_nanos() as f64;
    ((r as f64) * t * speed as f64 + 1e-6).floor() as u64
}

/// Time to advance for recorded frame `r` (0-based).
pub fn frame_delta(r: u64, speed: f32, tick: Duration) -> Duration {
    Duration::from_nanos(sim_nanos_after(r + 1, speed, tick) - sim_nanos_after(r, speed, tick))
}

/// Capture settings for this run (`None` = capture off).
pub fn config() -> Option<&'static CaptureConfig> {
    static C: OnceLock<Option<CaptureConfig>> = OnceLock::new();
    C.get_or_init(|| CaptureConfig::parse(|k| std::env::var(k).ok())).as_ref()
}

/// True when capture mode is on.
pub fn on() -> bool {
    config().is_some()
}

/// Run condition: capture mode is off (for tips and other screen clutter).
pub fn off() -> bool {
    !on()
}

/// Sim ticks elapsed (for `BB_PRESS` in capture mode), from virtual time.
pub fn press_tick(time: &Time<Virtual>) -> u32 {
    (time.elapsed().as_nanos() / tick().as_nanos()) as u32
}

pub struct CapturePlugin;

impl Plugin for CapturePlugin {
    fn build(&self, app: &mut App) {
        let Some(cfg) = config() else { return };
        if std::env::var("BB_TAP").is_ok() {
            app.add_systems(PreUpdate, tap.before(bevy::input::InputSystems));
        }
        app.init_resource::<CapCam>()
            .init_resource::<ShapeLerp>()
            .add_systems(PostStartup, setup_camera)
            .add_systems(PostUpdate, place_pip.run_if(resource_added::<Game>))
            .add_systems(FixedPostUpdate, capture_respawn.run_if(resource_exists::<Game>))
            .add_systems(
                PostUpdate,
                frame_camera.in_set(crate::camera::CameraFraming).after(crate::camera::follow),
            );
        if cfg.transparent {
            app.add_systems(Startup, |mut c: ResMut<ClearColor>| c.0 = Color::NONE);
        }
        if cfg.transparent || cfg.hide_chars {
            app.add_systems(
                PostUpdate,
                filter_view.after(crate::backdrop::BackdropSystems).before(bevy::camera::visibility::VisibilitySystems::VisibilityPropagate),
            );
        }
        if !cfg.keep_ui {
            app.add_systems(PostUpdate, hide_ui.before(bevy::camera::visibility::VisibilitySystems::VisibilityPropagate));
        }
        if cfg.headless() {
            app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::ZERO))
                .insert_resource(Recorder::default())
                .add_systems(PostStartup, offscreen)
                .add_systems(FixedPostUpdate, snapshot_shapes.run_if(resource_exists::<Game>))
                .add_systems(
                    RunFixedMainLoop,
                    (
                        restore_shapes.in_set(RunFixedMainLoopSystems::BeforeFixedMainLoop),
                        lerp_shapes.in_set(RunFixedMainLoopSystems::AfterFixedMainLoop),
                    ),
                )
                .insert_resource(bevy::audio::GlobalVolume::from(bevy::audio::Volume::SILENT))
                .init_resource::<AudioLog>()
                .add_systems(Last, (log_audio, record).chain());
        } else {
            app.add_systems(Startup, size_window);
        }
    }
}

// ───────────────────────────────────────────────────────────── camera

#[derive(Resource, Default)]
struct CapCam {
    centre: Option<Vec2>,
    /// Pip popped during the shot: keep holding the framing (even after
    /// the respawn), so the pop and its droplets stay the subject.
    lost: bool,
}

fn setup_camera(mut cams: Query<&mut Projection, With<MainCamera>>) {
    let Some(cfg) = config() else { return };
    let v = cfg.base_view();
    for mut p in cams.iter_mut() {
        if let Projection::Orthographic(o) = p.as_mut() {
            o.scaling_mode = ScalingMode::AutoMin { min_width: v.x, min_height: v.y };
        }
    }
}

/// The recorded frame index (0 before recording starts).
fn rec_frame(rec: Option<&Recorder>) -> u32 {
    rec.and_then(|r| r.frame.checked_sub(r.first)).unwrap_or(0) as u32
}

fn frame_camera(
    game: Option<Res<Game>>,
    dir: Res<crate::camera::CameraDirector>,
    rec: Option<Res<Recorder>>,
    time: Res<Time>,
    mut state: ResMut<CapCam>,
    mut cam: Query<(&mut Transform, &mut Projection), With<MainCamera>>,
) {
    let Some(cfg) = config() else { return };
    let Ok((mut tf, mut proj)) = cam.single_mut() else { return };
    let r = rec_frame(rec.as_deref());
    let pip = game.as_ref().and_then(|g| {
        let p = g.sim.players.first().filter(|p| p.dead.is_none())?;
        let b = g.sim.world.body(p.ctl.body)?;
        let (c, v) = (b.centroid(), b.velocity());
        Some((Vec2::new(c.x, c.y), Vec2::new(v.x, v.y)))
    });
    // Menus and cutscenes drive their own camera; leave them alone unless
    // the shot asks for a zoom or a fixed point.
    // Pip popped (or between lives) mid-shot: hold the framing rather than
    // swinging off to the respawn point, so the pop stays in frame.
    if pip.is_none() && game.is_some() && state.centre.is_some() {
        state.lost = true;
    }
    let pip = pip.filter(|_| !state.lost);
    let held = state.lost;
    let directed = dir.target.is_some() || (pip.is_none() && !held);
    let asked = cfg.zoom.is_some() || cfg.pull.is_some() || !matches!(cfg.cam, CamMode::Follow | CamMode::Tight);
    if directed && !asked {
        return;
    }
    let zoom = cfg.zoom_at(r);
    let dt = time.delta_secs();
    let follow = |state: &mut CapCam, lead: f32| -> Option<Vec2> {
        let Some((p, v)) = pip else { return state.centre };
        // Portrait: Pip sits in the lower-middle so the frame shows the
        // space Pip bounces into, not a half-frame of rock below.
        let lift = cfg.lift.unwrap_or(if cfg.portrait() { 200.0 } else { CAM_LIFT * 0.5 }) * zoom;
        let target = p + Vec2::new((v.x * 0.2 * lead).clamp(-100.0, 100.0) * zoom, lift);
        let cur = state.centre.unwrap_or(target);
        // Lazier vertically so a bounce doesn't bob the whole frame.
        // Closer views track harder, so Pip stays put in a tight frame.
        let tight = cfg.track / zoom.clamp(0.2, 1.0);
        let kx = 1.0 - (-dt * 4.0 * tight).exp();
        let ky = 1.0 - (-dt * 2.2 * tight).exp();
        let next = Vec2::new(cur.x + (target.x - cur.x) * kx, cur.y + (target.y - cur.y) * ky);
        state.centre = Some(next);
        Some(next)
    };
    let centre = match cfg.cam {
        CamMode::Follow => follow(&mut state, 1.0),
        CamMode::Tight => follow(&mut state, 0.0),
        CamMode::Static(p) => Some(p),
        CamMode::Reveal(p) => Some(follow(&mut state, 0.0).map_or(p, |f| f.lerp(p, cfg.ease_at(r)))),
        CamMode::FollowX(y) => follow(&mut state, 0.5).map(|f| Vec2::new(f.x, y)),
    };
    if let Some(c) = centre.filter(|_| !directed || !matches!(cfg.cam, CamMode::Follow | CamMode::Tight)) {
        tf.translation.x = c.x;
        tf.translation.y = c.y;
    }
    if let Projection::Orthographic(o) = proj.as_mut() {
        o.scale = zoom;
    }
}

/// `BB_CAPTURE_AT=x,y`: put Pip there once the level is loaded.
/// `BB_CAPTURE_NO_PICKUPS=1`: clear the glow drops.
fn place_pip(mut game: ResMut<Game>, mut state: ResMut<CapCam>) {
    state.centre = None;
    state.lost = false;
    let Some(cfg) = config() else { return };
    if cfg.no_pickups {
        let sim = &mut game.sim;
        for i in 0..sim.amoebas.len() {
            if let Some(id) = sim.amoebas[i].take() {
                sim.collected[i] = true;
                sim.tags.remove(&id);
                sim.world.remove_body(id);
            }
        }
    }
    if let Some(d) = cfg.respawn {
        game.sim.rules.respawn_delay = d;
    }
    let Some(at) = cfg.at else { return };
    let bodies: Vec<_> = game.sim.players.iter().map(|p| p.ctl.body).collect();
    for b in bodies {
        game.sim.world.respawn(b, bb_physics::Vec2::new(at.x, at.y));
    }
}

/// `BB_CAPTURE_RESPAWN_AT`: a life that just began starts there instead.
fn capture_respawn(mut game: ResMut<Game>, mut was_dead: Local<Vec<bool>>, mut lives: Local<usize>) {
    let Some(pts) = config().map(|c| &c.respawn_at).filter(|p| !p.is_empty()) else { return };
    let dead: Vec<bool> = game.sim.players.iter().map(|p| p.dead.is_some()).collect();
    let back: Vec<_> = game.sim.players.iter().enumerate().filter(|(i, p)| p.dead.is_none() && was_dead.get(*i).copied().unwrap_or(false)).map(|(_, p)| p.ctl.body).collect();
    for b in back {
        let at = pts[*lives % pts.len()];
        *lives += 1;
        game.sim.world.respawn(b, bb_physics::Vec2::new(at.x, at.y));
    }
    *was_dead = dead;
}

/// Hide every root UI node (HUD, letterbox, skip hint, fades, toasts).
fn hide_ui(mut roots: Query<&mut Visibility, (With<Node>, Without<ChildOf>)>) {
    for mut v in roots.iter_mut() {
        if *v != Visibility::Hidden {
            *v = Visibility::Hidden;
        }
    }
}

/// Windowed capture: size the window to the capture size (logical px).
fn size_window(mut windows: Query<&mut Window>) {
    let Some(cfg) = config() else { return };
    for mut w in windows.iter_mut() {
        w.resize_constraints = default();
        w.resolution.set(cfg.size.x as f32, cfg.size.y as f32);
    }
}

// ───────────────────────────────────────────────── slow-motion shapes

/// Outline interpolation between sim steps (headless slow motion): every
/// body is drawn between its previous and current step, then put back
/// exactly before the next step, so the sim itself never sees it.
#[derive(Resource, Default)]
struct ShapeLerp {
    prev: std::collections::HashMap<bb_sim::BodyId, Vec<bb_physics::Vec2>>,
    cur: std::collections::HashMap<bb_sim::BodyId, Vec<bb_physics::Vec2>>,
    /// First point as drawn, to spot bodies something else moved meanwhile.
    drawn: std::collections::HashMap<bb_sim::BodyId, bb_physics::Vec2>,
}

fn slow() -> bool {
    config().is_some_and(|c| c.speed < 0.999)
}

fn snapshot_shapes(game: Res<Game>, mut s: ResMut<ShapeLerp>) {
    if !slow() {
        return;
    }
    let s = s.as_mut();
    std::mem::swap(&mut s.prev, &mut s.cur);
    s.cur.clear();
    for (id, b) in game.sim.world.bodies() {
        if b.enabled {
            s.cur.insert(id, b.x.clone());
        }
    }
}

fn restore_shapes(game: Option<ResMut<Game>>, mut s: ResMut<ShapeLerp>) {
    let Some(mut game) = game else { return };
    let drawn = std::mem::take(&mut s.drawn);
    for (id, first) in drawn {
        let (Some(cur), Some(b)) = (s.cur.get(&id), game.sim.world.body_mut(id)) else { continue };
        if b.x.len() == cur.len() && b.x.first() == Some(&first) {
            b.x.copy_from_slice(cur);
        }
    }
}

fn lerp_shapes(game: Option<ResMut<Game>>, mut s: ResMut<ShapeLerp>, fixed: Res<Time<Fixed>>, mut interp: ResMut<crate::sim::Interp>) {
    // Fixed-step frames land exactly on (or between) steps: draw the sim as
    // it is (or blended here), never the centroid-only offset.
    interp.alpha = 1.0;
    let Some(mut game) = game else { return };
    if !slow() {
        return;
    }
    let a = fixed.overstep_fraction().clamp(0.0, 1.0);
    let s = s.as_mut();
    s.drawn.clear();
    for (id, cur) in &s.cur {
        let (Some(prev), Some(b)) = (s.prev.get(id), game.sim.world.body_mut(*id)) else { continue };
        if prev.len() != cur.len() || b.x.len() != cur.len() || b.x[..] != cur[..] {
            continue;
        }
        // A teleport (respawn) shouldn't smear.
        if (prev[0] - cur[0]).length() > 200.0 {
            continue;
        }
        for i in 0..cur.len() {
            b.x[i] = prev[i] + (cur[i] - prev[i]) * a;
        }
        s.drawn.insert(*id, b.x[0]);
    }
}

// ─────────────────────────────────────────────────────── recording

#[derive(Resource)]
struct CaptureTarget(Handle<Image>);

fn offscreen(mut commands: Commands, mut images: ResMut<Assets<Image>>, cams: Query<Entity, With<MainCamera>>) {
    use bevy::camera::RenderTarget;
    use bevy::render::render_resource::TextureFormat;
    let Some(cfg) = config() else { return };
    let image = Image::new_target_texture(cfg.size.x, cfg.size.y, TextureFormat::Rgba8UnormSrgb, None);
    let handle = images.add(image);
    for cam in cams.iter() {
        commands.entity(cam).insert(RenderTarget::Image(handle.clone().into()));
    }
    commands.insert_resource(CaptureTarget(handle));
}

type Frames = Arc<Mutex<std::collections::BTreeMap<u32, Vec<u8>>>>;

#[derive(Resource)]
struct Recorder {
    /// Updates so far.
    frame: u64,
    /// Update at which recording starts (after warm-up + pre-roll).
    first: u64,
    /// Updates spent waiting for assets with the clock stopped.
    warm: u64,
    started: Instant,
    requested: u32,
    written: u32,
    frames: Frames,
    ffmpeg: Option<(Child, ChildStdin)>,
    failed: bool,
}

impl Default for Recorder {
    fn default() -> Self {
        Recorder {
            frame: 0,
            first: u64::MAX,
            warm: 0,
            started: Instant::now(),
            requested: 0,
            written: 0,
            frames: default(),
            ffmpeg: None,
            failed: false,
        }
    }
}

/// Warm-up: the clock stays stopped (no sim steps) for this many updates
/// and at least `WARM_SECS` of wall time, so textures and fonts are loaded
/// before anything moves.
const WARM_FRAMES: u64 = 30;
const WARM_SECS: f32 = 2.0;

fn spawn_ffmpeg(cfg: &CaptureConfig, out: &std::path::Path) -> std::io::Result<(Child, ChildStdin)> {
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"])
        .arg(format!("{}x{}", cfg.size.x, cfg.size.y))
        .args(["-r", "60", "-i", "-"]);
    if out.extension().is_some_and(|e| e == "png") {
        // Stills: every recorded frame as a lossless PNG, `<stem>_0001.png`…
        let stem = out.with_extension("");
        cmd.args(["-pix_fmt", if cfg.transparent { "rgba" } else { "rgb24" }, "-f", "image2"]).arg(format!("{}_%04d.png", stem.display()));
    } else {
        cmd.args(["-c:v", "libx264", "-preset", "slow", "-crf"])
            .arg(cfg.crf.to_string())
            .args(["-pix_fmt", "yuv420p", "-movflags", "+faststart"])
            .arg(out);
    }
    let mut child = cmd.stdin(Stdio::piped()).spawn()?;
    let stdin = child.stdin.take().expect("piped stdin");
    Ok((child, stdin))
}

fn record(
    mut commands: Commands,
    mut rec: ResMut<Recorder>,
    mut strategy: ResMut<TimeUpdateStrategy>,
    target: Option<Res<CaptureTarget>>,
    log: Res<AudioLog>,
    mut exit: MessageWriter<AppExit>,
) {
    let Some(cfg) = config() else { return };
    let Some(out) = cfg.out.clone() else { return };
    let rec = rec.as_mut();
    rec.frame += 1;
    // Warm-up with the clock stopped, then pre-roll at 1×.
    if rec.first == u64::MAX {
        if rec.frame >= WARM_FRAMES && rec.started.elapsed().as_secs_f32() >= WARM_SECS {
            rec.warm = rec.frame;
            rec.first = rec.frame + cfg.start as u64 + 1;
            info!("capture: warm-up done after {} updates; recording from update {}", rec.warm, rec.first);
        } else {
            *strategy = TimeUpdateStrategy::ManualDuration(Duration::ZERO);
            return;
        }
    }
    // Clock for the NEXT update.
    let next = rec.frame + 1;
    *strategy = TimeUpdateStrategy::ManualDuration(if next >= rec.first { frame_delta(next - rec.first, cfg.speed, tick()) } else { tick() });

    // This update is a recorded frame: grab it.
    if rec.frame >= rec.first && rec.requested < cfg.frames && !rec.failed {
        if rec.ffmpeg.is_none() {
            match spawn_ffmpeg(cfg, &out) {
                Ok(f) => rec.ffmpeg = Some(f),
                Err(e) => {
                    error!("capture: can't start ffmpeg: {e}");
                    rec.failed = true;
                }
            }
        }
        if let Some(t) = &target {
            let i = rec.requested;
            let frames = rec.frames.clone();
            let size = cfg.size;
            let transparent = cfg.transparent;
            commands.spawn(Screenshot::image(t.0.clone())).observe(move |shot: On<ScreenshotCaptured>| {
                let img = &shot.image;
                let Some(data) = img.data.as_ref() else { return };
                let want = (size.x * size.y * 4) as usize;
                if data.len() != want {
                    error!("capture: frame {i} is {} bytes, expected {want}", data.len());
                    return;
                }
                let mut data = data.clone();
                if transparent {
                    unpremultiply(&mut data);
                }
                frames.lock().unwrap().insert(i, data);
            });
            rec.requested += 1;
        }
    }
    // Write frames that came back, in order.
    loop {
        let next = rec.written;
        let Some(data) = rec.frames.lock().unwrap().remove(&next) else { break };
        if let Some((_, stdin)) = rec.ffmpeg.as_mut() {
            if let Err(e) = stdin.write_all(&data) {
                error!("capture: ffmpeg write failed: {e}");
                rec.failed = true;
            }
        }
        rec.written += 1;
    }
    let done = rec.written >= cfg.frames;
    let stuck = rec.first != u64::MAX && rec.frame > rec.first + cfg.frames as u64 + 600;
    if done || rec.failed || stuck {
        if stuck && !done {
            error!("capture: only {} of {} frames came back", rec.written, cfg.frames);
        }
        write_audio_log(&log, rec.first, cfg.start, &out);
        if let Some((mut child, stdin)) = rec.ffmpeg.take() {
            drop(stdin);
            match child.wait() {
                Ok(s) if s.success() && done => info!("capture: wrote {} frames to {}", rec.written, out.display()),
                Ok(s) => error!("capture: ffmpeg exited with {s}"),
                Err(e) => error!("capture: ffmpeg: {e}"),
            }
        }
        exit.write(if done && !rec.failed { AppExit::Success } else { AppExit::error() });
        // Don't exit twice.
        rec.failed = true;
        rec.written = 0;
        rec.requested = u32::MAX;
    }
}

// ─────────────────────────────────────────────────── transparent stills

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.powf(1.0 / 2.4) - 0.055 }
}

/// The render target holds alpha-blended colour over a clear of alpha 0,
/// i.e. premultiplied colour (blending happens in linear space; the texture
/// stores sRGB). Turn RGBA8 sRGB-premultiplied into straight alpha so the
/// PNG composites cleanly in an editor: glows keep their colour instead of
/// darkening toward black at the edges.
pub fn unpremultiply(rgba: &mut [u8]) {
    for px in rgba.chunks_exact_mut(4) {
        let a = px[3];
        if a == 0 {
            px[0] = 0;
            px[1] = 0;
            px[2] = 0;
        } else if a < 255 {
            let af = a as f32 / 255.0;
            for c in &mut px[..3] {
                let lin = srgb_to_linear(*c as f32 / 255.0) / af;
                *c = (linear_to_srgb(lin.min(1.0)) * 255.0).round() as u8;
            }
        }
    }
}

/// What a capture frame keeps. Transparent mode (`BB_CAPTURE_TRANSPARENT`)
/// hides everything except, by `BB_CAPTURE_SHOW`: `blobs` (default: player
/// and NPC blobs and their faces) or `ui` (jelly UI tiles and their
/// lettering, e.g. the logo). `BB_CAPTURE_HIDE=chars` (any mode) hides just
/// the characters (players, NPCs, their faces) and floating effect words,
/// for empty background plates. Glimmer is never kept.
#[allow(clippy::type_complexity)]
fn filter_view(
    game: Option<Res<Game>>,
    mut q: Query<
        (&mut Visibility, Option<&crate::render::BodyVisual>, Option<&crate::render::Face>, Option<&crate::softtext::SoftText>),
        (Or<(With<Mesh2d>, With<Sprite>, With<Text2d>, With<crate::softtext::SoftText>)>, Without<crate::softtext::SoftGlyph>),
    >,
) {
    let Some(cfg) = config() else { return };
    let tag = |id: bb_sim::BodyId| game.as_ref().and_then(|g| g.sim.tag(id));
    let is_char = |id: bb_sim::BodyId| match tag(id) {
        Some(bb_sim::BodyTag::Player(_) | bb_sim::BodyTag::Npc(_)) => true,
        _ => false,
    };
    let glimmer = |id: bb_sim::BodyId| match tag(id) {
        Some(bb_sim::BodyTag::Npc(i)) => game.as_ref().is_some_and(|g| g.sim.npc_role(i) == Some(&bb_level::NpcRole::Glimmer)),
        _ => false,
    };
    let is_ui = |id: bb_sim::BodyId| matches!(tag(id), Some(bb_sim::BodyTag::Ui));
    for (mut v, body, face, text) in q.iter_mut() {
        let id = body.map(|b| b.id).or(face.map(|f| f.body)).or(text.and_then(|t| t.body()));
        let show = if cfg.transparent {
            match (cfg.show_ui, id) {
                (false, Some(id)) => is_char(id) && !glimmer(id) && text.is_none(),
                (true, Some(id)) => is_ui(id),
                (_, None) => false,
            }
        } else {
            // Opaque plate: only characters and floating words go.
            let hide = match id {
                Some(id) => is_char(id),
                None => text.is_some(),
            };
            if !hide {
                continue;
            }
            false
        };
        let want = if show { Visibility::Inherited } else { Visibility::Hidden };
        if *v != want {
            *v = want;
        }
    }
}

// ──────────────────────────────────────────────────────────── taps

#[derive(Clone, Debug, PartialEq)]
pub enum TapTarget {
    World(Vec2),
    Chip(String),
    Blob(u8),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tap {
    pub target: TapTarget,
    pub down: u32,
    pub up: u32,
}

pub fn parse_taps(spec: &str) -> Vec<Tap> {
    spec.split(';')
        .filter_map(|item| {
            let (t, when) = item.trim().rsplit_once('@')?;
            let (down, up) = match when.split_once('-') {
                Some((a, b)) => (a.parse().ok()?, b.parse().ok()?),
                None => {
                    let a: u32 = when.parse().ok()?;
                    (a, a + 6)
                }
            };
            let target = if let Some(c) = t.strip_prefix("chip:") {
                TapTarget::Chip(c.to_string())
            } else if let Some(n) = t.strip_prefix("blob:") {
                TapTarget::Blob(n.parse().ok()?)
            } else {
                let (x, y) = pair(t, ',')?;
                TapTarget::World(Vec2::new(x, y))
            };
            Some(Tap { target, down, up: up.max(down + 1) })
        })
        .collect()
}

fn tap_world(t: &TapTarget, game: Option<&Game>, kids: Option<&crate::kids::Kids>) -> Option<Vec2> {
    match t {
        TapTarget::World(p) => Some(*p),
        TapTarget::Chip(name) => kids?
            .ui
            .iter()
            .find(|u| matches!(u.kind, crate::kids::ui::UiKind::Chip(c) if crate::kids::lessons::color_name(c) == name))
            .map(|u| Vec2::new(u.center.x, u.center.y)),
        TapTarget::Blob(n) => {
            let g = game?;
            let b = g.sim.world.body(g.sim.player(*n)?.ctl.body)?;
            let c = b.centroid();
            Some(Vec2::new(c.x, c.y))
        }
    }
}

/// `BB_TAP`: synthetic touches, as if a finger pressed the screen there.
fn tap(
    vtime: Res<Time<Virtual>>,
    game: Option<Res<Game>>,
    kids: Option<Res<crate::kids::Kids>>,
    cam: Query<(&Camera, &GlobalTransform), With<MainCamera>>,
    mut out: MessageWriter<bevy::input::touch::TouchInput>,
    mut frame: Local<u32>,
    mut held: Local<std::collections::HashMap<usize, Vec2>>,
) {
    use bevy::input::touch::{TouchInput, TouchPhase};
    *frame += 1;
    let f = if config().is_some_and(|c| c.headless()) { press_tick(&vtime) } else { *frame };
    let Ok((camera, tf)) = cam.single() else { return };
    let taps = parse_taps(&std::env::var("BB_TAP").unwrap_or_default());
    for (i, t) in taps.iter().enumerate() {
        let on = f >= t.down && f < t.up;
        let phase = match (on, held.contains_key(&i)) {
            (true, false) => TouchPhase::Started,
            (true, true) => TouchPhase::Moved,
            (false, true) => TouchPhase::Ended,
            (false, false) => continue,
        };
        let pos = if phase == TouchPhase::Ended {
            held.remove(&i)
        } else {
            tap_world(&t.target, game.as_deref(), kids.as_deref()).and_then(|w| camera.world_to_viewport(tf, w.extend(0.0)).ok())
        };
        let Some(pos) = pos else { continue };
        if phase != TouchPhase::Ended {
            held.insert(i, pos);
        }
        if phase == TouchPhase::Started {
            info!("capture: tap {:?} at tick {f}", t.target);
        }
        out.write(TouchInput { phase, position: pos, window: Entity::PLACEHOLDER, force: None, id: 900 + i as u64 });
    }
}

// ─────────────────────────────────────────────────────────── audio log

/// Sounds the game started, for rebuilding the clip's soundtrack offline.
#[derive(Resource, Default)]
struct AudioLog {
    open: std::collections::HashMap<Entity, usize>,
    rows: Vec<AudioRow>,
}

struct AudioRow {
    path: String,
    /// When it started / stopped: (update, sim seconds).
    start: (u64, f64),
    end: Option<(u64, f64)>,
    gain: f32,
    speed: f32,
    looped: bool,
}

/// Clip time (s) of a stamp: 0 at the first recorded frame, one frame =
/// 1/60 s. Before that it's sim time before recording began (the warm-up
/// has the clock stopped, so it doesn't count), i.e. negative.
fn clip_secs((frame, sim): (u64, f64), first: u64, start_ticks: u32) -> f64 {
    if first != u64::MAX && frame >= first {
        (frame - first) as f64 / 60.0
    } else {
        sim - start_ticks as f64 / 60.0
    }
}

#[allow(clippy::type_complexity)]
fn log_audio(
    mut log: ResMut<AudioLog>,
    rec: Res<Recorder>,
    server: Res<AssetServer>,
    settings: Option<Res<crate::audio::AudioSettings>>,
    added: Query<(Entity, &AudioPlayer, &PlaybackSettings, Option<&crate::audio::Music>), Added<AudioPlayer>>,
    mut gone: RemovedComponents<AudioPlayer>,
    vtime: Res<Time<Virtual>>,
) {
    // `record` runs after this and counts this update then.
    let now = (rec.frame + 1, vtime.elapsed_secs_f64());
    for e in gone.read() {
        if let Some(i) = log.open.remove(&e) {
            log.rows[i].end = Some(now);
        }
    }
    for (e, player, ps, music) in added.iter() {
        // Music knows its track; other clips by their asset path (sounds
        // synthesised in memory have none and can't be rebuilt).
        let path = match (music, server.get_path(player.0.id())) {
            (Some(m), _) => m.track.to_string(),
            (None, Some(p)) => p.path().to_string_lossy().into_owned(),
            (None, None) => {
                debug!("capture: unnamed sound at update {}", now.0);
                continue;
            }
        };
        let gain = match music {
            Some(m) => m.gain * settings.as_ref().map_or(0.255, |s| s.music_gain()),
            None => match ps.volume {
                bevy::audio::Volume::Linear(v) => v,
                v => v.to_linear(),
            },
        };
        let row = AudioRow { path, start: now, end: None, gain, speed: ps.speed, looped: matches!(ps.mode, bevy::audio::PlaybackMode::Loop) };
        let i = log.rows.len();
        log.open.insert(e, i);
        log.rows.push(row);
    }
}

fn write_audio_log(log: &AudioLog, first: u64, start_ticks: u32, out: &std::path::Path) {
    let mut s = String::from("start\tend\tgain\tspeed\tloop\tpath\n");
    for r in &log.rows {
        let (start, end) = (clip_secs(r.start, first, start_ticks), r.end.map(|e| clip_secs(e, first, start_ticks)));
        let end = end.map_or(String::new(), |e| format!("{e:.4}"));
        s += &format!("{start:.4}\t{end}\t{:.4}\t{:.3}\t{}\t{}\n", r.gain, r.speed, r.looped as u8, r.path);
    }
    let p = format!("{}.audio.tsv", out.display());
    if let Err(e) = std::fs::write(&p, s) {
        error!("capture: can't write {p}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(vars: &[(&str, &str)]) -> Option<CaptureConfig> {
        let map: std::collections::HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        CaptureConfig::parse(|k| map.get(k).cloned())
    }

    #[test]
    fn off_without_vars() {
        assert!(cfg(&[]).is_none());
        assert!(cfg(&[("BB_CAPTURE", "0")]).is_none());
        assert!(cfg(&[("BB_CAPTURE", "1")]).is_some());
        // An output path alone switches it on (headless).
        let c = cfg(&[("BB_CAPTURE_OUT", "/tmp/x.mp4")]).unwrap();
        assert!(c.headless());
    }

    #[test]
    fn parses_everything() {
        let c = cfg(&[
            ("BB_CAPTURE", "1"),
            ("BB_CAPTURE_SIZE", "1080x1920"),
            ("BB_CAPTURE_FRAMES", "420"),
            ("BB_CAPTURE_SPEED", "0.25"),
            ("BB_CAPTURE_START", "90"),
            ("BB_CAPTURE_CAM", "static:120,-40.5"),
            ("BB_CAPTURE_ZOOM", "0.6"),
            ("BB_CAPTURE_PULL", "0.4,1.6"),
            ("BB_CAPTURE_AT", "300,500"),
            ("BB_CAPTURE_TRACK", "20"),
        ])
        .unwrap();
        assert_eq!(c.size, UVec2::new(1080, 1920));
        assert!(c.portrait() && !c.headless());
        assert_eq!((c.frames, c.speed, c.start), (420, 0.25, 90));
        assert_eq!(c.cam, CamMode::Static(Vec2::new(120.0, -40.5)));
        assert_eq!(c.zoom, Some(0.6));
        assert_eq!(c.pull, Some((0.4, 1.6)));
        assert_eq!(c.at, Some(Vec2::new(300.0, 500.0)));
        assert_eq!(c.track, 20.0);
        let r = cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_RESPAWN", "0.3"), ("BB_CAPTURE_RESPAWN_AT", "10600,2100;10700,2100")]).unwrap();
        assert_eq!((r.respawn, r.respawn_at), (Some(0.3), vec![Vec2::new(10600.0, 2100.0), Vec2::new(10700.0, 2100.0)]));
        assert_eq!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_CAM", "tight")]).unwrap().cam, CamMode::Tight);
        assert_eq!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_CAM", "reveal:1,2")]).unwrap().cam, CamMode::Reveal(Vec2::new(1.0, 2.0)));
        assert_eq!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_CAM", "followx:360")]).unwrap().cam, CamMode::FollowX(360.0));
        // Bad values fall back.
        let c = cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_CAM", "static:nope"), ("BB_CAPTURE_SIZE", "big")]).unwrap();
        assert_eq!(c.cam, CamMode::Follow);
        assert_eq!(c.size, UVec2::new(1920, 1080));
        // Odd sizes round down to even (yuv420p).
        assert_eq!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_SIZE", "1081X1919")]).unwrap().size, UVec2::new(1080, 1918));
    }

    #[test]
    fn portrait_view_fills_the_frame() {
        let p = cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_SIZE", "1080x1920")]).unwrap();
        // AutoMin over a 9:16 frame: width = VIEW_H, height = VIEW_H * 16/9.
        assert_eq!(p.base_view(), Vec2::new(VIEW_H, VIEW_H));
        let l = cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_SIZE", "1920x1080")]).unwrap();
        assert_eq!(l.base_view(), Vec2::new(VIEW_W, VIEW_H));
    }

    #[test]
    fn one_tick_per_frame_at_full_speed() {
        let t = tick();
        for r in 0..600 {
            assert_eq!(frame_delta(r, 1.0, t), t);
        }
        assert_eq!(sim_nanos_after(60, 1.0, t), t.as_nanos() as u64 * 60);
    }

    #[test]
    fn quarter_speed_is_four_frames_per_tick() {
        let t = tick();
        let tn = t.as_nanos() as u64;
        // Every 4th frame boundary is an exact tick, so the fixed loop steps
        // exactly once per 4 frames and never drifts.
        for k in 0..300u64 {
            assert_eq!(sim_nanos_after(4 * k, 0.25, t), k * tn);
        }
        // 240 frames (4 s of video) = 60 ticks = 1 s of sim.
        let total: u64 = (0..240).map(|r| frame_delta(r, 0.25, t).as_nanos() as u64).sum();
        assert_eq!(total, 60 * tn);
        // Steps per frame, simulated like Time<Fixed>::expend.
        let mut acc = 0u64;
        let mut steps = Vec::new();
        for r in 0..16 {
            acc += frame_delta(r, 0.25, t).as_nanos() as u64;
            let mut n = 0;
            while acc >= tn {
                acc -= tn;
                n += 1;
            }
            steps.push(n);
        }
        assert_eq!(steps, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }

    #[test]
    fn unpremultiply_restores_straight_colour() {
        // Opaque and empty pixels.
        let mut px = [200u8, 100, 50, 255, 9, 9, 9, 0];
        unpremultiply(&mut px);
        assert_eq!(px, [200, 100, 50, 255, 0, 0, 0, 0]);
        // A white glow at 50% over transparent: stored premultiplied as
        // linear 0.5 (sRGB ~188); straight it is white again.
        let mut g = [188u8, 188, 188, 128];
        unpremultiply(&mut g);
        assert!(g[0] >= 253, "{g:?}");
        assert_eq!(g[3], 128);
        assert!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_TRANSPARENT", "1")]).unwrap().transparent);
    }

    #[test]
    fn tap_specs() {
        let t = parse_taps("600,200@120; chip:green@200-230;blob:2@300;nope@x");
        assert_eq!(t.len(), 3);
        assert_eq!(t[0], Tap { target: TapTarget::World(Vec2::new(600.0, 200.0)), down: 120, up: 126 });
        assert_eq!(t[1], Tap { target: TapTarget::Chip("green".into()), down: 200, up: 230 });
        assert_eq!(t[2].target, TapTarget::Blob(2));
    }

    #[test]
    fn audio_stamps_map_to_clip_time() {
        // Recording starts at update 300 after 120 pre-roll ticks.
        assert_eq!(clip_secs((360, 3.0), 300, 120), 1.0);
        // Started during the pre-roll, 0.5 s of sim before frame 1.
        assert_eq!(clip_secs((250, 1.5), 300, 120), -0.5);
        // During the warm-up (clock stopped at 0): the whole pre-roll before.
        assert_eq!(clip_secs((5, 0.0), u64::MAX, 120), -2.0);
    }

    #[test]
    fn pull_eases_from_z0_to_z1() {
        let c = cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_FRAMES", "300"), ("BB_CAPTURE_PULL", "0.5,2")]).unwrap();
        assert_eq!(c.zoom_at(0), 0.5);
        assert!((c.zoom_at(299) - 2.0).abs() < 1e-5);
        let mid = c.zoom_at(150);
        assert!(mid > 1.1 && mid < 1.4, "{mid}");
        assert_eq!(cfg(&[("BB_CAPTURE", "1"), ("BB_CAPTURE_CAM", "tight")]).unwrap().zoom_at(10), 0.45);
    }
}
