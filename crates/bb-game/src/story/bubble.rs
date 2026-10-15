//! Speech bubbles: real jelly bodies with typewriter soft text.
//!
//! A bubble is a weightless grid mesh in the game's physics world (it
//! collides with nothing), sized to its text. A few particles at the middle
//! of its bottom edge are pinned and driven toward the speaker's head, and
//! the rest of the sheet is pulled toward an upright pose by a soft home
//! tether that follows along, so the bubble lags, sways and jiggles as the
//! speaker moves. Every glyph rides the sheet (see [`crate::softtext`]).

use bb_physics::{BodyDesc, BodyId, Vec2 as PVec2};
use bb_sim::BodyTag;
use bevy::prelude::*;

use super::{Blub, Voice};
use crate::camera::{MainCamera, VIEW_H, VIEW_W};
use crate::input::LastDevice;
use super::lulu::LuluHead;
use crate::palette::lin;
use crate::render::{MeshBuf, Shared, Style, StyleOverrides, empty_mesh, z};
use crate::sim::{Game, Inputs};
use crate::softtext::{Ride, SoftText, layout};

#[derive(Clone, Debug, PartialEq)]
pub enum Speaker {
    /// An NPC by level id.
    Actor(String),
    /// A player by slot.
    Player(u8),
    /// A voice from off-screen (Lulu from above).
    Offscreen,
    /// A gameplay tip, shown near the top of the screen.
    Tip,
}

#[derive(Message, Clone, Debug)]
pub struct SayRequest {
    pub speaker: Speaker,
    pub text: String,
    pub voice: Voice,
    /// Seconds the bubble stays after the text is fully shown.
    pub linger: f32,
}

/// Typewriter speed. Slow enough to read along comfortably.
pub const CHARS_PER_SEC: f32 = 17.0;
const WRAP: f32 = 540.0;
const FONT: f32 = 38.0;
const PAD: Vec2 = Vec2::new(50.0, 38.0);
/// Gap between the speaker's top and the bubble's bottom edge.
const LIFT: f32 = 46.0;
const CLOSE: f32 = 0.28;
/// Quiet beat between different speakers, after the last bubble closes.
pub const SPEAKER_GAP: f32 = 0.75;

/// How long a new speaker waits when someone else is still talking.
pub fn speaker_change_delay() -> f32 {
    CLOSE + SPEAKER_GAP
}
/// Above everything in the world, front decor and the cave's foreground
/// silhouettes (DECOR_FRONT + 3) included, so no stalactite ever cuts
/// through a line of text.
const BUBBLE_Z: f32 = z::DECOR_FRONT + 6.0;

/// Seconds to type `text` out.
pub fn type_secs(text: &str) -> f32 {
    text.chars().count() as f32 / CHARS_PER_SEC
}

/// How long a line stays up after it has finished typing.
pub fn linger_secs(text: &str) -> f32 {
    1.5 + text.chars().count() as f32 * 0.035
}

#[derive(Component)]
pub struct Bubble {
    pub speaker: Speaker,
    pub text: String,
    pub shown: f32,
    pub linger: f32,
    pub age: f32,
    pub voice: Voice,
    pub body: BodyId,
    /// Rest positions relative to the bubble's bottom-centre anchor.
    rest: Vec<PVec2>,
    pins: Vec<usize>,
    tail: Entity,
    tail_mesh: Handle<Mesh>,
    size: Vec2,
}

fn paper(s: &Speaker) -> Color {
    match s {
        Speaker::Tip => Color::srgb(0.86, 0.97, 0.88),
        Speaker::Offscreen => Color::srgb(1.0, 0.92, 0.96),
        _ => Color::srgb(1.0, 0.98, 0.93),
    }
}

const INK: Color = Color::srgb(0.17, 0.13, 0.21);

/// The jelly sheet of a bubble whose bottom-centre sits at `anchor`.
fn bubble_desc(anchor: PVec2, size: Vec2) -> (BodyDesc, Vec<usize>) {
    let cols = ((size.x / 34.0).ceil() as usize).max(4);
    let cols = cols + cols % 2; // even, so there's a middle column
    let rows = ((size.y / 30.0).ceil() as usize).max(2);
    let min = anchor + PVec2::new(-size.x * 0.5, 0.0);
    let max = anchor + PVec2::new(size.x * 0.5, size.y);
    let mut d = BodyDesc::grid(min, max, cols, rows, size.x * size.y / 4000.0);
    let nx = cols + 1;
    let cut = 10.0f32.min(size.y * 0.2);
    for (ix, iy, dx, dy) in [(0, 0, 1.0, 1.0), (nx - 1, 0, -1.0, 1.0), (0, rows, 1.0, -1.0), (nx - 1, rows, -1.0, -1.0)] {
        d.positions[iy * nx + ix] += PVec2::new(dx, dy) * cut;
    }
    d.params.gravity_scale = 0.0;
    d.params.shape_compliance = Some(1e-4);
    d.params.edge_compliance = 2e-5;
    d.params.tri_compliance = 2e-5;
    d.params.internal_damping = 2.2;
    d.params.linear_damping = 0.5;
    d.params.limits.poppable = false;
    d.layer = 0;
    d.mask = 0;
    let mid = cols / 2;
    let pins = vec![mid - 1, mid, mid + 1];
    (d, pins)
}

/// Lines waiting their turn. One voice at a time: a new speaker waits for
/// everyone else's bubble to close plus a short beat, so bubbles never
/// overlap — and the line's voice only plays once its bubble is actually on
/// screen (see [`spawn_bubbles`]).
#[derive(Default)]
pub struct SpeechQueue {
    delayed: Vec<(f32, SayRequest)>,
}

impl SpeechQueue {
    /// Queue `r`, given who is talking right now. Returns it straight back
    /// if it can be shown at once.
    pub fn push(&mut self, r: SayRequest, talking: &[Speaker]) -> Option<SayRequest> {
        // Keep order: nothing jumps ahead of a line that is already waiting.
        if let Some((t, last)) = self.delayed.last() {
            let t = if last.speaker == r.speaker { *t } else { *t + speaker_change_delay() };
            self.delayed.push((t, r));
            return None;
        }
        if talking.iter().any(|s| *s != r.speaker) {
            self.delayed.push((speaker_change_delay(), r));
            return None;
        }
        Some(r)
    }

    /// Advance the clock; returns the lines whose turn has come.
    pub fn tick(&mut self, dt: f32) -> Vec<SayRequest> {
        let mut ready = Vec::new();
        self.delayed.retain_mut(|(t, r)| {
            *t -= dt;
            if *t <= 0.0 {
                ready.push(r.clone());
                false
            } else {
                true
            }
        });
        ready
    }

    pub fn is_empty(&self) -> bool {
        self.delayed.is_empty()
    }
}

/// The gibberish voice for a line, played when its bubble appears. Tips are
/// the game talking, not a character: silent.
pub fn voice_for_line(r: &SayRequest) -> Option<Blub> {
    if r.speaker == Speaker::Tip {
        return None;
    }
    Some(Blub { voice: r.voice, syllables: (r.text.chars().count() / 3).clamp(2, 16) as u8 })
}

/// The visible world rectangle (centre, half extents) of the main camera.
fn view_rect(cam: &Query<(&Transform, &Projection), With<MainCamera>>) -> (Vec2, Vec2) {
    let Ok((t, p)) = cam.single() else { return (Vec2::ZERO, Vec2::new(VIEW_W, VIEW_H) * 0.5) };
    let scale = if let Projection::Orthographic(o) = p { o.scale } else { 1.0 };
    (t.translation.truncate(), Vec2::new(VIEW_W, VIEW_H) * 0.5 * scale)
}

#[allow(clippy::too_many_arguments)]
pub fn spawn_bubbles(
    mut commands: Commands,
    mut reqs: MessageReader<SayRequest>,
    mut existing: Query<(Entity, &mut Bubble)>,
    mut game: Option<ResMut<Game>>,
    shared: Res<Shared>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut overrides: ResMut<StyleOverrides>,
    cam: Query<(&Transform, &Projection), With<MainCamera>>,
    time: Res<Time>,
    device: Option<Res<LastDevice>>,
    lulu: Res<LuluHead>,
    mut blub: MessageWriter<Blub>,
    mut queue: Local<SpeechQueue>,
) {
    let view = view_rect(&cam);
    let device = device.map_or_else(LastDevice::default, |d| *d);
    let mut ready = queue.tick(time.delta_secs());
    for r in reqs.read() {
        let talking: Vec<Speaker> = existing.iter().map(|(_, b)| b.speaker.clone()).collect();
        // A new speaker first asks everyone else to wrap up.
        for (_, mut b) in existing.iter_mut() {
            if b.speaker != r.speaker {
                let total = b.text.chars().count() as f32;
                b.shown = total;
                let typed = total / CHARS_PER_SEC;
                // Close now even if it was still typing (a negative linger
                // puts its end in the past), so the next speaker's bubble
                // never opens on top of it.
                b.linger = b.linger.min(b.age - typed);
            }
        }
        if let Some(r) = queue.push(r.clone(), &talking) {
            ready.push(r);
        }
    }
    for r in ready.iter() {
        let Some(game) = game.as_mut() else { continue };
        for (e, b) in existing.iter() {
            if b.speaker == r.speaker {
                despawn_bubble(&mut commands, &mut game.sim, &mut overrides, e, b);
            }
        }
        // Tips name the controls of whatever the player is holding.
        let text = crate::input::control_text(&r.text, device);
        let size = layout(&text, FONT, 500, Some(WRAP)).size.max(Vec2::new(40.0, 30.0)) + PAD;
        // No speaker to speak from: no bubble, and no voice either.
        let Some((anchor, _)) = speaker_anchor(game, &r.speaker, view, size, lulu.0) else { continue };
        let a = PVec2::new(anchor.x, anchor.y);
        let (desc, pins) = bubble_desc(a, size);
        let rest: Vec<PVec2> = desc.positions.iter().map(|p| *p - a).collect();
        let body = game.sim.add_body(desc, BodyTag::Ui);
        if let Some(b) = game.sim.world.body_mut(body) {
            // Start squeezed toward the speaker so it springs open.
            for i in 0..b.x.len() {
                let p = a + rest[i] * PVec2::new(0.35, 0.2);
                b.x[i] = p;
                b.prev[i] = p;
            }
            for &i in &pins {
                b.pin(i);
            }
            b.home = Some(b.x.clone());
            b.home_compliance = 4e-3;
        }
        let p = paper(&r.speaker);
        overrides.0.insert(body, Style { fill: p, rim: INK, rim_w: 4.0, highlight: false, z: BUBBLE_Z, top_rim_only: false });
        let tail_mesh = meshes.add(empty_mesh());
        let tail = commands.spawn((Mesh2d(tail_mesh.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, BUBBLE_Z))).id();
        // Text centre in the sheet's rest frame (rest centroid = sheet centre).
        // The voice starts with the bubble, never before it.
        if let Some(v) = voice_for_line(r) {
            blub.write(v);
        }
        commands.spawn((
            Bubble {
                speaker: r.speaker.clone(),
                text: text.clone(),
                shown: 0.0,
                // A filled-in tip can be longer than its template.
                linger: r.linger.max(linger_secs(&text) * 0.8),
                age: 0.0,
                voice: r.voice,
                body,
                rest,
                pins,
                tail,
                tail_mesh,
                size,
            },
            SoftText::new(text, FONT)
                .ride(Ride::Game(body))
                .weight(500)
                .color(INK)
                .wrap(WRAP)
                .z(BUBBLE_Z + 0.1)
                .typewriter(),
        ));
    }
}

fn despawn_bubble(commands: &mut Commands, sim: &mut bb_sim::Sim, overrides: &mut StyleOverrides, e: Entity, b: &Bubble) {
    sim.remove_body(b.body);
    overrides.0.remove(&b.body);
    commands.entity(b.tail).despawn();
    commands.entity(e).despawn();
}

/// Where the bubble's bottom-centre wants to be, kept on screen (a speaker
/// just out of view still gets a readable bubble at the edge). The flag is
/// true when it had to be pulled in (the tail is hidden then).
fn speaker_anchor(game: &Game, s: &Speaker, view: (Vec2, Vec2), size: Vec2, lulu: Option<(Vec2, f32)>) -> Option<(Vec2, bool)> {
    let (head, r) = match (s, lulu) {
        // Lulu on stage speaks for herself.
        (Speaker::Offscreen, Some(h)) => h,
        _ => speaker_head(game, s, view.0)?,
    };
    let want = head + Vec2::new(0.0, r + LIFT);
    let (c, h) = view;
    let margin = 24.0;
    let clamp = |v: f32, lo: f32, hi: f32| if lo > hi { (lo + hi) * 0.5 } else { v.clamp(lo, hi) };
    let at = Vec2::new(
        clamp(want.x, c.x - h.x + size.x * 0.5 + margin, c.x + h.x - size.x * 0.5 - margin),
        clamp(want.y, c.y - h.y + margin, c.y + h.y - size.y - margin),
    );
    Some((at, at.distance(want) > 40.0))
}

fn speaker_head(game: &Game, s: &Speaker, cam: Vec2) -> Option<(Vec2, f32)> {
    let (c, r) = match s {
        Speaker::Actor(id) => {
            let n = game.sim.npc_by_id(id)?;
            let b = game.sim.world.body(n.ctl.body)?;
            (b.centroid(), n.ctl.radius * n.ctl.expand)
        }
        Speaker::Player(slot) => {
            let p = game.sim.player(*slot)?;
            let b = game.sim.world.body(p.ctl.body)?;
            (b.centroid(), p.ctl.radius * p.ctl.expand)
        }
        Speaker::Offscreen => return Some((cam + Vec2::new(0.0, 190.0), 0.0)),
        Speaker::Tip => return Some((cam + Vec2::new(0.0, 160.0), 0.0)),
    };
    Some((Vec2::new(c.x, c.y), r))
}

#[allow(clippy::too_many_arguments)]
pub fn update_bubbles(
    mut commands: Commands,
    time: Res<Time>,
    mut game: Option<ResMut<Game>>,
    mut bubbles: Query<(Entity, &mut Bubble, &mut SoftText)>,
    cam: Query<(&Transform, &Projection), With<MainCamera>>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut overrides: ResMut<StyleOverrides>,
    inputs: Res<Inputs>,
    keys: Res<ButtonInput<KeyCode>>,
    lulu: Res<LuluHead>,
    mut prev_button: Local<bool>,
) {
    let dt = time.delta_secs().min(1.0 / 20.0);
    let view = view_rect(&cam);
    // A tap while a line is typing shows the rest of it at once.
    let button = inputs.slots.iter().any(|i| i.button) || keys.any_pressed([KeyCode::Enter, KeyCode::Space]);
    let tapped = button && !*prev_button;
    *prev_button = button;
    for (e, mut b, mut st) in bubbles.iter_mut() {
        let Some(game) = game.as_mut() else {
            commands.entity(b.tail).despawn();
            commands.entity(e).despawn();
            continue;
        };
        b.age += dt;
        let total = b.text.chars().count() as f32;
        if tapped && b.age > 0.25 && b.shown < total {
            b.shown = total;
            b.age = b.age.max(type_secs(&b.text));
        }
        b.shown = (b.shown + dt * CHARS_PER_SEC).min(total);
        let done_at = total / CHARS_PER_SEC + b.linger;
        let anchor = speaker_anchor(game, &b.speaker, view, b.size, lulu.0);
        let alive = game.sim.world.body(b.body).is_some();
        if b.age > done_at + CLOSE || anchor.is_none() || !alive {
            despawn_bubble(&mut commands, &mut game.sim, &mut overrides, e, &b);
            continue;
        }
        st.reveal = b.shown;
        let (anchor, pulled_in) = anchor.unwrap();
        let a = PVec2::new(anchor.x, anchor.y);
        let closing = ((b.age - done_at) / CLOSE).clamp(0.0, 1.0);
        st.alpha = 1.0 - closing;
        let Some(body) = game.sim.world.body_mut(b.body) else { continue };
        // Drive the pinned stem toward the speaker; the sheet follows on a
        // soft tether, so it lags and jiggles.
        for &i in &b.pins {
            body.drive_pinned(i, a + b.rest[i]);
        }
        if let Some(home) = body.home.as_mut() {
            for (h, r) in home.iter_mut().zip(&b.rest) {
                *h = a + *r;
            }
        }
        if closing > 0.0 {
            body.rest_scale = 1.0 - 0.75 * closing;
            if let Some(home) = body.home.as_mut() {
                for (h, r) in home.iter_mut().zip(&b.rest) {
                    *h = a + *r * (1.0 - 0.75 * closing);
                }
            }
        }
        // Tail from the stem down to the speaker.
        let has_tail = (matches!(b.speaker, Speaker::Actor(_) | Speaker::Player(_)) || (b.speaker == Speaker::Offscreen && lulu.0.is_some())) && !pulled_in;
        if let Some(mut m) = meshes.get_mut(&b.tail_mesh) {
            let mut buf = MeshBuf::default();
            if has_tail && closing < 1.0 {
                let (l, r) = (body.x[b.pins[0]], body.x[b.pins[2]]);
                let mid = (l + r) * 0.5;
                let tip = mid + PVec2::new(-8.0, -(LIFT - 14.0)) * (1.0 - closing);
                let ink = lin(INK);
                let pap = lin(paper(&b.speaker));
                let side = (r - l).normalize_or_zero();
                let (li, ri) = (l - side * 4.0, r + side * 4.0);
                let (i0, i1, i2) = (buf.vert(li + PVec2::new(0.0, 5.0), -0.01, ink), buf.vert(ri + PVec2::new(0.0, 5.0), -0.01, ink), buf.vert(tip - PVec2::new(0.0, 6.0), -0.01, ink));
                buf.tri(i0, i1, i2);
                let (j0, j1, j2) = (buf.vert(l + PVec2::new(0.0, 6.0), 0.0015, pap), buf.vert(r + PVec2::new(0.0, 6.0), 0.0015, pap), buf.vert(tip, 0.0015, pap));
                buf.tri(j0, j1, j2);
            }
            buf.write(&mut m);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(speaker: Speaker, text: &str) -> SayRequest {
        SayRequest { speaker, text: text.into(), voice: Voice::Pip, linger: 1.0 }
    }

    #[test]
    fn a_new_speaker_waits_for_the_old_bubble() {
        let mut q = SpeechQueue::default();
        // Nobody talking: shown at once.
        assert!(q.push(line(Speaker::Player(0), "Hi!"), &[]).is_some());
        // Same speaker carrying on: also at once.
        assert!(q.push(line(Speaker::Player(0), "Hello?"), &[Speaker::Player(0)]).is_some());
        // Someone else: waits for the change-over.
        assert!(q.push(line(Speaker::Tip, "{Jump} to hop."), &[Speaker::Player(0)]).is_none());
        assert!(q.tick(speaker_change_delay() * 0.5).is_empty());
        let ready = q.tick(speaker_change_delay() * 0.6);
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].speaker, Speaker::Tip);
        assert!(q.is_empty());
    }

    #[test]
    fn queued_lines_keep_their_order() {
        let mut q = SpeechQueue::default();
        let talking = [Speaker::Player(0)];
        assert!(q.push(line(Speaker::Actor("reg".into()), "HALT!"), &talking).is_none());
        // Pip again, after Reg: must not jump the queue even though Pip is
        // the one talking now.
        assert!(q.push(line(Speaker::Player(0), "Me?"), &talking).is_none());
        let mut order = Vec::new();
        for _ in 0..200 {
            order.extend(q.tick(1.0 / 60.0).into_iter().map(|r| r.text));
        }
        assert_eq!(order, vec!["HALT!".to_string(), "Me?".to_string()]);
    }

    #[test]
    fn voices_belong_to_characters_not_tips() {
        assert!(voice_for_line(&line(Speaker::Tip, "Press Space")).is_none());
        let v = voice_for_line(&line(Speaker::Player(0), "Hello there, friend")).unwrap();
        assert_eq!(v.voice, Voice::Pip);
        assert!((2..=16).contains(&v.syllables));
    }
}
