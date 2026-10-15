//! Cave mouths: the tunnels every story chapter begins beside and ends in.
//!
//! * **Exit** — a tunnel in the end wall you roll into (the goal sits deep
//!   inside). Its far end glows with the *next* chapter's light, so the
//!   colour you walk into is the colour of the level that follows.
//! * **Entry** — the tunnel you came out of, plugged by a rock-fall, with
//!   the *previous* chapter's light leaking through the cracks.
//! * **Daylight** (the finale's exit) — warm sunlight pouring in.
//!
//! The rock itself is ordinary level terrain (see `Ch::exit_cave`); this
//! module only paints light: the tunnel's depth gradient behind the rock,
//! the glow of "the tunnel turning away" over the back wall, a pool of
//! light spilling out over the floor and lip, and drifting motes.
//!
//! It also hides the old round goal light (`level_view::GoalVisual`) on
//! levels that have an exit cave: the cave *is* the goal now.

use bb_level::{CaveMouth, MouthKind};
use bb_physics::Vec2 as PVec2;
use bevy::prelude::*;

use crate::level_view::{GoalVisual, LevelEntity};
use crate::palette::{self, darken, hex, lighten, mix};
use crate::render::{Ends, MeshBuf, Shared, empty_mesh, la, z};
use crate::sim::Game;

pub struct MouthsPlugin;

impl Plugin for MouthsPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, spawn_mouths.run_if(resource_added::<Game>))
            .add_systems(PostUpdate, (update_mouths, hide_goal_light).run_if(resource_exists::<Game>));
    }
}

/// One mouth: index into `level.mouths`, and three meshes (behind the rock,
/// painted on the rock, in front of everything).
#[derive(Component)]
struct MouthVisual {
    index: usize,
    level: String,
    back: Handle<Mesh>,
    on_rock: Handle<Mesh>,
    front: Handle<Mesh>,
}

fn spawn_mouths(mut commands: Commands, game: Res<Game>, shared: Res<Shared>, mut meshes: ResMut<Assets<Mesh>>) {
    for index in 0..game.sim.level.mouths.len() {
        let (back, on_rock, front) = (meshes.add(empty_mesh()), meshes.add(empty_mesh()), meshes.add(empty_mesh()));
        let mat = MeshMaterial2d(shared.blend.clone());
        let zi = index as f32 * 0.001;
        // Behind the rock: just in front of the backdrop and back decor.
        commands.spawn((Mesh2d(back.clone()), mat.clone(), Transform::from_xyz(0.0, 0.0, z::DECOR_BACK + 1.0 + zi), LevelEntity));
        // Over the rock (light round the lip, the bright bend at the back),
        // under jelly and players.
        commands.spawn((Mesh2d(on_rock.clone()), mat.clone(), Transform::from_xyz(0.0, 0.0, z::SPILL + 0.05 + zi), LevelEntity));
        // Haze and motes over everything gameplay (very faint).
        commands.spawn((Mesh2d(front.clone()), mat, Transform::from_xyz(0.0, 0.0, z::FX - 0.4 + zi), LevelEntity));
        commands.spawn((MouthVisual { index, level: game.sim.level.id.clone(), back, on_rock, front }, LevelEntity));
    }
}

/// The light a mouth carries.
struct Light {
    /// Bright core (the tunnel bending into the next cave).
    core: Color,
    /// Main glow colour.
    glow: Color,
    /// Deep tint for the far gradient.
    deep: Color,
    /// Overall strength (daylight is much brighter).
    gain: f32,
}

fn light_for(m: &CaveMouth) -> Light {
    if m.daylight {
        let sun = hex(0xfff1c8);
        return Light { core: Color::WHITE, glow: sun, deep: hex(0xffd98a), gain: 1.35 };
    }
    let t = palette::theme(m.theme);
    let glow = if t.dark { mix(t.jelly, t.glow, 0.3) } else { mix(t.jelly, t.accent, 0.35) };
    Light { core: lighten(glow, 0.7), glow, deep: darken(glow, 0.35), gain: 1.0 }
}

fn update_mouths(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&MouthVisual>) {
    let t = time.elapsed_secs();
    for mv in q.iter() {
        if mv.level != game.sim.level.id {
            continue;
        }
        let Some(m) = game.sim.level.mouths.get(mv.index) else { continue };
        let (mut back, mut on_rock, mut front) = (MeshBuf::default(), MeshBuf::default(), MeshBuf::default());
        draw_mouth(m, t, &mut back, &mut on_rock, &mut front);
        for (h, buf) in [(&mv.back, back), (&mv.on_rock, on_rock), (&mv.front, front)] {
            if let Some(mut mesh) = meshes.get_mut(h) {
                buf.write(&mut mesh);
            }
        }
    }
}

/// Paint one mouth. Coordinates: `f` is the facing (+1: tunnel runs to +x),
/// `x(d)` is d px into the tunnel from the face.
pub fn draw_mouth(m: &CaveMouth, t: f32, back: &mut MeshBuf, on_rock: &mut MeshBuf, front: &mut MeshBuf) {
    let f = if m.facing < 0.0 { -1.0 } else { 1.0 };
    let (d, h) = (m.size.x, m.size.y);
    let p = PVec2::new(m.pos.x, m.pos.y);
    let x = |dx: f32| p.x + f * dx;
    let at = |dx: f32, dy: f32| PVec2::new(x(dx), p.y + dy);
    let lt = light_for(m);
    let g = lt.gain;
    let breathe = 1.0 + 0.06 * (t * 1.3 + p.x * 0.001).sin();
    let sealed = m.kind == MouthKind::Entry;
    // Sealed tunnels only leak light; open ones blaze.
    let k = if sealed { 0.55 } else { 1.0 } * g * breathe;

    // ── 1. Depth gradient behind the rock: dark at the mouth, brightening
    // towards the back where the tunnel turns away into the next cave.
    // Columns from the face (u=0) to just past the back wall (u=1.15),
    // brightest along the middle height.
    const COLS: usize = 12;
    const ROWS: usize = 6;
    let col = |u: f32, v: f32| -> [f32; 4] {
        let depth = u.clamp(0.0, 1.0).powf(1.6);
        let mid = 1.0 - (v * 2.0 - 1.0).abs().powf(1.5) * 0.55;
        let c = mix(mix(Color::BLACK, lt.deep, 0.5), lt.glow, depth);
        la(c, ((0.10 + 0.75 * depth) * mid * k).min(1.0))
    };
    let start = back.pos.len() as u32;
    for i in 0..=COLS {
        let u = i as f32 / COLS as f32 * 1.15;
        for j in 0..=ROWS {
            let v = j as f32 / ROWS as f32;
            back.vert(at(u * d, -10.0 + v * (h + 40.0)), 0.0, col(u, v));
        }
    }
    let w = (ROWS + 1) as u32;
    for i in 0..COLS as u32 {
        for j in 0..ROWS as u32 {
            let a = start + i * w + j;
            back.tri(a, a + w, a + w + 1);
            back.tri(a, a + w + 1, a + 1);
        }
    }
    // A soft bloom at the far end.
    back.halo(at(d * 0.92, h * 0.45), PVec2::new(d * 0.55, h * 0.75), 0.001, la(lt.glow, 0.55 * k));

    // ── 2. On the rock: the back wall reads as a bright bend in the tunnel
    // (light from beyond), the lip catches the glow, a pool of light rolls
    // out over the floor.
    if sealed {
        // Rock-fall plug: a pile of black boulders wedged against the back
        // of the tunnel, the old light leaking round their edges.
        back.halo(at(d - 20.0, h * 0.42), PVec2::new(190.0, h * 0.65), 0.002, la(lt.glow, 0.7 * k));
        back.halo(at(d - 30.0, h * 0.35), PVec2::new(80.0, h * 0.3), 0.003, la(lt.core, 0.55 * k));
        let stones: [(f32, f32, f32); 6] = [
            (d - 30.0, 46.0, 50.0),
            (d - 96.0, 34.0, 36.0),
            (d + 6.0, 128.0, 52.0),
            (d - 64.0, 108.0, 38.0),
            (d - 18.0, 210.0, 46.0),
            (d - 72.0, 178.0, 30.0),
        ];
        for (i, (dx, dy, r)) in stones.iter().enumerate() {
            let c = at(*dx, *dy);
            // Leak: light squeezing out round each stone.
            on_rock.halo(c, PVec2::splat(r * 1.5), 0.0, la(lt.glow, 0.28 * k));
            let rad = |ang: f32| r * (1.0 + 0.1 * (ang * 3.0 + i as f32 * 1.3).sin() + 0.05 * (ang * 5.0 + i as f32).cos());
            let pt = |ang: f32| c + PVec2::new(ang.cos() * rad(ang) * 1.08, ang.sin() * rad(ang) * 0.92);
            let ring: Vec<PVec2> = (0..16).map(|a| pt(a as f32 / 16.0 * std::f32::consts::TAU)).collect();
            on_rock.fan(&ring, c, 0.001, la(hex(0x040306), 1.0), la(mix(Color::BLACK, lt.glow, 0.1), 1.0));
            // A thin lit rim on the side facing the level.
            let towards = if f < 0.0 { 0.0 } else { std::f32::consts::PI };
            let lit: Vec<PVec2> = (0..=8).map(|j| pt(towards - 1.1 + 2.2 * j as f32 / 8.0)).collect();
            on_rock.stroke_taper(&lit, 2.0, 0.002, &[la(lighten(lt.glow, 0.3), 0.45 * k)], r * 0.6, Ends::Both);
        }
        // Pinpricks of light between the stones.
        for (dx, dy) in [(d - 70.0, 70.0), (d - 40.0, 160.0), (d - 100.0, 140.0), (d - 30.0, 250.0)] {
            on_rock.halo(at(dx, dy), PVec2::splat(14.0), 0.003, la(lt.core, 0.8 * k));
        }
    } else {
        // The bend: a tall bright window on the back wall, fading upward and
        // into the rock.
        let bx = d - 6.0;
        let core = at(bx + 40.0, h * 0.42);
        on_rock.halo(core, PVec2::new(170.0, h * 0.62), 0.0, la(lt.glow, 0.85 * k));
        on_rock.halo(core, PVec2::new(70.0, h * 0.42), 0.001, la(lt.core, 0.9 * k.min(1.0)));
        // Light rolling along the tunnel floor and roof towards you.
        on_rock.halo(at(d * 0.6, 0.0), PVec2::new(d * 0.6, 60.0), 0.002, la(lt.glow, 0.35 * k));
        on_rock.halo(at(d * 0.75, h), PVec2::new(d * 0.45, 46.0), 0.002, la(lt.glow, 0.22 * k));
    }
    // The lip and the floor outside catch the light.
    on_rock.halo(at(0.0, h * 0.5), PVec2::new(150.0, h * 0.75), 0.003, la(lt.glow, 0.18 * k));
    on_rock.halo(at(-90.0, 0.0), PVec2::new(260.0, 70.0), 0.003, la(lt.glow, 0.2 * k));

    // ── 3. In front: a faint haze across the opening and motes drifting
    // out of the tunnel (in), or up through the cracks (sealed).
    front.halo(at(d * 0.55, h * 0.5), PVec2::new(d * 0.7, h * 0.7), 0.0, la(lt.glow, 0.07 * k));
    if m.daylight {
        // God rays slanting out of the mouth.
        for i in 0..6 {
            let s = i as f32 / 5.0;
            let wv = 0.5 + 0.5 * (t * 0.7 + i as f32 * 1.9).sin();
            let a = at(d * 0.9, h * (0.2 + 0.6 * s));
            let b = at(-260.0 - 140.0 * s, -40.0 + h * (0.1 + 0.9 * s));
            let n = PVec2::new(0.0, 22.0 + 30.0 * s);
            let c0 = la(lt.core, 0.16 * wv);
            let c1 = la(lt.glow, 0.0);
            let i0 = front.vert(a - n * 0.4, 0.001, c0);
            let i1 = front.vert(a + n * 0.4, 0.001, c0);
            let i2 = front.vert(b + n, 0.001, c1);
            let i3 = front.vert(b - n, 0.001, c1);
            front.tri(i0, i1, i2);
            front.tri(i0, i2, i3);
        }
    }
    let n_motes = if sealed { 5 } else { 9 };
    for i in 0..n_motes {
        let seed = i as f32 * 12.9898 + p.x * 0.013;
        let speed = 0.08 + 0.05 * (seed.sin() * 0.5 + 0.5);
        let life = (t * speed + seed.fract()).fract();
        let (dx, dy) = if sealed {
            // Rise from the cracks.
            (d - 60.0 - 70.0 * (seed * 1.7).sin().abs() + 20.0 * (t + seed).sin(), 40.0 + life * (h + 120.0))
        } else {
            // Drift out of the tunnel towards the level.
            (d * (1.0 - life) - 120.0 * life, h * (0.25 + 0.5 * (seed * 3.1).sin().abs()) + 30.0 * (t * 0.9 + seed).sin())
        };
        let fade = (life * (1.0 - life) * 4.0).clamp(0.0, 1.0);
        let r = 3.0 + 2.5 * (seed * 2.3).sin().abs();
        let c = at(dx, dy);
        front.halo(c, PVec2::splat(r * 4.0), 0.002, la(lt.glow, 0.25 * fade * g));
        front.ellipse(c, PVec2::splat(r), 0.0, 0.003, la(lt.core, 0.8 * fade));
    }
}

/// The round goal light predates the cave mouths; levels with an exit cave
/// don't show it.
fn hide_goal_light(game: Res<Game>, mut q: Query<&mut Visibility, With<GoalVisual>>) {
    let has_exit = game.sim.level.mouths.iter().any(|m| m.kind == MouthKind::Exit);
    for mut v in q.iter_mut() {
        let want = if has_exit { Visibility::Hidden } else { Visibility::Inherited };
        if *v != want {
            *v = want;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_chapter_mouth_draws() {
        for level in bb_level::campaign::campaign() {
            for m in &level.mouths {
                let (mut a, mut b, mut c) = (MeshBuf::default(), MeshBuf::default(), MeshBuf::default());
                draw_mouth(m, 1.0, &mut a, &mut b, &mut c);
                assert!(!a.idx.is_empty() && !b.idx.is_empty() && !c.idx.is_empty(), "{} mouth draws nothing", level.id);
                assert!(a.pos.iter().chain(b.pos.iter()).all(|p| p.iter().all(|v| v.is_finite())));
            }
        }
    }
}
