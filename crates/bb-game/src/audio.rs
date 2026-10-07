//! Audio: sound effects from sim events, per-theme music loops, and the
//! gibberish "blub" voices for story speech bubbles.
//!
//! * Anything can request a sound with a [`PlaySfx`] message (name, volume,
//!   pitch). Names with variants (`puff-up` → `puff-up-1..3`) pick one at
//!   random; each name is throttled to one play per 30 ms (legacy audio.ts).
//! * [`SimMsg`] events and controller edges map to sounds the way the
//!   legacy `effectsBindings.ts` did (volumes and pitch ranges copied).
//! * Story speech: read [`Blub`] messages, render a phrase procedurally.
//! * Everything respects [`AudioSettings`] (master / music / sfx, mute).

pub mod synth;

use std::collections::HashMap;
use std::sync::Arc;

use bb_level::Theme;
use bb_sim::{Action, BodyTag, SimEvent};
use bevy::audio::{AudioSinkPlayback, PlaybackMode, Volume};
use bevy::prelude::*;
use bevy::window::WindowFocused;

use crate::flow::AppState;
use crate::sim::{Game, Inputs, SimMsg};
use crate::story_iface::Blub;

/// Global volumes (0..1). Legacy defaults: music 0.34, sfx 0.85.
#[derive(Resource, Clone, Debug, PartialEq)]
pub struct AudioSettings {
    pub master: f32,
    pub music: f32,
    pub sfx: f32,
    pub mute: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        AudioSettings { master: 1.0, music: 0.34, sfx: 0.85, mute: false }
    }
}

impl AudioSettings {
    pub fn sfx_gain(&self) -> f32 {
        if self.mute { 0.0 } else { self.master * self.sfx }
    }
    pub fn music_gain(&self) -> f32 {
        if self.mute { 0.0 } else { self.master * self.music }
    }
    /// Voices (story blubs, Kids Mode clips) follow master only, like the
    /// legacy kids voice which ignored the sliders.
    pub fn voice_gain(&self) -> f32 {
        if self.mute { 0.0 } else { self.master }
    }
}

/// Play a named sound effect. See the module docs for names.
#[derive(Message, Clone, Debug)]
pub struct PlaySfx {
    pub name: &'static str,
    pub volume: f32,
    /// Playback rate (changes pitch and speed together).
    pub pitch: f32,
}

impl PlaySfx {
    pub fn new(name: &'static str, volume: f32, pitch: f32) -> PlaySfx {
        PlaySfx { name, volume, pitch }
    }
}

/// File-backed sounds (`assets/sfx/<name>.mp3`).
pub const SFX_FILES: [&str; 17] = [
    "land-squelch", "puff-up-1", "puff-up-2", "puff-up-3", "wall-stick", "wall-jump", "spring-boing", "spike-splat",
    "powerup-sparkle", "countdown-tick", "countdown-go", "round-win", "ui-hover", "ui-click", "ui-confirm",
    "ui-modal-open", "ui-modal-close",
];

/// Loaded and synthesized clips, keyed by base name (variants grouped).
#[derive(Resource, Default)]
pub struct SfxBank {
    clips: HashMap<&'static str, Vec<Handle<AudioSource>>>,
    last_played: HashMap<&'static str, f64>,
}

impl SfxBank {
    pub fn get(&self, name: &str) -> Option<&Vec<Handle<AudioSource>>> {
        self.clips.get(name)
    }
}

/// Marks short-lived sound entities.
#[derive(Component)]
pub struct Sfx;

/// The music loop entity.
#[derive(Component)]
pub struct Music {
    pub track: &'static str,
    /// Current fade level 0..1.
    pub level: f32,
    pub fading_out: bool,
    pub gain: f32,
}

/// Music per theme: (file, gain). The legacy game had two loops — the cave
/// theme and the bright Saturday-morning theme — so themes share them.
pub fn theme_music(theme: Theme) -> (&'static str, f32) {
    match theme {
        Theme::Toys | Theme::Well | Theme::Playroom | Theme::Party => ("music/theme.mp3", 1.0),
        // Quieter under the voice clips.
        Theme::Kids => ("music/theme.mp3", 0.55),
        Theme::Lake | Theme::Chimney => ("music/theme-cave.mp3", 0.9),
        _ => ("music/theme-cave.mp3", 1.0),
    }
}

/// Forces a particular music track (cutscenes, menus); `None` = by theme.
#[derive(Resource, Default)]
pub struct MusicOverride(pub Option<(&'static str, f32)>);

pub struct GameAudioPlugin;

impl Plugin for GameAudioPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<AudioSettings>()
            .init_resource::<SfxBank>()
            .init_resource::<MusicOverride>()
            .add_message::<PlaySfx>()
            .add_message::<Blub>()
            .add_systems(Startup, load_bank)
            .add_systems(Update, (sim_sounds, controller_sounds, play_sfx).chain())
            .add_systems(Update, (play_blubs, music, pause_on_blur));
    }
}

fn load_bank(server: Option<Res<AssetServer>>, sources: Option<ResMut<Assets<AudioSource>>>, mut bank: ResMut<SfxBank>) {
    let (Some(server), Some(mut sources)) = (server, sources) else { return };
    for name in SFX_FILES {
        let base: &'static str = match name.rsplit_once('-') {
            Some((b, n)) if n.parse::<u8>().is_ok() => b,
            _ => name,
        };
        bank.clips.entry(base).or_default().push(server.load(format!("sfx/{name}.mp3")));
    }
    for (name, samples) in [("plink", synth::plink()), ("bloop", synth::bloop())] {
        bank.clips.insert(name, vec![sources.add(wav_source(&samples))]);
    }
}

pub fn wav_source(samples: &[f32]) -> AudioSource {
    AudioSource { bytes: Arc::from(synth::wav(samples)) }
}

/// Spawn a one-shot sound. Returns the entity (despawns itself when done).
pub fn spawn_sound(commands: &mut Commands, clip: Handle<AudioSource>, volume: f32, speed: f32) -> Entity {
    commands
        .spawn((
            AudioPlayer(clip),
            PlaybackSettings { mode: PlaybackMode::Despawn, volume: Volume::Linear(volume), speed, ..default() },
            Sfx,
        ))
        .id()
}

fn play_sfx(
    mut commands: Commands,
    mut reader: MessageReader<PlaySfx>,
    mut bank: ResMut<SfxBank>,
    settings: Res<AudioSettings>,
    time: Res<Time<Real>>,
) {
    let now = time.elapsed_secs_f64();
    let gain = settings.sfx_gain();
    for m in reader.read() {
        if gain <= 0.0 || m.volume <= 0.0 {
            continue;
        }
        if bank.last_played.get(m.name).is_some_and(|t| now - t < 0.03) {
            continue;
        }
        let Some(clips) = bank.clips.get(m.name).filter(|c| !c.is_empty()) else { continue };
        let pick = (now * 7919.0) as usize % clips.len();
        let clip = clips[pick].clone();
        bank.last_played.insert(m.name, now);
        spawn_sound(&mut commands, clip, m.volume * gain, m.pitch.max(0.05));
    }
}

fn rand(seed: &mut u32) -> f32 {
    let mut r = synth::Rng(*seed);
    let v = r.f();
    *seed = r.0;
    v
}

/// Sim events → sounds (legacy effectsBindings.ts volumes).
fn sim_sounds(
    mut reader: MessageReader<SimMsg>,
    game: Option<Res<Game>>,
    time: Res<Time<Real>>,
    mut out: MessageWriter<PlaySfx>,
    mut seed: Local<u32>,
    mut last_land: Local<HashMap<bb_sim::BodyId, f64>>,
    mut streak: Local<(u32, f64)>,
) {
    if *seed == 0 {
        *seed = 0x2545_f491;
    }
    let now = time.elapsed_secs_f64();
    for SimMsg(e) in reader.read() {
        match e {
            SimEvent::Impact { body, speed, .. } => {
                const LAND_MIN: f32 = 220.0;
                const LAND_LOUD: f32 = 1400.0;
                let blob = game.as_ref().and_then(|g| g.sim.tag(*body)).is_some_and(|t| matches!(t, BodyTag::Player(_) | BodyTag::Npc(_)));
                if !blob || *speed < LAND_MIN || last_land.get(body).is_some_and(|t| now - t < 0.18) {
                    continue;
                }
                last_land.insert(*body, now);
                let t = ((speed - LAND_MIN) / (LAND_LOUD - LAND_MIN)).clamp(0.0, 1.0);
                out.write(PlaySfx::new("land-squelch", 0.06 + 0.09 * t, 0.7 + rand(&mut seed) * 0.28));
            }
            SimEvent::Popped { .. } => {
                out.write(PlaySfx::new("spike-splat", 0.10625, 0.9 + rand(&mut seed) * 0.2));
            }
            SimEvent::Respawned { .. } => {
                out.write(PlaySfx::new("bloop", 0.35, 1.0));
            }
            SimEvent::Checkpoint { .. } => {
                out.write(PlaySfx::new("powerup-sparkle", 0.7, 1.0));
            }
            SimEvent::Pickup { .. } => {
                // Rising major scale while drops are collected in a streak.
                const SCALE: [f32; 10] = [0.0, 2.0, 4.0, 5.0, 7.0, 9.0, 11.0, 12.0, 14.0, 16.0];
                *streak = if now - streak.1 < 1.0 { ((streak.0 + 1).min(9), now) } else { (0, now) };
                out.write(PlaySfx::new("plink", 0.45, 2f32.powf(SCALE[streak.0 as usize] / 12.0)));
            }
            SimEvent::Spring { .. } => {
                out.write(PlaySfx::new("spring-boing", 0.02625, 0.95 + rand(&mut seed) * 0.12));
            }
            SimEvent::Goal { .. } => {
                out.write(PlaySfx::new("round-win", 0.85, 1.0));
            }
            SimEvent::NpcFreed { .. } => {
                out.write(PlaySfx::new("powerup-sparkle", 0.5, 1.2));
            }
            SimEvent::Action { action, .. } => match action {
                Action::WallJump => {
                    out.write(PlaySfx::new("wall-jump", 0.7, 1.0));
                }
                Action::Grab => {
                    out.write(PlaySfx::new("wall-stick", 0.5, 1.15));
                }
                Action::Release => {
                    out.write(PlaySfx::new("wall-jump", 0.55, 1.1));
                }
                Action::Jump => {}
            },
            SimEvent::Story { .. } => {}
            SimEvent::Phew { .. } => {
                out.write(PlaySfx::new("powerup-sparkle", 0.4, 1.5));
            }
        }
    }
}

/// Edges read from controllers: expand (puff-up) and sticky-wall cling.
/// Only slots driven by a real device this frame make a puff, so AI blobs
/// in Kids Mode don't spam it.
fn controller_sounds(
    game: Option<Res<Game>>,
    inputs: Res<Inputs>,
    mut out: MessageWriter<PlaySfx>,
    mut prev: Local<HashMap<u8, (bool, bool)>>,
    mut seed: Local<u32>,
) {
    let Some(game) = game else {
        prev.clear();
        return;
    };
    if *seed == 0 {
        *seed = 0x9e37_79b9;
    }
    for p in &game.sim.players {
        let now = (p.ctl.input.button && p.dead.is_none(), p.ctl.stuck.is_some());
        let was = prev.insert(p.slot, now).unwrap_or(now);
        if now.0 && !was.0 && inputs.active[p.slot as usize] {
            out.write(PlaySfx::new("puff-up", 0.216 + rand(&mut seed) * 0.072, 1.3 + rand(&mut seed) * 0.5));
        }
        if now.1 && !was.1 {
            out.write(PlaySfx::new("wall-stick", 0.6, 1.0));
        }
    }
}

fn play_blubs(
    mut commands: Commands,
    mut reader: MessageReader<Blub>,
    sources: Option<ResMut<Assets<AudioSource>>>,
    settings: Res<AudioSettings>,
    mut seed: Local<u32>,
) {
    let Some(mut sources) = sources else {
        reader.clear();
        return;
    };
    for b in reader.read() {
        *seed = seed.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
        if settings.voice_gain() <= 0.0 {
            continue;
        }
        let clip = sources.add(wav_source(&synth::blub_phrase(b.voice, b.syllables, *seed)));
        spawn_sound(&mut commands, clip, settings.voice_gain(), 1.0);
    }
}

/// Keeps one looping track playing for the current theme, crossfading on
/// change, with live volume.
fn music(
    mut commands: Commands,
    server: Option<Res<AssetServer>>,
    game: Option<Res<Game>>,
    state: Option<Res<State<AppState>>>,
    over: Res<MusicOverride>,
    settings: Res<AudioSettings>,
    time: Res<Time<Real>>,
    mut q: Query<(Entity, &mut Music, Option<&mut AudioSink>)>,
) {
    let Some(server) = server else { return };
    let booting = state.is_some_and(|s| *s.get() == AppState::Boot) && game.is_none();
    let want = over.0.or_else(|| game.as_ref().map(|g| theme_music(g.sim.level.theme))).or((!booting).then_some(("music/theme-cave.mp3", 1.0)));
    let dt = time.delta_secs();
    let mut have = false;
    for (e, mut m, sink) in q.iter_mut() {
        if want.is_none_or(|w| w.0 != m.track) {
            m.fading_out = true;
        } else {
            m.fading_out = false;
            m.gain = want.unwrap().1;
            have = true;
        }
        m.level = if m.fading_out { (m.level - dt / 0.8).max(0.0) } else { (m.level + dt / 1.2).min(1.0) };
        if let Some(mut sink) = sink {
            sink.set_volume(Volume::Linear(m.level * m.gain * settings.music_gain()));
        }
        if m.fading_out && m.level <= 0.0 {
            commands.entity(e).despawn();
        }
    }
    if let (Some((track, gain)), false) = (want, have) {
        commands.spawn((
            AudioPlayer::new(server.load(track)),
            PlaybackSettings { mode: PlaybackMode::Loop, volume: Volume::Linear(0.0), ..default() },
            Music { track, level: 0.0, fading_out: false, gain },
        ));
    }
}

/// Pause music while the window is in the background (iOS app switch).
fn pause_on_blur(mut focus: MessageReader<WindowFocused>, q: Query<&AudioSink, With<Music>>) {
    for f in focus.read() {
        for s in q.iter() {
            if f.focused { s.play() } else { s.pause() }
        }
    }
}
