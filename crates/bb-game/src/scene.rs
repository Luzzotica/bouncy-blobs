//! Scene files (content's SCENE-SPEC v0/v0.1, Bouncy Blobs runner): one JSON
//! file describes one shot; `bb-scene validate|preview|render` turns it into
//! videos, stills, audio stems, an event log and NOTES through the real game
//! in capture mode. See docs/SceneFiles.md.
//!
//! This module is the schema, plain-word validation, and the translation
//! into the game's capture settings. No Bevy here; the in-game half (camera
//! timeline, checks, event log) is `scene_run`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Finished chapters (stage allowlist): (spec id, campaign id).
pub const CHAPTERS: [(&str, &str); 4] = [("the-drip", "ch02"), ("fungus-caverns", "ch03"), ("puddle-lake", "ch06"), ("the-old-well", "ch10")];

/// Built-in stages: (id, capture-only?).
pub const BUILTINS: [(&str, bool); 9] = [
    ("title-cave", false),
    ("kids", false),
    ("transparent", true),
    ("spikeloop", true),
    ("stage-pile", true),
    ("stage-pile4", true),
    ("stage-trio", true),
    ("logo", true),
    ("endcard", true),
];

/// Pip's shipped colours (bb_sim::PALETTE) by name.
pub const COLORS: [(&str, u32); 12] = [
    ("pink", 0xff5d73),
    ("orange", 0xff9f43),
    ("yellow", 0xffd93d),
    ("green", 0x6bcb77),
    ("blue", 0x4d96ff),
    ("purple", 0x9b5de5),
    ("magenta", 0xf15bb5),
    ("teal", 0x00c2a8),
    ("sky", 0x5dd6ff),
    ("lime", 0xa0e426),
    ("rose", 0xff7eb6),
    ("lavender", 0xb8a1ff),
];

/// Kids Mode shape friends (cast `shape`) and their colour names.
pub const SHAPES: [&str; 3] = ["star", "square", "triangle"];
pub const KIDS_COLORS: [(&str, u32); 9] = [
    ("red", 0xe06070),
    ("orange", 0xe88a5a),
    ("yellow", 0xe8c54a),
    ("green", 0x6ecf6e),
    ("teal", 0x4ac8c8),
    ("blue", 0x5a8ae0),
    ("purple", 0x8a6ae0),
    ("pink", 0xd06eb0),
    ("white", 0xf0f0f0),
];

/// Names this game has (SCENE-SPEC v0.2 #4: validate rejects anything else).
pub const EVENT_NAMES: [&str; 6] = ["pop", "death", "land", "jump", "respawn", "spawn"];
pub const SCENE_EVENTS: [&str; 1] = ["respawn"];
pub const SFX_FAMILIES: [&str; 3] = ["pop", "land", "ui"];
pub const WORD_SELECTOR: &str = "word:POP!";

/// Behaviour changes a scene may make (each only via `capture_only`).
pub const CAPTURE_ONLY: [(&str, &str); 6] = [
    ("stage", "a capture-only stage (value: null)"),
    ("respawn_delay", "seconds from a pop to the next life (game: 1.1)"),
    ("respawn_point", "lives restart where `respawn` events say instead of the checkpoint (value: null)"),
    ("droplet_life", "seconds pop droplets lie about (game: ~42)"),
    ("spikeloop_slope", "spikeloop stage: tent slope so droplets slide off"),
    ("can_die", "a cast member that can't pop (value: false)"),
];

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    /// Id, used in output names.
    pub scene: String,
    pub game: String,
    /// "current" (the head of game-polish) or a commit.
    #[serde(default = "current")]
    pub build: String,
    pub allow_old_build: Option<String>,
    #[serde(default = "seeds1")]
    pub seeds: Vec<u32>,
    pub stage: Stage,
    #[serde(default)]
    pub cast: Vec<Cast>,
    #[serde(default)]
    pub inputs: Vec<Input>,
    /// A recorded human input file (BB_RECORD_INPUT) that drives Pip.
    pub replay: Option<String>,
    /// Reason to replay a recording whose stage differs from this build's.
    pub allow_old_stage: Option<String>,
    #[serde(default)]
    pub events: Vec<Event>,
    /// Seconds of game time run before frame 1 (so frame 1 is already
    /// moving). BB addition to the spec.
    #[serde(default)]
    pub pre_roll: f32,
    pub camera: Vec<CamKey>,
    pub length: Length,
    #[serde(default)]
    pub capture_only: Vec<CaptureOnly>,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub show: Vec<String>,
    #[serde(default)]
    pub check: Check,
    /// Seeded variation between takes (none = every seed is the same take).
    #[serde(default)]
    pub vary: Vary,
    pub outputs: Vec<Output>,
    #[serde(default)]
    pub audio: Audio,
}

fn current() -> String {
    "current".into()
}
fn seeds1() -> Vec<u32> {
    vec![1]
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Vary {
    /// Max ± world units added to x where each new life starts.
    pub respawn_x: Option<f32>,
    /// Max ± seconds added to each input's time.
    pub input_jitter: Option<f32>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    /// chapter | builtin | inline
    pub kind: String,
    #[serde(default)]
    pub id: String,
    /// World crop [x0, y0, x1, y1]: the default framing when no camera key
    /// says otherwise.
    pub region: Option<[f32; 4]>,
    pub theme: Option<String>,
    pub r#override: Option<String>,
    /// kind "inline": a level in the game's level JSON format.
    pub level: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Cast {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: String,
    pub color: Option<String>,
    pub spawn: Option<[f32; 2]>,
    pub can_die: Option<bool>,
    /// Kids Mode shape: star, square or triangle (a shape friend).
    pub shape: Option<String>,
    /// The stage's own actors (menu blobs, Kids friends, end-card blobs).
    pub from_stage: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub t: f32,
    #[serde(default = "pip")]
    pub who: String,
    /// hold | release | jump | squish
    pub r#do: String,
    /// left | right | up | down | jump (for hold/release).
    pub key: Option<String>,
    /// jump/squish: seconds held (jump: longer = higher, default 1 frame;
    /// squish: default 0.3 s).
    pub hold: Option<f32>,
}

fn pip() -> String {
    "pip".into()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub t: f32,
    /// respawn
    pub r#do: String,
    #[serde(default = "pip")]
    pub who: String,
    /// [x, y]: from this time on, Pip's next life starts here.
    pub at: Option<[f32; 2]>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct CamKey {
    pub t: f32,
    /// frame | follow | hold | pan | zoom | shake | timescale
    pub r#do: String,
    /// "pip" (or ["pip"]).
    pub who: Option<Value>,
    pub at: Option<[f32; 2]>,
    /// World area to show at least [w, h] (BB addition).
    pub view: Option<[f32; 2]>,
    /// Subject width as a fraction of the frame width (per output aspect).
    pub subject_width: Option<f32>,
    /// follow: look ahead by velocity × this (s); a number or [x, y].
    pub lead: Option<Value>,
    /// follow: seconds to catch up (0 = locked).
    pub lag: Option<f32>,
    /// follow: dead zone [w, h] in world px.
    pub deadzone: Option<[f32; 2]>,
    /// follow/frame: offset [x, y] in world px.
    pub offset: Option<[f32; 2]>,
    /// pan/zoom/frame/follow: seconds the change takes (default: a cut).
    pub by: Option<f32>,
    /// linear | ease (default ease when `by` is set).
    pub ease: Option<String>,
    /// shake: amplitude in world px (decays over `by`, default 0.6 s).
    pub amount: Option<f32>,
    /// timescale: game time per video second, until `until`.
    pub rate: Option<f32>,
    pub until: Option<f32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct Length {
    pub seconds: Option<f32>,
    /// "event:pop" etc.
    pub until: Option<String>,
    pub count: Option<u32>,
    pub plus: Option<f32>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CaptureOnly {
    pub what: String,
    #[serde(default)]
    pub value: Value,
    pub why: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Check {
    #[serde(default = "band")]
    pub band_x: [f32; 2],
    #[serde(default = "band_y")]
    pub band_y: [f32; 2],
    /// "pip", "word:POP!"
    #[serde(default = "objects")]
    pub objects: Vec<String>,
    #[serde(default = "min_w")]
    pub min_subject_width: f32,
    #[serde(default = "yes")]
    pub frame1_moving: bool,
}

fn band() -> [f32; 2] {
    [0.25, 0.75]
}
fn band_y() -> [f32; 2] {
    [0.0, 1.0]
}
fn objects() -> Vec<String> {
    vec!["pip".into()]
}
fn min_w() -> f32 {
    0.12
}
fn yes() -> bool {
    true
}

impl Default for Check {
    fn default() -> Self {
        Check { band_x: band(), band_y: band_y(), objects: objects(), min_subject_width: min_w(), frame1_moving: true }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Output {
    /// video | still
    pub kind: String,
    pub size: String,
    #[serde(default = "sixty")]
    pub fps: u32,
    /// still: seconds, or "event:pop#3".
    pub at: Option<Value>,
    #[serde(default)]
    pub transparent: bool,
    /// This file's own safe band (default: check.band_x).
    pub band_x: Option<[f32; 2]>,
    /// Minimum world view [w, h] for this output only (0 = unconstrained).
    pub view: Option<[f32; 2]>,
}

fn sixty() -> u32 {
    60
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Audio {
    #[serde(default = "yes")]
    pub music_stem: bool,
    #[serde(default = "fams")]
    pub sfx_families: Vec<String>,
    #[serde(default = "yes")]
    pub mix: bool,
}

fn fams() -> Vec<String> {
    SFX_FAMILIES.map(String::from).to_vec()
}

impl Default for Audio {
    fn default() -> Self {
        Audio { music_stem: true, sfx_families: fams(), mix: true }
    }
}

impl Output {
    pub fn dims(&self) -> Option<(u32, u32)> {
        let (w, h) = self.size.to_lowercase().split_once('x').map(|(a, b)| (a.trim().parse().ok(), b.trim().parse().ok()))?;
        Some((w?, h?))
    }
    pub fn band_x(&self, s: &Scene) -> [f32; 2] {
        self.band_x.unwrap_or(s.check.band_x)
    }
}

impl Scene {
    /// Campaign id for a chapter stage ("the-drip" or "ch02").
    pub fn chapter_id(&self) -> Option<String> {
        let id = self.stage.id.as_str();
        if let Some((_, c)) = CHAPTERS.iter().find(|(n, c)| *n == id || *c == id) {
            return Some(c.to_string());
        }
        (1..=10).map(|n| format!("ch{n:02}")).find(|c| c == id)
    }
    pub fn capture(&self, what: &str) -> Option<&CaptureOnly> {
        self.capture_only.iter().find(|c| c.what == what)
    }
    /// Cast members the runner spawns and drives (not the stage's own).
    pub fn members(&self) -> Vec<&Cast> {
        self.cast.iter().filter(|c| c.from_stage != Some(true)).collect()
    }
    /// Player slot of a cast member (Pip is 0, the rest follow in order).
    pub fn slot_of(&self, id: &str) -> Option<u8> {
        let m = self.members();
        if m.iter().any(|c| c.id == "pip") && id == "pip" {
            return Some(0);
        }
        let others: Vec<&&Cast> = m.iter().filter(|c| c.id != "pip").collect();
        others.iter().position(|c| c.id == id).map(|i| i as u8 + 1)
    }
    pub fn id_of_slot(&self, slot: u8) -> Option<&str> {
        self.members().into_iter().map(|c| c.id.as_str()).find(|id| self.slot_of(id) == Some(slot))
    }
    pub fn color_of(&self, c: &Cast) -> u32 {
        let name = c.color.as_deref().unwrap_or(if c.shape.is_some() { "blue" } else { "pink" });
        if c.shape.is_some() { kids_color(name).or_else(|| color(name)) } else { color(name).or_else(|| kids_color(name)) }.unwrap_or(0xff5d73)
    }
    /// Valid selectors: cast ids and the POP! word.
    pub fn is_selector(&self, s: &str) -> bool {
        s == WORD_SELECTOR || self.members().iter().any(|c| c.id == s)
    }
    pub fn pip(&self) -> Option<&Cast> {
        self.cast.iter().find(|c| c.id == "pip")
    }
    pub fn has_pip(&self) -> bool {
        self.pip().is_some()
    }
    pub fn pip_color(&self) -> u32 {
        self.pip().and_then(|c| c.color.as_deref()).and_then(color).unwrap_or(0xff5d73)
    }
    /// Timescale windows from the camera timeline: (from_s, to_s, rate).
    pub fn timescales(&self) -> Vec<(f32, f32, f32)> {
        self.camera.iter().filter(|k| k.r#do == "timescale").map(|k| (k.t, k.until.unwrap_or(f32::MAX), k.rate.unwrap_or(1.0))).collect()
    }
    /// Game-time rate for video frame `f`.
    pub fn rate_at_frame(&self, f: u64) -> f32 {
        let t = f as f32 / 60.0;
        self.timescales().iter().rev().find(|(a, b, _)| t >= *a - 1e-6 && t < *b - 1e-6).map_or(1.0, |w| w.2)
    }
    /// Game seconds elapsed after `t` video seconds (from frame 1).
    pub fn game_secs(&self, t: f32) -> f32 {
        let frames = (t * 60.0).round().max(0.0) as u64;
        (0..frames).map(|f| self.rate_at_frame(f)).sum::<f32>() / 60.0
    }
    /// Sim tick (60 Hz, counted from the start of the pre-roll) at video time t.
    pub fn tick_at(&self, t: f32) -> i64 {
        let pre = (self.pre_roll * 60.0).round() as i64;
        if t < 0.0 { pre + (t * 60.0).round() as i64 } else { pre + (self.game_secs(t) * 60.0).round() as i64 }
    }
}

pub fn kids_color(name: &str) -> Option<u32> {
    KIDS_COLORS.iter().find(|(n, _)| *n == name).map(|c| c.1)
}

pub fn color(name: &str) -> Option<u32> {
    COLORS.iter().find(|(n, _)| *n == name).map(|c| c.1).or_else(|| bb_sim::parse_color(name).filter(|c| COLORS.iter().any(|(_, v)| v == c)))
}

/// Drop every key starting with `_` (comments) before typed parsing.
fn strip_comments(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| !k.starts_with('_'));
            for x in m.values_mut() {
                strip_comments(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(strip_comments),
        _ => {}
    }
}

/// Parse a scene file. Errors are plain sentences.
pub fn parse(text: &str) -> Result<Scene, String> {
    let mut v: Value = serde_json::from_str(text).map_err(|e| format!("The file isn't valid JSON: {e}."))?;
    strip_comments(&mut v);
    serde_json::from_value(v).map_err(|e| format!("The scene doesn't match the format: {e}. See docs/SceneFiles.md for every field."))
}

fn who_list(v: &Option<Value>) -> Vec<String> {
    match v {
        None => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => vec!["?".into()],
    }
}

fn event_ref_ok(r: &str) -> bool {
    r.strip_prefix("event:").map(|k| k.split('#').next().unwrap_or("")).is_some_and(|k| EVENT_NAMES.contains(&k))
}

/// Validate; Ok(warnings) or Err(problems), all in plain words.
pub fn validate(s: &Scene) -> Result<Vec<String>, Vec<String>> {
    let mut err = Vec::new();
    let mut warn = Vec::new();
    let e = &mut err;
    if s.game != "bouncy-blobs" {
        e.push(format!("\"game\" is {:?}; this runner renders \"bouncy-blobs\".", s.game));
    }
    if s.scene.is_empty() || !s.scene.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        e.push(format!("\"scene\" must be letters, digits, - or _ (got {:?}).", s.scene));
    }
    if s.seeds.is_empty() {
        e.push("\"seeds\" needs at least one seed (one take per seed).".into());
    }
    if s.seeds.len() > 1 && s.vary == Vary::default() {
        warn.push("Several seeds but no \"vary\" block: every seed will be the same performance.".into());
    }
    for (n, v) in [("respawn_x", s.vary.respawn_x), ("input_jitter", s.vary.input_jitter)] {
        if v.is_some_and(|v| !(0.0..=1000.0).contains(&v)) {
            e.push(format!("vary.{n} must be a positive amount."));
        }
    }
    // Stage.
    let cap_stage = || s.capture("stage").is_some();
    match s.stage.kind.as_str() {
        "chapter" => match s.chapter_id() {
            None => e.push(format!("There is no chapter {:?}. Finished chapters: {}.", s.stage.id, CHAPTERS.map(|c| c.0).join(", "))),
            Some(c) => {
                if !CHAPTERS.iter().any(|(_, id)| *id == c.as_str()) && s.stage.r#override.as_deref().is_none_or(|r| r.trim().is_empty()) {
                    e.push(format!("Chapter {} isn't finished (cleared: {}). Add \"override\": \"<reason, Sterling's ask>\" to the stage to use it anyway.", s.stage.id, CHAPTERS.map(|c| c.0).join(", ")));
                }
            }
        },
        "builtin" => match BUILTINS.iter().find(|(n, _)| *n == s.stage.id) {
            None => e.push(format!("Unknown built-in stage {:?}. Choose one of: {}.", s.stage.id, BUILTINS.map(|b| b.0).join(", "))),
            Some((_, true)) if !cap_stage() => e.push(format!(
                "The built-in stage {:?} is capture-only (not a place in the shipped game), so declare it: add {{\"what\": \"stage\", \"value\": null, \"why\": \"...\"}} to \"capture_only\".",
                s.stage.id
            )),
            _ => {}
        },
        "inline" => match &s.stage.level {
            None => e.push("An inline stage needs \"level\": { ... } in the game's level format.".into()),
            Some(v) => {
                if let Err(x) = bb_level::Level::from_json(&v.to_string()) {
                    e.push(format!("The inline level isn't in the game's level format: {x}."));
                }
                if !cap_stage() {
                    e.push("An inline level is a capture-only stage; declare it in \"capture_only\" with \"what\": \"stage\".".into());
                }
            }
        },
        k => e.push(format!("Stage kind {k:?} isn't one of chapter, builtin, inline.")),
    }
    if s.stage.level.is_some() && s.stage.kind != "inline" {
        e.push("\"stage.level\" is only for \"kind\": \"inline\".".into());
    }
    if s.stage.theme.is_some() {
        e.push("\"stage.theme\" must be null for now (each stage uses its own shipped theme).".into());
    }
    // Cast.
    let members = s.members();
    let can_cast = matches!(s.stage.kind.as_str(), "chapter" | "inline") || matches!(s.stage.id.as_str(), "transparent" | "spikeloop");
    if !members.is_empty() && !can_cast {
        e.push(format!("The stage {:?} brings its own actors; use \"cast\": [{{\"from_stage\": true}}] (cast members can go in chapters, inline levels, spikeloop and transparent).", s.stage.id));
    }
    if members.len() > 8 {
        e.push("At most 8 cast members.".into());
    }
    for (i, c) in members.iter().enumerate() {
        let who = if c.id.is_empty() { format!("#{}", i + 1) } else { format!("{:?}", c.id) };
        if c.id.is_empty() || !c.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') || c.id.starts_with("word:") {
            e.push(format!("Cast member {who} needs an \"id\" (letters, digits, - or _)."));
        }
        if members[..i].iter().any(|o| o.id == c.id) {
            e.push(format!("Two cast members are both {who}."));
        }
        if c.kind != "blob" {
            e.push(format!("Cast member {who}: \"kind\" must be \"blob\" (named characters aren't castable yet)."));
        }
        if let Some(sh) = &c.shape {
            if !SHAPES.contains(&sh.as_str()) {
                e.push(format!("Cast member {who}: shape {sh:?} isn't a Kids Mode shape ({}).", SHAPES.join(", ")));
            }
            if let Some(col) = &c.color {
                if kids_color(col).is_none() {
                    e.push(format!("Cast member {who}: {col:?} isn't a Kids Mode colour ({}).", KIDS_COLORS.map(|c| c.0).join(", ")));
                }
            }
        } else if let Some(col) = &c.color {
            if color(col).is_none() {
                e.push(format!("Cast member {who}: colour {col:?} isn't a shipped blob colour ({}).", COLORS.map(|c| c.0).join(", ")));
            }
        }
        if c.spawn.is_none() && c.id != "pip" {
            e.push(format!("Cast member {who} needs \"spawn\": [x, y]."));
        }
        if c.can_die == Some(false) && s.capture("can_die").is_none() {
            e.push(format!("Cast member {who} can't pop (can_die: false), which changes the game: declare it in \"capture_only\" with \"what\": \"can_die\"."));
        }
    }
    // Spawns: never inside each other or inside rock/jelly.
    e.extend(spawn_problems(s));
    // Inputs.
    for (i, inp) in s.inputs.iter().enumerate() {
        let n = i + 1;
        if s.slot_of(&inp.who).is_none() {
            e.push(format!("Input {n}: {:?} isn't in \"cast\".", inp.who));
        }
        match inp.r#do.as_str() {
            "jump" | "squish" => {}
            "hold" | "release" => match inp.key.as_deref() {
                Some("left" | "right" | "up" | "down" | "jump") => {}
                k => e.push(format!("Input {n}: {} needs \"key\": left, right, up, down or jump (got {k:?}).", inp.r#do)),
            },
            d => e.push(format!("Input {n}: {d:?} isn't a Bouncy Blobs input; use hold, release, jump or squish.")),
        }
    }
    if let Some(path) = &s.replay {
        match crate::replay::load(path) {
            Err(x) => e.push(format!("\"replay\": {x}.")),
            Ok(r) => {
                if s.pip().is_none() {
                    e.push("A replay drives Pip, so \"cast\" needs {\"id\": \"pip\"}.".into());
                }
                if s.inputs.iter().any(|i| i.who == "pip") {
                    e.push("Pip is driven by the replay; remove Pip's entries from \"inputs\".".into());
                }
                let stage_level = match s.stage.kind.as_str() {
                    "chapter" => s.chapter_id(),
                    "inline" => s.stage.level.as_ref().and_then(|v| v.get("id")).and_then(|v| v.as_str()).map(String::from),
                    _ => None,
                };
                if stage_level.as_deref() != Some(r.level.as_str()) {
                    e.push(format!("The replay was recorded on {:?}, but this scene's stage is {:?}; replays rebuild the stage they were played on.", r.level, stage_level.unwrap_or_else(|| s.stage.id.clone())));
                }
                let frames_needed = (s.pre_roll * 60.0) as u64 + s.length.seconds.map_or(0, |x| (x * 60.0) as u64);
                if s.length.seconds.is_some() && frames_needed > r.ticks {
                    warn.push(format!("The replay is {:.1} s long; after that Pip gets no input (the scene runs {:.1} s including the pre-roll).", r.ticks as f32 / 60.0, frames_needed as f32 / 60.0));
                }
            }
        }
    }
    // Scene events.
    for (i, ev) in s.events.iter().enumerate() {
        if !SCENE_EVENTS.contains(&ev.r#do.as_str()) {
            e.push(format!("Event {}: {:?} isn't a scene event here (have: {}; slow motion is a camera \"timescale\").", i + 1, ev.r#do, SCENE_EVENTS.join(", ")));
        }
        if s.slot_of(&ev.who).is_none() {
            e.push(format!("Event {}: {:?} isn't in \"cast\".", i + 1, ev.who));
        }
        if ev.r#do == "respawn" {
            if ev.at.is_none() {
                e.push(format!("Event {}: respawn needs \"at\": [x, y].", i + 1));
            }
            if s.capture("respawn_point").is_none() {
                e.push("\"respawn\" events move where lives restart, which changes the game: declare it in \"capture_only\" with \"what\": \"respawn_point\".".into());
            }
        }
    }
    // Capture-only entries.
    for c in &s.capture_only {
        match CAPTURE_ONLY.iter().find(|(w, _)| *w == c.what) {
            None => e.push(format!("capture_only {:?} isn't a change this runner knows; known: {}.", c.what, CAPTURE_ONLY.map(|c| c.0).join(", "))),
            Some(_) => {
                if c.why.trim().is_empty() {
                    e.push(format!("capture_only {:?} needs a \"why\" (it goes into NOTES).", c.what));
                }
                let num = |ok: fn(f64) -> bool| c.value.as_f64().is_some_and(ok);
                let bad = match c.what.as_str() {
                    "respawn_delay" | "droplet_life" => !num(|v| v > 0.0 && v < 60.0),
                    "spikeloop_slope" => !num(|v| (0.0..2.0).contains(&v)),
                    _ => false,
                };
                if bad {
                    e.push(format!("capture_only {:?}: \"value\" should be a number of the right size.", c.what));
                }
                if c.what == "spikeloop_slope" && s.stage.id != "spikeloop" {
                    e.push("capture_only spikeloop_slope only applies to the spikeloop stage.".into());
                }
            }
        }
    }
    // Camera.
    if s.camera.is_empty() && s.stage.region.is_none() {
        e.push("Add a camera key, e.g. {\"t\": 0, \"do\": \"frame\", \"who\": \"pip\", \"subject_width\": 0.18}, or a stage \"region\".".into());
    }
    let mut last = f32::MIN;
    for (i, k) in s.camera.iter().enumerate() {
        let n = i + 1;
        if k.t < last {
            e.push(format!("Camera key {n} (t={}) comes before the one above it; keep keys in time order.", k.t));
        }
        last = k.t;
        for w in who_list(&k.who) {
            if s.slot_of(&w).is_none() {
                e.push(format!("Camera key {n}: {w:?} isn't in \"cast\"."));
            }
        }
        if k.r#do == "follow" && k.who.is_none() {
            e.push(format!("Camera key {n}: follow needs \"who\"."));
        }
        match k.r#do.as_str() {
            "frame" | "pan" | "follow" | "zoom" | "hold" | "shake" | "timescale" => {}
            d => e.push(format!("Camera key {n}: {d:?} isn't a camera move; use frame, follow, hold, pan, zoom, shake or timescale.")),
        }
        if k.r#do == "timescale" && !k.rate.is_some_and(|r| (0.01..=1.0).contains(&r)) {
            e.push(format!("Camera key {n}: timescale needs \"rate\" between 0.01 and 1."));
        }
        if matches!(k.r#do.as_str(), "frame" | "pan" | "follow") && i == 0 && k.view.is_none() && k.subject_width.is_none() {
            e.push(format!("Camera key {n}: say how much to show: \"subject_width\" (fraction of the frame width) or \"view\": [w, h]."));
        }
        if k.subject_width.is_some() && k.view.is_some() {
            e.push(format!("Camera key {n} has both subject_width and view. Each output frames itself to subject_width; put a minimum view on the output instead (outputs[].view)."));
        }
        if let Some(w) = k.subject_width {
            if !(0.01..=0.95).contains(&w) {
                e.push(format!("Camera key {n}: subject_width {w} should be a fraction like 0.18."));
            }
        }
        if let Some(x) = &k.ease {
            if !["linear", "ease", "cut"].contains(&x.as_str()) {
                e.push(format!("Camera key {n}: ease is linear, ease or cut."));
            }
        }
    }
    if let Some(first) = s.camera.first() {
        if first.t > 0.0 && s.stage.region.is_none() {
            e.push("The first camera key should be at t 0 (or give the stage a \"region\").".into());
        }
    }
    // Length.
    match (&s.length.seconds, &s.length.until) {
        (Some(x), None) if *x > 0.0 && *x <= 120.0 => {}
        (None, Some(u)) => {
            if !event_ref_ok(u) {
                e.push(format!("length.until {u:?}: use \"event:<name>\" with one of {}.", EVENT_NAMES.join(", ")));
            }
        }
        _ => e.push("\"length\" is {\"seconds\": n} (up to 120) or {\"until\": \"event:pop\", \"count\": n, \"plus\": s}.".into()),
    }
    // Check.
    for o in &s.check.objects {
        if !s.is_selector(o) {
            e.push(format!("check.objects {o:?} isn't a selector here: use a cast id ({}) or {WORD_SELECTOR:?}.", s.members().iter().map(|c| c.id.as_str()).collect::<Vec<_>>().join(", ")));
        }
    }
    for (n, b) in [("band_x", s.check.band_x), ("band_y", s.check.band_y)] {
        if !(0.0..=1.0).contains(&b[0]) || !(0.0..=1.0).contains(&b[1]) || b[0] >= b[1] {
            e.push(format!("check.{n} must be two fractions, low then high, like [0.25, 0.75]."));
        }
    }
    // Outputs.
    if s.outputs.is_empty() {
        e.push("List at least one output, e.g. {\"kind\": \"video\", \"size\": \"1080x1920\", \"fps\": 60}.".into());
    }
    for o in &s.outputs {
        match o.dims() {
            Some((w, h)) if (16..=8192).contains(&w) && (16..=8192).contains(&h) && w % 2 == 0 && h % 2 == 0 => {}
            _ => e.push(format!("Output size {:?} should be even numbers like \"1080x1920\".", o.size)),
        }
        if o.fps != 60 {
            e.push(format!("Output {}: only 60 fps is supported (the game runs at 60 Hz).", o.size));
        }
        match o.kind.as_str() {
            "video" => {
                if o.transparent {
                    e.push(format!("Output {}: a video can't be transparent (mp4 has no alpha); use a still.", o.size));
                }
            }
            "still" => match &o.at {
                Some(Value::Number(_)) => {}
                Some(Value::String(a)) if a.contains('#') && event_ref_ok(a) => {}
                _ => e.push(format!("Still {}: \"at\" is seconds (1.5) or \"event:<name>#n\" ({}).", o.size, EVENT_NAMES.join(", "))),
            },
            k => e.push(format!("Output kind {k:?}: use video or still (no GIFs or image sequences).")),
        }
        if o.transparent && !matches!(s.stage.id.as_str(), "transparent" | "logo" | "stage-pile" | "stage-pile4" | "stage-trio") {
            e.push(format!("Output {}: transparent stills need a transparent-ready stage (builtin \"transparent\", \"logo\", or a posing stage).", o.size));
        }
        if let Some(b) = o.band_x {
            if !(0.0..=1.0).contains(&b[0]) || !(0.0..=1.0).contains(&b[1]) || b[0] >= b[1] {
                e.push(format!("Output {}: band_x must be two fractions, low then high.", o.size));
            }
        }
        if let Some(v) = o.view {
            if v[0] < 0.0 || v[1] < 0.0 {
                e.push(format!("Output {}: view must be [w, h] with 0 for unconstrained.", o.size));
            }
        }
    }
    let vids: Vec<&String> = s.outputs.iter().filter(|o| o.kind == "video").map(|o| &o.size).collect();
    for (i, a) in vids.iter().enumerate() {
        if vids[..i].contains(a) {
            e.push(format!("Two video outputs are both {a}."));
        }
    }
    // Audio.
    for f in &s.audio.sfx_families {
        if !SFX_FAMILIES.contains(&f.as_str()) {
            e.push(format!("audio.sfx_families {f:?}: this game has {}.", SFX_FAMILIES.join(", ")));
        }
    }
    for n in &s.show {
        if !["glimmer", "pickups"].contains(&n.as_str()) {
            e.push(format!("\"show\" lists {n:?}; this runner can show \"glimmer\" and \"pickups\"."));
        }
    }
    if s.staged {
        warn.push("\"staged\": true is set, but this runner has no staged moves yet; nothing is puppeted.".into());
    }
    if err.is_empty() { Ok(warn) } else { Err(err) }
}

/// The stage's level as this build builds it (None for stages without one).
pub fn stage_level(s: &Scene) -> Option<bb_level::Level> {
    match s.stage.kind.as_str() {
        "chapter" => s.chapter_id().and_then(|c| bb_level::campaign::by_id(&c)),
        "inline" => s.stage.level.as_ref().and_then(|v| bb_level::Level::from_json(&v.to_string()).ok()),
        _ => match s.stage.id.as_str() {
            "spikeloop" => Some(crate::capture_scene::spikeloop_level()),
            "transparent" => Some(crate::capture_scene::stage_level("solo", 0)),
            _ => None,
        },
    }
}

/// Cast spawns that overlap each other or start inside rock or jelly.
pub fn spawn_problems(s: &Scene) -> Vec<String> {
    let r = bb_sim::control::tune::RADIUS;
    let mut out = Vec::new();
    let spawns: Vec<(&str, [f32; 2])> = s.members().iter().filter_map(|c| c.spawn.map(|p| (c.id.as_str(), p))).collect();
    for (i, (a, pa)) in spawns.iter().enumerate() {
        for (b, pb) in &spawns[..i] {
            let d = ((pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2)).sqrt();
            if d < 2.0 * r {
                out.push(format!(
                    "Cast members {b:?} at [{}, {}] and {a:?} at [{}, {}] start inside each other ({d:.0} px apart; blobs are {:.0} px across). Move one at least {:.0} px away.",
                    pb[0], pb[1], pa[0], pa[1], 2.0 * r, 2.0 * r - d + 1.0
                ));
            }
        }
    }
    if let Some(level) = stage_level(s) {
        let solids = bb_level::lint::solids(&level);
        for (id, p) in &spawns {
            if bb_level::lint::embedded(&solids, bb_physics::Vec2::new(p[0], p[1]), r) {
                out.push(format!("Cast member {id:?} at [{}, {}] starts inside (or within {r:.0} px of) rock or jelly; move it into open air.", p[0], p[1]));
            }
        }
    }
    out
}

/// A tiny deterministic RNG for seeded variation.
pub fn seeded(seed: u32, i: u32) -> f32 {
    let mut x = seed.wrapping_mul(0x9e37_79b9) ^ i.wrapping_mul(0x85eb_ca6b) ^ 0x27d4_eb2f;
    x ^= x >> 15;
    x = x.wrapping_mul(0x2c1b_3c6d);
    x ^= x >> 12;
    x = x.wrapping_mul(0x297a_2d39);
    x ^= x >> 15;
    (x >> 8) as f32 / (1u32 << 24) as f32
}

/// One key held by one cast member over sim ticks [from, to).
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub slot: u8,
    /// left, right, up, down or button.
    pub key: &'static str,
    pub from: i64,
    pub to: i64,
}

fn key_name(k: &str) -> &'static str {
    match k {
        "left" => "left",
        "right" => "right",
        "up" => "up",
        "down" => "down",
        _ => "button",
    }
}

/// Each input's time shift for this seed (vary.input_jitter), in seconds.
pub fn input_shifts(s: &Scene, seed: u32) -> Vec<f32> {
    let j = s.vary.input_jitter.unwrap_or(0.0);
    (0..s.inputs.len()).map(|i| if j > 0.0 { (seeded(seed, 1000 + i as u32) * 2.0 - 1.0) * j } else { 0.0 }).collect()
}

/// The respawn x offset for `slot`'s `life`-th new life (vary.respawn_x).
pub fn respawn_shift(s: &Scene, seed: u32, slot: u8, life: u32) -> f32 {
    let r = s.vary.respawn_x.unwrap_or(0.0);
    if r > 0.0 { (seeded(seed, 7000 + slot as u32 * 1000 + life) * 2.0 - 1.0) * r } else { 0.0 }
}

/// The inputs as held keys in sim ticks (from the start of the pre-roll),
/// with this seed's jitter. These go into the game's per-player input slots,
/// the same path a keyboard, pad or phone uses.
pub fn input_plan(s: &Scene, seed: u32) -> Vec<Held> {
    let shifts = input_shifts(s, seed);
    let mut ins: Vec<(f32, &Input)> = s.inputs.iter().zip(&shifts).map(|(i, d)| (i.t + d, i)).collect();
    ins.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = Vec::new();
    let mut open: Vec<(u8, &'static str, i64)> = Vec::new();
    for (t, inp) in ins {
        let Some(slot) = s.slot_of(&inp.who) else { continue };
        let tk = s.tick_at(t).max(0);
        let span = |h: f32| (s.tick_at(t + h) - s.tick_at(t)).max(1);
        match inp.r#do.as_str() {
            "jump" => out.push(Held { slot, key: "button", from: tk, to: tk + inp.hold.map_or(1, span) }),
            "squish" => out.push(Held { slot, key: "down", from: tk, to: tk + span(inp.hold.unwrap_or(0.3)) }),
            "hold" => {
                let k = key_name(inp.key.as_deref().unwrap_or("right"));
                if !open.iter().any(|o| o.0 == slot && o.1 == k) {
                    open.push((slot, k, tk));
                }
            }
            "release" => {
                let k = key_name(inp.key.as_deref().unwrap_or("right"));
                if let Some(i) = open.iter().position(|o| o.0 == slot && o.1 == k) {
                    let (sl, key, from) = open.remove(i);
                    out.push(Held { slot: sl, key, from, to: tk.max(from + 1) });
                }
            }
            _ => {}
        }
    }
    for (slot, key, from) in open {
        out.push(Held { slot, key, from, to: i64::MAX });
    }
    out
}

/// The input a cast member gives at sim tick `tick`.
pub fn input_at(plan: &[Held], slot: u8, tick: i64) -> bb_sim::Input {
    let mut i = bb_sim::Input::default();
    for h in plan.iter().filter(|h| h.slot == slot && tick >= h.from && tick < h.to) {
        match h.key {
            "left" => i.stick.x -= 1.0,
            "right" => i.stick.x += 1.0,
            "up" => i.stick.y += 1.0,
            "down" => i.stick.y -= 1.0,
            _ => i.button = true,
        }
    }
    i.stick.x = i.stick.x.clamp(-1.0, 1.0);
    i.stick.y = i.stick.y.clamp(-1.0, 1.0);
    i
}

/// Environment for one game run of this scene with `seed` at `size`.
#[allow(clippy::too_many_arguments)]
pub fn env_for(s: &Scene, scene_path: &str, seed: u32, size: (u32, u32), transparent: bool, view_floor: Option<[f32; 2]>, frames: u32, out_path: &str, check_path: &str) -> BTreeMap<String, String> {
    let mut e = BTreeMap::new();
    let mut set = |k: &str, v: String| {
        e.insert(k.to_string(), v);
    };
    set("BB_MUTE", "1".into());
    set("BB_CAPTURE", "1".into());
    set("BB_CAPTURE_SIZE", format!("{}x{}", size.0, size.1));
    set("BB_CAPTURE_OUT", out_path.into());
    set("BB_CAPTURE_FRAMES", frames.max(1).to_string());
    set("BB_CAPTURE_START", ((s.pre_roll * 60.0).round() as u32).to_string());
    set("BB_SCENE_FILE", scene_path.into());
    set("BB_SCENE_CHECK", check_path.into());
    set("BB_SCENE_SEED", seed.to_string());
    set("BB_CAPTURE_SCENE_SEED", seed.to_string());
    match s.stage.kind.as_str() {
        "chapter" => set("BB_LEVEL", s.chapter_id().unwrap_or_else(|| "ch02".into())),
        "inline" => set("BB_CAPTURE_SCENE", "inline".into()),
        _ => match s.stage.id.as_str() {
            "title-cave" => {}
            "kids" => set("BB_START", "kids".into()),
            "transparent" => {
                set("BB_CAPTURE_SCENE", "stage".into());
                set("BB_STAGE", "solo".into());
            }
            "spikeloop" | "logo" | "endcard" => set("BB_CAPTURE_SCENE", s.stage.id.clone()),
            other => {
                set("BB_CAPTURE_SCENE", "stage".into());
                set("BB_STAGE", other.trim_start_matches("stage-").into());
            }
        },
    }
    if let Some([x, y]) = s.pip().and_then(|p| p.spawn) {
        set("BB_CAPTURE_AT", format!("{x},{y}"));
    }
    if !s.show.iter().any(|x| x == "pickups") {
        set("BB_CAPTURE_NO_PICKUPS", "1".into());
    }
    if let Some(v) = s.capture("respawn_delay").and_then(|c| c.value.as_f64()) {
        set("BB_CAPTURE_RESPAWN", v.to_string());
    }
    if let Some(v) = s.capture("droplet_life").and_then(|c| c.value.as_f64()) {
        set("BB_CAPTURE_DROPLET_LIFE", v.to_string());
    }
    if let Some(v) = s.capture("spikeloop_slope").and_then(|c| c.value.as_f64()) {
        set("BB_SPIKELOOP_SLOPE", v.to_string());
    }
    if transparent {
        set("BB_CAPTURE_TRANSPARENT", "1".into());
        if s.stage.id == "logo" {
            set("BB_CAPTURE_SHOW", "ui".into());
        }
    }
    if let Some([w, h]) = view_floor {
        set("BB_SCENE_VIEW_FLOOR", format!("{w},{h}"));
    }
    // The scene camera drives the view; capture's own camera stays out of it.
    set("BB_CAPTURE_CAM", "static:0,0".into());
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPIKE: &str = r#"{
        "_comment": "comments are keys starting with _",
        "scene": "bb-spike-loop", "game": "bouncy-blobs", "build": "current", "seeds": [1, 2],
        "stage": {"kind": "builtin", "id": "spikeloop"},
        "cast": [{"id": "pip", "kind": "blob", "color": "pink", "spawn": [0, 260]}],
        "pre_roll": 0.33,
        "camera": [{"t": 0, "do": "frame", "at": [0, 215], "view": [366, 500]}],
        "length": {"seconds": 11},
        "capture_only": [
            {"what": "stage", "value": null, "why": "capture-only spike stage"},
            {"what": "respawn_delay", "value": 0.65, "why": "snappy rhythm"},
            {"what": "spikeloop_slope", "value": 0.25, "why": "droplets slide off"}],
        "check": {"band_x": [0.05, 0.95], "objects": ["pip", "word:POP!"]},
        "audio": {"sfx_families": ["pop", "land", "ui"]},
        "outputs": [{"kind": "video", "size": "1080x1920", "fps": 60}, {"kind": "still", "size": "1080x1920", "at": "event:pop#3"}]
    }"#;

    #[test]
    fn every_shipped_example_is_valid() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scenes/examples");
        let mut n = 0;
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "json") {
                let mut s = parse(&std::fs::read_to_string(&p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
                if let Some(r) = &s.replay {
                    s.replay = Some(dir.join(r).to_string_lossy().into_owned());
                }
                assert!(validate(&s).is_ok(), "{}: {:?}", p.display(), validate(&s));
                n += 1;
            }
        }
        assert!(n >= 5, "expected the five example shots, found {n}");
    }

    #[test]
    fn parses_and_validates() {
        let s = parse(SPIKE).unwrap();
        assert!(validate(&s).is_ok(), "{:?}", validate(&s));
        assert_eq!(s.seeds, vec![1, 2]);
        assert_eq!(s.pip_color(), 0xff5d73);
    }

    #[test]
    fn undeclared_change_fails() {
        let mut s = parse(SPIKE).unwrap();
        s.capture_only.retain(|c| c.what != "stage");
        assert!(validate(&s).unwrap_err().iter().any(|m| m.contains("capture-only")));
        let mut s = parse(SPIKE).unwrap();
        s.events.push(Event { t: 1.0, r#do: "respawn".into(), who: "pip".into(), at: Some([0.0, 300.0]) });
        assert!(validate(&s).unwrap_err().iter().any(|m| m.contains("respawn_point")));
    }

    #[test]
    fn chapter_allowlist_and_names() {
        let mut s = parse(SPIKE).unwrap();
        s.capture_only.clear();
        s.stage = Stage { kind: "chapter".into(), id: "the-drip".into(), ..Default::default() };
        assert_eq!(s.chapter_id().as_deref(), Some("ch02"));
        assert!(validate(&s).is_ok(), "{:?}", validate(&s));
        s.stage.id = "ch05".into();
        assert!(validate(&s).unwrap_err().iter().any(|m| m.contains("isn't finished")));
        s.stage.r#override = Some("Sterling asked".into());
        assert!(validate(&s).is_ok());
    }

    #[test]
    fn plain_errors() {
        assert!(parse("{ nope").unwrap_err().contains("isn't valid JSON"));
        assert!(parse(&SPIKE.replace("\"length\"", "\"lenght\"")).unwrap_err().contains("lenght"));
        let mut s = parse(SPIKE).unwrap();
        s.outputs[0].size = "1080by1920".into();
        assert!(validate(&s).unwrap_err().iter().any(|m| m.contains("1080by1920")));
    }

    #[test]
    fn inputs_and_timescale_map_to_ticks() {
        let mut s = parse(SPIKE).unwrap();
        s.pre_roll = 1.0;
        s.inputs = vec![
            Input { t: 0.0, who: "pip".into(), r#do: "hold".into(), key: Some("right".into()), hold: None },
            Input { t: 0.5, who: "pip".into(), r#do: "jump".into(), key: None, hold: Some(0.25) },
            Input { t: 1.0, who: "pip".into(), r#do: "squish".into(), key: None, hold: None },
            Input { t: 2.0, who: "pip".into(), r#do: "release".into(), key: Some("right".into()), hold: None },
        ];
        let p = input_plan(&s, 1);
        assert!(p.contains(&Held { slot: 0, key: "button", from: 90, to: 105 }), "{p:?}");
        assert!(p.contains(&Held { slot: 0, key: "down", from: 120, to: 138 }));
        assert!(p.contains(&Held { slot: 0, key: "right", from: 60, to: 180 }));
        assert!(input_at(&p, 0, 95).button && input_at(&p, 0, 95).stick.x == 1.0);
        assert!(!input_at(&p, 0, 200).button && input_at(&p, 0, 200).stick.x == 0.0);
        // 4× slow motion from 1 s: 2 s of video = 1 s + 0.25 s of game.
        s.camera.push(CamKey { t: 1.0, r#do: "timescale".into(), rate: Some(0.25), ..Default::default() });
        assert!((s.game_secs(2.0) - 1.25).abs() < 1e-4);
        assert_eq!(s.tick_at(2.0), 60 + 75);
        assert_eq!(s.rate_at_frame(59), 1.0);
        assert_eq!(s.rate_at_frame(60), 0.25);
    }

    #[test]
    fn overlapping_or_buried_spawns_fail() {
        let mut s = parse(SPIKE).unwrap();
        s.cast.push(Cast { id: "bluey".into(), kind: "blob".into(), color: Some("blue".into()), spawn: Some([20.0, 250.0]), ..Default::default() });
        let e = validate(&s).unwrap_err();
        assert!(e.iter().any(|m| m.contains("\"pip\"") && m.contains("\"bluey\"") && m.contains("inside each other")), "{e:?}");
        s.cast[1].spawn = Some([200.0, 160.0]);
        assert!(validate(&s).is_ok(), "{:?}", validate(&s));
        // Into the spike strip's ground.
        s.cast[1].spawn = Some([200.0, -40.0]);
        assert!(validate(&s).unwrap_err().iter().any(|m| m.contains("\"bluey\"") && m.contains("rock or jelly")));
    }

    #[test]
    fn vary_is_seeded_and_off_by_default() {
        let mut s = parse(SPIKE).unwrap();
        s.inputs = vec![Input { t: 1.0, who: "pip".into(), r#do: "jump".into(), key: None, hold: None }];
        assert_eq!(input_shifts(&s, 1), input_shifts(&s, 2));
        assert_eq!(respawn_shift(&s, 1, 0, 1), 0.0);
        s.vary = Vary { respawn_x: Some(35.0), input_jitter: Some(0.03) };
        let (a, b) = (input_shifts(&s, 1), input_shifts(&s, 2));
        assert_ne!(a, b);
        assert!(a[0].abs() <= 0.03 && b[0].abs() <= 0.03);
        assert_eq!(a, input_shifts(&s, 1));
        let r = respawn_shift(&s, 1, 0, 3);
        assert!(r.abs() <= 35.0 && r != 0.0);
    }

    #[test]
    fn cast_slots_selectors_and_names() {
        let mut s = parse(SPIKE).unwrap();
        s.cast.push(Cast { id: "star1".into(), kind: "blob".into(), color: Some("yellow".into()), spawn: Some([50.0, 200.0]), shape: Some("star".into()), ..Default::default() });
        assert_eq!(s.slot_of("pip"), Some(0));
        assert_eq!(s.slot_of("star1"), Some(1));
        assert_eq!(s.id_of_slot(1), Some("star1"));
        assert_eq!(s.color_of(&s.cast[1]), 0xe8c54a);
        assert!(s.is_selector("star1") && s.is_selector("word:POP!") && !s.is_selector("glimmer"));
        assert!(validate(&s).is_ok(), "{:?}", validate(&s));
        s.audio.sfx_families = vec!["splash".into()];
        s.check.objects.push("enemy".into());
        s.length = Length { until: Some("event:kill".into()), ..Default::default() };
        let e = validate(&s).unwrap_err();
        assert!(e.iter().any(|m| m.contains("splash")) && e.iter().any(|m| m.contains("enemy")) && e.iter().any(|m| m.contains("event:kill")), "{e:?}");
    }
}
