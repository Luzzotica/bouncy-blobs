//! Soft text: every glyph is its own sprite riding a softbody.
//!
//! Text is laid out once (advances measured straight from the font file, so
//! layout is synchronous and testable), then each glyph is spawned as its own
//! `Text2d`. Every frame each glyph's rest-frame position is mapped through
//! the body it rides — barycentrically inside a mesh triangle, or by a local
//! best-fit affine on ring blobs — and the glyph is rotated and squashed by
//! the jelly's local deformation. On top of that every glyph has its own
//! little spring (offset, squash, tilt), so letters pop in with a boing,
//! burst out of FX words and jiggle when kicked.
//!
//! [`JiggleText`] is the bevy_ui cousin for HUD numbers: one text node per
//! glyph, and the glyphs that change bounce.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use bb_physics::{Body, BodyId, Mat2, RestAnchor, Vec2 as PVec2};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::sim::Game;

static FONT_BYTES: &[u8] = include_bytes!("../assets/fonts/Fredoka.ttf");

/// Horizontal advance of `ch` in em units at `weight` (Fredoka is variable).
pub fn advance(ch: char, weight: u16) -> f32 {
    static CACHE: OnceLock<Mutex<HashMap<(char, u16), f32>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(a) = cache.lock().ok().and_then(|c| c.get(&(ch, weight)).copied()) {
        return a;
    }
    let a = measure(ch, weight).unwrap_or(0.55);
    if let Ok(mut c) = cache.lock() {
        c.insert((ch, weight), a);
    }
    a
}

fn measure(ch: char, weight: u16) -> Option<f32> {
    let mut face = ttf_parser::Face::parse(FONT_BYTES, 0).ok()?;
    let _ = face.set_variation(ttf_parser::Tag::from_bytes(b"wght"), (weight as f32).clamp(300.0, 700.0));
    let gid = face.glyph_index(ch).or_else(|| face.glyph_index('?'))?;
    Some(face.glyph_hor_advance(gid)? as f32 / face.units_per_em() as f32)
}

/// One laid-out glyph.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    pub ch: char,
    /// Char index in the source text (for typewriter reveals).
    pub index: usize,
    /// Glyph centre relative to the text block's centre (y up).
    pub pos: Vec2,
    pub adv: f32,
}

#[derive(Clone, Debug, Default)]
pub struct Layout {
    /// Visible glyphs only (no whitespace).
    pub slots: Vec<Slot>,
    pub size: Vec2,
}

pub const LINE_HEIGHT: f32 = 1.2;

/// Lay out `text`, centred on the origin, each line centred, greedy word
/// wrap at `wrap` units.
pub fn layout(text: &str, size: f32, weight: u16, wrap: Option<f32>) -> Layout {
    let chars: Vec<char> = text.chars().collect();
    let adv = |c: char| advance(c, weight) * size;
    let space = adv(' ');
    // Lines of (index, x, advance).
    let mut lines: Vec<Vec<(usize, f32, f32)>> = vec![Vec::new()];
    let mut x = 0.0f32;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\n' => {
                lines.push(Vec::new());
                x = 0.0;
                i += 1;
            }
            c if c.is_whitespace() => {
                if !lines.last().unwrap().is_empty() {
                    x += space;
                }
                i += 1;
            }
            _ => {
                let mut j = i;
                while j < chars.len() && !chars[j].is_whitespace() {
                    j += 1;
                }
                let w: f32 = chars[i..j].iter().map(|c| adv(*c)).sum();
                if wrap.is_some_and(|wr| !lines.last().unwrap().is_empty() && x + w > wr) {
                    lines.push(Vec::new());
                    x = 0.0;
                }
                for (k, c) in chars.iter().enumerate().take(j).skip(i) {
                    let a = adv(*c);
                    lines.last_mut().unwrap().push((k, x, a));
                    x += a;
                }
                i = j;
            }
        }
    }
    let lh = size * LINE_HEIGHT;
    let n = lines.len() as f32;
    let mut out = Layout { slots: Vec::new(), size: Vec2::new(0.0, n * lh) };
    for (li, line) in lines.iter().enumerate() {
        let w = line.last().map_or(0.0, |(_, x, a)| x + a);
        out.size.x = out.size.x.max(w);
        let y = ((n - 1.0) * 0.5 - li as f32) * lh;
        for &(index, x, a) in line {
            out.slots.push(Slot { ch: chars[index], index, pos: Vec2::new(x + a * 0.5 - w * 0.5, y), adv: a });
        }
    }
    out
}

/// What a soft text rides on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Ride {
    /// A body in the running game's world. `offset` is in the body's rest
    /// frame (relative to its rest centroid).
    Game(BodyId),
    /// A body in some other world (the pause overlay); posed by its owner
    /// through [`pose`].
    Overlay(BodyId),
    /// Nothing: `offset` is a world position (FX words).
    Free,
}

#[derive(Clone, Debug)]
struct GlyphState {
    entity: Entity,
    slot: Slot,
    order: usize,
    anchor: Option<RestAnchor>,
    shown: bool,
    off: Vec2,
    off_v: Vec2,
    /// Uniform scale deviation (pop-in).
    sq: f32,
    sq_v: f32,
    /// Squash/stretch deviation (y grows, x shrinks).
    jg: f32,
    jg_v: f32,
    rot: f32,
    rot_v: f32,
}

/// Text made of jelly glyphs. Spawn it on its own entity; glyphs are
/// spawned as its children (the entity itself stays at the origin, so
/// despawning it cleans everything up).
#[derive(Component, Clone, Debug)]
#[require(Transform, Visibility)]
pub struct SoftText {
    pub text: String,
    pub size: f32,
    pub weight: u16,
    pub color: Color,
    pub wrap: Option<f32>,
    pub z: f32,
    pub ride: Ride,
    pub offset: Vec2,
    /// Chars revealed (typewriter); `f32::INFINITY` shows everything.
    pub reveal: f32,
    pub alpha: f32,
    /// Seconds between glyphs popping in when revealed together.
    pub stagger: f32,
    /// FX words: initial outward speed of every letter.
    pub burst: f32,
    /// Shrink the text to fit this width.
    pub fit_width: Option<f32>,
    /// Spring stiffness / damping of the per-glyph wobble.
    pub stiffness: f32,
    pub damping: f32,
    built: Option<(String, u32, u16, Option<u32>)>,
    glyphs: Vec<GlyphState>,
    layout_size: Vec2,
    age: f32,
}

impl SoftText {
    pub fn new(text: impl Into<String>, size: f32) -> SoftText {
        SoftText {
            text: text.into(),
            size,
            weight: 700,
            color: Color::WHITE,
            wrap: None,
            z: crate::render::z::FX - 0.5,
            ride: Ride::Free,
            offset: Vec2::ZERO,
            reveal: f32::INFINITY,
            alpha: 1.0,
            stagger: 0.03,
            burst: 0.0,
            fit_width: None,
            stiffness: 260.0,
            damping: 7.0,
            built: None,
            glyphs: Vec::new(),
            layout_size: Vec2::ZERO,
            age: 0.0,
        }
    }

    pub fn ride(mut self, r: Ride) -> Self {
        self.ride = r;
        self
    }
    pub fn color(mut self, c: Color) -> Self {
        self.color = c;
        self
    }
    pub fn weight(mut self, w: u16) -> Self {
        self.weight = w;
        self
    }
    pub fn z(mut self, z: f32) -> Self {
        self.z = z;
        self
    }
    pub fn at(mut self, offset: Vec2) -> Self {
        self.offset = offset;
        self
    }
    pub fn wrap(mut self, w: f32) -> Self {
        self.wrap = Some(w);
        self
    }
    pub fn fit(mut self, w: f32) -> Self {
        self.fit_width = Some(w);
        self
    }
    pub fn stagger(mut self, s: f32) -> Self {
        self.stagger = s;
        self
    }
    pub fn typewriter(mut self) -> Self {
        self.reveal = 0.0;
        self
    }

    /// Laid-out size of the full text (before fit scaling).
    pub fn measure(&self) -> Vec2 {
        layout(&self.text, self.size, self.weight, self.wrap).size
    }

    pub fn body(&self) -> Option<BodyId> {
        match self.ride {
            Ride::Game(b) | Ride::Overlay(b) => Some(b),
            Ride::Free => None,
        }
    }

    /// Give every visible glyph a jiggle (button press, focus, score change).
    pub fn kick(&mut self, strength: f32) {
        for (k, g) in self.glyphs.iter_mut().enumerate() {
            let s = if k % 2 == 0 { 1.0 } else { -1.0 };
            g.jg_v += 9.0 * strength * s;
            g.rot_v += 2.5 * strength * s;
            g.off_v.y += 160.0 * strength * (0.6 + 0.4 * (k % 3) as f32 / 2.0);
        }
    }

    fn fit_scale(&self) -> f32 {
        match self.fit_width {
            Some(w) if self.layout_size.x > w && self.layout_size.x > 0.0 => w / self.layout_size.x,
            _ => 1.0,
        }
    }
}

/// Glyph sprite marker.
#[derive(Component)]
pub struct SoftGlyph;

pub struct SoftTextPlugin;

impl Plugin for SoftTextPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            PostUpdate,
            (rebuild, ride_game).chain().before(bevy::transform::TransformSystems::Propagate),
        )
        .add_systems(Update, jiggle_ui);
    }
}

/// (Re)spawn glyph sprites when the text changes.
fn rebuild(mut commands: Commands, assets: Option<Res<GameAssets>>, mut q: Query<(Entity, &mut SoftText, &mut Transform)>) {
    let Some(assets) = assets else { return };
    for (e, mut st, mut tf) in q.iter_mut() {
        if *tf != Transform::IDENTITY {
            *tf = Transform::IDENTITY;
        }
        let key = (st.text.clone(), st.size.to_bits(), st.weight, st.wrap.map(f32::to_bits));
        if st.built.as_ref() == Some(&key) {
            continue;
        }
        let same_layout_count = st.built.is_some();
        st.built = Some(key);
        for g in st.glyphs.drain(..) {
            commands.entity(g.entity).despawn();
        }
        let lay = layout(&st.text, st.size, st.weight, st.wrap);
        st.layout_size = lay.size;
        let font = TextFont { font: assets.font.clone().into(), font_size: st.size.into(), weight: FontWeight(st.weight), ..default() };
        let mut glyphs = Vec::with_capacity(lay.slots.len());
        for (order, slot) in lay.slots.iter().enumerate() {
            let ge = commands
                .spawn((
                    Text2d::new(slot.ch.to_string()),
                    font.clone(),
                    TextColor(st.color),
                    Transform::from_xyz(0.0, -1.0e6, st.z),
                    Visibility::Hidden,
                    SoftGlyph,
                    ChildOf(e),
                ))
                .id();
            glyphs.push(GlyphState {
                entity: ge,
                slot: *slot,
                order,
                anchor: None,
                shown: false,
                off: Vec2::ZERO,
                off_v: Vec2::ZERO,
                sq: 0.0,
                sq_v: 0.0,
                jg: 0.0,
                jg_v: 0.0,
                rot: 0.0,
                rot_v: 0.0,
            });
        }
        // A relabel (party "Map: …") re-pops quickly instead of staggering.
        if same_layout_count {
            st.age = 1.0e3;
        }
        st.glyphs = glyphs;
    }
}

type GlyphQuery<'w, 's> = Query<'w, 's, (&'static mut Transform, &'static mut TextColor, &'static mut Visibility), (With<SoftGlyph>, Without<SoftText>)>;

fn ride_game(time: Res<Time>, game: Option<Res<Game>>, mut q: Query<&mut SoftText>, mut glyphs: GlyphQuery) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    for mut st in q.iter_mut() {
        match st.ride {
            Ride::Overlay(_) => continue,
            Ride::Game(id) => {
                let body = game.as_ref().and_then(|g| g.sim.world.body(id));
                pose(&mut st, body, dt, &mut glyphs);
            }
            Ride::Free => pose(&mut st, None, dt, &mut glyphs),
        }
    }
}

/// Split a deformation gradient into rotation angle and stretch along the
/// rotated axes.
pub fn decompose(f: Mat2) -> (f32, Vec2) {
    let angle = (f.x_axis.y - f.y_axis.x).atan2(f.x_axis.x + f.y_axis.y);
    let s = Mat2::from_angle(-angle) * f;
    (angle, Vec2::new(s.x_axis.x, s.y_axis.y))
}

/// Advance springs and place every glyph. `body` is what the text rides
/// (ignored for [`Ride::Free`]); a missing or popped body hides the text.
pub fn pose(st: &mut SoftText, body: Option<&Body>, dt: f32, glyphs: &mut GlyphQuery) {
    st.age += dt;
    let fit = st.fit_scale();
    let (k, c) = (st.stiffness, st.damping);
    let riding = st.ride != Ride::Free;
    let hide_all = riding && !body.is_some_and(|b| b.enabled);
    let (age, stagger, reveal, burst, offset, z, size) = (st.age, st.stagger, st.reveal, st.burst, st.offset, st.z, st.size);
    let mut color = st.color;
    color.set_alpha(st.color.alpha() * st.alpha.clamp(0.0, 1.0));
    let n = st.glyphs.len().max(1) as f32;
    for g in st.glyphs.iter_mut() {
        let Ok((mut tf, mut col, mut vis)) = glyphs.get_mut(g.entity) else { continue };
        let want = (g.slot.index as f32) < reveal && age >= g.order as f32 * stagger;
        if hide_all || !want {
            *vis = Visibility::Hidden;
            g.shown = false;
            continue;
        }
        if !g.shown {
            g.shown = true;
            g.sq = -0.95;
            g.sq_v = 0.0;
            g.off_v.y += size * 4.0;
            g.rot_v += if g.order % 2 == 0 { 3.0 } else { -3.0 };
            if burst > 0.0 {
                let a = (g.order as f32 + 0.5) / n * std::f32::consts::PI;
                let dir = Vec2::new(-a.cos() * 1.4, a.sin() + 0.25);
                g.off_v += dir.normalize_or_zero() * burst;
                g.rot_v += -dir.x * 8.0;
                g.jg_v += 10.0;
            }
        }
        // Springs (semi-implicit Euler, a few substeps for stiffness).
        let sub = 3;
        let h = dt / sub as f32;
        for _ in 0..sub {
            g.off_v += (-g.off * k - g.off_v * c) * h;
            g.off += g.off_v * h;
            g.sq_v += (-g.sq * k - g.sq_v * c) * h;
            g.sq += g.sq_v * h;
            g.jg_v += (-g.jg * k * 1.6 - g.jg_v * c) * h;
            g.jg += g.jg_v * h;
            g.rot_v += (-g.rot * k - g.rot_v * c) * h;
            g.rot += g.rot_v * h;
        }
        let local = offset + g.slot.pos * fit;
        let (pos, f) = match (st.ride, body) {
            (Ride::Free, _) => (local, Mat2::IDENTITY),
            (_, Some(b)) => {
                let anchor = *g.anchor.get_or_insert_with(|| b.rest_anchor(PVec2::new(local.x, local.y)));
                let (p, f) = b.anchor_pose(&anchor);
                // Smooth the stretch over a glyph-sized patch so letters on
                // fine meshes don't flicker between neighbouring triangles.
                let (_, smooth) = b.local_affine(PVec2::new(local.x, local.y), (size * fit * 0.9).max(18.0));
                (Vec2::new(p.x, p.y), (f + smooth * 3.0) * 0.25)
            }
            _ => continue,
        };
        let (angle, stretch) = decompose(f);
        let stretch = stretch.clamp(Vec2::splat(0.45), Vec2::splat(1.9));
        let p = pos + Vec2::from_angle(angle).rotate(g.off);
        let s = (1.0 + g.sq).max(0.0) * fit;
        tf.translation = Vec3::new(p.x, p.y, z);
        tf.rotation = Quat::from_rotation_z(angle + g.rot);
        tf.scale = Vec3::new(stretch.x * s * (1.0 - g.jg * 0.6), stretch.y * s * (1.0 + g.jg), 1.0);
        if col.0 != color {
            col.0 = color;
        }
        *vis = Visibility::Inherited;
    }
}

// ------------------------------------------------------------- bevy_ui text

/// A bevy_ui text whose glyphs are separate nodes; glyphs that change
/// bounce and jiggle. Put it on a `Node` (it becomes a flex row).
#[derive(Component, Clone, Debug)]
pub struct JiggleText {
    pub text: String,
    pub font: TextFont,
    pub color: Color,
    pub shadow: Option<TextShadow>,
    shown: String,
    glyphs: Vec<Entity>,
}

impl JiggleText {
    pub fn new(text: impl Into<String>, font: TextFont, color: Color) -> JiggleText {
        JiggleText { text: text.into(), font, color, shadow: None, shown: String::new(), glyphs: Vec::new() }
    }
    pub fn shadow(mut self, s: TextShadow) -> Self {
        self.shadow = Some(s);
        self
    }
}

#[derive(Component, Default)]
pub struct UiGlyph {
    y: f32,
    yv: f32,
    sq: f32,
    sqv: f32,
    rot: f32,
    rotv: f32,
}

impl UiGlyph {
    fn kick(&mut self, k: usize) {
        self.yv -= 520.0;
        self.sqv += 14.0;
        self.rotv += if k % 2 == 0 { 7.0 } else { -7.0 };
    }
}

fn jiggle_ui(
    mut commands: Commands,
    time: Res<Time>,
    mut q: Query<(Entity, &mut JiggleText)>,
    mut glyphs: Query<(&mut UiGlyph, &mut UiTransform, &mut Text, &mut TextColor)>,
) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    for (e, mut jt) in q.iter_mut() {
        if jt.text != jt.shown {
            let new: Vec<char> = jt.text.chars().collect();
            let old: Vec<char> = jt.shown.chars().collect();
            if new.len() != old.len() || jt.glyphs.len() != new.len() {
                for g in jt.glyphs.drain(..) {
                    commands.entity(g).despawn();
                }
                let mut ids = Vec::new();
                for (k, ch) in new.iter().enumerate() {
                    let mut g = UiGlyph::default();
                    if !old.is_empty() || jt.shown.is_empty() {
                        g.kick(k);
                        g.sq = -0.8;
                    }
                    let mut ec = commands.spawn((Text::new(ch.to_string()), jt.font.clone(), TextColor(jt.color), UiTransform::IDENTITY, g, ChildOf(e)));
                    if let Some(s) = jt.shadow {
                        ec.insert(s);
                    }
                    ids.push(ec.id());
                }
                jt.glyphs = ids;
            } else {
                for (k, (a, b)) in new.iter().zip(&old).enumerate() {
                    if a != b {
                        if let Ok((mut g, _, mut t, _)) = glyphs.get_mut(jt.glyphs[k]) {
                            t.0 = a.to_string();
                            g.kick(k);
                        }
                    }
                }
            }
            jt.shown = jt.text.clone();
        }
        let color = jt.color;
        for &g in &jt.glyphs {
            let Ok((mut s, mut tf, _, mut col)) = glyphs.get_mut(g) else { continue };
            let (k, c) = (300.0, 9.0);
            for _ in 0..3 {
                let h = dt / 3.0;
                s.yv += (-s.y * k - s.yv * c) * h;
                s.y += s.yv * h;
                s.sqv += (-s.sq * k - s.sqv * c) * h;
                s.sq += s.sqv * h;
                s.rotv += (-s.rot * k - s.rotv * c) * h;
                s.rot += s.rotv * h;
            }
            tf.translation = Val2::px(0.0, s.y * 0.05);
            let u = (1.0 + s.sq * 0.5).max(0.05);
            tf.scale = Vec2::new(u * (1.0 - s.sq * 0.25), u * (1.0 + s.sq * 0.25));
            tf.rotation = Rot2::radians(s.rot * 0.05);
            if col.0 != color {
                col.0 = color;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_advances_are_sane() {
        let m = advance('M', 700);
        let i = advance('i', 700);
        assert!(m > i && m > 0.4 && m < 1.2, "M {m} i {i}");
        assert!(advance(' ', 500) > 0.1);
    }

    #[test]
    fn layout_centres_lines_and_keeps_char_indices() {
        let l = layout("Hello there friend", 30.0, 500, Some(130.0));
        assert_eq!(l.slots.len(), 16);
        assert!(l.size.x <= 130.0 + 1.0, "{}", l.size.x);
        let lines: std::collections::BTreeSet<i32> = l.slots.iter().map(|s| s.pos.y.round() as i32).collect();
        assert!(lines.len() >= 2);
        // Indices skip spaces and stay in order.
        assert_eq!(l.slots[5].index, 6);
        assert!(l.slots.windows(2).all(|w| w[0].index < w[1].index));
        // Block is centred vertically.
        let top = l.slots.first().unwrap().pos.y;
        let bottom = l.slots.last().unwrap().pos.y;
        assert!((top + bottom).abs() < 1e-3);
        // Single line is centred horizontally.
        let one = layout("ABC", 40.0, 700, None);
        let left = one.slots[0].pos.x - one.slots[0].adv * 0.5;
        let right = one.slots[2].pos.x + one.slots[2].adv * 0.5;
        assert!((left + right).abs() < 1e-3);
    }

    #[test]
    fn decompose_recovers_rotation_and_stretch() {
        let f = Mat2::from_angle(0.7) * Mat2::from_diagonal(PVec2::new(1.4, 0.6));
        let (a, s) = decompose(f);
        assert!((a - 0.7).abs() < 1e-4);
        assert!((s - Vec2::new(1.4, 0.6)).length() < 1e-4);
    }
}
