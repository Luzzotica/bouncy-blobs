//! Cutscene runner: in-engine softbody puppetry.
//!
//! A cutscene is a small stage level plus a list of beats. Actors are real
//! NPC softbodies (scripted, so the AI leaves them alone) driven through the
//! same controller as players — so a "hop" squashes, a "push" wobbles and a
//! sneeze can knock a whole pile of blobs over.

use bb_level::Level;
use bb_sim::Vec2 as PVec2;
use bevy::prelude::*;

use super::bubble::{SayRequest, Speaker, linger_secs, type_secs};
use super::Voice;
use crate::camera::CameraDirector;
use crate::sim::{Game, Inputs};

#[derive(Clone, Debug)]
pub enum Beat {
    /// Eyes shut / open / roll into place (first awakening).
    Eyes { who: String, state: EyeState },
    /// Look in a direction (-1..1 each axis); `None` = back to natural.
    Gaze { who: String, dir: Option<PVec2> },
    /// Force an expression; `None` = back to natural.
    Mood { who: String, mood: Option<crate::render::Mood> },
    /// Chapter title card.
    Title { title: String, sub: String },
    /// Speech bubble; waits until read (or the button is pressed).
    Say { who: String, text: String },
    /// Speech bubble that doesn't wait.
    Aside { who: String, text: String },
    /// Roll to an x position (waits until there, max 4 s).
    Walk { who: String, x: f32 },
    /// Roll without waiting.
    Stroll { who: String, x: f32 },
    Hop { who: String, hold: f32 },
    /// Inflate to `scale` for `secs` (no jump).
    Puff { who: String, scale: f32, secs: f32 },
    Push { who: String, vel: PVec2 },
    /// Push every actor whose id starts with `prefix` away from `from`.
    Scatter { prefix: String, from: String, speed: f32 },
    Pop { who: String },
    Wait(f32),
    /// Point the camera. Pip always stays in frame: the shot zooms out (and
    /// at most slides) to fit Pip, so a shot of the sky far above shows Pip
    /// looking up at it.
    Cam { at: PVec2, zoom: f32, ease: f32 },
    /// A deliberate close-up on something else: the one camera beat that
    /// may leave Pip out of frame (until the next `Cam` / `Follow`).
    CloseUp { at: PVec2, zoom: f32, ease: f32 },
    Follow { who: String, zoom: f32 },
    Shake(f32),
    /// Onomatopoeia above an actor.
    Word { who: String, text: String },
    SpeedLines(bool),
    Fade { to: f32, secs: f32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EyeState {
    /// No eyes at all (Pip before the very first awakening).
    None,
    /// The eye outlines draw themselves in like pen strokes, over
    /// [`EYE_DRAW_SECS`] (from no eyes); `Open` / `Roll` then open them.
    Draw,
    Closed,
    Open,
    /// Pop open with pupils rolling round before they settle.
    Roll,
}

/// How long the pen takes to trace both eyes ([`EyeState::Draw`]).
pub const EYE_DRAW_SECS: f32 = 2.4;

pub struct Cutscene {
    pub id: String,
    pub stage: Level,
    pub beats: Vec<Beat>,
}

/// Running cutscene state.
#[derive(Resource)]
pub struct Runner {
    pub id: String,
    pub beats: Vec<Beat>,
    pub index: usize,
    pub timer: f32,
    pub started: bool,
    pub follow: Option<(String, f32)>,
    pub done: bool,
    pub skip_hold: f32,
    /// Timed puffs still running: (actor, seconds left).
    pub puffs: Vec<(String, f32)>,
    pub hops: Vec<(String, f32)>,
    pub strolls: Vec<(String, f32)>,
    /// Who spoke last, and the extra wait before the current line (a new
    /// speaker waits for the old bubble to close).
    pub last_speaker: Option<String>,
    pub say_gap: f32,
    /// A [`Beat::CloseUp`] is on: Pip may be out of frame.
    pub closeup: bool,
}

impl Runner {
    pub fn new(cs: &Cutscene) -> Runner {
        Runner {
            id: cs.id.clone(),
            beats: cs.beats.clone(),
            index: 0,
            timer: 0.0,
            started: false,
            follow: None,
            done: false,
            skip_hold: 0.0,
            puffs: Vec::new(),
            hops: Vec::new(),
            strolls: Vec::new(),
            last_speaker: None,
            say_gap: 0.0,
            closeup: false,
        }
    }
}

/// Height of each letterbox bar, as a fraction of the screen.
pub const LETTERBOX: f32 = 0.09;

/// Room kept around Pip in every cutscene shot (world px), and how far
/// ahead of a moving Pip (seconds of travel, at most `LEAD_MAX` px) the
/// shot already makes room.
const PIP_MARGIN: f32 = 70.0;
const LEAD_SECS: f32 = 0.22;
const LEAD_MAX: f32 = 280.0;

/// The box the cutscene camera keeps on screen: Pip, padded, stretched
/// toward where Pip is heading (a jump makes room above before Pip gets
/// there).
pub fn pip_box(min: Vec2, max: Vec2, vel: Vec2) -> Rect {
    let lead = (vel * LEAD_SECS).clamp(Vec2::splat(-LEAD_MAX), Vec2::splat(LEAD_MAX));
    let (min, max) = (min - Vec2::splat(PIP_MARGIN), max + Vec2::splat(PIP_MARGIN));
    Rect::from_corners(min + lead.min(Vec2::ZERO), max + lead.max(Vec2::ZERO))
}

/// Visual cues the UI layer draws (letterbox, cards, fades, speed lines).
#[derive(Resource, Default)]
pub struct Cues {
    pub letterbox: bool,
    pub title: Option<(String, String, f32)>,
    pub fade: f32,
    pub fade_target: f32,
    pub fade_speed: f32,
    pub speed_lines: bool,
    pub skip_progress: f32,
}

/// How long a `Say` beat holds the scene: the bubble finishes typing, then
/// a beat to read it (the bubble itself lingers a little longer).
pub fn say_wait(text: &str) -> f32 {
    type_secs(text) + 0.9 + text.chars().count() as f32 * 0.02
}

pub fn voice_for(game: &Game, who: &str) -> Voice {
    use bb_level::NpcRole::*;
    if who == "pip" {
        return Voice::Pip;
    }
    if who == "lulu" {
        return Voice::Lulu;
    }
    match game.sim.npc_by_id(who).map(|n| &n.role) {
        Some(Granny) => Voice::Granny,
        Some(Glimmer) => Voice::Glimmer,
        Some(Reg) => Voice::Reg,
        _ => Voice::Huddle,
    }
}

fn actor_pos(game: &Game, who: &str) -> Option<PVec2> {
    let n = game.sim.npc_by_id(who)?;
    let b = game.sim.world.body(n.ctl.body)?;
    Some(b.centroid())
}

#[allow(clippy::too_many_arguments)]
pub fn run(
    mut runner: ResMut<Runner>,
    mut game: ResMut<Game>,
    time: Res<Time>,
    inputs: Res<Inputs>,
    keys: Res<ButtonInput<KeyCode>>,
    mut cam: ResMut<CameraDirector>,
    mut cues: ResMut<Cues>,
    mut say: MessageWriter<SayRequest>,
    mut prev_button: Local<bool>,
    mut word: MessageWriter<super::WordRequest>,
    mut faces: ResMut<crate::render::FaceCues>,
) {
    let dt = time.delta_secs();
    cues.letterbox = true;
    if runner.done {
        return;
    }
    // All actors are scripted while a cutscene runs.
    for n in game.sim.npcs.iter_mut() {
        n.scripted = true;
    }

    // Hold anything for 0.8 s to skip; tap to hurry the current line.
    let button = inputs.slots.iter().any(|i| i.button) || keys.any_pressed([KeyCode::Enter, KeyCode::Escape, KeyCode::Space]);
    let tapped = button && !*prev_button;
    *prev_button = button;
    runner.skip_hold = if button { runner.skip_hold + dt } else { 0.0 };
    cues.skip_progress = (runner.skip_hold / 0.8).min(1.0);
    if runner.skip_hold >= 0.8 {
        runner.done = true;
        return;
    }

    // Timed actor actions.
    let mut finished_puffs = Vec::new();
    for (who, left) in runner.puffs.iter_mut() {
        *left -= dt;
        if *left <= 0.0 {
            finished_puffs.push(who.clone());
        }
    }
    runner.puffs.retain(|p| p.1 > 0.0);
    for who in finished_puffs {
        if let Some(n) = game.sim.npc_by_id_mut(&who) {
            n.ctl.puff = None;
        }
    }
    let mut hops = std::mem::take(&mut runner.hops);
    for (who, left) in hops.iter_mut() {
        *left -= dt;
        if let Some(n) = game.sim.npc_by_id_mut(who) {
            n.ctl.input.button = *left > 0.0;
        }
    }
    hops.retain(|h| h.1 > -0.05);
    runner.hops = hops;
    let strolls = runner.strolls.clone();
    let mut arrived = Vec::new();
    for (who, x) in &strolls {
        let Some(p) = actor_pos(&game, who) else { continue };
        let dx = x - p.x;
        if let Some(n) = game.sim.npc_by_id_mut(who) {
            if dx.abs() < 14.0 {
                n.ctl.input.stick.x = 0.0;
                arrived.push(who.clone());
            } else {
                n.ctl.input.stick.x = dx.signum() * (dx.abs() / 80.0).clamp(0.35, 1.0);
            }
        }
    }
    runner.strolls.retain(|s| !arrived.contains(&s.0));

    // Pip stays in every shot (bar a deliberate close-up).
    cam.cover = LETTERBOX;
    cam.keep = if runner.closeup {
        None
    } else {
        game.sim.npc_by_id("pip").and_then(|n| game.sim.world.body(n.ctl.body)).map(|b| {
            let (v, bb) = (b.velocity(), b.aabb);
            pip_box(Vec2::new(bb.min.x, bb.min.y), Vec2::new(bb.max.x, bb.max.y), Vec2::new(v.x, v.y))
        })
    };
    if let Some((who, zoom)) = runner.follow.clone() {
        if let Some(p) = actor_pos(&game, &who) {
            cam.target = Some(Vec2::new(p.x, p.y + 90.0));
            cam.zoom = Some(zoom);
            cam.ease = 0.6;
        }
    }

    if let Some(t) = cues.title.as_mut() {
        t.2 -= dt;
        if t.2 <= 0.0 {
            cues.title = None;
        }
    }

    // Advance beats.
    loop {
        let Some(beat) = runner.beats.get(runner.index).cloned() else {
            runner.done = true;
            return;
        };
        if !runner.started {
            runner.started = true;
            runner.timer = 0.0;
            match &beat {
                Beat::Title { title, sub } => cues.title = Some((title.clone(), sub.clone(), 2.6)),
                Beat::Say { who, text } | Beat::Aside { who, text } => {
                    runner.say_gap = if runner.last_speaker.as_ref().is_some_and(|l| l != who) { super::bubble::speaker_change_delay() } else { 0.0 };
                    runner.last_speaker = Some(who.clone());
                    let voice = voice_for(&game, who);
                    let speaker = if who == "lulu" { Speaker::Offscreen } else { Speaker::Actor(who.clone()) };
                    // The voice plays when the bubble actually appears.
                    say.write(SayRequest { speaker, text: text.clone(), voice, linger: linger_secs(text) });
                }
                Beat::Walk { who, x } | Beat::Stroll { who, x } => runner.strolls.push((who.clone(), *x)),
                Beat::Hop { who, hold } => runner.hops.push((who.clone(), *hold)),
                Beat::Puff { who, scale, secs } => {
                    if let Some(n) = game.sim.npc_by_id_mut(who) {
                        n.ctl.puff = Some(*scale);
                    }
                    runner.puffs.push((who.clone(), *secs));
                }
                Beat::Push { who, vel } => {
                    if let Some(body) = game.sim.npc_by_id(who).map(|n| n.ctl.body) {
                        if let Some(b) = game.sim.world.body_mut(body) {
                            b.add_velocity(*vel);
                        }
                    }
                }
                Beat::Scatter { prefix, from, speed } => {
                    let origin = actor_pos(&game, from).unwrap_or_default();
                    let bodies: Vec<_> =
                        game.sim.npcs.iter().filter(|n| n.id.starts_with(prefix.as_str())).map(|n| n.ctl.body).collect();
                    for (k, body) in bodies.into_iter().enumerate() {
                        if let Some(b) = game.sim.world.body_mut(body) {
                            let d = (b.centroid() - origin).normalize_or(PVec2::Y);
                            let up = 0.6 + (k % 3) as f32 * 0.25;
                            b.add_velocity((d + PVec2::Y * up).normalize() * *speed);
                            b.add_spin(if k % 2 == 0 { 6.0 } else { -6.0 });
                        }
                    }
                }
                Beat::Pop { who } => {
                    if let Some(body) = game.sim.npc_by_id(who).map(|n| n.ctl.body) {
                        game.sim.pop(body);
                    }
                }
                Beat::Cam { at, zoom, ease } | Beat::CloseUp { at, zoom, ease } => {
                    runner.follow = None;
                    runner.closeup = matches!(beat, Beat::CloseUp { .. });
                    cam.target = Some(Vec2::new(at.x, at.y));
                    cam.zoom = Some(*zoom);
                    cam.ease = *ease;
                }
                Beat::Follow { who, zoom } => {
                    runner.closeup = false;
                    runner.follow = Some((who.clone(), *zoom));
                }
                Beat::Shake(s) => cam.shake = cam.shake.max(*s),
                Beat::Word { who, text } => {
                    if let Some(p) = actor_pos(&game, who) {
                        word.write(super::WordRequest { text: text.clone(), at: Vec2::new(p.x, p.y + 80.0) });
                    }
                }
                Beat::SpeedLines(on) => cues.speed_lines = *on,
                Beat::Fade { to, secs } => {
                    cues.fade_target = *to;
                    cues.fade_speed = 1.0 / secs.max(0.01);
                }
                Beat::Eyes { who, state } => {
                    if let Some(body) = game.sim.npc_by_id(who).map(|n| n.ctl.body) {
                        let c = faces.0.entry(body).or_default();
                        c.closed = *state == EyeState::Closed;
                        c.roll = if *state == EyeState::Roll { 1.4 } else { 0.0 };
                        match state {
                            EyeState::None => {
                                c.sketch = Some(0.0);
                                c.sketch_secs = 0.0;
                            }
                            EyeState::Draw => {
                                c.sketch = Some(c.sketch.unwrap_or(0.0));
                                c.sketch_secs = EYE_DRAW_SECS;
                            }
                            // Drawn eyes open inside their outlines.
                            EyeState::Open | EyeState::Roll if c.sketch.take().is_some() => c.opening = Some(0.0),
                            _ => {}
                        }
                    }
                }
                Beat::Gaze { who, dir } => {
                    if let Some(body) = game.sim.npc_by_id(who).map(|n| n.ctl.body) {
                        faces.0.entry(body).or_default().look = dir.map(|d| Vec2::new(d.x, d.y));
                    }
                }
                Beat::Mood { who, mood } => {
                    if let Some(body) = game.sim.npc_by_id(who).map(|n| n.ctl.body) {
                        faces.0.entry(body).or_default().mood = *mood;
                    }
                }
                Beat::Wait(_) => {}
            }
        }
        runner.timer += dt;
        let t = runner.timer;
        let complete = match &beat {
            Beat::Title { .. } => t > 2.4 || (tapped && t > 0.4),
            Beat::Say { text, .. } => t > runner.say_gap + say_wait(text) || (tapped && t > runner.say_gap + 0.25),
            Beat::Walk { who, .. } => !runner.strolls.iter().any(|s| &s.0 == who) || t > 4.0,
            Beat::Wait(s) => t >= *s,
            Beat::Fade { secs, .. } => t >= *secs,
            _ => true,
        };
        if !complete {
            return;
        }
        runner.index += 1;
        runner.started = false;
        if matches!(beat, Beat::Say { .. } | Beat::Walk { .. } | Beat::Wait(_) | Beat::Title { .. } | Beat::Fade { .. }) {
            // Blocking beats end the frame so instant beats after them start next frame.
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::bubble::{CHARS_PER_SEC, linger_secs, type_secs};
    use super::*;

    /// The box makes room where Pip is going, and never less than the margin.
    #[test]
    fn pip_box_leads_a_jump() {
        let (min, max) = (Vec2::new(-30.0, 30.0), Vec2::new(30.0, 90.0));
        let still = pip_box(min, max, Vec2::ZERO);
        assert_eq!(still, Rect::from_corners(min - PIP_MARGIN, max + PIP_MARGIN));
        let jumping = pip_box(min, max, Vec2::new(0.0, 1400.0));
        assert_eq!(jumping.min, still.min);
        assert!((jumping.max.y - still.max.y - LEAD_MAX).abs() < 1e-3, "a fast jump gets the full lead");
        let hop = pip_box(min, max, Vec2::new(0.0, 500.0));
        assert!((hop.max.y - still.max.y - 500.0 * LEAD_SECS).abs() < 1e-3);
    }

    /// Every scripted shot (stage NPC positions at rest) keeps Pip in frame
    /// at the cutscene camera's widest zoom, at 16:9 with the letterbox up.
    #[test]
    fn every_scripted_shot_can_frame_pip() {
        use crate::camera::{KEEP_MAX_ZOOM, VIEW_H, VIEW_W, fit_shot, zoom_to_fit};
        let half = Vec2::new(VIEW_W, VIEW_H) * 0.5 * Vec2::new(1.0, 1.0 - 2.0 * LETTERBOX);
        for n in 1..=super::super::CHAPTERS {
            for id in [format!("ch{n:02}_intro"), format!("ch{n:02}_outro")] {
                let Some(cs) = super::super::scripts::cutscene(&id, 0xff5d73) else { continue };
                let pip = cs.stage.npcs.iter().find(|n| n.id == "pip").expect("every cutscene has Pip");
                let r = pip.radius;
                let keep = pip_box(Vec2::new(pip.pos.x - r, pip.pos.y - r), Vec2::new(pip.pos.x + r, pip.pos.y + r), Vec2::ZERO);
                for beat in &cs.beats {
                    if let Beat::Cam { at, zoom, .. } = beat {
                        let (t, z) = fit_shot(Vec2::new(at.x, at.y), *zoom, keep, half, KEEP_MAX_ZOOM.max(*zoom));
                        assert!(zoom_to_fit(t, keep, half) <= z + 1e-3, "{id}: Pip out of the shot at {at:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn text_pacing_is_readable_and_in_sync() {
        assert!((16.0..=18.0).contains(&CHARS_PER_SEC));
        for text in ["Hi!", "This mushroom looks... springy.", "Mushrooms remember you. Pop all you like! Then come back and find me by the big glowing tree."] {
            let (ty, wait, linger) = (type_secs(text), say_wait(text), linger_secs(text));
            // A Say beat never moves on before its line has finished typing
            // and had a moment to be read...
            assert!(wait >= ty + 0.8, "{text}");
            // ...and the bubble is still up when the next beat starts.
            assert!(ty + linger > wait, "{text}");
        }
    }
}
