//! Lulu: the little girl at the top of the world.
//!
//! Drawn, not simulated: a small procedural puppet (pigtails, a polka-dot
//! dress, round cheeks) sitting on the ground, whose eyes follow Pip and
//! whose arms reach out when Pip comes close. A level or cutscene stage
//! places her with a `"lulu"` decor entry (its position is the ground point
//! she sits on, its scale her size). While she is on stage, Lulu's lines
//! come out of her own mouth (see [`LuluHead`]) instead of from off-screen.

use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::palette::{hex, lin};
use crate::render::{MeshBuf, Shared, empty_mesh, la, z};
use crate::sim::Game;

/// Decor kind that places Lulu.
pub const DECOR: &str = "lulu";
/// Decor kind for a cave mouth open to daylight, seen from inside: its
/// position is the middle of the opening's floor, its scale the size
/// (1 = 560 px wide).
pub const DAYLIGHT: &str = "daylight";

/// A drawn cave mouth (static).
#[derive(Component)]
pub struct DaylightMouth;

#[derive(Component)]
pub struct Lulu {
    /// Ground point she sits on.
    pub at: Vec2,
    pub scale: f32,
    reach: f32,
    look: Vec2,
    blink: f32,
    t: f32,
    mesh: Handle<Mesh>,
}

/// Where Lulu's head is (centre, radius), while she is on stage.
#[derive(Resource, Default)]
pub struct LuluHead(pub Option<(Vec2, f32)>);

/// Spawn/despawn Lulu figures as levels load.
pub fn sync(
    mut commands: Commands,
    game: Option<Res<Game>>,
    existing: Query<Entity, Or<(With<Lulu>, With<DaylightMouth>)>>,
    mut meshes: ResMut<Assets<Mesh>>,
    shared: Res<Shared>,
    mut head: ResMut<LuluHead>,
) {
    let Some(game) = game else {
        for e in existing.iter() {
            commands.entity(e).despawn();
        }
        head.0 = None;
        return;
    };
    if !game.is_added() {
        return;
    }
    for e in existing.iter() {
        commands.entity(e).despawn();
    }
    for d in game.sim.level.decor.iter().filter(|d| d.kind == DAYLIGHT) {
        let mut buf = MeshBuf::default();
        daylight(&mut buf, PVec2::new(d.pos.x, d.pos.y), d.scale.max(0.1));
        commands.spawn((
            Mesh2d(meshes.add(buf.into_mesh())),
            MeshMaterial2d(shared.blend.clone()),
            // Over the cave rock behind it, under every body.
            Transform::from_xyz(0.0, 0.0, z::PROP - 0.6),
            DaylightMouth,
        ));
    }
    head.0 = None;
    for d in game.sim.level.decor.iter().filter(|d| d.kind == DECOR) {
        let mesh = meshes.add(empty_mesh());
        commands.spawn((
            Lulu { at: Vec2::new(d.pos.x, d.pos.y), scale: d.scale, reach: 0.0, look: Vec2::ZERO, blink: 2.0, t: 0.0, mesh: mesh.clone() },
            Mesh2d(mesh),
            MeshMaterial2d(shared.blend.clone()),
            // Behind the blobs (so Pip lands in her hands, not under them).
            Transform::from_xyz(0.0, 0.0, z::PROP - 0.3),
        ));
    }
}

/// Animate and redraw.
pub fn draw(time: Res<Time>, game: Option<Res<Game>>, mut q: Query<&mut Lulu>, mut meshes: ResMut<Assets<Mesh>>, mut head: ResMut<LuluHead>) {
    let Some(game) = game else { return };
    let dt = time.delta_secs().min(0.05);
    // Pip: the player in a level, the "pip" actor on a cutscene stage.
    let pip = game
        .sim
        .player(0)
        .map(|p| p.ctl.body)
        .or_else(|| game.sim.npc_by_id("pip").map(|n| n.ctl.body))
        .and_then(|b| game.sim.world.body(b))
        .map(|b| {
            let c = b.centroid();
            Vec2::new(c.x, c.y)
        });
    let mut any = false;
    for mut l in q.iter_mut() {
        any = true;
        l.t += dt;
        let s = l.scale.max(0.1);
        let head_c = l.at + Vec2::new(0.0, 330.0 * s);
        // Reach for Pip when Pip is close; otherwise hands in her lap.
        let near = pip.is_some_and(|p| p.distance(l.at + Vec2::new(0.0, 150.0 * s)) < 560.0 * s);
        let want = if near { 1.0 } else { 0.0 };
        l.reach += (want - l.reach) * (1.0 - (-dt * 3.0).exp());
        let look = pip.map_or(Vec2::ZERO, |p| ((p - head_c) / 300.0).clamp_length_max(1.0));
        l.look = l.look.lerp(look, 1.0 - (-dt * 6.0).exp());
        l.blink -= dt;
        if l.blink < -0.14 {
            l.blink = 2.2 + (l.t * 7.3).sin().abs() * 2.5;
        }
        let pose = Pose {
            t: l.t,
            reach: l.reach,
            look: PVec2::new(l.look.x, l.look.y),
            blink: l.blink < 0.0,
            target: pip.map(|p| {
                let r = (p - l.at) / s;
                PVec2::new(r.x, r.y)
            }),
        };
        let mut buf = MeshBuf::default();
        figure(&mut buf, PVec2::new(l.at.x, l.at.y), s, &pose);
        if let Some(mut m) = meshes.get_mut(&l.mesh) {
            buf.write(&mut m);
        }
        head.0 = Some((head_c + Vec2::new(0.0, pose.bob() * s), 92.0 * s));
    }
    if !any {
        head.0 = None;
    }
}

/// The way out, seen from inside the cave: a rounded arch of open sky
/// (blue overhead, warm near the horizon), a sun, a strip of meadow with
/// flowers, a rocky lip around it and warm light spilling onto the cave
/// floor. `o` is the middle of the opening's floor.
pub fn daylight(buf: &mut MeshBuf, o: PVec2, s: f32) {
    let p = |x: f32, y: f32| o + PVec2::new(x, y) * s;
    let (w, h) = (280.0f32, 520.0f32);
    // Arch outline (CCW): flat floor, straight-ish sides, round top.
    let arch: Vec<PVec2> = {
        let mut v = vec![p(-w, 0.0), p(w, 0.0)];
        let r = w;
        for i in 0..=16 {
            let a = std::f32::consts::PI * i as f32 / 16.0;
            v.push(p(a.cos() * r * (1.0 + 0.04 * (a * 3.0).sin()), h - r + a.sin() * r));
        }
        v
    };
    // Light spill on the cave floor and walls (under everything else).
    buf.halo(p(0.0, 60.0), PVec2::new(900.0, 260.0) * s, 0.0, la(hex(0xfff0c0), 0.28));
    buf.halo(p(0.0, h * 0.5), PVec2::new(620.0, 560.0) * s, 0.0, la(hex(0xfff6d8), 0.22));
    // Sky: a vertical gradient, sampled per vertex.
    let sky = |y: f32| {
        let t = ((y - o.y) / (h * s)).clamp(0.0, 1.0);
        crate::palette::lin(crate::palette::mix(hex(0xfff1c9), hex(0x7cc4ff), t.powf(0.7)))
    };
    let base = buf.pos.len() as u32;
    let c = p(0.0, h * 0.45);
    buf.vert(c, 0.0, sky(c.y));
    for q in &arch {
        buf.vert(*q, 0.0, sky(q.y));
    }
    let n = arch.len() as u32;
    for k in 0..n {
        buf.tri(base, base + 1 + k, base + 1 + (k + 1) % n);
    }
    // Sun and a soft glow around it.
    buf.halo(p(110.0, h - 150.0), PVec2::splat(170.0) * s, 0.0, la(hex(0xfffbe0), 0.9));
    buf.ellipse(p(110.0, h - 150.0), PVec2::splat(42.0) * s, 0.0, 0.0, lin(hex(0xfff7c2)));
    // Far hills and a meadow outside.
    let hill: Vec<PVec2> = (0..=12)
        .map(|i| {
            let u = i as f32 / 12.0;
            p(-w + 2.0 * w * u, 70.0 + (u * 7.0).sin() * 14.0 + (u * 2.3).cos() * 18.0)
        })
        .chain([p(w, 0.0), p(-w, 0.0)])
        .collect();
    buf.fan(&hill, p(0.0, 30.0), 0.0, lin(hex(0x9fe08a)), lin(hex(0x7cc96b)));
    for (x, y, col) in [(-180.0, 40.0, 0xffffff), (-120.0, 28.0, 0xffd23f), (-40.0, 46.0, 0xff8fb1), (40.0, 30.0, 0xffffff), (150.0, 42.0, 0xffd23f), (210.0, 24.0, 0xff8fb1)] {
        buf.ellipse(p(x, y), PVec2::splat(7.0) * s, 0.0, 0.0, lin(hex(col)));
        buf.ellipse(p(x, y), PVec2::splat(2.6) * s, 0.0, 0.0, lin(hex(0xffb000)));
    }
    // Rocky lip: a thick dark rim with a warm inner edge where the light
    // catches it.
    let rim: Vec<PVec2> = arch[2..].to_vec();
    buf.stroke(&rim, 46.0 * s, 0.0, lin(hex(0x1a1220)));
    let inner: Vec<PVec2> = rim.iter().map(|q| *q + (c - *q).normalize_or_zero() * 22.0 * s).collect();
    buf.stroke(&inner, 6.0 * s, 0.0, la(hex(0xffe3a8), 0.7));
    for side in [-1.0f32, 1.0] {
        buf.stroke(&[p(side * w, 0.0), p(side * w, h - w)], 46.0 * s, 0.0, lin(hex(0x1a1220)));
    }
    // Light rays falling in toward the cave floor.
    for (k, (x0, dx)) in [(-160.0, -520.0), (-40.0, -760.0), (90.0, -980.0)].iter().enumerate() {
        let top_a = p(*x0 - 30.0, h * 0.75);
        let top_b = p(*x0 + 30.0, h * 0.75);
        let bot_a = p(*x0 + dx - 120.0, 0.0);
        let bot_b = p(*x0 + dx + 60.0, 0.0);
        let a = 0.07 - k as f32 * 0.015;
        let (i0, i1) = (buf.vert(top_a, 0.0, la(hex(0xfff3cf), a)), buf.vert(top_b, 0.0, la(hex(0xfff3cf), a)));
        let (i2, i3) = (buf.vert(bot_b, 0.0, la(hex(0xfff3cf), 0.0)), buf.vert(bot_a, 0.0, la(hex(0xfff3cf), 0.0)));
        buf.tri(i0, i1, i2);
        buf.tri(i0, i2, i3);
    }
}

/// One frame of Lulu's animation.
pub struct Pose {
    pub t: f32,
    /// 0 = hands in lap, 1 = arms out toward `target`.
    pub reach: f32,
    /// Where she's looking (-1..1 each axis).
    pub look: PVec2,
    pub blink: bool,
    /// Pip, relative to her ground point, in unscaled figure units.
    pub target: Option<PVec2>,
}

impl Pose {
    fn bob(&self) -> f32 {
        (self.t * 2.1).sin() * 3.0 + self.reach * 6.0
    }
}

const SKIN: u32 = 0xffd9c4;
const SKIN_SHADE: u32 = 0xf2b39b;
const HAIR: u32 = 0x6e3f27;
const HAIR_HI: u32 = 0x8f5a3a;
const DRESS: u32 = 0xff7aa8;
const DRESS_SHADE: u32 = 0xe2578a;
const DOTS: u32 = 0xffd3e2;
const SHOES: u32 = 0xd9465a;
const BOWS: u32 = 0xffd23f;
const INK: u32 = 0x2b2135;

/// Draw Lulu sitting at `o` (ground), `s` = scale (1 ≈ 420 px tall).
/// Everything is emitted back to front (the material blends).
pub fn figure(buf: &mut MeshBuf, o: PVec2, s: f32, pose: &Pose) {
    let p = |x: f32, y: f32| o + PVec2::new(x, y) * s;
    let c = |h: u32| lin(hex(h));
    let bob = pose.bob();
    let lean = pose.target.map_or(0.0, |t| (t.x / 400.0).clamp(-1.0, 1.0)) * pose.reach;
    // Upper body sways toward Pip a little as she reaches.
    let up = |x: f32, y: f32| {
        let k = ((y - 150.0) / 200.0).clamp(0.0, 1.5);
        p(x + lean * 18.0 * k, y + bob * k.min(1.0))
    };
    let zz = 0.0;

    // Soft shadow.
    buf.ellipse(p(0.0, 4.0), PVec2::new(200.0, 20.0) * s, 0.0, zz, la(Color::BLACK, 0.22));

    // Pigtails (behind the head).
    for side in [-1.0f32, 1.0] {
        let swing = (pose.t * 2.3 + side).sin() * 0.06;
        buf.ellipse(up(side * 104.0, 296.0), PVec2::new(34.0, 56.0) * s, side * 0.45 + swing, zz, c(HAIR));
        buf.ellipse(up(side * 110.0, 286.0), PVec2::new(14.0, 30.0) * s, side * 0.45 + swing, zz, c(HAIR_HI));
    }
    // Back of the hair.
    buf.ellipse(up(0.0, 342.0), PVec2::new(94.0, 92.0) * s, 0.0, zz, c(HAIR));

    // Skirt: a wide dome of dress spread on the ground.
    let skirt: Vec<PVec2> = {
        let mut v = Vec::new();
        for i in 0..=12 {
            let u = i as f32 / 12.0;
            let x = -175.0 + 350.0 * u;
            // Scalloped hem.
            let y = 6.0 + (u * std::f32::consts::PI * 6.0).sin().abs() * 7.0;
            v.push(p(x, y));
        }
        for i in 0..=8 {
            let u = i as f32 / 8.0;
            let a = u * std::f32::consts::FRAC_PI_2;
            v.push(p(175.0 - (175.0 - 66.0) * a.sin(), 6.0 + 168.0 * (1.0 - a.cos()) * 0.98));
        }
        for i in 0..=8 {
            let u = i as f32 / 8.0;
            let a = (1.0 - u) * std::f32::consts::FRAC_PI_2;
            v.push(p(-175.0 + (175.0 - 66.0) * a.sin(), 6.0 + 168.0 * (1.0 - a.cos()) * 0.98));
        }
        v
    };
    buf.fan(&skirt, p(0.0, 70.0), zz, c(DRESS), c(DRESS_SHADE));
    buf.stroke(&skirt[..13], 9.0 * s, zz, lin(Color::WHITE));
    for (x, y, r) in [(-110.0, 40.0, 11.0), (-50.0, 90.0, 10.0), (20.0, 45.0, 12.0), (85.0, 100.0, 9.0), (120.0, 35.0, 10.0), (-15.0, 135.0, 8.0), (-130.0, 20.0, 7.0)] {
        buf.ellipse(p(x, y), PVec2::splat(r) * s, 0.0, zz, c(DOTS));
    }
    // Feet poking out from under the hem.
    for side in [-1.0f32, 1.0] {
        buf.ellipse(p(side * 60.0, 14.0), PVec2::new(24.0, 15.0) * s, 0.0, zz, lin(Color::WHITE));
        buf.ellipse(p(side * 70.0, 6.0), PVec2::new(36.0, 17.0) * s, side * 0.12, zz, c(SHOES));
        buf.ellipse(p(side * 78.0, 12.0), PVec2::new(10.0, 5.0) * s, side * 0.12, zz, la(Color::WHITE, 0.5));
    }

    // Bodice.
    let bodice = [up(-62.0, 160.0), up(62.0, 160.0), up(58.0, 232.0), up(40.0, 252.0), up(-40.0, 252.0), up(-58.0, 232.0)];
    buf.fan(&bodice, up(0.0, 200.0), zz, c(DRESS), c(DRESS_SHADE));
    buf.stroke(&[up(-62.0, 162.0), up(62.0, 162.0)], 10.0 * s, zz, c(DRESS_SHADE));
    // Neck and collar.
    buf.fan(&[up(-15.0, 240.0), up(15.0, 240.0), up(15.0, 268.0), up(-15.0, 268.0)], up(0.0, 254.0), zz, c(SKIN_SHADE), c(SKIN_SHADE));
    for side in [-1.0f32, 1.0] {
        buf.ellipse(up(side * 22.0, 249.0), PVec2::new(27.0, 14.0) * s, side * -0.35, zz, lin(Color::WHITE));
    }

    // Head.
    let h = up(0.0, 330.0);
    buf.ellipse(h, PVec2::new(84.0, 80.0) * s, 0.0, zz, c(SKIN));
    // Ears.
    for side in [-1.0f32, 1.0] {
        buf.ellipse(up(side * 82.0, 322.0), PVec2::new(12.0, 16.0) * s, 0.0, zz, c(SKIN_SHADE));
    }
    // Bangs: a cap of hair with a scalloped fringe.
    let fringe: Vec<PVec2> = {
        let mut v = Vec::new();
        for i in 0..=14 {
            let a = (8.0 + 164.0 * i as f32 / 14.0f32).to_radians();
            v.push(up(a.cos() * 90.0, 336.0 + a.sin() * 86.0));
        }
        for i in 0..=10 {
            let u = i as f32 / 10.0;
            let x = -84.0 + 168.0 * u;
            let y = 346.0 + ((u * 5.0).fract() - 0.5).abs() * 18.0 + (1.0 - (2.0 * u - 1.0).powi(2)) * 8.0;
            v.push(up(x, y));
        }
        v
    };
    buf.fan(&fringe, up(0.0, 385.0), zz, c(HAIR_HI), c(HAIR));
    // Hair ties on the pigtails, and a bow on top.
    for side in [-1.0f32, 1.0] {
        buf.ellipse(up(side * 88.0, 334.0), PVec2::splat(12.0) * s, 0.0, zz, c(BOWS));
    }
    for side in [-1.0f32, 1.0] {
        buf.ellipse(up(46.0 + side * 22.0, 412.0), PVec2::new(22.0, 14.0) * s, side * 0.5, zz, c(BOWS));
    }
    buf.ellipse(up(46.0, 412.0), PVec2::splat(9.0) * s, 0.0, zz, lin(hex(0xf5b800)));

    // Face.
    let look = pose.look * PVec2::new(7.0, 5.0);
    for side in [-1.0f32, 1.0] {
        let e = up(side * 30.0, 320.0) + look * s;
        if pose.blink {
            buf.arc(e, PVec2::new(11.0, 5.0) * s, std::f32::consts::PI, std::f32::consts::TAU, 4.0 * s, zz, c(INK));
        } else {
            buf.ellipse(e, PVec2::new(11.0, 15.0) * s, 0.0, zz, c(INK));
            buf.ellipse(e + PVec2::new(-3.5, 5.0) * s, PVec2::splat(4.5) * s, 0.0, zz, lin(Color::WHITE));
        }
        buf.ellipse(up(side * 52.0, 298.0), PVec2::new(16.0, 10.0) * s, 0.0, zz, la(hex(0xff7f9b), 0.45));
    }
    buf.ellipse(up(0.0, 307.0) + look * 0.5 * s, PVec2::new(6.0, 4.5) * s, 0.0, zz, c(SKIN_SHADE));
    let m = up(0.0, 292.0) + look * 0.4 * s;
    if pose.reach > 0.5 {
        // Delighted: an open "ohh!" smile.
        buf.ellipse(m, PVec2::new(15.0, 11.0 + 3.0 * (pose.t * 5.0).sin().abs()) * s, 0.0, zz, lin(hex(0x8a2b3f)));
        buf.ellipse(m - PVec2::new(0.0, 5.0) * s, PVec2::new(8.0, 4.0) * s, 0.0, zz, lin(hex(0xff8fa3)));
    } else {
        buf.arc(m + PVec2::new(0.0, 8.0) * s, PVec2::new(17.0, 12.0) * s, 3.55, 5.87, 4.5 * s, zz, c(INK));
    }

    // Arms (in front of the body): from the shoulders to the lap, or out
    // toward Pip with open hands.
    for side in [-1.0f32, 1.0] {
        let sh = up(side * 58.0, 236.0);
        let lap = p(side * 34.0, 150.0);
        let reach_to = match pose.target {
            Some(t) => {
                let shp = PVec2::new(side * 58.0 + lean * 18.0, 236.0);
                let d = (t + PVec2::new(side * 26.0, 10.0)) - shp;
                p(0.0, 0.0) + (shp + d.clamp_length_max(190.0)) * s
            }
            None => up(side * 150.0, 300.0),
        };
        let k = pose.reach * pose.reach * (3.0 - 2.0 * pose.reach);
        let hand = lap.lerp(reach_to, k);
        let mid = (sh + hand) * 0.5;
        let out = PVec2::new(side, -0.6).normalize() * (38.0 * (1.0 - k) + 14.0) * s;
        let elbow = mid + out;
        buf.stroke(&[sh, elbow, hand], 26.0 * s, zz, c(SKIN));
        buf.ellipse(elbow, PVec2::splat(13.0) * s, 0.0, zz, c(SKIN));
        // Puffed sleeve.
        buf.ellipse(sh + PVec2::new(side * 4.0, -4.0) * s, PVec2::new(30.0, 25.0) * s, 0.0, zz, c(DRESS));
        buf.ellipse(sh + PVec2::new(side * 4.0, -20.0) * s, PVec2::new(26.0, 6.0) * s, 0.0, zz, lin(Color::WHITE));
        // Hand with a thumb, opening as she reaches.
        let dir = (hand - elbow).normalize_or(PVec2::Y);
        buf.ellipse(hand, PVec2::new(19.0, 17.0) * s, dir.to_angle(), zz, c(SKIN));
        let thumb = hand + (dir.perp() * -side * 14.0 + dir * 2.0) * s * (0.6 + 0.4 * k);
        buf.ellipse(thumb, PVec2::new(9.0, 7.0) * s, dir.to_angle(), zz, c(SKIN));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lulu_draws_a_whole_girl_in_every_pose() {
        for (reach, blink, target) in [(0.0, false, None), (1.0, true, Some(PVec2::new(-300.0, 60.0))), (0.5, false, Some(PVec2::new(250.0, 400.0)))] {
            let mut buf = MeshBuf::default();
            let pose = Pose { t: 1.3, reach, look: PVec2::new(-0.5, 0.2), blink, target };
            figure(&mut buf, PVec2::new(100.0, 0.0), 1.0, &pose);
            assert!(buf.idx.len() > 600, "plenty of detail");
            assert!(buf.pos.iter().all(|p| p.iter().all(|v| v.is_finite())));
            // Sits on the ground, about 420 px tall, centred on her spot.
            let (lo, hi) = buf.pos.iter().fold((f32::MAX, f32::MIN), |(lo, hi), p| (lo.min(p[1]), hi.max(p[1])));
            assert!(lo > -30.0 && lo < 10.0, "feet on the ground: {lo}");
            assert!(hi > 400.0 && hi < 470.0, "height: {hi}");
        }
    }
}
