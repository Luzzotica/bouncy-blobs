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
use super::{Blub, Voice};
use crate::camera::CameraDirector;
use crate::sim::{Game, Inputs};

#[derive(Clone, Debug)]
pub enum Beat {
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
    Cam { at: PVec2, zoom: f32, ease: f32 },
    Follow { who: String, zoom: f32 },
    Shake(f32),
    /// Onomatopoeia above an actor.
    Word { who: String, text: String },
    SpeedLines(bool),
    Fade { to: f32, secs: f32 },
}

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
        }
    }
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
    mut blub: MessageWriter<Blub>,
    mut prev_button: Local<bool>,
    mut word: MessageWriter<super::WordRequest>,
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
                    let voice = voice_for(&game, who);
                    let speaker = if who == "lulu" { Speaker::Offscreen } else { Speaker::Actor(who.clone()) };
                    say.write(SayRequest { speaker, text: text.clone(), voice, linger: linger_secs(text) });
                    blub.write(Blub { voice, syllables: (text.len() / 3).clamp(2, 16) as u8 });
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
                Beat::Cam { at, zoom, ease } => {
                    runner.follow = None;
                    cam.target = Some(Vec2::new(at.x, at.y));
                    cam.zoom = Some(*zoom);
                    cam.ease = *ease;
                }
                Beat::Follow { who, zoom } => runner.follow = Some((who.clone(), *zoom)),
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
                Beat::Wait(_) => {}
            }
        }
        runner.timer += dt;
        let t = runner.timer;
        let complete = match &beat {
            Beat::Title { .. } => t > 2.4 || (tapped && t > 0.4),
            Beat::Say { text, .. } => t > say_wait(text) || (tapped && t > 0.25),
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
    use super::say_wait;

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
