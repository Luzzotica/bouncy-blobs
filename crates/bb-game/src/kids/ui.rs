//! Kids Mode chrome, built from softbodies like everything else: colour
//! chips are candy blobs on the floor tray, the learn-mode picker and the
//! hold-to-exit button are paper stickies on the ceiling shelf. They float
//! on soft home tethers (no gravity, no collisions) and wobble when tapped.
//!
//! Sizes are in world units; the camera fits `VIEW_MIN..VIEW_MAX`, so on an
//! iPad (≈1.3 world units per point) every target is ≥ 64 pt.

use bb_physics::{BodyDesc, BodyId, Vec2 as PVec2};
use bb_sim::load::layer;
use bb_sim::{BodyTag, Sim};
use bevy::prelude::*;

use super::fx::{self, Glyph, INK, LAVENDER, PAPER, Z_UI};
use super::lessons::LearnMode;
use super::{HOLD_SECS, Kids, KidsEntity};
use crate::palette::{darken, hex, lighten, lin, mix};
use crate::render::{BodyEntities, BodyVisual, MeshBuf, Shared, Style, empty_mesh};
use crate::sim::Game;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UiKind {
    Chip(u32),
    Mode(LearnMode),
    Puff,
    Home,
    Badge,
}

#[derive(Clone, Debug)]
pub struct UiItem {
    pub kind: UiKind,
    pub body: BodyId,
    pub center: PVec2,
    pub size: PVec2,
    /// Paper sticky tilt (radians), like the legacy rotated cards.
    pub tilt: f32,
}

pub const CHIP_R: f32 = 44.0;
pub const PUFF_R: f32 = 60.0;
const SHELF_Y: f32 = 760.0;
const TRAY_Y: f32 = -62.0;

/// Rounded rectangle outline, CCW, roughly every `step` units.
fn rounded_rect(c: PVec2, size: PVec2, r: f32, tilt: f32) -> Vec<PVec2> {
    let h = size * 0.5 - PVec2::splat(r);
    let rot = PVec2::from_angle(tilt);
    let mut pts = Vec::new();
    for (k, corner) in [PVec2::new(h.x, -h.y), PVec2::new(h.x, h.y), PVec2::new(-h.x, h.y), PVec2::new(-h.x, -h.y)].iter().enumerate() {
        let a0 = -std::f32::consts::FRAC_PI_2 + k as f32 * std::f32::consts::FRAC_PI_2;
        for i in 0..=4 {
            let a = a0 + i as f32 / 4.0 * std::f32::consts::FRAC_PI_2;
            pts.push(*corner + PVec2::new(a.cos(), a.sin()) * r);
        }
    }
    let pts = bb_physics::body::resample_loop(&pts, 14.0);
    pts.into_iter().map(|p| c + rot.rotate(p)).collect()
}

fn circle(c: PVec2, r: f32) -> Vec<PVec2> {
    (0..24).map(|i| c + PVec2::from_angle(i as f32 / 24.0 * std::f32::consts::TAU) * r).collect()
}

fn add_ui_body(sim: &mut Sim, outline: &[PVec2]) -> BodyId {
    let mut d = BodyDesc::blob_from_outline(outline, 1.0);
    d.params.gravity_scale = 0.0;
    d.params.limits.poppable = false;
    d.params.shape_compliance = Some(1e-6);
    d.params.internal_damping = 5.0;
    d.layer = layer::UI;
    d.mask = 0;
    let id = sim.world.add_body(d);
    sim.world.body_mut(id).unwrap().anchor_home(3e-5);
    sim.tags.insert(id, BodyTag::Ui);
    id
}

/// Lay out every control. Returns the items in tap-priority order.
pub fn spawn_items(sim: &mut Sim, chips: &[u32]) -> Vec<UiItem> {
    let mut items = Vec::new();
    let mut add = |sim: &mut Sim, kind, center: PVec2, size: PVec2, tilt: f32, round: bool| {
        let outline = if round { circle(center, size.x * 0.5) } else { rounded_rect(center, size, 16.0, tilt) };
        let body = add_ui_body(sim, &outline);
        items.push(UiItem { kind, body, center, size, tilt });
    };
    // Floor tray: colour chips, then the big PUFF button.
    for (i, c) in chips.iter().enumerate() {
        add(sim, UiKind::Chip(*c), PVec2::new(110.0 + i as f32 * 108.0, TRAY_Y), PVec2::splat(CHIP_R * 2.0), 0.0, true);
    }
    add(sim, UiKind::Puff, PVec2::new(1138.0, TRAY_Y + 6.0), PVec2::splat(PUFF_R * 2.0), 0.0, true);
    // Ceiling shelf: hold-to-exit, learn modes, badge.
    add(sim, UiKind::Home, PVec2::new(118.0, SHELF_Y), PVec2::new(176.0, 86.0), -0.035, false);
    for (k, m) in LearnMode::ALL.iter().enumerate() {
        let x = 600.0 + (k as f32 - 1.5) * 116.0;
        add(sim, UiKind::Mode(*m), PVec2::new(x, SHELF_Y), PVec2::splat(96.0), -0.014, false);
    }
    add(sim, UiKind::Badge, PVec2::new(1102.0, SHELF_Y), PVec2::splat(100.0), 0.026, false);
    items
}

/// Tape colour per learn mode (legacy picker).
pub fn mode_tape(m: LearnMode) -> u32 {
    match m {
        LearnMode::Alphabet => fx::PINK,
        LearnMode::Music => LAVENDER,
        LearnMode::Shape => fx::GREEN,
        LearnMode::Color => fx::YELLOW,
    }
}

pub fn mode_glyph(m: LearnMode) -> Glyph {
    match m {
        LearnMode::Alphabet => Glyph::Text("ABC"),
        LearnMode::Music => Glyph::Note,
        LearnMode::Shape => Glyph::Star,
        LearnMode::Color => Glyph::Dot,
    }
}

/// Tap feedback: particles spring outward from the touch, then settle home.
pub fn poke(sim: &mut Sim, body: BodyId, at: PVec2) {
    if let Some(b) = sim.world.body_mut(body) {
        for i in 0..b.len() {
            let d = (b.x[i] - at).normalize_or_zero();
            b.v[i] += d * 240.0;
        }
    }
}

/// Text labels that ride on a UI body.
#[derive(Component)]
pub struct UiLabel {
    pub item: usize,
    pub offset: Vec2,
}

/// The overlay mesh (tape, selection rings, glyphs, progress fill).
#[derive(Component)]
pub struct UiOverlay(pub Handle<Mesh>);

pub(crate) fn spawn_overlay(commands: &mut Commands, meshes: &mut Assets<Mesh>, shared: &Shared, items: &[UiItem]) {
    let h = meshes.add(empty_mesh());
    commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, Z_UI + 0.5), UiOverlay(h), KidsEntity));
    let ink = hex(INK);
    for (i, it) in items.iter().enumerate() {
        let (text, size, off) = match it.kind {
            UiKind::Mode(LearnMode::Alphabet) => ("ABC", 34.0, Vec2::ZERO),
            UiKind::Puff => ("PUFF", 30.0, Vec2::ZERO),
            UiKind::Home => ("HOME", 32.0, Vec2::new(22.0, 0.0)),
            UiKind::Badge => ("", 64.0, Vec2::ZERO),
            _ => continue,
        };
        let color = if it.kind == UiKind::Puff { hex(PAPER) } else { ink };
        commands.spawn((
            Text2d::new(text),
            TextFont { font_size: FontSize::Px(size), weight: FontWeight::BOLD, ..default() },
            TextColor(color),
            Transform::from_xyz(it.center.x, it.center.y, Z_UI + 1.0),
            UiLabel { item: i, offset: off },
            KidsEntity,
        ));
    }
}

/// Append a unit glyph mesh scaled to `size` at `at`.
fn glyph_at(buf: &mut MeshBuf, g: Glyph, fill: Color, at: PVec2, size: f32, z: f32) {
    let mut tmp = MeshBuf::default();
    fx::glyph_mesh(g, fill, &mut tmp);
    let base = buf.pos.len() as u32;
    for (p, c) in tmp.pos.iter().zip(&tmp.col) {
        buf.pos.push([at.x + p[0] * size, at.y + p[1] * size, z + p[2]]);
        buf.col.push(*c);
    }
    buf.idx.extend(tmp.idx.iter().map(|i| i + base));
}

/// Per-frame look of the chrome: body styles, puff/selection scale, tape,
/// rings, glyphs, the hold-to-exit fill, and label positions.
pub(crate) fn visuals(
    mut game: ResMut<Game>,
    kids: Res<Kids>,
    time: Res<Time>,
    map: Res<BodyEntities>,
    mut vis: Query<(&mut BodyVisual, &mut Transform), Without<UiLabel>>,
    mut meshes: ResMut<Assets<Mesh>>,
    overlay: Query<&UiOverlay>,
    mut labels: Query<(&UiLabel, &mut Transform, &mut Text2d, &mut Visibility), Without<BodyVisual>>,
) {
    let dt = time.delta_secs();
    let t = time.elapsed_secs();
    let ink = hex(INK);
    let paper = hex(PAPER);
    let mut buf = MeshBuf::default();
    let player_color = kids.color;
    // Keep player / friend colours live (chips recolour the player).
    let colors: Vec<(BodyId, u32)> = game.sim.players.iter().map(|p| (p.ctl.body, p.color)).collect();
    for (body, c) in colors {
        if let Some((mut v, _)) = map.0.get(&body).and_then(|e| vis.get_mut(*e).ok()) {
            v.style.fill = hex(c);
            v.style.rim = darken(hex(c), 0.45);
        }
    }
    // Jelly platforms as stickers: full darker rim instead of a top lip.
    let jelly: Vec<BodyId> = game.sim.jelly.iter().map(|j| j.0).collect();
    for body in jelly {
        if let Some((mut v, _)) = map.0.get(&body).and_then(|e| vis.get_mut(*e).ok()) {
            if v.style.top_rim_only {
                v.style.top_rim_only = false;
                v.style.rim = darken(v.style.fill, 0.32);
                v.style.rim_w = 4.0;
            }
        }
    }
    for (i, it) in kids.ui.iter().enumerate() {
        let selected = match it.kind {
            UiKind::Chip(c) => c == player_color,
            UiKind::Mode(m) => m == kids.mode,
            UiKind::Puff => kids.puff.is_some(),
            UiKind::Home => kids.home.is_some(),
            UiKind::Badge => false,
        };
        let style = match it.kind {
            UiKind::Chip(c) => Style { fill: hex(c), rim: ink, rim_w: 4.0, highlight: true, z: Z_UI, top_rim_only: false },
            UiKind::Puff => Style { fill: hex(0x7b68ee), rim: ink, rim_w: 4.5, highlight: true, z: Z_UI, top_rim_only: false },
            UiKind::Mode(_) if !selected => Style { fill: mix(paper, hex(0xe9dcc0), 0.55), rim: mix(ink, paper, 0.35), rim_w: 4.0, highlight: false, z: Z_UI, top_rim_only: false },
            _ => Style { fill: paper, rim: ink, rim_w: 4.0, highlight: false, z: Z_UI, top_rim_only: false },
        };
        if let Some((mut v, mut tf)) = map.0.get(&it.body).and_then(|e| vis.get_mut(*e).ok()) {
            v.style = style;
            tf.translation.z = Z_UI + i as f32 * 0.001;
        }
        let Some(b) = game.sim.world.body_mut(it.body) else { continue };
        // Selected things puff up a little; PUFF squashes while held.
        let target = match it.kind {
            UiKind::Puff if selected => 0.9,
            _ if selected => 1.1,
            _ => 1.0,
        };
        b.rest_scale += (target - b.rest_scale) * (1.0 - (-dt * 12.0).exp());
        let c = b.centroid();
        let outline: Vec<PVec2> = b.outline().collect();
        let s = b.rest_scale;
        let up = PVec2::from_angle(it.tilt).perp();
        let right = PVec2::from_angle(it.tilt);

        // Washi tape across the top of paper stickies.
        let tape = match it.kind {
            UiKind::Mode(m) => Some(mode_tape(m)),
            UiKind::Home => Some(LAVENDER),
            UiKind::Badge => Some(match kids.mode {
                LearnMode::Music => LAVENDER,
                LearnMode::Shape => fx::GREEN,
                LearnMode::Color => fx::YELLOW,
                LearnMode::Alphabet => fx::PINK,
            }),
            _ => None,
        };
        if let Some(tc) = tape {
            let tc = lin(hex(tc).with_alpha(0.8));
            let tc_r = PVec2::from_angle(it.tilt + 0.12);
            let at = c + up * it.size.y * 0.5 * s;
            let (w, h) = (it.size.x * 0.45, 13.0);
            let q = [at - tc_r * w - tc_r.perp() * h, at + tc_r * w - tc_r.perp() * h, at + tc_r * w + tc_r.perp() * h, at - tc_r * w + tc_r.perp() * h];
            buf.fan(&q, at, 0.3, tc, tc);
        }
        if selected && !matches!(it.kind, UiKind::Puff | UiKind::Home) {
            // Paper + lavender double ring (legacy selected chip).
            buf.ring(&outline, -4.0, 9.0, 0.0, lin(paper));
            buf.ring(&outline, -9.0, 17.0, -0.01, lin(hex(LAVENDER)));
        }
        let wob = (t * 2.3 + i as f32).sin() * 0.04;
        match it.kind {
            UiKind::Mode(m) if m != LearnMode::Alphabet => {
                let fill = match m {
                    LearnMode::Music => hex(LAVENDER),
                    LearnMode::Shape => hex(0x6ecf6e),
                    _ => hex(0xe06070),
                };
                glyph_at(&mut buf, mode_glyph(m), fill, c, 58.0 * s, 0.2);
                if m == LearnMode::Color {
                    // A little rainbow: three dots on the big one.
                    for (k, col) in [0xe8c54a, 0x5a8ae0, 0x6ecf6e].iter().enumerate() {
                        let a = 0.9 + k as f32 * 1.6;
                        glyph_at(&mut buf, Glyph::Dot, hex(*col), c + PVec2::from_angle(a) * 12.0 * s, 18.0 * s, 0.25);
                    }
                }
            }
            UiKind::Home => {
                // Arrow ← and the hold progress fill.
                let p = kids.home.map_or(0.0, |h| (h.1 / HOLD_SECS).min(1.0));
                if p > 0.0 {
                    let w = it.size.x * s - 16.0;
                    let h = it.size.y * s - 16.0;
                    let lo = c - right * (w * 0.5) - up * (h * 0.5);
                    let q = [lo, lo + right * w * p, lo + right * w * p + up * h, lo + up * h];
                    buf.fan(&q, (q[0] + q[2]) * 0.5, 0.1, lin(Color::srgba(0.78, 0.49, 1.0, 0.45)), lin(Color::srgba(0.78, 0.49, 1.0, 0.45)));
                }
                let a = c - right * 52.0;
                let ink_l = lin(ink);
                buf.stroke(&[a + right * 30.0, a], 9.0, 0.2, ink_l);
                buf.stroke(&[a + right * 16.0 + up * 15.0, a, a + right * 16.0 - up * 15.0], 9.0, 0.2, ink_l);
            }
            UiKind::Badge => {
                if !matches!(kids.badge.0, Glyph::Letter(_) | Glyph::Text(_)) {
                    glyph_at(&mut buf, kids.badge.0, kids.badge.1, c, 64.0 * s * (1.0 + wob), 0.2);
                }
            }
            _ => {}
        }
    }
    if let Some(o) = overlay.iter().next() {
        if let Some(mut m) = meshes.get_mut(&o.0) {
            buf.write(&mut m);
        }
    }
    for (l, mut tf, mut text, mut v) in labels.iter_mut() {
        let Some(it) = kids.ui.get(l.item) else { continue };
        let Some(b) = game.sim.world.body(it.body) else { continue };
        let c = b.centroid();
        tf.translation.x = c.x + l.offset.x;
        tf.translation.y = c.y + l.offset.y;
        tf.rotation = Quat::from_rotation_z(it.tilt);
        tf.scale = Vec3::splat(b.rest_scale);
        if it.kind == UiKind::Badge {
            let s = match kids.badge.0 {
                Glyph::Letter(ch) => ch.to_string(),
                Glyph::Text(t) => t.to_string(),
                _ => String::new(),
            };
            if text.0 != s {
                text.0 = s;
            }
        }
        if it.kind == UiKind::Home {
            *v = Visibility::Visible;
        }
    }
    let _ = lighten;
}
