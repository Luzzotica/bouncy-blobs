//! Learn-mode data: the alphabet cycle, the Twinkle melody, colour names and
//! the voice-clip bank (legacy kidsAbc.ts, kidsMusic.ts, colorNames.ts,
//! kidsVoice.ts).

use std::collections::HashMap;

use bevy::prelude::*;

use super::level::KidsShape;
use crate::audio::{self, AudioSettings, synth};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum LearnMode {
    #[default]
    Alphabet,
    Music,
    Shape,
    Color,
}

impl LearnMode {
    pub const ALL: [LearnMode; 4] = [LearnMode::Alphabet, LearnMode::Music, LearnMode::Shape, LearnMode::Color];

    pub fn key(self) -> &'static str {
        match self {
            LearnMode::Alphabet => "alphabet",
            LearnMode::Music => "music",
            LearnMode::Shape => "shape",
            LearnMode::Color => "color",
        }
    }

    pub fn from_key(s: &str) -> Option<LearnMode> {
        LearnMode::ALL.into_iter().find(|m| m.key() == s)
    }
}

/// Seconds between letters / notes (legacy debounce).
pub const LETTER_GAP: f32 = 0.28;
pub const NOTE_GAP: f32 = 0.18;

/// Twinkle Twinkle Little Star, 42 notes, looping.
pub const TWINKLE: [f32; 42] = {
    const C: f32 = 261.63;
    const D: f32 = 293.66;
    const E: f32 = 329.63;
    const F: f32 = 349.23;
    const G: f32 = 392.00;
    const A: f32 = 440.00;
    [
        C, C, G, G, A, A, G, F, F, E, E, D, D, C, G, G, F, F, E, E, D, G, G, F, F, E, E, D, C, C, G, G, A, A, G, F, F, E,
        E, D, D, C,
    ]
};

/// Legacy `COLOR_PALETTE` with spoken names (duplicates share a clip).
pub const PALETTE_NAMES: [(u32, &str); 12] = [
    (0xe06070, "red"),
    (0xe88a5a, "orange"),
    (0xe8c54a, "yellow"),
    (0x6ecf6e, "green"),
    (0x4ac8c8, "teal"),
    (0x5a8ae0, "blue"),
    (0x8a6ae0, "purple"),
    (0xd06eb0, "pink"),
    (0xf0f0f0, "white"),
    (0xff4444, "red"),
    (0x44aaff, "blue"),
    (0xaa44ff, "purple"),
];

/// The 9 chips: one per spoken colour (legacy showed all 12 incl. 3 repeats).
pub fn chip_colors() -> [u32; 9] {
    std::array::from_fn(|i| PALETTE_NAMES[i].0)
}

/// Nearest palette colour's spoken name.
pub fn color_name(c: u32) -> &'static str {
    let rgb = |c: u32| [(c >> 16) as i32 & 255, (c >> 8) as i32 & 255, c as i32 & 255];
    let a = rgb(c);
    PALETTE_NAMES
        .iter()
        .min_by_key(|(p, _)| {
            let b = rgb(*p);
            (0..3).map(|k| (a[k] - b[k]).pow(2)).sum::<i32>()
        })
        .map_or("red", |p| p.1)
}

/// Pre-loaded voice clips + synthesized notes. One clip speaks at a time.
#[derive(Resource)]
pub struct KidsVoice {
    letters: Vec<Handle<AudioSource>>,
    colors: HashMap<&'static str, Handle<AudioSource>>,
    shapes: HashMap<&'static str, Handle<AudioSource>>,
    notes: HashMap<u32, Handle<AudioSource>>,
    active: Option<Entity>,
}

impl KidsVoice {
    pub fn load(server: &AssetServer, sources: &mut Assets<AudioSource>) -> KidsVoice {
        let clip = |stem: &str| server.load(format!("voice/kids/{stem}.mp3"));
        let mut notes = HashMap::new();
        for hz in TWINKLE {
            notes.entry(hz.to_bits()).or_insert_with(|| sources.add(audio::wav_source(&synth::twinkle_note(hz))));
        }
        KidsVoice {
            letters: ('a'..='z').map(|c| clip(&format!("letter-{c}"))).collect(),
            colors: PALETTE_NAMES.iter().map(|(_, n)| (*n, clip(&format!("color-{n}")))).collect(),
            shapes: super::level::KIDS_SHAPES.iter().map(|s| (s.stem(), clip(&format!("shape-{}", s.stem())))).collect(),
            notes,
            active: None,
        }
    }

    fn say(&mut self, commands: &mut Commands, clip: Option<Handle<AudioSource>>, settings: &AudioSettings) {
        self.stop(commands);
        if let Some(clip) = clip.filter(|_| settings.voice_gain() > 0.0) {
            self.active = Some(audio::spawn_sound(commands, clip, settings.voice_gain(), 1.0));
        }
    }

    pub fn letter(&mut self, commands: &mut Commands, l: char, s: &AudioSettings) {
        let i = (l.to_ascii_lowercase() as u8).wrapping_sub(b'a') as usize;
        let clip = self.letters.get(i).cloned();
        self.say(commands, clip, s);
    }

    pub fn color(&mut self, commands: &mut Commands, c: u32, s: &AudioSettings) {
        let clip = self.colors.get(color_name(c)).cloned();
        self.say(commands, clip, s);
    }

    pub fn shape(&mut self, commands: &mut Commands, shape: KidsShape, s: &AudioSettings) {
        let clip = self.shapes.get(shape.stem()).cloned();
        self.say(commands, clip, s);
    }

    /// Twinkle notes overlap (they don't cut the voice), at fixed 0.9 gain.
    pub fn note(&self, commands: &mut Commands, hz: f32, s: &AudioSettings) {
        if let Some(clip) = self.notes.get(&hz.to_bits()).filter(|_| s.voice_gain() > 0.0) {
            audio::spawn_sound(commands, clip.clone(), s.voice_gain(), 1.0);
        }
    }

    pub fn stop(&mut self, commands: &mut Commands) {
        if let Some(e) = self.active.take() {
            if let Ok(mut ec) = commands.get_entity(e) {
                ec.despawn();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colour_names_snap_to_nearest() {
        assert_eq!(color_name(0xe06070), "red");
        assert_eq!(color_name(0xff4444), "red");
        assert_eq!(color_name(0x6ecf6e), "green");
        assert_eq!(color_name(0x4d96ff), "blue");
        assert_eq!(color_name(0xffffff), "white");
    }

    #[test]
    fn twinkle_has_42_notes_and_6_pitches() {
        let mut v: Vec<u32> = TWINKLE.iter().map(|h| h.to_bits()).collect();
        v.sort();
        v.dedup();
        assert_eq!(v.len(), 6);
    }
}
