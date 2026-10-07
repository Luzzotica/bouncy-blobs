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
    let rock_c = hex(rock);
    let jelly_c = hex(jelly);
    ThemeColors {
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
    }
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
