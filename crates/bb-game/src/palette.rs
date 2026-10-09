//! Colours. Every theme is a set of candy colours for the cave layer.

use bb_level::Theme;
use bevy::prelude::*;

pub fn hex(c: u32) -> Color {
    Color::srgb_u8((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

pub fn lin(c: Color) -> [f32; 4] {
    c.to_linear().to_f32_array()
}

/// Mix two colours in sRGB space.
pub fn mix(a: Color, b: Color, t: f32) -> Color {
    let (a, b) = (a.to_srgba(), b.to_srgba());
    Color::srgba(
        a.red + (b.red - a.red) * t,
        a.green + (b.green - a.green) * t,
        a.blue + (b.blue - a.blue) * t,
        a.alpha + (b.alpha - a.alpha) * t,
    )
}

pub fn darken(c: Color, t: f32) -> Color {
    mix(c, Color::BLACK, t)
}

pub fn lighten(c: Color, t: f32) -> Color {
    mix(c, Color::WHITE, t)
}

#[derive(Clone, Copy, Debug)]
pub struct ThemeColors {
    pub sky_top: Color,
    pub sky_bottom: Color,
    pub far: Color,
    pub rock: Color,
    pub rock_rim: Color,
    pub jelly: Color,
    pub jelly_rim: Color,
    pub accent: Color,
    pub glow: Color,
    pub water: Color,
    /// Black-cave look: black stone, near-black sky, luminous life.
    /// False for the daylight playroom and Kids Mode. (The Old Well is a
    /// cave climb like every other chapter: daylight only shows through
    /// its exit mouth.)
    pub dark: bool,
    /// Glow-mushroom colour (per-theme tint of the luminous accents).
    pub mush: Color,
    /// Crystal / glowworm colour.
    pub crystal: Color,
    /// Checkpoint lantern flowers: cyan-white or warm gold-white, whichever
    /// stands further from this theme's fungus and crystal light, so a
    /// checkpoint never reads as one more mushroom.
    pub lantern: Color,
}

pub fn theme(t: Theme) -> ThemeColors {
    let (sky_top, sky_bottom, rock, jelly, accent) = match t {
        Theme::Hollow => (0x2a1b3d, 0x4b2e5e, 0x6a4a7c, 0xc58bd8, 0xffc75f),
        Theme::Drip => (0x13293d, 0x1f4e5f, 0x355c6b, 0x7fd1c7, 0xb5ff7d),
        Theme::Fungus => (0x2b1d2f, 0x5d2e46, 0x6e4555, 0xff8fab, 0xffe066),
        Theme::Vines => (0x10261c, 0x1f4d34, 0x3b5e3f, 0x8bd48b, 0xf9f871),
        Theme::Stoneworks => (0x241f1c, 0x423630, 0x6b5b52, 0xd9a07a, 0xffb347),
        Theme::Lake => (0x0e1e3a, 0x1b3b6f, 0x34507a, 0x86c5ff, 0xfff1a8),
        Theme::Chimney => (0x2c2433, 0x5a4b6b, 0x7a6a8a, 0xc2b5ff, 0xffd6a5),
        Theme::Toys => (0x3d2c5e, 0xff8fb1, 0x8c6ad0, 0xffd166, 0x06d6a0),
        Theme::CaveIn => (0x1c1716, 0x3a2e2a, 0x5e4c45, 0xcf9b7a, 0xff6b6b),
        Theme::Well => (0x3a5a7a, 0xfff2c6, 0x6f7f8f, 0xa8e6cf, 0xfff27a),
        Theme::Playroom => (0xffd6e0, 0xfff5e1, 0xf4a6c0, 0xbde0fe, 0xffafcc),
        // Cream paper with lilac card walls and mint jelly.
        Theme::Kids => (0xfff3d6, 0xfffae6, 0xd9c8f5, 0xa8e6cf, 0xff8fab),
        Theme::Party => (0x232946, 0x3e4a89, 0x5b5f97, 0xeebbc3, 0xffd803),
    };
    // Luminous accents for the black cave: (jelly, mushroom, crystal, drop glow).
    let cave = match t {
        Theme::Hollow => Some((0xc98cff, 0xd77bff, 0x9fb8ff, 0xffd27a)),
        Theme::Drip => Some((0x5fe3d0, 0x6dffb0, 0x8ff7ff, 0xc8ff7d)),
        Theme::Fungus => Some((0xff7fb0, 0xff4fa0, 0xff9be8, 0xffd0ea)),
        Theme::Vines => Some((0x7fe08a, 0x8dff6a, 0xc6ff8a, 0xeaff86)),
        Theme::Stoneworks => Some((0xffa86b, 0xff9a3d, 0xffc98a, 0xffd38a)),
        Theme::Lake => Some((0x6fb8ff, 0x4fa8ff, 0x8fd8ff, 0xc4ecff)),
        Theme::Chimney => Some((0xb7a4ff, 0xc08bff, 0xffc9a0, 0xffe0b8)),
        Theme::Toys => Some((0xffc94d, 0x2ee6b0, 0xff8fd0, 0xff9fc0)),
        Theme::CaveIn => Some((0xff8a6a, 0xff5a5a, 0xffb070, 0xffc0a0)),
        Theme::Party => Some((0xff9fd0, 0xffd803, 0x8fd8ff, 0xfff27a)),
        // The Old Well: warm gold-and-mint life, the colour of the
        // daylight far above.
        Theme::Well => Some((0x9fe8c8, 0xffe27a, 0xfff0b8, 0xfff2c6)),
        Theme::Playroom | Theme::Kids => None,
    };
    let rock_c = hex(rock);
    let jelly_c = hex(jelly);
    match cave {
        Some((jelly, mush, crystal, glow)) => {
            let lantern = lantern_for(&[hex(jelly), hex(mush), hex(crystal), hex(glow)]);
            let j = hex(jelly);
            // A breath of the theme hue in the black so each chapter keeps
            // its mood without lifting the backdrop.
            let tint = |k: f32| mix(Color::BLACK, j, k);
            ThemeColors {
                sky_top: tint(0.02),
                sky_bottom: tint(0.075),
                far: tint(0.105),
                rock: Color::BLACK,
                rock_rim: tint(0.2),
                jelly: j,
                jelly_rim: lighten(j, 0.45),
                accent: hex(accent),
                glow: hex(glow),
                water: Color::srgba(0.3, 0.6, 1.0, 0.28),
                dark: true,
                mush: hex(mush),
                crystal: hex(crystal),
                lantern,
            }
        }
        None => ThemeColors {
            sky_top: hex(sky_top),
            sky_bottom: hex(sky_bottom),
            far: mix(hex(sky_bottom), rock_c, 0.35),
            rock: rock_c,
            rock_rim: darken(rock_c, 0.35),
            jelly: jelly_c,
            jelly_rim: darken(jelly_c, 0.3),
            accent: hex(accent),
            glow: lighten(hex(accent), 0.4),
            water: Color::srgba(0.35, 0.65, 1.0, 0.35),
            dark: false,
            mush: lighten(hex(accent), 0.1),
            crystal: lighten(hex(accent), 0.4),
            lantern: hex(0x5fd8ff),
        },
    }
}

/// The lantern candidate furthest (by its nearest neighbour) from `ambient`.
fn lantern_for(ambient: &[Color]) -> Color {
    let dist = |a: Color, b: Color| {
        let (a, b) = (a.to_srgba(), b.to_srgba());
        (a.red - b.red).powi(2) + (a.green - b.green).powi(2) + (a.blue - b.blue).powi(2)
    };
    [hex(0x8ff8ff), hex(0xffe58a)]
        .into_iter()
        .map(|c| (c, ambient.iter().map(|a| dist(c, *a)).fold(f32::MAX, f32::min)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map_or(hex(0x8ff8ff), |(c, _)| c)
}

pub fn material_tint(m: bb_level::Material, base: Color) -> Color {
    match m {
        bb_level::Material::Ground => base,
        bb_level::Material::Stone => mix(base, Color::srgb(0.6, 0.58, 0.55), 0.6),
        bb_level::Material::Ice => mix(base, Color::srgb(0.75, 0.95, 1.0), 0.75),
        bb_level::Material::Sticky => mix(base, Color::srgb(0.55, 0.85, 0.25), 0.7),
        bb_level::Material::Bouncy => mix(base, Color::srgb(1.0, 0.45, 0.7), 0.7),
    }
}

/// The scene's one glow-hue family: the theme's jelly light, leaning
/// smoothly toward its mushroom hue in some places and its crystal hue in
/// others. A slow function of position, so neighbouring glows always share
/// (nearly) the same colour and any change of hue is a gentle gradient —
/// never two different lights abutting with a hard edge.
pub fn glow_at(theme: &ThemeColors, x: f32, y: f32) -> Color {
    let k = ((x * 0.0019).sin() * 0.6 + (x * 0.00071 + y * 0.0012 + 1.3).sin() * 0.4).clamp(-1.0, 1.0);
    if k >= 0.0 { mix(theme.jelly, theme.mush, 0.45 * k) } else { mix(theme.jelly, theme.crystal, -0.45 * k) }
}

/// A pulse front's light at a point the front passed `x` px ago (negative:
/// not there yet). A soft leading edge, a brighter crest riding the front,
/// and a long gentle tail of `tail` px — never a step.
pub fn pulse_env(x: f32, lead: f32, tail: f32) -> f32 {
    if x < -lead {
        return 0.0;
    }
    let rise = {
        let t = ((x + lead) / (lead * 1.25)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let xp = x.max(0.0);
    rise * (0.55 * (-xp / tail).exp() + 0.45 * (-xp / lead).exp())
}

/// Combine overlapping lights softly (1 - Π(1 - a)): two fronts crossing
/// brighten, but never clip or flash.
pub fn screen_add(a: f32, b: f32) -> f32 {
    1.0 - (1.0 - a.clamp(0.0, 1.0)) * (1.0 - b.clamp(0.0, 1.0))
}

/// The level's one vine colour: a living green leaning toward the
/// chapter's jelly light, the same for every vine and root in the level.
pub fn vine(theme: &ThemeColors) -> Color {
    if theme.dark { mix(hex(0x6fd67a), theme.jelly, 0.35) } else { hex(0x7ccf6b) }
}
