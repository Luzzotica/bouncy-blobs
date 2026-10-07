//! Procedural audio rendered into in-memory WAV buffers: gibberish "blub"
//! voices, the Kids Mode Twinkle tone, and a few tiny game blips.
//!
//! Everything is short (< 2 s), so rendering a whole phrase up front is
//! cheaper and simpler than a streaming source, and sample-accurate.

use std::f32::consts::TAU;

use crate::story_iface::Voice;

pub const RATE: u32 = 44_100;

/// 16-bit mono PCM WAV file bytes.
pub fn wav(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut b = Vec::with_capacity(44 + data_len as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_len).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes()); // PCM
    b.extend_from_slice(&1u16.to_le_bytes()); // mono
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        b.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    b
}

fn secs(n: f32) -> usize {
    (n * RATE as f32) as usize
}

/// Tiny deterministic RNG (xorshift) so phrases vary but tests are stable.
pub struct Rng(pub u32);

impl Rng {
    pub fn f(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 >> 8) as f32 / (1u32 << 24) as f32
    }
}

/// How a character's blubs sound.
struct VoiceParams {
    /// Base pitch (Hz).
    pitch: f32,
    /// Random pitch spread per syllable, in semitones (±).
    spread: f32,
    syllable: f32,
    gap: f32,
    /// Vowel formants (Hz): "oo"-ish for blub.
    f1: f32,
    f2: f32,
    vibrato: (f32, f32),
    /// Pitch glide across one syllable (end / start).
    glide: f32,
    /// Bell partials instead of a voice (Glimmer).
    chime: bool,
    gain: f32,
}

fn params(v: Voice) -> VoiceParams {
    let base = VoiceParams {
        pitch: 300.0,
        spread: 3.0,
        syllable: 0.12,
        gap: 0.035,
        f1: 380.0,
        f2: 900.0,
        vibrato: (0.0, 0.0),
        glide: 0.8,
        chime: false,
        gain: 0.55,
    };
    match v {
        // High and squeaky, quick.
        Voice::Pip => VoiceParams { pitch: 540.0, spread: 4.0, syllable: 0.085, gap: 0.03, f1: 700.0, f2: 1700.0, glide: 0.75, ..base },
        // Low and wobbly: slow vibrato, long syllables.
        Voice::Granny => VoiceParams { pitch: 140.0, spread: 2.0, syllable: 0.19, gap: 0.05, f1: 330.0, f2: 800.0, vibrato: (5.5, 0.06), glide: 0.92, gain: 0.7, ..base },
        // Pompous: mid-low, brassy, declaiming (contour set per phrase).
        Voice::Reg => VoiceParams { pitch: 200.0, spread: 1.5, syllable: 0.15, gap: 0.04, f1: 520.0, f2: 1250.0, glide: 1.0, gain: 0.6, ..base },
        // Chimes: bell partials on a pentatonic.
        Voice::Glimmer => VoiceParams { pitch: 1046.5, syllable: 0.11, gap: 0.02, chime: true, gain: 0.35, ..base },
        Voice::Huddle => VoiceParams { pitch: 300.0, ..base },
        // Sweet and giggly: high, rising glides.
        Voice::Lulu => VoiceParams { pitch: 430.0, spread: 3.0, syllable: 0.1, gap: 0.03, f1: 620.0, f2: 1900.0, glide: 1.18, gain: 0.5, ..base },
    }
}

/// Seconds a phrase of `syllables` lasts for `voice` (bubble timing).
pub fn blub_duration(voice: Voice, syllables: u8) -> f32 {
    let p = params(voice);
    syllables.max(1) as f32 * (p.syllable + p.gap) + if p.chime { 0.4 } else { 0.05 }
}

/// Render a gibberish phrase.
pub fn blub_phrase(voice: Voice, syllables: u8, seed: u32) -> Vec<f32> {
    let p = params(voice);
    let n = syllables.max(1) as usize;
    let mut rng = Rng(seed | 1);
    let mut out = vec![0.0f32; secs(blub_duration(voice, syllables))];
    let mut start = 0usize;
    for k in 0..n {
        let len = p.syllable * (0.8 + rng.f() * 0.45);
        let mut f = p.pitch * 2f32.powf((rng.f() * 2.0 - 1.0) * p.spread / 12.0);
        if voice == Voice::Reg {
            // Up through the phrase, then a grand fall on the last word.
            let t = k as f32 / n.max(2) as f32;
            f *= if k + 1 == n { 0.82 } else { 1.0 + 0.25 * t };
        }
        if voice == Voice::Glimmer {
            const PENTA: [f32; 5] = [0.0, 2.0, 4.0, 7.0, 9.0];
            f = p.pitch * 2f32.powf(PENTA[(rng.f() * 5.0) as usize % 5] / 12.0);
        }
        let giggle = voice == Voice::Lulu && rng.f() < 0.3;
        let glide = if giggle { 1.35 } else { p.glide };
        let seg = if p.chime { chime(f, len + 0.4) } else { syllable(&p, f, len, glide) };
        for (i, s) in seg.iter().enumerate() {
            if let Some(o) = out.get_mut(start + i) {
                *o += s * p.gain;
            }
        }
        start += secs(len + p.gap);
    }
    out
}

/// One "blub": a buzzy voiced tone through two formants, pitch gliding,
/// with a lip-closure at both ends.
fn syllable(p: &VoiceParams, f0: f32, len: f32, glide: f32) -> Vec<f32> {
    let n = secs(len);
    let mut phase = 0.0f32;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / n as f32;
        let time = i as f32 / RATE as f32;
        let vib = 1.0 + p.vibrato.1 * (TAU * p.vibrato.0 * time).sin();
        let f = f0 * (1.0 + (glide - 1.0) * t) * vib;
        phase = (phase + TAU * f / RATE as f32) % (TAU * 64.0);
        // "b-l-UU-b": first formant opens then closes.
        let open = (t * std::f32::consts::PI).sin();
        let f1 = p.f1 * (0.6 + 0.4 * open);
        let mut s = 0.0;
        let mut k = 1.0;
        while k * f < 5000.0 && k < 24.0 {
            let h = k * f;
            let w = (-((h - f1) / 180.0).powi(2)).exp() + 0.45 * (-((h - p.f2) / 260.0).powi(2)).exp() + 0.25 / k;
            s += w * (phase * k).sin();
            k += 1.0;
        }
        // Envelope: soft attack, plosive close.
        let env = (t / 0.12).min(1.0) * ((1.0 - t) / 0.2).min(1.0).powf(1.5);
        out.push(s * env * 0.35);
    }
    out
}

/// Glass-bell tone (inharmonic partials, long decay).
fn chime(f: f32, len: f32) -> Vec<f32> {
    let n = secs(len);
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let a = (t / 0.004).min(1.0);
            a * ((TAU * f * t).sin() * (-t * 7.0).exp()
                + 0.5 * (TAU * f * 2.76 * t).sin() * (-t * 12.0).exp()
                + 0.25 * (TAU * f * 5.4 * t).sin() * (-t * 20.0).exp())
                * 0.6
        })
        .collect()
}

/// Kids Mode Twinkle note: triangle at f + sine an octave up, exponential
/// 18 ms attack to 0.95 and decay to silence at 0.38 s (legacy kidsMusic.ts).
pub fn twinkle_note(hz: f32) -> Vec<f32> {
    const NOTE: f32 = 0.38;
    let n = secs(NOTE + 0.03);
    (0..n)
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let env = if t < 0.018 {
                0.0001 * (0.95f32 / 0.0001).powf(t / 0.018)
            } else {
                0.95 * (0.0001f32 / 0.95).powf(((t - 0.018) / (NOTE - 0.018)).min(1.0))
            };
            let ph = (hz * t).fract();
            let tri = 4.0 * (ph - 0.5).abs() - 1.0;
            env * (tri * 0.55 + (TAU * 2.0 * hz * t).sin() * 0.35) * 0.9
        })
        .collect()
}

/// Glow-drop pickup: a bright two-partial plink (pitched up in streaks).
pub fn plink() -> Vec<f32> {
    (0..secs(0.28))
        .map(|i| {
            let t = i as f32 / RATE as f32;
            let a = (t / 0.003).min(1.0) * (-t * 16.0).exp();
            a * ((TAU * 1318.5 * t).sin() * 0.6 + (TAU * 2637.0 * t).sin() * 0.25) * 0.8
        })
        .collect()
}

/// Reforming after a pop: a bubbly upward bloop.
pub fn bloop() -> Vec<f32> {
    let n = secs(0.26);
    let mut phase = 0.0f32;
    (0..n)
        .map(|i| {
            let t = i as f32 / n as f32;
            let f = 260.0 + 620.0 * t * t;
            phase += TAU * f / RATE as f32;
            let env = (t / 0.08).min(1.0) * (1.0 - t).powi(2);
            (phase.sin() + 0.3 * (phase * 2.0).sin()) * env * 0.7
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_and_length() {
        let s = plink();
        let b = wav(&s);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(&b[8..12], b"WAVE");
        assert_eq!(b.len(), 44 + s.len() * 2);
    }

    #[test]
    fn blubs_are_audible_bounded_and_voiced_differently() {
        let rms = |s: &[f32]| (s.iter().map(|x| x * x).sum::<f32>() / s.len() as f32).sqrt();
        for v in [Voice::Pip, Voice::Granny, Voice::Glimmer, Voice::Reg, Voice::Huddle, Voice::Lulu] {
            let s = blub_phrase(v, 5, 7);
            assert_eq!(s.len(), secs(blub_duration(v, 5)));
            assert!(s.iter().all(|x| x.is_finite() && x.abs() < 1.5), "{v:?} clips");
            assert!(rms(&s) > 0.02, "{v:?} is silent");
        }
        // Zero crossings track pitch: Pip is far higher than Granny.
        let zc = |s: &[f32]| s.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f32 / s.len() as f32;
        let (pip, granny) = (zc(&blub_phrase(Voice::Pip, 6, 3)), zc(&blub_phrase(Voice::Granny, 6, 3)));
        assert!(pip > 1.5 * granny, "pip {pip} granny {granny}");
    }

    #[test]
    fn twinkle_note_envelope() {
        let s = twinkle_note(261.63);
        let peak = s.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.4 && peak <= 1.0);
        assert!(s[s.len() - 10].abs() < 0.01, "decays to silence");
    }
}
