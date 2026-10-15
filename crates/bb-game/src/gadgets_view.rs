//! Gadget visuals, sounds and fx: the spinning launch gears (ch05), seed
//! pods (ch04), glow-moth balloons (ch07) and the toy claw machine (ch08).
//!
//! The look is the caves' bioluminescent pulse network: each gadget rests
//! dim, its veins glow while it's busy (`GadgetState::glow`), and a pulse
//! runs through them when it's used (`GadgetState::pulse`). The claw machine
//! is a toy: candy plastic, still softly lit. Sounds and pop-words come from
//! `SimEvent::Gadget`.

use bb_level::GadgetKind;
use bb_physics::Vec2 as PVec2;
use bb_sim::SimEvent;
use bb_sim::gadgets::{ClawPhase, GadgetEvent, GadgetRt, GadgetState, tune};
use bevy::prelude::*;

use crate::assets::GameAssets;
use crate::audio::PlaySfx;
use crate::level_view::LevelEntity;
use crate::palette::{self, ThemeColors, darken, hex, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, empty_mesh, la, z};
use crate::sim::{Game, SimMsg};

pub struct GadgetsViewPlugin;

impl Plugin for GadgetsViewPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, spawn_gadget_views.run_if(resource_added::<Game>))
            .add_systems(PostUpdate, (update_gadget_views, gadget_fx).run_if(resource_exists::<Game>));
    }
}

/// One mesh per gadget layer: behind the blobs (`front = false`) or in front.
#[derive(Component)]
struct GadgetVisual {
    index: usize,
    front: bool,
    mesh: Handle<Mesh>,
    /// Fixed scenery found at load: the roof above (crane rail, hanging
    /// pod vine) and the ground below (claw pad, balloon tether).
    roof: Option<f32>,
    ground: Option<f32>,
}

fn spawn_gadget_views(mut commands: Commands, game: Res<Game>, shared: Res<Shared>, mut meshes: ResMut<Assets<Mesh>>) {
    let sim = &game.sim;
    let mask = bb_sim::load::layer::WORLD;
    for (i, g) in sim.gadgets.iter().enumerate() {
        let p = g.def.pos;
        let roof = sim.world.raycast(p + PVec2::new(0.0, 80.0), PVec2::Y, 2500.0, mask, None).map(|h| h.1.y);
        let ground = sim.world.raycast(p, PVec2::NEG_Y, 600.0, mask, None).map(|h| h.1.y);
        let (back_z, front_z) = match g.def.kind {
            GadgetKind::LaunchPlate { .. } => (z::PLATFORM + 0.3, z::PLATFORM + 0.35),
            GadgetKind::Launcher { .. } => (z::ITEMS + 0.2, z::PLAYER + 0.3),
            GadgetKind::Balloon { .. } => (z::ITEMS + 0.3, z::PLAYER + 0.6),
            GadgetKind::Crane { .. } => (z::TERRAIN + 0.7, z::PLAYER + 0.4),
        };
        for (front, zz) in [(false, back_z), (true, front_z)] {
            let h = meshes.add(empty_mesh());
            commands.spawn((
                Mesh2d(h.clone()),
                MeshMaterial2d(shared.blend.clone()),
                Transform::from_xyz(0.0, 0.0, zz + (i % 50) as f32 * 0.001),
                GadgetVisual { index: i, front, mesh: h, roof, ground },
                LevelEntity,
            ));
        }
    }
}

fn update_gadget_views(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&GadgetVisual>) {
    let sim = &game.sim;
    let theme = palette::theme(sim.level.theme);
    let t = time.elapsed_secs();
    for gv in q.iter() {
        let Some(g) = sim.gadgets.get(gv.index) else { continue };
        let Some(mut mesh) = meshes.get_mut(&gv.mesh) else { continue };
        let mut buf = MeshBuf::default();
        match &g.def.kind {
            GadgetKind::LaunchPlate { .. } => draw_gear(&mut buf, sim, g, gv.front, t, &theme),
            GadgetKind::Launcher { .. } => draw_pod(&mut buf, sim, g, gv, t, &theme),
            GadgetKind::Balloon { .. } => draw_balloon(&mut buf, sim, g, gv, t, &theme),
            GadgetKind::Crane { .. } => draw_claw(&mut buf, sim, g, gv, t, &theme),
        }
        buf.write(&mut mesh);
    }
}

/// The glow colour of a vein at rest (dim) → busy (bright) → pulsing.
fn vein(base: Color, glow: f32, pulse: f32) -> Color {
    let dim = darken(base, 0.55);
    lighten(mix(dim, base, glow.clamp(0.0, 1.0)), pulse.clamp(0.0, 1.0) * 0.45)
}

// ------------------------------------------------------------------ gears

/// Amber light in the stone gears of the old works.
const GEAR_GLOW: u32 = 0xffb35c;

fn draw_gear(buf: &mut MeshBuf, sim: &bb_sim::Sim, g: &GadgetState, front: bool, t: f32, theme: &ThemeColors) {
    let (GadgetKind::LaunchPlate { radius, angle: launch, clockwise, .. }, GadgetRt::Plate { id, angle, spin, full, .. }) = (&g.def.kind, &g.rt) else { return };
    let c = g.def.pos;
    let r = *radius;
    let glow = g.glow;
    let warm = hex(GEAR_GLOW);
    let rot = PVec2::from_angle(*angle);
    if front {
        // Where it lets go: chevrons just past the rim, pointing the way
        // you'll fly (they brighten as it winds up).
        let dir = if *clockwise { -1.0 } else { 1.0 };
        let rel = launch - dir * std::f32::consts::FRAC_PI_2;
        let at = c + PVec2::from_angle(rel) * (r + 44.0);
        let ld = PVec2::from_angle(*launch);
        let ready = (spin / full.max(1e-3)).clamp(0.0, 1.0);
        for k in 0..3 {
            let wave = ((t * 6.0 - k as f32 * 0.9).sin() * 0.5 + 0.5) * ready;
            let p = at + ld * (k as f32 * 22.0);
            let a = 0.18 + 0.55 * wave + 0.25 * g.pulse;
            buf.stroke(&[p - ld * 9.0 + ld.perp() * 10.0, p, p - ld * 9.0 - ld.perp() * 10.0], 5.0, 0.0, la(lighten(warm, 0.2), a));
        }
        return;
    }
    // The socket in the back wall, faintly lit.
    if theme.dark {
        buf.halo(c, PVec2::splat(r * 1.9), -0.003, la(warm, 0.08 + 0.22 * glow + 0.3 * g.pulse));
    }
    buf.ellipse(c, PVec2::splat(r + 26.0), 0.0, -0.002, lin(darken(theme.rock, 0.35)));
    // The gear itself (its collider's outline, turning).
    let Some(s) = sim.world.static_collider(*id) else { return };
    let stone = mix(theme.rock, hex(0x5a5048), 0.5);
    buf.fan(&s.poly, c, 0.0, lin(lighten(stone, 0.08)), lin(darken(stone, 0.2)));
    buf.ring(&s.poly, 4.0, 1.5, 0.001, lin(vein(warm, glow * 0.6, g.pulse)));
    // Motion streaks along the rim when it's really going.
    let speed = (spin / full.max(1e-3)).clamp(0.0, 1.0);
    if speed > 0.3 {
        let dir = if *clockwise { -1.0 } else { 1.0 };
        for k in 0..4 {
            let a0 = angle + k as f32 * std::f32::consts::FRAC_PI_2;
            buf.arc(c, PVec2::splat(r * 0.86), a0, a0 - dir * 0.9 * speed, 3.0, 0.002, la(warm, 0.12 * speed));
        }
    }
    // Veins: spokes from the hub to the rim, and a ring. A pulse runs
    // outward along them on each fling.
    let col = vein(warm, glow, g.pulse);
    for k in 0..6 {
        let d = rot.rotate(PVec2::from_angle(k as f32 * std::f32::consts::TAU / 6.0));
        let pts = [c + d * 26.0, c + d * (r * 0.55) + d.perp() * 6.0, c + d * (r * 0.9)];
        buf.stroke(&pts, 4.0, 0.003, lin(col));
        if g.pulse > 0.0 {
            let rp = 26.0 + (1.0 - g.pulse) * (r * 0.9 - 26.0);
            buf.ellipse(c + d * rp, PVec2::splat(6.0 + 4.0 * g.pulse), 0.0, 0.004, la(lighten(warm, 0.5), g.pulse));
        }
    }
    let ring: Vec<PVec2> = (0..=24).map(|i| c + PVec2::from_angle(i as f32 / 24.0 * std::f32::consts::TAU) * (r * 0.62)).collect();
    buf.stroke(&ring, 2.5, 0.003, la(col, 0.7));
    // Hub.
    if theme.dark {
        buf.halo(c, PVec2::splat(46.0 + 20.0 * glow), 0.003, la(warm, 0.25 + 0.5 * glow));
    }
    buf.ellipse(c, PVec2::splat(22.0), 0.0, 0.004, lin(darken(stone, 0.3)));
    buf.ellipse(c, PVec2::splat(11.0), 0.0, 0.005, lin(col));
}

// ------------------------------------------------------------------- pods

/// Seed-pod skin and its glowing veins (vine-garden green-cyan).
const POD_SKIN: u32 = 0x1d4a3c;
const POD_GLOW: u32 = 0x7cf5c1;

fn draw_pod(buf: &mut MeshBuf, sim: &bb_sim::Sim, g: &GadgetState, gv: &GadgetVisual, t: f32, theme: &ThemeColors) {
    let (GadgetKind::Launcher { power, .. }, GadgetRt::Pod { aim, loaded, recoil }) = (&g.def.kind, &g.rt) else { return };
    let mouth = g.def.pos;
    let d = PVec2::from_angle(*aim);
    let side = d.perp();
    // The bulb sits behind the mouth, recoiling on a shot.
    let kick = recoil * 14.0;
    let c = mouth - d * (30.0 + kick);
    let glow = g.glow;
    let lit = hex(POD_GLOW);
    let col = vein(lit, glow.max(0.25), g.pulse);
    let skin = mix(hex(POD_SKIN), theme.jelly, 0.15);
    if gv.front {
        // Lips either side of the mouth, over a swallowed blob.
        for s in [-1.0f32, 1.0] {
            let a0 = aim + s * 0.95;
            let a1 = aim + s * 2.2;
            buf.arc(c, PVec2::new(64.0, 58.0), a0, a1, 15.0, 0.0, la(lighten(skin, 0.08), if loaded.is_some() { 0.95 } else { 0.0 }));
        }
        if loaded.is_some() {
            buf.arc(c, PVec2::new(64.0, 58.0), aim + 1.0, aim + 2.1, 3.0, 0.001, lin(col));
            buf.arc(c, PVec2::new(64.0, 58.0), aim - 1.0, aim - 2.1, 3.0, 0.001, lin(col));
        }
        return;
    }
    // Hanging pods: a vine down from the roof. Ground pods: a root tuft.
    match gv.ground {
        Some(gy) if mouth.y - gy < 140.0 => {
            for k in [-1.0f32, 0.0, 1.0] {
                buf.stroke(&[c + PVec2::new(k * 16.0, -30.0), PVec2::new(c.x + k * 34.0, gy + 2.0)], 7.0, -0.001, lin(darken(skin, 0.2)));
            }
        }
        _ => {
            if let Some(ry) = gv.roof {
                let top = PVec2::new(c.x, ry);
                let pts: Vec<PVec2> = (0..=8).map(|i| top.lerp(c, i as f32 / 8.0) + PVec2::new((i as f32 * 1.3 + t * 0.8).sin() * 4.0, 0.0)).collect();
                crate::render::draw_vine(buf, &pts, 8.0, darken(skin, 0.1), -0.001, glow * 0.6);
            }
        }
    }
    if theme.dark {
        buf.halo(c, PVec2::splat(120.0), -0.002, la(lit, 0.06 + 0.22 * glow + 0.3 * g.pulse));
    }
    // Bulb, turned along the barrel.
    let bulb: Vec<PVec2> = (0..28)
        .map(|i| {
            let a = i as f32 / 28.0 * std::f32::consts::TAU;
            // Wider at the back, open at the mouth.
            let rr = 1.0 + 0.12 * (a.cos() * -1.0);
            c + d * (a.cos() * 70.0 * rr) + side * (a.sin() * 56.0)
        })
        .collect();
    buf.fan(&bulb, c - d * 16.0, 0.0, lin(lighten(skin, 0.1)), lin(darken(skin, 0.25)));
    // Veins from the base toward the mouth; a pulse rides them on firing.
    for k in [-2.0f32, -1.0, 0.0, 1.0, 2.0] {
        let pts: Vec<PVec2> = (0..=6)
            .map(|i| {
                let u = i as f32 / 6.0;
                c - d * 62.0 * (1.0 - u) + d * 20.0 * u + side * (k * 18.0 * (u * std::f32::consts::PI).sin().max(0.3))
            })
            .collect();
        buf.stroke(&pts, 2.5, 0.001, la(col, 0.85));
        if g.pulse > 0.0 {
            let u = 1.0 - g.pulse;
            let p = c - d * 62.0 * (1.0 - u) + d * 20.0 * u + side * (k * 18.0 * (u * std::f32::consts::PI).sin().max(0.3));
            buf.ellipse(p, PVec2::splat(5.0), 0.0, 0.002, la(lighten(lit, 0.5), g.pulse));
        }
    }
    // The dark mouth.
    buf.ellipse(mouth - d * kick, PVec2::new(22.0, 38.0), *aim, 0.002, lin(darken(skin, 0.6)));
    buf.ring(&ellipse_pts(mouth - d * kick, PVec2::new(22.0, 38.0), *aim), 3.0, 1.0, 0.003, lin(col));
    // Aim: glowing seeds along where it'll throw you.
    let gb = sim.tuning.gravity.gravity;
    let speed = power * (gb / sim.world.config.gravity.length().max(1.0)).sqrt();
    let n = 9;
    for k in 1..=n {
        let tt = k as f32 * 0.055;
        let p = mouth + d * speed * tt + PVec2::new(0.0, -0.5 * gb * tt * tt);
        let fade = 1.0 - k as f32 / (n as f32 + 1.0);
        let a = (0.12 + 0.55 * glow) * fade * (0.75 + 0.25 * (t * 8.0 - k as f32).sin());
        buf.ellipse(p, PVec2::splat(5.0 + 2.0 * glow), 0.0, 0.003, la(lighten(lit, 0.3), a));
    }
}

fn ellipse_pts(c: PVec2, r: PVec2, angle: f32) -> Vec<PVec2> {
    let rot = PVec2::from_angle(angle);
    (0..16)
        .map(|i| {
            let a = i as f32 / 16.0 * std::f32::consts::TAU;
            c + rot.rotate(PVec2::new(a.cos() * r.x, a.sin() * r.y))
        })
        .collect()
}

// --------------------------------------------------------------- balloons

/// Glow-moth balloons: soft lilac-pink with a warm heart.
const BALLOON: u32 = 0xf2a6e6;
const BALLOON_HEART: u32 = 0xfff0c2;

fn draw_balloon(buf: &mut MeshBuf, sim: &bb_sim::Sim, g: &GadgetState, gv: &GadgetVisual, t: f32, theme: &ThemeColors) {
    let (GadgetKind::Balloon { .. }, GadgetRt::Balloon { carrier, pos, left: _, away, popped, inflate, pressed, .. }) = (&g.def.kind, &g.rt) else { return };
    let p = *pos;
    let skin = hex(BALLOON);
    let heart = hex(BALLOON_HEART);
    if gv.front {
        // The string (in front, so you can see it's tied on).
        let knot = match carrier.and_then(|b| sim.world.body(b)) {
            Some(b) => {
                let c = b.centroid();
                let r = sim.players.iter().map(|p| &p.ctl).chain(sim.npcs.iter().map(|n| &n.ctl)).find(|c| Some(c.body) == *carrier).map_or(32.0, |c| c.radius * c.expand);
                Some(c + PVec2::new(0.0, r * 0.9))
            }
            None if *away <= 0.0 => gv.ground.map(|gy| PVec2::new(g.def.pos.x, gy)),
            None => None,
        };
        if let Some(k) = knot {
            let tail = p - PVec2::new(0.0, tune::BALLOON_R * 1.1);
            let mid = (k + tail) * 0.5 + PVec2::new((t * 2.3).sin() * 8.0, 0.0);
            let pts: Vec<PVec2> = (0..=8)
                .map(|i| {
                    let u = i as f32 / 8.0;
                    k.lerp(mid, u).lerp(mid.lerp(tail, u), u)
                })
                .collect();
            buf.stroke(&pts, 2.0, 0.0, la(lighten(skin, 0.5), 0.8));
        }
        return;
    }
    if *away > 0.0 && *popped {
        // Shreds drifting down.
        let u = 1.0 - away / tune::BALLOON_RESPAWN;
        for k in 0..7 {
            let a = k as f32 * 0.9 + 0.3;
            let q = p + PVec2::new(a.cos() * (20.0 + 90.0 * u), a.sin() * 40.0 * u - 160.0 * u * u);
            buf.ellipse(q, PVec2::new(7.0, 4.0), a + t * 3.0, 0.0, la(skin, (1.0 - u) * 0.8));
        }
        return;
    }
    let fade = if *away > 0.0 { (away / tune::BALLOON_RESPAWN).clamp(0.0, 1.0) } else { 1.0 };
    // Running out: it blinks.
    let left = g.balloon_left();
    let blink = if carrier.is_some() && left < 0.3 { 0.55 + 0.45 * (t * (10.0 + 20.0 * (0.3 - left))).sin().abs() } else { 1.0 };
    let r = tune::BALLOON_R * (0.95 + 0.3 * inflate);
    let squash = if *pressed { PVec2::new(1.15, 0.85) } else { PVec2::new(1.0, 1.12) };
    let rr = PVec2::new(r * squash.x, r * squash.y);
    let a = fade * blink;
    if theme.dark {
        buf.halo(p, rr * 3.2, -0.002, la(skin, (0.12 + 0.35 * g.glow + 0.3 * g.pulse) * a));
    }
    buf.ellipse(p, rr, 0.0, 0.0, la(mix(darken(skin, 0.2), skin, 0.4 + 0.6 * g.glow.max(0.3)), 0.82 * a));
    // The moth-glow heart, brighter the more you puff.
    buf.halo(p - PVec2::new(0.0, r * 0.1), rr * 0.8, 0.001, la(heart, (0.35 + 0.6 * inflate) * a));
    // Veins (latitude lines) and a highlight.
    for k in [-0.45f32, 0.0, 0.45] {
        buf.arc(p, PVec2::new(rr.x * (1.0 - k.abs() * 0.6), rr.y), -1.35, 1.35, 1.5, 0.002, la(lighten(skin, 0.4), 0.35 * a));
        let _ = k;
    }
    buf.ellipse(p + PVec2::new(-r * 0.35, r * 0.45), PVec2::new(r * 0.22, r * 0.14), 0.6, 0.003, la(Color::WHITE, 0.55 * a));
    // The knot.
    let kb = p - PVec2::new(0.0, rr.y);
    buf.fan(&[kb + PVec2::new(-6.0, -8.0), kb + PVec2::new(6.0, -8.0), kb + PVec2::new(0.0, 2.0)], kb - PVec2::new(0.0, 3.0), 0.002, la(skin, a), la(darken(skin, 0.2), a));
}

// -------------------------------------------------------------- claw crane

const TOY_RED: u32 = 0xff6b6b;
const TOY_YELLOW: u32 = 0xffd93d;
const TOY_GLOW: u32 = 0xfff3a3;

fn draw_claw(buf: &mut MeshBuf, sim: &bb_sim::Sim, g: &GadgetState, gv: &GadgetVisual, t: f32, theme: &ThemeColors) {
    let (GadgetKind::Crane { to, .. }, GadgetRt::Crane { phase, claw, open, held, .. }) = (&g.def.kind, &g.rt) else { return };
    let home = g.def.pos;
    let drop = home + *to;
    let red = hex(TOY_RED);
    let yellow = hex(TOY_YELLOW);
    let light = hex(TOY_GLOW);
    let rail_y = gv.roof.map_or(home.y + 320.0, |r| r - 26.0).max(home.y + 140.0);
    // The held blob's size sets how far the prongs reach round it.
    let blob_r = held.and_then(|b| sim.players.iter().map(|p| &p.ctl).chain(sim.npcs.iter().map(|n| &n.ctl)).find(|c| c.body == b)).map_or(32.0, |c| c.radius * c.expand);
    let head = *claw + PVec2::new(0.0, blob_r + 26.0);
    if !gv.front {
        // Rail with lights that chase toward the drop while carrying.
        let (x0, x1) = (home.x.min(drop.x) - 90.0, home.x.max(drop.x) + 90.0);
        buf.stroke(&[PVec2::new(x0, rail_y), PVec2::new(x1, rail_y)], 16.0, 0.0, lin(darken(yellow, 0.25)));
        buf.stroke(&[PVec2::new(x0, rail_y + 5.0), PVec2::new(x1, rail_y + 5.0)], 4.0, 0.001, lin(lighten(yellow, 0.2)));
        let n = ((x1 - x0) / 60.0) as usize;
        let carrying = matches!(phase, ClawPhase::Carry);
        for k in 0..=n {
            let x = x0 + k as f32 * 60.0;
            let chase = if carrying { ((x - t * 400.0) / 120.0).sin() * 0.5 + 0.5 } else { 0.0 };
            let a = 0.15 + 0.5 * chase * g.glow;
            buf.ellipse(PVec2::new(x, rail_y - 2.0), PVec2::splat(4.0), 0.0, 0.002, la(light, a));
        }
        // Hangers up into the roof at the rail ends.
        if let Some(r) = gv.roof {
            for x in [x0 + 20.0, x1 - 20.0] {
                buf.stroke(&[PVec2::new(x, rail_y), PVec2::new(x, r + 30.0)], 8.0, -0.001, lin(darken(yellow, 0.4)));
            }
        }
        // Carriage and cable.
        let car = PVec2::new(claw.x, rail_y);
        buf.fan(&rounded(car - PVec2::new(38.0, 18.0), car + PVec2::new(38.0, 16.0)), car, 0.002, lin(lighten(red, 0.1)), lin(darken(red, 0.15)));
        buf.stroke(&[car, head + PVec2::new(0.0, 14.0)], 4.0, 0.001, lin(hex(0xb8c0d0)));
        // The pad under the home spot: a soft target ring.
        if let Some(gy) = gv.ground {
            let pad = PVec2::new(home.x, gy + 3.0);
            let idle = *phase == ClawPhase::Idle;
            let a = if idle { 0.35 + 0.25 * (t * 3.0).sin() } else { 0.2 };
            if theme.dark {
                buf.halo(pad + PVec2::new(0.0, 10.0), PVec2::new(90.0, 30.0), -0.001, la(light, a * 0.5));
            }
            buf.stroke(&[pad - PVec2::new(60.0, 0.0), pad + PVec2::new(60.0, 0.0)], 6.0, 0.002, la(yellow, a + 0.3));
        }
        return;
    }
    // Claw head and prongs (in front of a held blob).
    if theme.dark {
        buf.halo(head, PVec2::splat(70.0), -0.001, la(light, 0.08 + 0.25 * g.glow + 0.3 * g.pulse));
    }
    buf.fan(&rounded(head - PVec2::new(30.0, 10.0), head + PVec2::new(30.0, 22.0)), head + PVec2::new(0.0, 6.0), 0.0, lin(lighten(red, 0.15)), lin(darken(red, 0.1)));
    for (k, x) in [-14.0f32, 0.0, 14.0].into_iter().enumerate() {
        let a = 0.3 + 0.7 * g.glow * (0.5 + 0.5 * (t * 5.0 + k as f32 * 2.0).sin()) + g.pulse * 0.4;
        buf.ellipse(head + PVec2::new(x, 8.0), PVec2::splat(4.0), 0.0, 0.001, la(light, a.min(1.0)));
    }
    let spread = 0.15 + 0.85 * open;
    let reach = blob_r + 22.0;
    for s in [-1.0f32, 1.0] {
        let shoulder = head + PVec2::new(s * 22.0, -6.0);
        let elbow = shoulder + PVec2::new(s * (reach * 0.45 + 30.0 * spread), -reach * 0.55);
        let tip = elbow + PVec2::new(-s * (reach * 0.35 * (1.0 - spread * 0.8)), -reach * 0.65);
        buf.stroke(&[shoulder, elbow, tip], 9.0, 0.0, lin(lighten(yellow, 0.05)));
        buf.ellipse(tip, PVec2::splat(6.0), 0.0, 0.001, lin(darken(yellow, 0.1)));
        buf.ellipse(elbow, PVec2::splat(5.0), 0.0, 0.001, lin(darken(yellow, 0.2)));
    }
}

fn rounded(lo: PVec2, hi: PVec2) -> Vec<PVec2> {
    let r = ((hi - lo).min_element() * 0.35).min(12.0);
    let mut pts = Vec::new();
    for (c, a0) in [(PVec2::new(hi.x - r, lo.y + r), -0.5f32), (PVec2::new(hi.x - r, hi.y - r), 0.0), (PVec2::new(lo.x + r, hi.y - r), 0.5), (PVec2::new(lo.x + r, lo.y + r), 1.0)] {
        for i in 0..=3 {
            let a = (a0 + i as f32 / 6.0) * std::f32::consts::PI;
            pts.push(c + PVec2::new(a.cos(), a.sin()) * r);
        }
    }
    pts
}

// ---------------------------------------------------------- sounds and fx

fn gadget_fx(mut commands: Commands, mut events: MessageReader<SimMsg>, game: Res<Game>, assets: Res<GameAssets>, mut sfx: MessageWriter<PlaySfx>) {
    for SimMsg(e) in events.read() {
        let SimEvent::Gadget { what, pos, index } = e else { continue };
        let p = Vec2::new(pos.x, pos.y);
        let word = |commands: &mut Commands, text: &str, col: u32, size: f32| crate::fx::word(commands, &assets, text, p + Vec2::new(0.0, 70.0), hex(col), size);
        let kind = game.sim.gadgets.get(*index).map(|g| &g.def.kind);
        match what {
            GadgetEvent::PlateGrip => {
                sfx.write(PlaySfx::new("wall-stick", 0.45, 0.75));
            }
            GadgetEvent::PlateLaunch { boosted } => {
                sfx.write(PlaySfx::new("spring-boing", 0.04, if *boosted { 0.6 } else { 0.72 }));
                if *boosted {
                    sfx.write(PlaySfx::new("powerup-sparkle", 0.3, 1.3));
                    word(&mut commands, "FWOOOSH!", GEAR_GLOW, 58.0);
                } else {
                    word(&mut commands, "fling!", GEAR_GLOW, 40.0);
                }
            }
            GadgetEvent::PodLoad => {
                sfx.write(PlaySfx::new("bloop", 0.35, 0.7));
            }
            GadgetEvent::PodFire => {
                sfx.write(PlaySfx::new("spring-boing", 0.035, 1.25));
                sfx.write(PlaySfx::new("wall-jump", 0.4, 0.75));
                if matches!(kind, Some(GadgetKind::Launcher { .. })) {
                    word(&mut commands, "PTOO!", POD_GLOW, 46.0);
                }
            }
            GadgetEvent::BalloonTie => {
                sfx.write(PlaySfx::new("plink", 0.4, 1.6));
            }
            GadgetEvent::BalloonPop => {
                sfx.write(PlaySfx::new("spike-splat", 0.12, 1.7));
                word(&mut commands, "POP!", BALLOON, 56.0);
            }
            GadgetEvent::BalloonGone => {
                sfx.write(PlaySfx::new("bloop", 0.25, 1.5));
            }
            GadgetEvent::CraneGrab => {
                sfx.write(PlaySfx::new("wall-stick", 0.5, 1.35));
                word(&mut commands, "gotcha!", TOY_YELLOW, 36.0);
            }
            GadgetEvent::CraneDrop => {
                sfx.write(PlaySfx::new("ui-click", 0.5, 0.75));
            }
        }
    }
}
