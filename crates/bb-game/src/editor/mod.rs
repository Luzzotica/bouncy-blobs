//! In-game level editor (`AppState::Editor`), built with bevy_egui.
//!
//! The level being edited is shown with the real game visuals: the editor
//! keeps a **paused** `Game` built from the edited level (so `level_view`
//! and `render` draw terrain, jelly, props, ropes… exactly as in play) and
//! paints selection, handles, zones, and labels on top with egui.
//!
//! * Play-test: Enter / ▶ runs the level in `AppState::Playing` through
//!   `LoadLevel`; Esc comes back with the editor state intact.
//! * Maps: saved as v3 JSON in the platform data dir (web: localStorage);
//!   legacy JSON is imported by drag-and-drop, path, or paste.
//!
//! Dev: `BB_START=editor` boots straight in; `BB_EDIT_LEVEL=<party id | map
//! id | path.json>` opens a level; `BB_EDIT_SELECT=<n>` selects the n-th
//! element (for screenshots).

pub mod library;
pub mod model;
pub mod storage;
pub mod tools;
mod ui;

use bb_level::Level;
use bevy::prelude::*;
use glam::{IVec2, Vec2};
use bevy_egui::{EguiPlugin, EguiPrimaryContextPass};

use crate::camera::CameraDirector;
use crate::flow::AppState;
use crate::sim::{Game, LoadLevel};
use model::{Elem, Item};
use tools::{Tool, ToolOpts};

const UNDO_CAP: usize = 100;

/// An in-progress pointer interaction on the canvas.
#[derive(Clone, Debug)]
pub enum Drag {
    Pan { last: bevy_egui::egui::Pos2 },
    Move { start: Vec2, orig: Level, moved: bool, cycle_to: Option<Elem> },
    Resize { elem: Elem, handle: IVec2, frame: model::Frame, orig: Level },
    Rotate { elem: Elem, frame: model::Frame, start_angle: f32, orig: Level },
    Vertex { elem: Elem, idx: usize, orig: Level, moved: bool },
    Place { start: Vec2, cur: Vec2 },
    BoxSelect { start: Vec2, cur: Vec2, add: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preview {
    /// Up to date (or waiting for the debounce).
    Idle,
    /// Old `Game` removed this frame; insert the new one next frame.
    Removed,
}

#[derive(Resource)]
pub struct Editor {
    pub level: Level,
    /// Local map id (None = never saved).
    pub map_id: Option<String>,
    pub unsaved: bool,
    pub sel: Vec<Elem>,
    pub sel_vertex: Option<usize>,
    pub tool: Tool,
    pub opts: ToolOpts,
    pub undo: Vec<Level>,
    pub redo: Vec<Level>,
    pub clipboard: Vec<Item>,
    /// Camera centre (world) and zoom (projection scale; > 1 = zoomed out).
    pub pan: Vec2,
    pub zoom: f32,
    pub grid: f32,
    pub snap: bool,
    pub show_ids: bool,
    pub show_grid: bool,
    /// Blob reference ghost at the cursor (radius), toggled by B / N / M.
    pub ghost: Option<f32>,
    pub drag: Option<Drag>,
    /// Points of an in-progress polyline placement.
    pub draft: Vec<Vec2>,
    pub cursor: Vec2,
    /// Animate the preview (physics running, no players).
    pub animate: bool,
    pub status: String,
    pub notes: Vec<String>,
    pub open_dialog: bool,
    pub import_text: String,
    pub path_text: String,
    pub request_play: bool,
    /// The primary button went down on the canvas (so its release counts).
    pub armed: bool,
    /// Play-test "back to editor" button.
    pub back_requested: bool,
    pub playtesting: bool,
    play_pending: bool,
    preview: Preview,
    /// Frames to wait before inserting (a removal must be seen first).
    preview_wait: u8,
    preview_dirty: bool,
    /// Seconds since startup of the last edit (debounces preview rebuilds).
    last_edit: f64,
    /// Frames rendered in the editor (dev hooks).
    frames: u32,
    /// Last frame a property-panel edit pushed undo (coalesces drags).
    panel_edit_frame: u32,
    fit_pending: bool,
}

impl Default for Editor {
    fn default() -> Self {
        Editor {
            level: tools::starter_level(),
            map_id: None,
            unsaved: false,
            sel: Vec::new(),
            sel_vertex: None,
            tool: Tool::Select,
            opts: ToolOpts::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            clipboard: Vec::new(),
            pan: Vec2::ZERO,
            zoom: 1.0,
            grid: 20.0,
            snap: true,
            show_ids: true,
            show_grid: true,
            ghost: None,
            drag: None,
            draft: Vec::new(),
            cursor: Vec2::ZERO,
            animate: false,
            status: String::new(),
            notes: Vec::new(),
            open_dialog: false,
            import_text: String::new(),
            path_text: String::new(),
            request_play: false,
            armed: false,
            back_requested: false,
            playtesting: false,
            play_pending: false,
            preview: Preview::Idle,
            preview_wait: 0,
            preview_dirty: true,
            last_edit: -10.0,
            frames: 0,
            panel_edit_frame: 0,
            fit_pending: true,
        }
    }
}

impl Editor {
    /// Record `before` as an undo step (call after mutating).
    pub fn push_undo(&mut self, before: Level) {
        self.undo.push(before);
        if self.undo.len() > UNDO_CAP {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.touch();
    }

    /// Snapshot, mutate, record.
    pub fn edit(&mut self, f: impl FnOnce(&mut Level)) {
        let before = self.level.clone();
        f(&mut self.level);
        self.push_undo(before);
    }

    /// Mark the level changed (preview rebuild + unsaved).
    pub fn touch(&mut self) {
        self.unsaved = true;
        self.preview_dirty = true;
        self.last_edit = f64::MAX; // stamped with real time by the preview system
    }

    pub fn undo(&mut self) {
        if let Some(prev) = self.undo.pop() {
            self.redo.push(std::mem::replace(&mut self.level, prev));
            self.after_history();
        }
    }

    pub fn redo(&mut self) {
        if let Some(next) = self.redo.pop() {
            self.undo.push(std::mem::replace(&mut self.level, next));
            self.after_history();
        }
    }

    fn after_history(&mut self) {
        self.sel.retain(|e| model::exists(&self.level, *e));
        self.sel_vertex = None;
        self.drag = None;
        self.unsaved = true;
        self.preview_dirty = true;
        self.last_edit = f64::MAX;
    }

    pub fn snap_pt(&self, p: Vec2) -> Vec2 {
        if self.snap { model::snap(p, self.grid) } else { p }
    }

    /// Replace the whole level (open / new / import).
    pub fn load(&mut self, level: Level, map_id: Option<String>) {
        self.level = level;
        self.map_id = map_id;
        self.unsaved = false;
        self.sel.clear();
        self.sel_vertex = None;
        self.undo.clear();
        self.redo.clear();
        self.draft.clear();
        self.drag = None;
        self.preview_dirty = true;
        self.last_edit = -10.0;
        self.fit_pending = true;
    }

    pub fn fit(&mut self, win: Vec2) {
        let (min, max) = self.level.bounds();
        let (min, max) = (min.min(self.level.spawn) - Vec2::splat(150.0), max.max(self.level.spawn) + Vec2::splat(150.0));
        self.pan = (min + max) * 0.5;
        let base = (win.x / crate::camera::VIEW_W).min(win.y / crate::camera::VIEW_H).max(1e-3);
        // Leave room for the side panel and toolbar.
        let avail = Vec2::new((win.x - 340.0).max(200.0), (win.y - 120.0).max(200.0));
        let need = max - min;
        self.zoom = (need.x * base / avail.x).max(need.y * base / avail.y).clamp(0.1, 12.0);
        // Centre in the canvas area (the side panel covers the right).
        let ppu = base / self.zoom;
        self.pan += Vec2::new(145.0, 12.0) / ppu;
    }

    pub fn save(&mut self) {
        let id = match &self.map_id {
            Some(id) => id.clone(),
            None => storage::unique_id(if self.level.id.is_empty() { &self.level.name } else { &self.level.id }),
        };
        match storage::save(&id, &self.level) {
            Ok(where_) => {
                self.map_id = Some(id);
                self.unsaved = false;
                self.status = format!("Saved to {where_}");
            }
            Err(e) => self.status = format!("Save failed: {e}"),
        }
    }

    /// Import JSON text (v3 or legacy) as a new unsaved map.
    pub fn import_json(&mut self, text: &str, label: &str) {
        let legacy = bb_level::legacy::is_legacy(text);
        let result = if legacy {
            bb_level::legacy::import_legacy_with(text, &Default::default()).map(|i| (i.level, i.notes)).map_err(|e| e.to_string())
        } else {
            Level::from_json(text).map(|l| (l, Vec::new())).map_err(|e| e.to_string())
        };
        match result {
            Ok((level, notes)) => {
                let n = notes.len();
                self.load(level, None);
                self.unsaved = true;
                self.notes = notes;
                self.status = if legacy {
                    format!("Imported legacy level from {label} ({n} lossy notes, see Level panel)")
                } else {
                    format!("Opened {label}")
                };
            }
            Err(e) => self.status = format!("Import failed ({label}): {e}"),
        }
    }
}

pub struct EditorPlugin;

impl Plugin for EditorPlugin {
    fn build(&self, app: &mut App) {
        // egui needs the render app; skip it in headless (MinimalPlugins) runs.
        let has_render = app.is_plugin_added::<bevy::render::RenderPlugin>();
        if has_render && !app.is_plugin_added::<EguiPlugin>() {
            app.add_plugins(EguiPlugin::default());
        }
        app.init_resource::<Editor>()
            .add_systems(Startup, dev_start)
            .add_systems(OnEnter(AppState::Editor), enter_editor)
            .add_systems(OnExit(AppState::Editor), exit_editor)
            .add_systems(
                Update,
                (sync_preview, drive_camera, dropped_files, start_play).run_if(in_state(AppState::Editor)),
            )
            .add_systems(Update, (playtest_load, playtest_escape).run_if(in_state(AppState::Playing)));
        if has_render {
            app.add_systems(EguiPrimaryContextPass, ui::editor_ui.run_if(in_state(AppState::Editor)))
                .add_systems(EguiPrimaryContextPass, ui::playtest_hint.run_if(in_state(AppState::Playing)));
        }
    }
}

/// `BB_START=editor` boots into the editor; `BB_EDIT_LEVEL` opens a level.
fn dev_start(mut next: ResMut<NextState<AppState>>, mut ed: ResMut<Editor>) {
    if std::env::var("BB_START").as_deref() != Ok("editor") {
        return;
    }
    if let Ok(what) = std::env::var("BB_EDIT_LEVEL") {
        if let Some(l) = library::party_level(&what) {
            ed.load(l, None);
        } else if let Ok(l) = storage::load(&what) {
            ed.load(l, Some(what.clone()));
        } else if let Ok(text) = storage::read_path(&what) {
            ed.import_json(&text, &what);
        }
    }
    next.set(AppState::Editor);
}

fn enter_editor(mut commands: Commands, mut ed: ResMut<Editor>, game: Option<Res<Game>>) {
    // Whatever was running (sandbox, a play-test) goes; the preview is
    // rebuilt next frame.
    if game.is_some() {
        commands.remove_resource::<Game>();
        ed.preview_wait = 1;
    }
    ed.playtesting = false;
    ed.preview = Preview::Removed;
    ed.preview_dirty = false;
}

fn exit_editor(mut commands: Commands, ed: Res<Editor>, mut dir: ResMut<CameraDirector>) {
    *dir = CameraDirector::default();
    if !ed.playtesting {
        commands.remove_resource::<Game>();
    }
}

fn preview_game(ed: &Editor) -> Game {
    let mut g = Game::new(ed.level.clone());
    g.paused = !ed.animate;
    g
}

/// Keep the paused preview `Game` in sync with the edited level. A rebuild
/// is remove-then-insert on consecutive frames so `level_view` / `render`
/// respawn their visuals.
fn sync_preview(mut commands: Commands, mut ed: ResMut<Editor>, game: Option<ResMut<Game>>, time: Res<Time>) {
    let now = time.elapsed_secs_f64();
    if ed.last_edit == f64::MAX {
        ed.last_edit = now;
    }
    match ed.preview {
        Preview::Removed if ed.preview_wait > 0 => ed.preview_wait -= 1,
        Preview::Removed => {
            commands.insert_resource(preview_game(&ed));
            ed.preview = Preview::Idle;
        }
        Preview::Idle => {
            if let Some(mut g) = game {
                g.paused = !ed.animate;
                let dragging = matches!(
                    ed.drag,
                    Some(Drag::Move { .. } | Drag::Resize { .. } | Drag::Rotate { .. } | Drag::Vertex { .. })
                );
                if ed.preview_dirty && !dragging && now - ed.last_edit > 0.12 {
                    commands.remove_resource::<Game>();
                    ed.preview = Preview::Removed;
                    ed.preview_dirty = false;
                }
            } else {
                commands.insert_resource(preview_game(&ed));
                ed.preview_dirty = false;
            }
        }
    }
}

/// Point the game camera at the editor view (and stretch the sky to cover
/// zoomed-out views).
fn drive_camera(
    ed: Res<Editor>,
    mut dir: ResMut<CameraDirector>,
    mut sky: Query<&mut Transform, With<crate::level_view::Sky>>,
) {
    dir.target = Some(bevy::math::Vec2::new(ed.pan.x, ed.pan.y));
    dir.zoom = Some(ed.zoom);
    dir.ease = 0.0;
    dir.shake = 0.0;
    let k = ed.zoom.max(1.0) * 1.2;
    for mut t in sky.iter_mut() {
        t.scale.x = 6000.0 * k;
        t.scale.y = 4000.0 * k;
    }
}

fn dropped_files(mut ed: ResMut<Editor>, mut drops: MessageReader<bevy::window::FileDragAndDrop>) {
    for d in drops.read() {
        if let bevy::window::FileDragAndDrop::DroppedFile { path_buf, .. } = d {
            match std::fs::read_to_string(path_buf) {
                Ok(text) => {
                    let label = path_buf.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
                    ed.import_json(&text, &label);
                }
                Err(e) => ed.status = format!("Couldn't read {}: {e}", path_buf.display()),
            }
        }
    }
}

fn start_play(
    mut commands: Commands,
    mut ed: ResMut<Editor>,
    mut next: ResMut<NextState<AppState>>,
    mut dir: ResMut<CameraDirector>,
) {
    if !ed.request_play {
        return;
    }
    ed.request_play = false;
    ed.drag = None;
    ed.draft.clear();
    commands.remove_resource::<Game>();
    *dir = CameraDirector::default();
    ed.playtesting = true;
    ed.play_pending = true;
    next.set(AppState::Playing);
}

fn playtest_load(mut ed: ResMut<Editor>, mut load: MessageWriter<LoadLevel>) {
    if ed.play_pending {
        ed.play_pending = false;
        load.write(LoadLevel { level: ed.level.clone(), players: vec![(0, "Pip".into(), 0xff5d73)] });
    }
}

fn playtest_escape(
    mut commands: Commands,
    keys: Res<ButtonInput<KeyCode>>,
    mut ed: ResMut<Editor>,
    mut next: ResMut<NextState<AppState>>,
    mut frames: Local<u32>,
) {
    if !ed.playtesting {
        *frames = 0;
        return;
    }
    *frames += 1;
    // Dev: `BB_EDIT_BACK=<n>` returns automatically after n frames of play.
    let auto = std::env::var("BB_EDIT_BACK").ok().and_then(|s| s.parse::<u32>().ok()) == Some(*frames);
    if keys.just_pressed(KeyCode::Escape) || auto || std::mem::take(&mut ed.back_requested) {
        commands.remove_resource::<Game>();
        next.set(AppState::Editor);
    }
}
