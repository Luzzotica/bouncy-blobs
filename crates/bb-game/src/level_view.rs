//! Visuals for level geometry and items: terrain, movers, springs, spikes,
//! zones, checkpoints, pickups, the goal, decor, and the cave backdrop.

use bb_physics::{Vec2 as PVec2, geom};
use bevy::prelude::*;

use crate::palette::{self, darken, hex, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, ccw, empty_mesh, la, z};
use crate::sim::Game;

/// Everything spawned for the current level (despawned on unload).
#[derive(Component)]
pub struct LevelEntity;

#[derive(Component)]
pub struct MoverVisual(pub usize, pub Handle<Mesh>);

#[derive(Component)]
pub struct SpringVisual(pub usize, pub Handle<Mesh>);

/// A checkpoint lantern flower. `lit_at` is when it bloomed.
#[derive(Component)]
pub struct CheckpointVisual(pub usize, pub Handle<Mesh>, pub Option<f32>, pub bool);

#[derive(Component)]
pub struct PickupVisual(pub usize);

#[derive(Component)]
pub struct GoalVisual(pub Handle<Mesh>);

#[derive(Component)]
pub struct Sky;

/// Moves with the camera by this fraction (0 = world-fixed, 1 = screen-fixed).
#[derive(Component)]
pub struct Parallax(pub f32);

/// A drifting glow spore.
#[derive(Component)]
pub struct Mote {
    seed: f32,
}

pub struct LevelViewPlugin;

impl Plugin for LevelViewPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, spawn_level_view.run_if(resource_added::<Game>))
            .add_systems(
                PostUpdate,
                (update_movers, update_springs, update_checkpoints, update_pickups, update_goal, follow_sky, parallax, motes)
                    .run_if(resource_exists::<Game>),
            )
            .add_systems(PostUpdate, despawn_level_view.run_if(resource_removed::<Game>));
    }
}

fn poly_mesh(poly: &[PVec2], fill: Color, rim: Color, rim_w: f32, buf: &mut MeshBuf) {
    let tris = geom::triangulate(poly);
    let bb = bb_physics::Aabb::from_points(poly.iter().copied());
    let span = (bb.max.y - bb.min.y).max(1.0);
    let base = buf.pos.len() as u32;
    let ccw = geom::signed_area_slice(poly) > 0.0;
    for p in poly {
        let t = ((p.y - bb.min.y) / span).clamp(0.0, 1.0);
        buf.vert(*p, 0.0, lin(mix(darken(fill, 0.25), fill, t)));
    }
    for t in tris {
        buf.tri(base + t[0], base + t[1], base + t[2]);
    }
    let mut outline = poly.to_vec();
    if !ccw {
        outline.reverse();
    }
    buf.ring(&outline, rim_w, rim_w * 0.2, 0.001, lin(rim));
}

/// Fill / rim / rim width for a terrain material in the black cave.
fn cave_terrain(mat: bb_level::Material, one_way: bool, theme: &palette::ThemeColors) -> (Color, Color, f32) {
    let k = |c: u32, f: f32| mix(Color::BLACK, hex(c), f);
    match mat {
        _ if one_way => (mix(Color::BLACK, theme.jelly, 0.08), mix(Color::BLACK, theme.jelly, 0.45), 2.5),
        bb_level::Material::Ground => (Color::BLACK, theme.rock_rim, 2.5),
        bb_level::Material::Stone => (Color::BLACK, k(0x9aa0b0, 0.22), 2.5),
        bb_level::Material::Ice => (k(0x9ff0ff, 0.12), k(0x9ff0ff, 0.75), 3.0),
        bb_level::Material::Sticky => (k(0x9dff5a, 0.12), k(0x9dff5a, 0.65), 3.0),
        bb_level::Material::Bouncy => (k(0xff6fb5, 0.15), k(0xff6fb5, 0.8), 3.0),
    }
}

pub fn spawn_level_view(
    mut commands: Commands,
    game: Res<Game>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    shared: Res<Shared>,
) {
    let sim = &game.sim;
    let level = &sim.level;
    let theme = palette::theme(level.theme);

    // Sky gradient (a big quad that follows the camera).
    let mut sky = MeshBuf::default();
    let (a, b, c, d) = (PVec2::new(-1.0, -1.0), PVec2::new(1.0, -1.0), PVec2::new(1.0, 1.0), PVec2::new(-1.0, 1.0));
    let (top, bot) = (lin(theme.sky_top), lin(theme.sky_bottom));
    let i0 = sky.vert(a, 0.0, bot);
    let i1 = sky.vert(b, 0.0, bot);
    let i2 = sky.vert(c, 0.0, top);
    let i3 = sky.vert(d, 0.0, top);
    sky.tri(i0, i1, i2);
    sky.tri(i0, i2, i3);
    commands.spawn((
        Mesh2d(meshes.add(sky.into_mesh())),
        MeshMaterial2d(shared.vertex.clone()),
        Transform::from_xyz(0.0, 0.0, z::SKY).with_scale(Vec3::new(6000.0, 4000.0, 1.0)),
        Sky,
        LevelEntity,
    ));

    // Far cave silhouettes: soft bumps behind the play area.
    let (min, max) = level.bounds();
    let mut far = MeshBuf::default();
    let mut x = min.x - 1500.0;
    let mut k = 0;
    while x < max.x + 1500.0 {
        let w = 260.0 + ((k * 37) % 7) as f32 * 60.0;
        let h = 300.0 + ((k * 53) % 5) as f32 * 140.0;
        let base_y = min.y - 400.0 + ((k * 29) % 9) as f32 * 120.0;
        let pts: Vec<PVec2> = (0..=12)
            .map(|i| {
                let a = std::f32::consts::PI * i as f32 / 12.0;
                PVec2::new(x + w * 0.5 + a.cos() * w * 0.5, base_y + a.sin() * h)
            })
            .collect();
        far.fan(&pts, PVec2::new(x + w * 0.5, base_y), 0.0, lin(theme.far), lin(darken(theme.far, 0.15)));
        // Stalactites hanging from the top.
        let sx = x + w * 0.3;
        let sy = max.y + 500.0 - ((k * 41) % 6) as f32 * 60.0;
        let tip = PVec2::new(sx, sy - 120.0 - ((k * 13) % 4) as f32 * 50.0);
        let a2 = far.vert(PVec2::new(sx - 26.0, sy), 0.0, lin(theme.far));
        let b2 = far.vert(PVec2::new(sx + 26.0, sy), 0.0, lin(theme.far));
        let c2 = far.vert(tip, 0.0, lin(lighten(theme.far, 0.1)));
        far.tri(a2, b2, c2);
        x += w * 0.8;
        k += 1;
    }
    commands.spawn((
        Mesh2d(meshes.add(far.into_mesh())),
        MeshMaterial2d(shared.vertex.clone()),
        Transform::from_xyz(0.0, 0.0, z::FAR),
        Parallax(0.45),
        LevelEntity,
    ));

    // Very dim far glows (distant mushroom patches) for depth in the dark.
    if theme.dark {
        let mut bokeh = MeshBuf::default();
        let mut x = min.x - 1500.0;
        let mut k = 0u32;
        while x < max.x + 1500.0 {
            let h = |n: u32| ((k * 7919 + n * 104729) % 1000) as f32 / 1000.0;
            let y = min.y - 300.0 + h(1) * (max.y - min.y + 600.0).max(600.0);
            let col = if k % 3 == 0 { theme.crystal } else { theme.mush };
            bokeh.halo(PVec2::new(x, y), PVec2::splat(120.0 + h(2) * 220.0), 0.0, la(col, 0.035 + h(3) * 0.04));
            x += 380.0 + h(4) * 500.0;
            k += 1;
        }
        commands.spawn((
            Mesh2d(meshes.add(bokeh.into_mesh())),
            MeshMaterial2d(shared.blend.clone()),
            Transform::from_xyz(0.0, 0.0, z::FAR + 1.0),
            Parallax(0.3),
            LevelEntity,
        ));
    }

    // Terrain.
    let mut terrain = MeshBuf::default();
    for (t, (_, mat, one_way)) in level.terrain.iter().zip(&sim.terrain) {
        let poly = t.shape.outline();
        if theme.dark {
            let (fill, rim, w) = cave_terrain(*mat, *one_way, &theme);
            poly_mesh(&poly, fill, rim, w, &mut terrain);
            continue;
        }
        let fill = palette::material_tint(*mat, theme.rock);
        let rim = palette::material_tint(*mat, theme.rock_rim);
        if *one_way {
            poly_mesh(&poly, lighten(fill, 0.2), rim, 3.0, &mut terrain);
        } else {
            poly_mesh(&poly, fill, rim, 5.0, &mut terrain);
        }
    }
    commands.spawn((
        Mesh2d(meshes.add(terrain.into_mesh())),
        MeshMaterial2d(shared.vertex.clone()),
        Transform::from_xyz(0.0, 0.0, z::TERRAIN),
        LevelEntity,
    ));

    // Movers.
    for i in 0..sim.movers.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::TERRAIN + 0.5), MoverVisual(i, h), LevelEntity));
    }

    // Springs.
    for i in 0..sim.springs.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS), SpringVisual(i, h), LevelEntity));
    }

    // Spikes (static). In the dark: black teeth with hot red glowing tips.
    let mut spikes = MeshBuf::default();
    for s in &level.spikes {
        let len = (s.b - s.a).length();
        let n = (s.b - s.a).perp().normalize_or(PVec2::Y);
        let teeth = (len / 26.0).ceil().max(1.0) as usize;
        if theme.dark {
            let red = hex(0xff3b4e);
            spikes.edge_glow(s.b, s.a, 34.0, -0.002, la(red, 0.22));
            for k in 0..teeth {
                let p0 = s.a.lerp(s.b, k as f32 / teeth as f32);
                let p1 = s.a.lerp(s.b, (k + 1) as f32 / teeth as f32);
                let tip = (p0 + p1) * 0.5 + n * 26.0;
                let a = spikes.vert(p0, 0.0, lin(hex(0x0a0a0d)));
                let b = spikes.vert(p1, 0.0, lin(hex(0x0a0a0d)));
                let c = spikes.vert(tip, 0.0, lin(lighten(red, 0.2)));
                spikes.tri(a, b, c);
            }
            spikes.stroke(&[s.a, s.b], 6.0, 0.001, lin(hex(0x2a0c12)));
            continue;
        }
        for k in 0..teeth {
            let p0 = s.a.lerp(s.b, k as f32 / teeth as f32);
            let p1 = s.a.lerp(s.b, (k + 1) as f32 / teeth as f32);
            let tip = (p0 + p1) * 0.5 + n * 26.0;
            let a = spikes.vert(p0, 0.0, lin(palette::hex(0x9aa3b5)));
            let b = spikes.vert(p1, 0.0, lin(palette::hex(0x6c7385)));
            let c = spikes.vert(tip, 0.0, lin(palette::hex(0xeef2ff)));
            spikes.tri(a, b, c);
        }
        spikes.stroke(&[s.a, s.b], 8.0, 0.001, lin(palette::hex(0x4a4f5c)));
    }
    commands.spawn((Mesh2d(meshes.add(spikes.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS), LevelEntity));

    // Zones (translucent).
    let mut zones = MeshBuf::default();
    for zd in &level.zones {
        let poly = zd.shape.outline();
        let c = geom::centroid(&poly);
        let col = match &zd.kind {
            bb_level::ZoneKind::Water { .. } => Color::srgba(0.35, 0.7, 1.0, 0.38),
            bb_level::ZoneKind::Wind { .. } => Color::srgba(1.0, 1.0, 1.0, 0.07),
            bb_level::ZoneKind::Kill => Color::srgba(1.0, 0.3, 0.4, 0.25),
            bb_level::ZoneKind::Goo { .. } if theme.dark => Color::srgba(0.45, 0.85, 0.25, 0.05),
            bb_level::ZoneKind::Goo { .. } => Color::srgba(0.5, 0.9, 0.3, 0.35),
            bb_level::ZoneKind::Conveyor { .. } if theme.dark => Color::srgba(1.0, 0.85, 0.3, 0.0),
            bb_level::ZoneKind::Conveyor { .. } => Color::srgba(1.0, 0.85, 0.3, 0.15),
            bb_level::ZoneKind::Gravity { .. } => Color::srgba(0.7, 0.5, 1.0, 0.15),
        };
        // Linear-space blending makes even small alphas glow on black, so the
        // cave keeps volumes faint and marks them with lines instead.
        let col = match &zd.kind {
            _ if !theme.dark => col,
            bb_level::ZoneKind::Water { .. } => Color::srgba(0.2, 0.5, 1.0, 0.1),
            bb_level::ZoneKind::Wind { .. } => Color::srgba(1.0, 1.0, 1.0, 0.0),
            bb_level::ZoneKind::Kill => Color::srgba(1.0, 0.25, 0.35, 0.07),
            bb_level::ZoneKind::Gravity { .. } => Color::srgba(0.7, 0.5, 1.0, 0.04),
            _ => col,
        };
        zones.fan(&poly, c, 0.0, lin(col), lin(col));
        if theme.dark {
            if let bb_level::ZoneKind::Wind { accel } = zd.kind {
                // Faint streaks along the draft.
                let (lo, hi) = zd.shape.bounds();
                let d = accel.normalize_or(PVec2::Y);
                let mut k = 0u32;
                let mut x = lo.x + 40.0;
                while x < hi.x - 20.0 {
                    let mut y = lo.y + 60.0 + ((k * 53) % 7) as f32 * 30.0;
                    while y < hi.y - 60.0 {
                        let p = PVec2::new(x, y);
                        zones.stroke(&[p, p + d * 70.0], 2.0, 0.0, la(Color::WHITE, 0.07));
                        y += 260.0;
                    }
                    x += 90.0;
                    k += 1;
                }
            }
            if let bb_level::ZoneKind::Conveyor { speed } = zd.kind {
                // Faint chevrons along the belt instead of a filled box.
                let (lo, hi) = zd.shape.bounds();
                let dir = speed.signum();
                let mut x = lo.x + 30.0;
                while x < hi.x - 20.0 {
                    let y = lo.y + 22.0;
                    let pts = [PVec2::new(x - dir * 9.0, y + 10.0), PVec2::new(x + dir * 5.0, y), PVec2::new(x - dir * 9.0, y - 10.0)];
                    zones.stroke(&pts, 3.0, 0.0, la(hex(0xffc85a), 0.35));
                    x += 46.0;
                }
            }
            if let bb_level::ZoneKind::Goo { .. } = zd.kind {
                let (lo, hi) = zd.shape.bounds();
                zones.edge_glow(PVec2::new(hi.x, hi.y), PVec2::new(lo.x, hi.y), 14.0, 0.0, la(hex(0x9dff5a), 0.2));
                zones.stroke(&[PVec2::new(lo.x, hi.y), PVec2::new(hi.x, hi.y)], 3.0, 0.001, la(hex(0xb8ff7a), 0.7));
            }
        }
        if theme.dark && matches!(zd.kind, bb_level::ZoneKind::Water { .. }) {
            // A glowing waterline so the surface reads against the black.
            let o = ccw(poly.clone());
            let n = o.len();
            for k in 0..n {
                let (a, b) = (o[k], o[(k + 1) % n]);
                let d = b - a;
                if PVec2::new(d.y, -d.x).normalize_or_zero().y > 0.7 {
                    zones.edge_glow(a, b, 22.0, 0.0, la(hex(0x7fd0ff), 0.25));
                    zones.stroke(&[a, b], 3.0, 0.001, la(hex(0xbfeaff), 0.8));
                }
            }
        }
    }
    commands.spawn((Mesh2d(meshes.add(zones.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FX + 0.5), LevelEntity));

    // Checkpoints: lantern flowers.
    for i in 0..level.checkpoints.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS - 0.2), CheckpointVisual(i, h, None, false), LevelEntity));
    }

    // Pickups: glow drops.
    let mut drop = MeshBuf::default();
    drop.halo(PVec2::ZERO, PVec2::splat(if theme.dark { 3.6 } else { 2.2 }), -0.002, la(theme.glow, if theme.dark { 0.25 } else { 0.18 }));
    drop.ellipse(PVec2::ZERO, PVec2::ONE, 0.0, 0.0, lin(theme.glow));
    drop.ellipse(PVec2::new(0.05, -0.05), PVec2::splat(0.62), 0.0, 0.001, lin(lighten(theme.glow, 0.45)));
    drop.ellipse(PVec2::new(-0.32, 0.36), PVec2::new(0.26, 0.2), 0.5, 0.002, la(Color::WHITE, 0.9));
    let drop_mesh = meshes.add(drop.into_mesh());
    for (i, p) in level.pickups.iter().enumerate() {
        commands.spawn((
            Mesh2d(drop_mesh.clone()),
            MeshMaterial2d(shared.blend.clone()),
            Transform::from_xyz(p.x, p.y, z::ITEMS + 0.1).with_scale(Vec3::splat(9.0)),
            PickupVisual(i),
            LevelEntity,
        ));
    }

    // Goal: a glowing arch.
    if level.goal.is_some() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS - 0.5), GoalVisual(h), LevelEntity));
    }

    // Decor. Mushrooms get their own entities so they can react; the rest
    // is baked, with glows behind (in the air) and a faint spill on the
    // stone in front.
    let caps: Vec<(PVec2, PVec2)> = level
        .jelly
        .iter()
        .filter(|j| j.material == bb_level::Material::Bouncy)
        .map(|j| j.shape.bounds())
        .collect();
    let on_cap = |p: PVec2| caps.iter().any(|(a, b)| p.x >= a.x - 12.0 && p.x <= b.x + 12.0 && p.y >= a.y - 12.0 && p.y <= b.y + 12.0);
    let mut back = MeshBuf::default();
    let mut front = MeshBuf::default();
    let mut glow_back = MeshBuf::default();
    let mut glow_front = MeshBuf::default();
    let mut spill = MeshBuf::default();
    for d in &level.decor {
        if crate::cave::is_reactive(&d.kind) || (d.kind == "mushroom_spots" && on_cap(d.pos)) {
            continue;
        }
        let (buf, glow) = if d.depth < 0.0 { (&mut back, &mut glow_back) } else { (&mut front, &mut glow_front) };
        decor(buf, &d.kind, d.pos, d.scale, &theme);
        if theme.dark {
            decor_glow(glow, &mut spill, &d.kind, d.pos, d.scale, &theme);
        }
    }
    crate::cave::spawn_reactive(&mut commands, &mut meshes, &mut mats, &shared, level, &theme);
    for (buf, zz) in [(glow_back, z::DECOR_BACK - 0.5), (spill, z::SPILL), (back, z::DECOR_BACK), (glow_front, z::DECOR_FRONT - 0.05), (front, z::DECOR_FRONT)] {
        commands.spawn((Mesh2d(meshes.add(buf.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, zz), LevelEntity));
    }
}

/// Halos for luminous decor: `glow` sits right behind the decor, `spill` is
/// a faint wash over the stone around it.
fn decor_glow(glow: &mut MeshBuf, spill: &mut MeshBuf, kind: &str, p: PVec2, s: f32, theme: &palette::ThemeColors) {
    let mut both = |c: PVec2, r: f32, col: Color, a: f32| {
        glow.halo(c, PVec2::splat(r), 0.0, la(col, a));
        spill.halo(c, PVec2::splat(r * 1.3), 0.0, la(col, a * 0.22));
    };
    match kind {
        "crystal" => both(p + PVec2::new(0.0, 45.0 * s), 140.0 * s, theme.crystal, 0.18),
        "glowworm" => both(p + PVec2::new(18.0 * s, -2.0 * s), 60.0 * s, theme.crystal, 0.2),
        "drip" => both(p - PVec2::new(0.0, 66.0 * s), 40.0 * s, theme.jelly, 0.25),
        "lantern" | "sun" => both(p, 240.0 * s, lighten(theme.glow, 0.3), 0.25),
        "mushroom_spots" => both(p + PVec2::new(0.0, 15.0 * s), 70.0 * s, theme.mush, 0.2),
        _ => {}
    }
}

/// Procedural decor shapes.
pub fn decor(buf: &mut MeshBuf, kind: &str, p: PVec2, s: f32, theme: &palette::ThemeColors) {
    let accent = theme.accent;
    let dark = theme.dark;
    match kind {
        "mushroom_spots" => {
            let col = if dark { lighten(theme.mush, 0.6) } else { Color::WHITE };
            for (dx, dy, r) in [(-30.0, 12.0, 8.0), (10.0, 22.0, 10.0), (36.0, 8.0, 6.0)] {
                buf.ellipse(p + PVec2::new(dx, dy) * s, PVec2::splat(r * s), 0.0, 0.0, lin(col));
            }
        }
        "mushroom" => {
            crate::cave::draw_mushroom(buf, s, 0.0, 0.0, 0.0, dark, theme.mush);
        }
        "crystal" if dark => {
            let c = theme.crystal;
            for (dx, h, a) in [(-12.0, 70.0, 0.25f32), (0.0, 100.0, 0.0), (14.0, 60.0, -0.3)] {
                let base = p + PVec2::new(dx * s, 0.0);
                let dir = PVec2::from_angle(std::f32::consts::FRAC_PI_2 + a);
                let side = dir.perp() * 10.0 * s;
                let tip = base + dir * h * s;
                let mid = base + dir * h * s * 0.72;
                // Two facets: a lit face and a shaded one, glowing at the tip.
                let i0 = buf.vert(base - side, 0.0, lin(mix(Color::BLACK, c, 0.35)));
                let i1 = buf.vert(base, 0.0, lin(mix(Color::BLACK, c, 0.6)));
                let i2 = buf.vert(mid - side * 0.9, 0.0, lin(mix(Color::BLACK, c, 0.7)));
                let i3 = buf.vert(tip, 0.0, lin(lighten(c, 0.75)));
                let i4 = buf.vert(base + side, 0.0, lin(c));
                let i5 = buf.vert(mid + side * 0.9, 0.0, lin(lighten(c, 0.35)));
                buf.tri(i0, i1, i2);
                buf.tri(i1, i3, i2);
                buf.tri(i1, i4, i5);
                buf.tri(i1, i5, i3);
                buf.stroke(&[base + side * 0.1, tip], 1.5 * s, 0.001, la(lighten(c, 0.8), 0.7));
            }
        }
        "crystal" => {
            for (dx, h, a) in [(-12.0, 70.0, 0.25f32), (0.0, 100.0, 0.0), (14.0, 60.0, -0.3)] {
                let base = p + PVec2::new(dx * s, 0.0);
                let dir = PVec2::from_angle(std::f32::consts::FRAC_PI_2 + a);
                let side = dir.perp() * 10.0 * s;
                let tip = base + dir * h * s;
                let i0 = buf.vert(base - side, 0.0, lin(darken(theme.glow, 0.3)));
                let i1 = buf.vert(base + side, 0.0, lin(theme.glow));
                let i2 = buf.vert(tip, 0.0, lin(lighten(theme.glow, 0.5)));
                buf.tri(i0, i1, i2);
            }
        }
        "glowworm" => {
            let c = if dark { theme.crystal } else { theme.glow };
            if dark {
                // Silk thread up to the ceiling.
                buf.stroke(&[p + PVec2::new(18.0 * s, 0.0), p + PVec2::new(18.0 * s, 70.0 * s)], 1.2, -0.001, la(lighten(c, 0.3), 0.25));
            }
            for k in 0..5 {
                let q = p + PVec2::new(k as f32 * 9.0, -(k as f32 * 0.8).sin() * 6.0) * s;
                let r = if k == 0 { 6.0 } else { 5.0 - k as f32 * 0.4 };
                buf.ellipse(q, PVec2::splat(r * s), 0.0, 0.0, lin(lighten(c, 0.3)));
                if dark {
                    buf.ellipse(q, PVec2::splat(r * 0.5 * s), 0.0, 0.001, lin(lighten(c, 0.8)));
                }
            }
        }
        "drip" => {
            let j = if dark { mix(Color::BLACK, theme.jelly, 0.55) } else { theme.jelly };
            buf.stroke(&[p, p - PVec2::new(0.0, 60.0 * s)], 6.0 * s, 0.0, lin(j));
            buf.ellipse(p - PVec2::new(0.0, 66.0 * s), PVec2::new(8.0, 11.0) * s, 0.0, 0.001, lin(lighten(theme.jelly, 0.2)));
        }
        "lantern" | "sun" => {
            buf.ellipse(p, PVec2::splat(60.0 * s), 0.0, 0.0, lin(lighten(theme.glow, 0.2)));
            buf.ellipse(p, PVec2::splat(40.0 * s), 0.0, 0.001, lin(lighten(theme.glow, 0.6)));
        }
        "sock" => {
            let col = lin(palette::hex(0xeeeeee));
            buf.stroke(&[p, p + PVec2::new(0.0, 50.0) * s, p + PVec2::new(30.0, 50.0) * s], 22.0 * s, 0.0, col);
        }
        "crayon" => {
            buf.stroke(&[p, p + PVec2::new(90.0, 20.0) * s], 14.0 * s, 0.0, lin(palette::hex(0xff6b6b)));
        }
        "block_letters" => {
            for (k, c) in [0xff6b6b, 0xffd93d, 0x6bcb77, 0x4d96ff].iter().enumerate() {
                let q = p + PVec2::new(k as f32 * 46.0 * s, 0.0);
                let pts = [q, q + PVec2::new(40.0, 0.0) * s, q + PVec2::new(40.0, 40.0) * s, q + PVec2::new(0.0, 40.0) * s];
                buf.fan(&pts, q + PVec2::splat(20.0 * s), 0.0, lin(lighten(palette::hex(*c), 0.2)), lin(palette::hex(*c)));
            }
        }
        _ => {
            // Generic pebble.
            let c = if dark { mix(Color::BLACK, theme.jelly, 0.12) } else { lighten(theme.rock, 0.1) };
            buf.ellipse(p, PVec2::new(24.0, 14.0) * s, 0.0, 0.0, lin(c));
        }
    }
    let _ = accent;
}

fn update_movers(game: Res<Game>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&MoverVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    for MoverVisual(i, h) in q.iter() {
        let Some(m) = game.sim.movers.get(*i) else { continue };
        let Some(s) = game.sim.world.static_collider(m.id) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let mut buf = MeshBuf::default();
        if theme.dark {
            if m.def.material == bb_level::Material::Ice {
                // Falling jelly drip: a luminous drop.
                let o = ccw(s.poly.clone());
                let c = geom::centroid(&o);
                let r = (geom::signed_area_slice(&o).abs() / std::f32::consts::PI).sqrt();
                buf.halo(c, PVec2::splat(r * 2.4), -0.002, la(theme.jelly, 0.3));
                buf.fan(&o, c + PVec2::new(-0.2, 0.3) * r, 0.0, lin(lighten(theme.jelly, 0.3)), lin(mix(Color::BLACK, theme.jelly, 0.6)));
                buf.ring(&o, 2.5, 1.0, 0.001, lin(lighten(theme.jelly, 0.5)));
                buf.ellipse(c + PVec2::new(-0.35, 0.35) * r, PVec2::new(0.22, 0.14) * r, 0.6, 0.002, la(Color::WHITE, 0.8));
            } else {
                // Moving stone: black, with a slightly stronger edge than the
                // walls so it reads as "this one moves".
                let edge = mix(Color::BLACK, lighten(theme.jelly, 0.3), 0.32);
                poly_mesh(&s.poly, Color::BLACK, edge, 3.0, &mut buf);
            }
        } else {
            let fill = palette::material_tint(m.def.material, theme.rock);
            poly_mesh(&s.poly, lighten(fill, 0.08), darken(fill, 0.45), 6.0, &mut buf);
        }
        buf.write(&mut mesh);
    }
}

fn update_springs(game: Res<Game>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&SpringVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    for SpringVisual(i, h) in q.iter() {
        let Some(s) = game.sim.springs.get(*i) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let dir = PVec2::from_angle(s.def.angle);
        let side = dir.perp() * s.def.width * 0.5;
        let lift = 18.0 + (1.0 - s.squash) * 6.0 - s.squash * 8.0;
        let mut buf = MeshBuf::default();
        let base = s.def.pos;
        let (pad_a, pad_b) = (palette::hex(0xff9fbf), palette::hex(0xff5d8f));
        if theme.dark {
            buf.halo(base + dir * (lift + 6.0), PVec2::new(s.def.width * 0.9, s.def.width * 0.6), -0.002, la(pad_b, 0.25 + s.squash * 0.3));
        }
        // Coil.
        let coil: Vec<PVec2> = (0..=8)
            .map(|k| base + dir * (k as f32 / 8.0 * lift) + side * 0.5 * if k % 2 == 0 { -0.6 } else { 0.6 })
            .collect();
        buf.stroke(&coil, 5.0, 0.0, lin(palette::hex(if theme.dark { 0xb8c0d0 } else { 0x8a8f9c })));
        let top = [base - side + dir * lift, base + side + dir * lift, base + side + dir * (lift + 12.0), base - side + dir * (lift + 12.0)];
        buf.fan(&top, base + dir * (lift + 6.0), 0.001, lin(lighten(pad_a, 0.2 * s.squash)), lin(pad_b));
        if theme.dark {
            buf.stroke(&[top[3], top[2]], 2.5, 0.002, lin(lighten(pad_a, 0.5)));
        }
        buf.write(&mut mesh);
    }
}

fn ease_out_back(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    1.0 + c3 * (x - 1.0).powi(3) + c1 * (x - 1.0).powi(2)
}

/// A four-point sparkle.
fn sparkle(buf: &mut MeshBuf, p: PVec2, r: f32, col: [f32; 4]) {
    buf.ellipse(p, PVec2::new(r, r * 0.18), 0.0, 0.0, col);
    buf.ellipse(p, PVec2::new(r * 0.18, r), 0.0, 0.0, col);
}

/// The checkpoint: a tall lantern flower on a slender stalk, cool
/// cyan-white. Unlit it droops, closed and sleepy; reached, it straightens
/// and blooms with a pulsing halo and sparkles. `bloom` 0..~1.1.
pub fn draw_lantern_flower(buf: &mut MeshBuf, ground: PVec2, bloom: f32, t: f32, seed: f32, theme: &palette::ThemeColors) {
    let c = theme.lantern;
    let dark = theme.dark;
    let b = bloom.max(0.0);
    let bc = b.min(1.0);
    let h = 118.0;
    let sway = (t * 0.9 + seed).sin() * (3.0 + 3.0 * (1.0 - bc));
    // Drooping tip when asleep; upright when lit.
    let tip = ground + PVec2::new(mix_f(30.0, 0.0, bc) + sway, mix_f(h - 26.0, h, bc));
    let ctrl = ground + PVec2::new(sway * 0.3, h * 0.75);
    let stem: Vec<PVec2> = (0..=12)
        .map(|i| {
            let u = i as f32 / 12.0;
            ground * (1.0 - u) * (1.0 - u) + ctrl * 2.0 * u * (1.0 - u) + tip * u * u
        })
        .collect();
    let dir = (tip - stem[10]).normalize_or(PVec2::Y);
    let stalk = if dark { mix(mix(Color::BLACK, c, 0.3), c, 0.35 * bc) } else { mix(palette::hex(0x5c8a8f), c, 0.3 * bc) };
    // Halo.
    let pulse = 1.0 + (t * 2.6 + seed).sin() * 0.08;
    let head = tip + dir * 16.0;
    let sleepy = 0.5 + 0.5 * (t * 0.8 + seed).sin();
    let halo_a = if dark { 0.04 + 0.03 * sleepy + 0.24 * bc } else { 0.03 + 0.2 * bc };
    buf.halo(head, PVec2::splat((60.0 + 110.0 * bc) * pulse), -0.004, la(c, halo_a));
    if bc > 0.0 {
        buf.halo(ground + PVec2::new(0.0, 10.0), PVec2::new(150.0, 60.0) * pulse, -0.0035, la(c, 0.18 * bc));
    }
    // Stem and leaves.
    buf.stroke(&stem, 6.0, -0.002, lin(stalk));
    for side in [-1.0f32, 1.0] {
        let l0 = stem[2];
        let tipl = l0 + PVec2::new(side * 26.0, 14.0 + 4.0 * bc);
        buf.ellipse((l0 + tipl) * 0.5, PVec2::new(15.0, 5.0), side * 0.55, -0.0015, lin(stalk));
    }
    // Petals: a closed bell when asleep, open five-petal lantern when lit.
    let ang = dir.y.atan2(dir.x);
    let spread = mix_f(0.14, 0.62, b);
    let len = mix_f(26.0, 34.0, bc);
    let petal_col = if dark { mix(mix(Color::BLACK, c, 0.42), lighten(c, 0.25), bc) } else { mix(palette::hex(0x7fb7c2), lighten(c, 0.2), bc) };
    for k in 0..5 {
        let a = ang + (k as f32 - 2.0) * spread;
        let d = PVec2::from_angle(a);
        let centre = tip + d * len * 0.5;
        buf.ellipse(centre, PVec2::new(len * 0.55, mix_f(9.0, 8.0, bc)), a, 0.0 + k as f32 * 0.0001, lin(if k % 2 == 0 { petal_col } else { darken(petal_col, 0.12) }));
    }
    // Glowing core.
    let core = if dark { mix(mix(Color::BLACK, c, 0.55), Color::WHITE, 0.85 * bc) } else { mix(c, Color::WHITE, 0.7 * bc) };
    buf.ellipse(tip + dir * 12.0, PVec2::splat(mix_f(7.0, 11.0, bc) * if bc > 0.0 { pulse } else { 1.0 }), 0.0, 0.002, lin(core));
    if bc <= 0.0 {
        // Sleepy: a slow dim breathing glow inside the bud.
        buf.ellipse(tip + dir * 12.0, PVec2::splat(3.5), 0.0, 0.003, la(lighten(c, 0.5), 0.35 + 0.4 * sleepy));
        return;
    }
    // Sparkles drifting up around the bloom.
    for k in 0..7 {
        let ph = ((t * 0.35 + k as f32 / 7.0 + seed * 0.1) % 1.0 + 1.0) % 1.0;
        let a = k as f32 * 2.4 + t * 0.6;
        let p = head + PVec2::new(a.cos() * (34.0 + 18.0 * ph), -10.0 + ph * 90.0);
        let fade = (ph * 4.0).min(1.0) * (1.0 - ph) * bc;
        sparkle(buf, p, 7.0 + 3.0 * (t * 5.0 + k as f32).sin(), la(lighten(c, 0.7), fade));
    }
}

fn mix_f(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn update_checkpoints(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, mut q: Query<&mut CheckpointVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    let t = time.elapsed_secs();
    for mut cv in q.iter_mut() {
        let i = cv.0;
        let Some(cp) = game.sim.level.checkpoints.get(i) else { continue };
        let lit = game.sim.checkpoint > i;
        if lit && cv.2.is_none() {
            // Already lit when the level loaded (continue / BB_CHECKPOINT):
            // show it open without replaying the bloom.
            cv.2 = Some(if cv.3 { t } else { t - 10.0 });
        }
        if !lit {
            cv.2 = None;
        }
        cv.3 = true;
        let bloom = cv.2.map_or(0.0, |at| ease_out_back((t - at) / 0.9));
        let Some(mut mesh) = meshes.get_mut(&cv.1) else { continue };
        let mut buf = MeshBuf::default();
        draw_lantern_flower(&mut buf, cp.pos - PVec2::new(0.0, 40.0), bloom, t, i as f32 * 1.7, &theme);
        buf.write(&mut mesh);
    }
}

fn update_pickups(game: Res<Game>, time: Res<Time>, mut q: Query<(&PickupVisual, &mut Transform, &mut Visibility)>) {
    let t = time.elapsed_secs();
    for (PickupVisual(i), mut tf, mut vis) in q.iter_mut() {
        if game.sim.collected.get(*i).copied().unwrap_or(true) {
            *vis = Visibility::Hidden;
            continue;
        }
        let p = game.sim.level.pickups[*i];
        tf.translation.y = p.y + (t * 3.0 + *i as f32 * 0.7).sin() * 5.0;
        let s = 9.0 + (t * 6.0 + *i as f32).sin() * 1.5;
        tf.scale = Vec3::new(s, s * 1.2, 1.0);
    }
}

fn update_goal(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&GoalVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    let t = time.elapsed_secs();
    for GoalVisual(h) in q.iter() {
        let Some(goal) = &game.sim.level.goal else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let (min, max) = goal.bounds();
        let c = (min + max) * 0.5;
        let mut buf = MeshBuf::default();
        let pulse = 1.0 + (t * 2.0).sin() * 0.05;
        let warm = Color::srgba(1.0, 0.95, 0.72, 1.0);
        if theme.dark {
            buf.halo(c, (max - min) * 1.6 * pulse, -0.003, la(warm, 0.35));
            // Soft rays.
            for k in 0..10 {
                let a = t * 0.15 + k as f32 * std::f32::consts::TAU / 10.0;
                let d = PVec2::from_angle(a);
                let len = (max - min).length() * (0.9 + 0.2 * (t * 1.3 + k as f32).sin());
                let i0 = buf.vert(c, -0.0025, la(warm, 0.22));
                let i1 = buf.vert(c + d * len + d.perp() * 26.0, -0.0025, la(warm, 0.0));
                let i2 = buf.vert(c + d * len - d.perp() * 26.0, -0.0025, la(warm, 0.0));
                buf.tri(i0, i1, i2);
            }
        }
        buf.ellipse(c, (max - min) * 0.6 * pulse, 0.0, 0.0, lin(warm));
        buf.ellipse(c, (max - min) * 0.42 * pulse, 0.0, 0.001, lin(lighten(theme.glow, 0.7)));
        for k in 0..8 {
            let a = t * 0.6 + k as f32 * std::f32::consts::TAU / 8.0;
            let q = c + PVec2::new(a.cos(), a.sin()) * (max - min).length() * 0.42;
            buf.ellipse(q, PVec2::splat(6.0), 0.0, 0.002, lin(theme.accent));
        }
        buf.write(&mut mesh);
    }
}

fn follow_sky(cam: Query<&Transform, (With<Camera2d>, Without<Sky>)>, mut sky: Query<&mut Transform, With<Sky>>) {
    let Ok(c) = cam.single() else { return };
    for mut s in sky.iter_mut() {
        s.translation.x = c.translation.x;
        s.translation.y = c.translation.y;
    }
}

fn parallax(cam: Query<&Transform, (With<Camera2d>, Without<Parallax>)>, mut q: Query<(&Parallax, &mut Transform)>) {
    let Ok(c) = cam.single() else { return };
    for (p, mut tf) in q.iter_mut() {
        tf.translation.x = c.translation.x * p.0;
        tf.translation.y = c.translation.y * p.0;
    }
}

/// Glow spores drifting through the cave, wrapping around the view.
fn motes(
    mut commands: Commands,
    time: Res<Time>,
    game: Res<Game>,
    shared: Res<Shared>,
    mut mats: ResMut<Assets<ColorMaterial>>,
    cam: Query<&Transform, (With<Camera2d>, Without<Mote>)>,
    mut q: Query<(&Mote, &mut Transform)>,
) {
    let Ok(c) = cam.single() else { return };
    let centre = c.translation.truncate();
    if q.is_empty() {
        let theme = palette::theme(game.sim.level.theme);
        let mut glow = theme.glow;
        glow.set_alpha(0.55);
        let mat = mats.add(ColorMaterial { color: glow, alpha_mode: bevy::sprite_render::AlphaMode2d::Blend, ..default() });
        for i in 0..40 {
            let seed = i as f32 * 12.9898;
            let p = centre + Vec2::new((seed.sin() * 43758.5).fract() * 1800.0 - 900.0, (seed.cos() * 23421.6).fract() * 1100.0 - 550.0);
            commands.spawn((
                Mesh2d(shared.circle.clone()),
                MeshMaterial2d(mat.clone()),
                Transform::from_xyz(p.x, p.y, z::DECOR_BACK + 1.0).with_scale(Vec3::splat(2.0 + (seed * 3.1).sin().abs() * 3.0)),
                Mote { seed },
                LevelEntity,
            ));
        }
        return;
    }
    let t = time.elapsed_secs();
    let dt = time.delta_secs();
    for (m, mut tf) in q.iter_mut() {
        tf.translation.x += ((t * 0.3 + m.seed).sin() * 14.0 + 6.0) * dt;
        tf.translation.y += ((t * 0.21 + m.seed * 1.7).cos() * 10.0 + 9.0) * dt;
        // Wrap around the view so there are always some on screen.
        let d = tf.translation.truncate() - centre;
        if d.x > 1000.0 { tf.translation.x -= 2000.0; }
        if d.x < -1000.0 { tf.translation.x += 2000.0; }
        if d.y > 650.0 { tf.translation.y -= 1300.0; }
        if d.y < -650.0 { tf.translation.y += 1300.0; }
    }
}

fn despawn_level_view(mut commands: Commands, q: Query<Entity, With<LevelEntity>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
