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

/// A checkpoint lantern flower: index, mesh, when it bloomed, whether it
/// has been drawn yet, and how tall its light shaft may rise before it
/// meets rock.
#[derive(Component)]
pub struct CheckpointVisual(pub usize, pub Handle<Mesh>, pub Option<f32>, pub bool, pub f32);

/// No decor (mushrooms, crystals, hangers…) within this many px of a
/// checkpoint horizontally, so the lantern flower always stands alone.
pub const CHECKPOINT_CLEAR: f32 = 380.0;

/// True if `p` is inside a checkpoint's clear zone.
pub fn near_checkpoint(level: &bb_level::Level, p: PVec2) -> bool {
    level.checkpoints.iter().any(|c| (p.x - c.pos.x).abs() < CHECKPOINT_CLEAR && (p.y - c.pos.y).abs() < 320.0)
}

/// How far up from `p` the air stays open (capped at `max`).
pub fn open_above(level: &bb_level::Level, p: PVec2, max: f32) -> f32 {
    let solids: Vec<Vec<PVec2>> = level
        .terrain
        .iter()
        .filter(|t| !t.one_way)
        .map(|t| t.shape.outline())
        .filter(|o| {
            let bb = bb_physics::Aabb::from_points(o.iter().copied());
            bb.max.y > p.y && bb.min.x < p.x + 1.0 && bb.max.x > p.x - 1.0
        })
        .collect();
    let mut h = 40.0;
    while h < max {
        let q = p + PVec2::new(0.0, h);
        if solids.iter().any(|o| geom::point_in_polygon(q, o)) {
            return h;
        }
        h += 20.0;
    }
    max
}

// ------------------------------------------------------ decor placement

/// Solid outlines that decor can stand on (or must keep out of).
pub struct Ground {
    /// CCW outline, bounds, and whether things can stand on it.
    polys: Vec<(Vec<PVec2>, bb_physics::Aabb, bool)>,
}

impl Ground {
    pub fn new(level: &bb_level::Level) -> Ground {
        let mut polys = Vec::new();
        for t in &level.terrain {
            let o = ccw(t.shape.outline());
            let bb = bb_physics::Aabb::from_points(o.iter().copied());
            polys.push((o, bb, true));
        }
        for j in &level.jelly {
            let o = ccw(j.shape.outline());
            let bb = bb_physics::Aabb::from_points(o.iter().copied());
            // Bouncy mushroom caps wobble: nothing grows on them, but
            // nothing may poke into them either.
            polys.push((o, bb, j.material != bb_level::Material::Bouncy));
        }
        Ground { polys }
    }

    pub fn solid(&self, p: PVec2) -> bool {
        self.polys.iter().any(|(o, b, _)| b.contains(p) && geom::point_in_polygon(p, o))
    }

    /// The walkable surface nearest `p` along the vertical through it,
    /// searching `up` px above and `down` px below: the surface point and
    /// its outward normal. Only up-facing edges with open air just above.
    pub fn snap(&self, p: PVec2, up: f32, down: f32) -> Option<(PVec2, PVec2)> {
        let mut best: Option<(f32, PVec2, PVec2)> = None;
        for (o, bb, stand) in &self.polys {
            if !*stand || p.x < bb.min.x || p.x > bb.max.x || bb.max.y < p.y - down || bb.min.y > p.y + up {
                continue;
            }
            let n = o.len();
            for k in 0..n {
                let (a, b) = (o[k], o[(k + 1) % n]);
                if (a.x - p.x) * (b.x - p.x) > 0.0 || (a.x - b.x).abs() < 1e-3 {
                    continue;
                }
                let nrm = PVec2::new(b.y - a.y, a.x - b.x).normalize_or_zero();
                if nrm.y < 0.35 {
                    continue;
                }
                let y = a.y + (b.y - a.y) * (p.x - a.x) / (b.x - a.x);
                if y < p.y - down || y > p.y + up {
                    continue;
                }
                let q = PVec2::new(p.x, y);
                if self.solid(q + PVec2::new(0.0, 6.0)) {
                    continue;
                }
                let cost = if y <= p.y { p.y - y } else { (y - p.y) * 1.6 };
                if best.is_none_or(|bst| cost < bst.0) {
                    best = Some((cost, q, nrm));
                }
            }
        }
        best.map(|(_, q, n)| (q, n))
    }
}

/// Kinds that stand on the ground (snapped to a surface when drawn).
pub fn stands(kind: &str) -> bool {
    !matches!(kind, "glowworm" | "drip" | "lantern" | "sun" | "mushroom_spots")
}

/// Where a standing decor item really goes: on the nearest surface under
/// (or just over) its authored spot, leaning with the slope, its base a
/// few px into the ground so it is rooted, and only where its whole
/// footprint has ground under it and open air above. None = skip it
/// (better no decor than decor in mid-air or inside rock).
pub fn place_decor(ground: &Ground, kind: &str, pos: PVec2, s: f32) -> Option<(PVec2, f32)> {
    if !stands(kind) {
        return Some((pos, 0.0));
    }
    let (half_w, tall) = match kind {
        "crystal" => (22.0 * s, 90.0 * s),
        "mushroom" => (32.0 * s, 70.0 * s),
        "crayon" => (48.0 * s, 16.0 * s),
        "sock" => (30.0 * s, 90.0 * s),
        "block_letters" => (20.0 * s, 40.0 * s),
        _ => (24.0 * s, 14.0 * s),
    };
    let (q, n) = ground.snap(pos, 260.0, 520.0)?;
    if n.y < 0.6 {
        return None;
    }
    // Footprint: the ground under both ends must be close to the base.
    let tan = PVec2::new(n.y, -n.x);
    for side in [-1.0f32, 1.0] {
        let e = q + tan * half_w * side * 0.85;
        let (qe, _) = ground.snap(e + n * 10.0, 30.0, 30.0)?;
        if (qe - e).dot(n).abs() > 12.0 + half_w * 0.12 {
            return None;
        }
    }
    // Open air above (nothing poking through a roof or a cap).
    for f in [0.5f32, 1.0] {
        if ground.solid(q + n * tall * f) {
            return None;
        }
    }
    let ang = (n.x.atan2(n.y) * -1.0).clamp(-0.6, 0.6);
    Some((q - n * 3.0, ang))
}

/// Half the footprint of a standing decor item.
fn decor_half_width(kind: &str, s: f32) -> f32 {
    match kind {
        "crystal" => 24.0 * s,
        "crayon" => 50.0 * s,
        "sock" => 32.0 * s,
        _ => 26.0 * s,
    }
}

/// Append `src` to `dst`, rotated by `ang` and moved to `at`.
pub fn append_placed(dst: &mut MeshBuf, src: MeshBuf, at: PVec2, ang: f32) {
    let r = PVec2::from_angle(ang);
    let base = dst.pos.len() as u32;
    for p in src.pos {
        let q = at + r.rotate(PVec2::new(p[0], p[1]));
        dst.pos.push([q.x, q.y, p[2]]);
    }
    dst.col.extend(src.col);
    dst.idx.extend(src.idx.into_iter().map(|i| i + base));
}

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
        app.init_resource::<Water>()
            .add_systems(PostUpdate, spawn_level_view.run_if(resource_added::<Game>))
            .add_systems(
                PostUpdate,
                (update_movers, update_springs, update_checkpoints, update_goal, follow_sky, parallax, motes, update_water, update_wind)
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

/// Craggy-rock colours for a terrain material in the black cave.
pub fn rock_look(mat: bb_level::Material, theme: &palette::ThemeColors) -> crate::crag::RockLook {
    let (fill, rim, rim_w) = cave_terrain(mat, false, theme);
    let tinted = !matches!(mat, bb_level::Material::Ground | bb_level::Material::Stone);
    crate::crag::RockLook {
        fill,
        rim,
        rim_w,
        lit: if tinted { rim } else { mix(Color::BLACK, lighten(theme.jelly, 0.25), 0.42) },
        crack: mix(Color::BLACK, theme.jelly, 0.16),
        fleck: theme.crystal,
        rough: match mat {
            bb_level::Material::Ground => 1.0,
            bb_level::Material::Stone => 0.75,
            _ => 0.45,
        },
        detail: !tinted,
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

    // Far cave silhouettes. The black cave gets layered craggy rock and
    // pulsing bioluminescence; daylight themes keep soft bumps.
    let (min, max) = level.bounds();
    if theme.dark {
        crate::backdrop::spawn(&mut commands, &mut meshes, &shared, &theme, &level.id);
    }
    let mut far = MeshBuf::default();
    let mut x = min.x - 1500.0;
    let mut k = 0;
    while x < max.x + 1500.0 && !theme.dark {
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
    for (i, (t, (_, mat, one_way))) in level.terrain.iter().zip(&sim.terrain).enumerate() {
        let poly = t.shape.outline();
        if theme.dark {
            let (fill, rim, w) = cave_terrain(*mat, *one_way, &theme);
            if *one_way {
                poly_mesh(&poly, fill, rim, w, &mut terrain);
            } else {
                crate::crag::rock_mesh(&poly, &rock_look(*mat, &theme), 0x5eed + i as u32 * 7919, &mut terrain);
            }
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
        MeshMaterial2d(shared.blend.clone()),
        Transform::from_xyz(0.0, 0.0, z::TERRAIN),
        LevelEntity,
    ));

    // Movers.
    for i in 0..sim.movers.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::TERRAIN + 0.5 + (i % 200) as f32 * 0.001), MoverVisual(i, h), LevelEntity));
    }

    // Springs.
    for i in 0..sim.springs.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS + 0.05 + (i % 100) as f32 * 0.001), SpringVisual(i, h), LevelEntity));
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
        // Water and wind are animated (see `update_water`, `update_wind`).
        if matches!(zd.kind, bb_level::ZoneKind::Water { .. } | bb_level::ZoneKind::Wind { .. }) {
            continue;
        }
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
    if level.zones.iter().any(|zd| matches!(zd.kind, bb_level::ZoneKind::Water { .. })) {
        let h = meshes.add(empty_mesh());
        // Above the blobs (so whatever swims is tinted by the water) and
        // below the particles.
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FX - 0.4), WaterVisual(h), LevelEntity));
    }
    if level.zones.iter().any(|zd| matches!(zd.kind, bb_level::ZoneKind::Wind { .. })) {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::JELLY + 0.3), WindVisual(h), LevelEntity));
    }

    // Checkpoints: lantern flowers.
    for (i, cp) in level.checkpoints.iter().enumerate() {
        let h = meshes.add(empty_mesh());
        let shaft = open_above(level, cp.pos, 1400.0);
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS - 0.2 + (i % 100) as f32 * 0.001), CheckpointVisual(i, h, None, false, shaft), LevelEntity));
    }

    // Pickups are amoebas now: real softbodies drawn by render.rs.

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
    let ground = Ground::new(level);
    let mut taken: Vec<(f32, f32, f32)> = Vec::new();
    // Toy blocks first, so loose props make room for them.
    let mut order: Vec<usize> = (0..level.decor.len()).collect();
    order.sort_by_key(|i| level.decor[*i].kind != "block_letters");
    for i in order {
        let d = &level.decor[i];
        if crate::cave::is_reactive(&d.kind) || crate::alive::is_hanger(&d.kind) || (d.kind == "mushroom_spots" && on_cap(d.pos)) {
            continue;
        }
        // The big round lights ("sun", "lantern") read as floating discs
        // in the cave; the exit glow is the goal's job now.
        if theme.dark && matches!(d.kind.as_str(), "sun" | "lantern") {
            continue;
        }
        if d.kind != "mushroom_spots" && near_checkpoint(level, d.pos) {
            continue;
        }
        let (buf, glow) = if d.depth < 0.0 { (&mut back, &mut glow_back) } else { (&mut front, &mut glow_front) };
        if d.kind == "block_letters" {
            // A row of toy blocks, each sitting on the floor under it.
            for k in 0..4 {
                let p = d.pos + PVec2::new((k as f32 * 46.0 + 20.0) * d.scale, 0.0);
                let Some((at, ang)) = place_decor(&ground, "block_letters", p, d.scale) else { continue };
                taken.push((at.x - 23.0 * d.scale, at.x + 23.0 * d.scale, at.y));
                let mut tmp = MeshBuf::default();
                toy_block(&mut tmp, d.scale, i * 4 + k, theme.dark);
                append_placed(buf, tmp, at, ang);
            }
            continue;
        }
        // Standing props never pile into each other: slide along until
        // the spot is free.
        let half = decor_half_width(&d.kind, d.scale);
        let mut p = d.pos;
        let mut spot = None;
        for _ in 0..4 {
            let Some((at, ang)) = place_decor(&ground, &d.kind, p, d.scale) else { break };
            match taken.iter().find(|(x0, x1, y)| at.x + half > *x0 && at.x - half < *x1 && (at.y - y).abs() < 60.0) {
                Some((_, x1, _)) if stands(&d.kind) => p.x = x1 + half + 10.0,
                _ => {
                    spot = Some((at, ang));
                    break;
                }
            }
        }
        let Some((at, ang)) = spot else { continue };
        if stands(&d.kind) {
            taken.push((at.x - half, at.x + half, at.y));
        }
        let mut tmp = MeshBuf::default();
        decor_seeded(&mut tmp, &d.kind, PVec2::ZERO, d.scale, &theme, i);
        append_placed(buf, tmp, at, ang);
        if theme.dark {
            decor_glow(glow, &mut spill, &d.kind, at, d.scale, &theme);
        }
    }
    crate::cave::spawn_reactive(&mut commands, &mut meshes, &mut mats, &shared, level, &theme);
    for (buf, zz) in [(glow_back, z::DECOR_BACK - 0.5), (spill, z::SPILL - 0.05), (back, z::DECOR_BACK), (glow_front, z::DECOR_FRONT - 0.05), (front, z::DECOR_FRONT)] {
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
    decor_seeded(buf, kind, p, s, theme, 0);
}

/// [`decor`] with a per-item seed (toy colours and letters vary).
pub fn decor_seeded(buf: &mut MeshBuf, kind: &str, p: PVec2, s: f32, theme: &palette::ThemeColors, seed: usize) {
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
            let mut tmp = MeshBuf::default();
            toy_sock(&mut tmp, s, seed, dark);
            append_placed(buf, tmp, p, 0.0);
        }
        "crayon" => {
            let mut tmp = MeshBuf::default();
            toy_crayon(&mut tmp, s, seed, dark);
            append_placed(buf, tmp, p, 0.0);
        }
        "block_letters" => {
            for k in 0..4 {
                let mut tmp = MeshBuf::default();
                toy_block(&mut tmp, s, seed * 4 + k, dark);
                append_placed(buf, tmp, p + PVec2::new((k as f32 * 46.0 + 20.0) * s, 0.0), 0.0);
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

// ------------------------------------------------------------- toys

/// A few toy-box colours, kept a touch dim in the dark cave so they sit in
/// its light instead of glaring (physical things keep a resting colour).
fn toy_color(k: usize, dark: bool) -> Color {
    const C: [u32; 6] = [0xff5d5d, 0xffc93d, 0x4cc46a, 0x3d8bff, 0xb16cff, 0xff8a3d];
    let c = hex(C[k % C.len()]);
    if dark { mix(c, Color::BLACK, 0.22) } else { c }
}

/// A rounded rectangle outline (CCW), `r` corner radius.
fn rounded_rect(lo: PVec2, hi: PVec2, r: f32) -> Vec<PVec2> {
    let r = r.min((hi.x - lo.x) * 0.5).min((hi.y - lo.y) * 0.5);
    let corners = [(PVec2::new(hi.x - r, lo.y + r), -0.5f32), (PVec2::new(hi.x - r, hi.y - r), 0.0), (PVec2::new(lo.x + r, hi.y - r), 0.5), (PVec2::new(lo.x + r, lo.y + r), 1.0)];
    let mut pts = Vec::new();
    for (c, a0) in corners {
        for i in 0..=4 {
            let a = (a0 + i as f32 / 8.0) * std::f32::consts::PI;
            pts.push(c + PVec2::from_angle(a) * r);
        }
    }
    pts
}

/// Letter strokes in a unit box (y up).
fn letter(k: usize) -> Vec<Vec<PVec2>> {
    let v = |x: f32, y: f32| PVec2::new(x, y);
    match k % 6 {
        0 => vec![vec![v(0.15, 0.0), v(0.5, 1.0), v(0.85, 0.0)], vec![v(0.3, 0.4), v(0.7, 0.4)]],
        1 => vec![vec![v(0.22, 0.0), v(0.22, 1.0), v(0.58, 1.0), v(0.74, 0.9), v(0.74, 0.62), v(0.58, 0.52), v(0.22, 0.52)], vec![v(0.58, 0.52), v(0.8, 0.4), v(0.8, 0.12), v(0.62, 0.0), v(0.22, 0.0)]],
        2 => vec![(0..=12).map(|i| { let a = 0.8 + i as f32 / 12.0 * 4.7; v(0.52 + 0.4 * a.cos(), 0.5 + 0.5 * a.sin()) }).collect()],
        3 => vec![vec![v(0.22, 0.0), v(0.22, 1.0), v(0.5, 1.0), v(0.8, 0.78), v(0.8, 0.22), v(0.5, 0.0), v(0.22, 0.0)]],
        4 => vec![vec![v(0.35, 0.78), v(0.55, 1.0), v(0.55, 0.0)], vec![v(0.33, 0.0), v(0.77, 0.0)]],
        _ => vec![vec![v(0.2, 0.75), v(0.38, 0.98), v(0.68, 0.98), v(0.8, 0.75), v(0.2, 0.0), v(0.82, 0.0)]],
    }
}

/// A wooden-and-paint alphabet block standing on the origin: rounded
/// corners, a darker bevel, a raised face panel, a big embossed letter and
/// a highlight along the top edge.
pub fn toy_block(buf: &mut MeshBuf, s: f32, seed: usize, dark: bool) {
    let h = crate::crag::hash1(seed as i32, 0x70b) ;
    let size = (38.0 + 6.0 * h) * s;
    let col = toy_color(seed, dark);
    let lo = PVec2::new(-size * 0.5, 0.0);
    let hi = PVec2::new(size * 0.5, size);
    // Contact shadow.
    buf.ellipse(PVec2::new(0.0, 1.0), PVec2::new(size * 0.6, 3.5 * s), 0.0, -0.001, la(Color::BLACK, 0.45));
    let outer = rounded_rect(lo, hi, 6.0 * s);
    buf.fan(&outer, PVec2::new(0.0, size * 0.5), 0.0, lin(darken(col, 0.25)), lin(darken(col, 0.4)));
    let inset = 5.0 * s;
    let face = rounded_rect(lo + PVec2::splat(inset), hi - PVec2::splat(inset), 4.0 * s);
    buf.fan(&face, PVec2::new(-size * 0.1, size * 0.62), 0.0002, lin(lighten(col, 0.18)), lin(col));
    // Bevel light on top / left edges, shade bottom / right.
    buf.stroke(&[PVec2::new(lo.x + 6.0 * s, hi.y - 1.6 * s), PVec2::new(hi.x - 6.0 * s, hi.y - 1.6 * s)], 2.2 * s, 0.0004, la(lighten(col, 0.55), 0.85));
    buf.stroke(&[PVec2::new(lo.x + 1.6 * s, lo.y + 6.0 * s), PVec2::new(lo.x + 1.6 * s, hi.y - 6.0 * s)], 1.6 * s, 0.0004, la(lighten(col, 0.4), 0.6));
    // The letter: embossed (shadow offset, then the cream letter).
    let cream = if dark { hex(0xd9cfb8) } else { hex(0xfff6e0) };
    let box_lo = lo + PVec2::splat(size * 0.26);
    let span = size * 0.48;
    let lw = (3.6 * s).max(1.5);
    for stroke in letter(seed) {
        let pts: Vec<PVec2> = stroke.iter().map(|q| box_lo + *q * span).collect();
        let sh: Vec<PVec2> = pts.iter().map(|q| *q + PVec2::new(1.2, -1.2) * s).collect();
        buf.stroke(&sh, lw, 0.0006, la(darken(col, 0.5), 0.9));
        buf.stroke(&pts, lw, 0.0008, lin(cream));
        for q in [pts[0], *pts.last().unwrap()] {
            buf.ellipse(q, PVec2::splat(lw * 0.5), 0.0, 0.0008, lin(cream));
        }
    }
    // Gloss.
    buf.ellipse(PVec2::new(-size * 0.22, size * 0.8), PVec2::new(size * 0.14, size * 0.05), 0.3, 0.001, la(Color::WHITE, if dark { 0.22 } else { 0.4 }));
}

/// A wax crayon lying on the ground (origin under its middle): a paper
/// wrapper with stripes and a zig-zag label, a sharpened cone tip and a
/// rounded worn back end, with a highlight along the top.
pub fn toy_crayon(buf: &mut MeshBuf, s: f32, seed: usize, dark: bool) {
    let col = toy_color(seed * 3 + 1, dark);
    let len = 92.0 * s;
    let r = 8.0 * s;
    let x0 = -len * 0.5;
    let x1 = len * 0.5 - 16.0 * s;
    let y = r;
    buf.ellipse(PVec2::new(0.0, 1.0), PVec2::new(len * 0.52, 3.0 * s), 0.0, -0.001, la(Color::BLACK, 0.45));
    // Wax body (rounded back end).
    let body = rounded_rect(PVec2::new(x0, 0.0), PVec2::new(x1 + 2.0 * s, 2.0 * r), r * 0.7);
    buf.fan(&body, PVec2::new(0.0, y * 1.2), 0.0, lin(lighten(col, 0.12)), lin(darken(col, 0.25)));
    // Cone tip.
    let tip = [PVec2::new(x1, 0.6 * s), PVec2::new(x1 + 15.0 * s, y - 1.5 * s), PVec2::new(x1 + 16.5 * s, y), PVec2::new(x1 + 15.0 * s, y + 1.5 * s), PVec2::new(x1, 2.0 * r - 0.6 * s)];
    buf.fan(&tip, PVec2::new(x1 + 5.0 * s, y), 0.0002, lin(lighten(col, 0.1)), lin(darken(col, 0.15)));
    // Paper wrapper.
    let wl = x0 + 14.0 * s;
    let wr = x1 - 10.0 * s;
    let paper = mix(col, if dark { hex(0x2a2430) } else { hex(0x3a3040) }, 0.55);
    let wrap = [PVec2::new(wl, -0.4 * s), PVec2::new(wr, -0.4 * s), PVec2::new(wr, 2.0 * r + 0.4 * s), PVec2::new(wl, 2.0 * r + 0.4 * s)];
    buf.fan(&wrap, PVec2::new((wl + wr) * 0.5, y), 0.0004, lin(paper), lin(darken(paper, 0.2)));
    for xx in [wl + 3.0 * s, wr - 3.0 * s] {
        buf.stroke(&[PVec2::new(xx, 0.0), PVec2::new(xx, 2.0 * r)], 1.6 * s, 0.0006, lin(lighten(col, 0.25)));
    }
    let zig: Vec<PVec2> = (0..=10).map(|i| PVec2::new(wl + 7.0 * s + (wr - wl - 14.0 * s) * i as f32 / 10.0, y + if i % 2 == 0 { 3.0 } else { -3.0 } * s)).collect();
    buf.stroke(&zig, 1.4 * s, 0.0006, lin(lighten(col, 0.35)));
    // Highlight.
    buf.stroke(&[PVec2::new(x0 + 4.0 * s, 2.0 * r - 3.0 * s), PVec2::new(x1 + 8.0 * s, y + 3.0 * s)], 1.8 * s, 0.0008, la(Color::WHITE, if dark { 0.25 } else { 0.45 }));
}

/// A striped sock standing on its heel (Reg's cousins), a soft rounded
/// tube with a ribbed cuff, contrasting heel and toe.
pub fn toy_sock(buf: &mut MeshBuf, s: f32, seed: usize, dark: bool) {
    let s = s * 1.4;
    let base = if dark { hex(0xb8b4c4) } else { hex(0xf0eef4) };
    let stripe = toy_color(seed * 5 + 2, dark);
    let w = 22.0 * s;
    // Centre line: up the leg, round the heel, along the foot.
    let path: Vec<PVec2> = {
        let mut p: Vec<PVec2> = (0..=5).map(|i| PVec2::new(0.0, 60.0 * s - i as f32 * 7.2 * s)).collect();
        let (p0, c, p2) = (PVec2::new(0.0, 24.0 * s), PVec2::new(0.0, w * 0.5), PVec2::new(14.0 * s, w * 0.5));
        for i in 1..=6 {
            let t = i as f32 / 6.0;
            p.push(p0 * (1.0 - t) * (1.0 - t) + c * 2.0 * t * (1.0 - t) + p2 * t * t);
        }
        for i in 1..=3 {
            p.push(PVec2::new(14.0 * s + i as f32 * 6.0 * s, w * 0.5));
        }
        p
    };
    buf.ellipse(PVec2::new(w * 0.8, 1.0), PVec2::new(w * 1.4, 3.0 * s), 0.0, -0.001, la(Color::BLACK, 0.45));
    let n = path.len();
    let ws = vec![w; n];
    buf.taper(&path, &ws, 0.0, &vec![lin(base); n], false, true);
    // Heel and toe in the stripe colour.
    buf.taper(&path[5..10], &ws[5..10], 0.0002, &vec![lin(darken(stripe, 0.1)); 5], true, true);
    buf.taper(&path[n - 3..], &ws[n - 3..], 0.0002, &vec![lin(stripe); 3], false, true);
    for k in 0..3 {
        let yy = 50.0 * s - k as f32 * 10.0 * s;
        buf.stroke(&[PVec2::new(-w * 0.5, yy), PVec2::new(w * 0.5, yy)], 4.0 * s, 0.0004, lin(stripe));
    }
    // Ribbed cuff.
    let cuff = [PVec2::new(-w * 0.55, 60.0 * s), PVec2::new(w * 0.55, 60.0 * s), PVec2::new(w * 0.55, 68.0 * s), PVec2::new(-w * 0.55, 68.0 * s)];
    buf.fan(&cuff, PVec2::new(0.0, 64.0 * s), 0.0006, lin(lighten(base, 0.1)), lin(darken(base, 0.1)));
    for k in 0..5 {
        let xx = -w * 0.4 + k as f32 * w * 0.2;
        buf.stroke(&[PVec2::new(xx, 61.0 * s), PVec2::new(xx, 67.0 * s)], 1.0 * s, 0.0008, lin(darken(base, 0.25)));
    }
    buf.stroke(&[PVec2::new(-w * 0.3, 56.0 * s), PVec2::new(-w * 0.3, 22.0 * s)], 2.0 * s, 0.001, la(Color::WHITE, 0.25));
}

/// A mover's craggy mesh, built once against a reference pose and moved
/// rigidly with the collider afterwards.
struct MoverTemplate {
    r0: PVec2,
    r1: PVec2,
    buf: MeshBuf,
}

fn update_movers(
    game: Res<Game>,
    time: Res<Time>,
    mut meshes: ResMut<Assets<Mesh>>,
    q: Query<&MoverVisual>,
    mut templates: Local<std::collections::HashMap<usize, MoverTemplate>>,
    mut level_id: Local<String>,
) {
    let theme = palette::theme(game.sim.level.theme);
    if *level_id != game.sim.level.id || game.is_added() {
        templates.clear();
        *level_id = game.sim.level.id.clone();
    }
    for MoverVisual(i, h) in q.iter() {
        let Some(m) = game.sim.movers.get(*i) else { continue };
        let Some(s) = game.sim.world.static_collider(m.id) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let mut buf = MeshBuf::default();
        if let bb_level::MoverMotion::Spin { speed } = m.def.motion {
            // Spinning fans are red cutting blades.
            blade(&mut buf, &s.poly, speed, time.elapsed_secs(), theme.dark);
            buf.write(&mut mesh);
            continue;
        }
        if theme.dark && m.def.material != bb_level::Material::Ice && s.poly.len() >= 2 {
            // Moving stone: craggy like the walls, with a slightly stronger
            // edge so it reads as "this one moves".
            let tpl = templates.entry(*i).or_insert_with(|| {
                let mut look = rock_look(bb_level::Material::Stone, &theme);
                look.rim = mix(Color::BLACK, lighten(theme.jelly, 0.3), 0.32);
                look.rim_w = 3.0;
                look.lit = mix(Color::BLACK, lighten(theme.jelly, 0.3), 0.5);
                let mut b = MeshBuf::default();
                crate::crag::rock_mesh(&s.poly, &look, 0xa11e + *i as u32 * 104_729, &mut b);
                MoverTemplate { r0: s.poly[0], r1: s.poly[1], buf: b }
            });
            let (c0, c1) = (s.poly[0], s.poly[1]);
            let rot = PVec2::from_angle((c1 - c0).to_angle() - (tpl.r1 - tpl.r0).to_angle());
            buf.pos = tpl
                .buf
                .pos
                .iter()
                .map(|p| {
                    let q = c0 + rot.rotate(PVec2::new(p[0], p[1]) - tpl.r0);
                    [q.x, q.y, p[2]]
                })
                .collect();
            buf.col = tpl.buf.col.clone();
            buf.idx = tpl.buf.idx.clone();
            if crusher_spiked(&game.sim.movers, *i) {
                crusher_teeth(&mut buf, m, &s.poly);
            }
        } else if theme.dark {
            if m.def.material == bb_level::Material::Ice {
                // Falling jelly drip: a luminous drop.
                let o = ccw(s.poly.clone());
                let c = geom::centroid(&o);
                let r = (geom::signed_area_slice(&o).abs() / std::f32::consts::PI).sqrt();
                buf.halo(c, PVec2::splat(r * 2.4), -0.002, la(theme.jelly, 0.3));
                // Spikes: this drop hurts. A ring of hot-pink thorns, slowly
                // turning, behind the drop.
                let danger = palette::hex(0xff3d6e);
                let spin = time.elapsed_secs() * 0.6 + *i as f32;
                let n = 12;
                for k in 0..n {
                    let a = spin + k as f32 / n as f32 * std::f32::consts::TAU;
                    let d = PVec2::from_angle(a);
                    let w = PVec2::from_angle(a + std::f32::consts::FRAC_PI_2) * r * 0.2;
                    let base = c + d * r * 0.82;
                    let tip = c + d * r * 1.5;
                    let i0 = buf.vert(base - w, -0.001, lin(mix(danger, Color::BLACK, 0.35)));
                    let i1 = buf.vert(base + w, -0.001, lin(mix(danger, Color::BLACK, 0.35)));
                    let i2 = buf.vert(tip, -0.001, lin(lighten(danger, 0.25)));
                    buf.tri(i0, i1, i2);
                }
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

/// Which crushers carry teeth on their slamming face. The level data has no
/// `spiked` flag yet, so every other crusher (in level order) is toothed.
fn crusher_spiked(movers: &[bb_sim::MoverState], i: usize) -> bool {
    // Authored per mover (`Mover.spiked`; falling rocks, spiked crushers).
    movers.get(i).is_some_and(|m| m.def.spiked)
}

/// Black teeth with hot red tips along a crusher's slamming face.
fn crusher_teeth(buf: &mut MeshBuf, m: &bb_sim::MoverState, poly: &[PVec2]) {
    let slam = m.def.path.last().copied().unwrap_or(PVec2::new(0.0, -1.0)).normalize_or(PVec2::new(0.0, -1.0));
    let o = ccw(poly.to_vec());
    let n = o.len();
    let red = hex(0xff3b4e);
    for k in 0..n {
        let (a, b) = (o[k], o[(k + 1) % n]);
        let e = b - a;
        let nr = PVec2::new(e.y, -e.x).normalize_or_zero();
        if nr.dot(slam) < 0.8 {
            continue;
        }
        let len = e.length();
        let teeth = (len / 30.0).floor().max(1.0) as usize;
        buf.edge_glow(a, b, 30.0, 0.0005, la(red, 0.18));
        for t in 0..teeth {
            let p0 = a.lerp(b, (t as f32 + 0.08) / teeth as f32);
            let p1 = a.lerp(b, (t as f32 + 0.92) / teeth as f32);
            let tip = (p0 + p1) * 0.5 + nr * 24.0;
            let i0 = buf.vert(p0 - nr * 2.0, 0.001, lin(hex(0x0a0a0d)));
            let i1 = buf.vert(p1 - nr * 2.0, 0.001, lin(hex(0x0a0a0d)));
            let i2 = buf.vert(tip, 0.001, lin(lighten(red, 0.2)));
            buf.tri(i0, i1, i2);
        }
        buf.stroke(&[a, b], 5.0, 0.0012, lin(hex(0x2a0c12)));
    }
}

/// A spinning red cutting blade drawn over a spinner's rectangle: two
/// tapered serrated arms, a hub, a hot edge glow and a faint sweep blur.
fn blade(buf: &mut MeshBuf, poly: &[PVec2], speed: f32, t: f32, dark: bool) {
    if poly.len() < 3 {
        return;
    }
    let c = geom::centroid(poly);
    // Long axis of the rectangle.
    let e0 = poly[1] - poly[0];
    let e1 = poly[2] - poly[1];
    let (long, short) = if e0.length() > e1.length() { (e0, e1) } else { (e1, e0) };
    let dir = long.normalize_or(PVec2::X);
    let half_w = short.length() * 0.5;
    let reach = long.length() * 0.5;
    let side = PVec2::new(-dir.y, dir.x);
    let red = hex(0xff2d3f);
    let hot = hex(0xff8a7a);
    // Sweep blur: the disc the blade cuts, faint.
    let spin = speed.abs().min(6.0) / 6.0;
    buf.halo(c, PVec2::splat(reach * 1.25), -0.004, la(red, if dark { 0.12 } else { 0.08 } + 0.06 * spin));
    for k in 1..=3 {
        let back = -speed.signum() * k as f32 * 0.12;
        let rot = PVec2::from_angle(back);
        let d2 = rot.rotate(dir);
        for sgn in [-1.0f32, 1.0] {
            let pts: Vec<PVec2> = (0..=6).map(|i| { let a = back * i as f32 / 6.0; c + PVec2::from_angle(a).rotate(d2) * reach * 0.95 * sgn }).collect();
            buf.stroke(&[c, pts[6]], half_w * 1.2, -0.003, la(red, 0.08 * (1.0 - k as f32 / 4.0) * (0.4 + spin)));
        }
    }
    // Arms: tapered, curved like a scythe, serrated leading edge.
    for sgn in [-1.0f32, 1.0] {
        let ax = dir * sgn;
        let sd = side * sgn;
        let mut edge_a = Vec::new();
        let mut edge_b = Vec::new();
        const N: usize = 10;
        for i in 0..=N {
            let u = i as f32 / N as f32;
            let w = half_w * (1.3 - 1.15 * u.powf(1.4));
            let curve = sd * (u * u * half_w * 1.4);
            let p = c + ax * (reach * u) + curve;
            // Teeth on the leading edge.
            let tooth = if i > 1 && i < N && i % 2 == 0 { half_w * 0.55 } else { 0.0 };
            edge_a.push(p + sd * (w + tooth));
            edge_b.push(p - sd * w * 0.7);
        }
        let n = edge_a.len();
        let base = buf.pos.len() as u32;
        for i in 0..n {
            let u = i as f32 / (n - 1) as f32;
            buf.vert(edge_a[i], 0.0, lin(mix(darken(red, 0.25), hot, u * 0.6)));
            buf.vert(edge_b[i], 0.0, lin(darken(red, 0.55)));
        }
        for i in 0..(n - 1) as u32 {
            let (a, b, cc, d) = (base + i * 2, base + i * 2 + 1, base + i * 2 + 2, base + i * 2 + 3);
            buf.tri(a, b, d);
            buf.tri(a, d, cc);
        }
        // Hot glowing cutting edge.
        if dark {
            buf.stroke(&edge_a, 7.0, 0.0005, la(red, 0.25));
        }
        buf.stroke(&edge_a, 1.8, 0.001, la(lighten(hot, 0.3), 0.95));
        buf.stroke(&edge_b, 1.4, 0.001, la(darken(red, 0.7), 0.9));
    }
    // Hub with a bolt.
    buf.ellipse(c, PVec2::splat(half_w * 1.25), 0.0, 0.002, lin(hex(0x1a0c10)));
    buf.ellipse(c, PVec2::splat(half_w * 0.9), 0.0, 0.0025, lin(darken(red, 0.35)));
    let bolt = PVec2::from_angle(t * speed);
    buf.stroke(&[c - bolt * half_w * 0.5, c + bolt * half_w * 0.5], 2.5, 0.003, lin(hex(0x1a0c10)));
    buf.ellipse(c + PVec2::new(-0.3, 0.3) * half_w, PVec2::splat(half_w * 0.2), 0.0, 0.003, la(Color::WHITE, 0.5));
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

/// The checkpoint: a tall lantern flower on a slender stalk, in the
/// theme's lantern colour (never a fungus colour). Unlit it droops, closed
/// and sleepy — but it is the cave's beacon: a soft shaft of light rises
/// from it with motes drifting up, and a slow ping ripples out along the
/// ground. Reached, it straightens and blooms with a pulsing halo and
/// sparkles, and the shaft settles to a calm glow. `bloom` 0..~1.1;
/// `shaft` is how tall the light may rise before it meets rock.
pub fn draw_lantern_flower(buf: &mut MeshBuf, ground: PVec2, bloom: f32, t: f32, seed: f32, shaft: f32, theme: &palette::ThemeColors) {
    let c = theme.lantern;
    let dark = theme.dark;
    let b = bloom.max(0.0);
    let bc = b.min(1.0);
    // A head taller than the fungus around it.
    let s = 1.35;
    let h = 118.0 * s;
    let sway = (t * 0.9 + seed).sin() * (3.0 + 3.0 * (1.0 - bc));
    // Drooping tip when asleep; upright when lit.
    let tip = ground + PVec2::new(mix_f(30.0 * s, 0.0, bc) + sway, mix_f(h - 26.0 * s, h, bc));
    let ctrl = ground + PVec2::new(sway * 0.3, h * 0.75);
    let stem: Vec<PVec2> = (0..=12)
        .map(|i| {
            let u = i as f32 / 12.0;
            ground * (1.0 - u) * (1.0 - u) + ctrl * 2.0 * u * (1.0 - u) + tip * u * u
        })
        .collect();
    let dir = (tip - stem[10]).normalize_or(PVec2::Y);
    let stalk = if dark { mix(mix(Color::BLACK, c, 0.38), c, 0.35 * bc) } else { mix(palette::hex(0x5c8a8f), c, 0.3 * bc) };
    let pulse = 1.0 + (t * 2.6 + seed).sin() * 0.08;
    let head = tip + dir * 16.0 * s;
    let sleepy = 0.5 + 0.5 * (t * 1.4 + seed).sin();

    // Beacon shaft: soft-edged column of light rising from the flower,
    // brighter while it is waiting to be reached.
    let beam_a = if dark { mix_f(0.17 + 0.07 * sleepy, 0.06, bc) } else { mix_f(0.18 + 0.06 * sleepy, 0.07, bc) };
    let top_y = (shaft - 20.0).max(120.0);
    let rows = 14;
    let base = buf.pos.len() as u32;
    for r in 0..=rows {
        let u = r as f32 / rows as f32;
        let y = ground.y + 20.0 + u * top_y;
        let half = 34.0 + 70.0 * u;
        // Fade in just above the head, out toward the top.
        let a = beam_a * (u * 6.0).min(1.0) * (1.0 - u).powf(1.3);
        let x = ground.x + sway * 0.3 * (1.0 - u);
        buf.vert(PVec2::new(x - half, y), -0.005, la(c, 0.0));
        buf.vert(PVec2::new(x, y), -0.005, la(lighten(c, 0.3), a));
        buf.vert(PVec2::new(x + half, y), -0.005, la(c, 0.0));
    }
    for r in 0..rows as u32 {
        for k in 0..2u32 {
            let (p0, p1, q0, q1) = (base + r * 3 + k, base + r * 3 + k + 1, base + (r + 1) * 3 + k, base + (r + 1) * 3 + k + 1);
            buf.tri(p0, p1, q1);
            buf.tri(p0, q1, q0);
        }
    }
    // Motes drifting up the shaft.
    for k in 0..6 {
        let ph = ((t * 0.12 + k as f32 / 6.0 + seed * 0.13) % 1.0 + 1.0) % 1.0;
        let y = ground.y + 60.0 + ph * top_y * 0.85;
        let x = ground.x + (t * 0.8 + k as f32 * 2.1).sin() * (14.0 + 30.0 * ph);
        let fade = (ph * 5.0).min(1.0) * (1.0 - ph) * mix_f(1.0, 0.45, bc);
        buf.ellipse(PVec2::new(x, y), PVec2::splat(2.6), 0.0, -0.0045, la(lighten(c, 0.6), 0.8 * fade));
        buf.halo(PVec2::new(x, y), PVec2::splat(12.0), -0.0046, la(c, 0.25 * fade));
    }
    // Ground ping: a slow ring rippling out along the floor.
    let ping = ((t * 0.42 + seed * 0.1) % 1.0 + 1.0) % 1.0;
    let ring_r = 40.0 + 190.0 * ping;
    let ring_a = (1.0 - ping).powi(2) * mix_f(0.5, 0.18, bc);
    let ring: Vec<PVec2> = (0..=48)
        .map(|k| {
            let a = k as f32 / 48.0 * std::f32::consts::TAU;
            ground + PVec2::new(a.cos() * ring_r, 4.0 + a.sin() * ring_r * 0.16)
        })
        .collect();
    buf.stroke(&ring, 2.5, -0.0035, la(lighten(c, 0.3), ring_a));

    // Halos: a pool on the ground and a glow round the head.
    let halo_a = if dark { 0.1 + 0.06 * sleepy + 0.2 * bc } else { 0.06 + 0.18 * bc };
    buf.halo(head, PVec2::splat((90.0 + 100.0 * bc) * pulse), -0.004, la(c, halo_a));
    buf.halo(ground + PVec2::new(0.0, 10.0), PVec2::new(170.0, 60.0) * pulse, -0.0035, la(c, 0.1 + 0.12 * bc));
    // Stem and leaves.
    buf.stroke(&stem, 7.0 * s, -0.002, lin(stalk));
    for side in [-1.0f32, 1.0] {
        let l0 = stem[2];
        let tipl = l0 + PVec2::new(side * 26.0 * s, (14.0 + 4.0 * bc) * s);
        buf.ellipse((l0 + tipl) * 0.5, PVec2::new(15.0, 5.0) * s, side * 0.55, -0.0015, lin(stalk));
    }
    // Petals: a closed bell when asleep, an open five-petal lantern when lit.
    let ang = dir.y.atan2(dir.x);
    let spread = mix_f(0.14, 0.62, b);
    let len = mix_f(26.0, 34.0, bc) * s;
    let petal_col = if dark { mix(mix(Color::BLACK, c, 0.6), lighten(c, 0.25), bc) } else { mix(palette::hex(0x7fb7c2), lighten(c, 0.2), bc) };
    for k in 0..5 {
        let a = ang + (k as f32 - 2.0) * spread;
        let d = PVec2::from_angle(a);
        let centre = tip + d * len * 0.5;
        buf.ellipse(centre, PVec2::new(len * 0.55, mix_f(9.0, 8.0, bc) * s), a, k as f32 * 0.0001, lin(if k % 2 == 0 { petal_col } else { darken(petal_col, 0.12) }));
    }
    // Glowing core.
    let core = if dark { mix(lighten(c, 0.2), Color::WHITE, 0.4 + 0.45 * bc) } else { mix(c, Color::WHITE, 0.7 * bc) };
    buf.ellipse(tip + dir * 12.0 * s, PVec2::splat(mix_f(8.0, 11.0, bc) * s * pulse), 0.0, 0.002, lin(core));
    if bc <= 0.0 {
        // Waiting: a heartbeat glow shining through the bud.
        buf.halo(tip + dir * 12.0 * s, PVec2::splat(30.0), 0.003, la(lighten(c, 0.5), 0.35 + 0.4 * sleepy));
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
        draw_lantern_flower(&mut buf, cp.pos - PVec2::new(0.0, 40.0), bloom, t, i as f32 * 1.7, cv.4, &theme);
        buf.write(&mut mesh);
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

// ------------------------------------------------------------------ water

#[derive(Component)]
pub struct WaterVisual(pub Handle<Mesh>);

#[derive(Component)]
pub struct WindVisual(pub Handle<Mesh>);

/// Spacing of the simulated surface columns (px).
const WAVE_DX: f32 = 10.0;

/// One pool: its box and a 1-D spring-column surface.
struct Pool {
    lo: PVec2,
    hi: PVec2,
    h: Vec<f32>,
    v: Vec<f32>,
    /// Which sides are against rock (left, right, bottom): those edges
    /// need no feathering.
    walled: [bool; 3],
    /// Fill grid: column xs, row depths below the surface, and how open
    /// (not inside rock) each grid point is, so water never paints over
    /// the stone around it and fades softly where it meets it.
    gx: Vec<f32>,
    rows: Vec<f32>,
    air: Vec<f32>,
}

impl Pool {
    fn col(&self, x: f32) -> f32 {
        ((x - self.lo.x) / WAVE_DX).clamp(0.0, (self.h.len() - 1) as f32)
    }

    /// Kick the surface at `x` over `r` px by `dv` (px/s, negative = down).
    fn kick(&mut self, x: f32, r: f32, dv: f32) {
        let n = self.h.len();
        let c = self.col(x);
        let span = (r / WAVE_DX).max(1.0);
        let i0 = (c - span).floor().max(0.0) as usize;
        let i1 = ((c + span).ceil() as usize).min(n - 1);
        for i in i0..=i1 {
            let k = 1.0 - ((i as f32 - c) / span).abs().min(1.0);
            self.v[i] += dv * k;
        }
    }

    /// Surface height offset at `x` (sim + gentle ambient swell).
    fn surface(&self, x: f32, t: f32) -> f32 {
        let c = self.col(x);
        let i = c.floor() as usize;
        let j = (i + 1).min(self.h.len() - 1);
        let f = c - i as f32;
        let sim = self.h[i] * (1.0 - f) + self.h[j] * f;
        // Ambient swell, calmed near the walls.
        let edge = ((x - self.lo.x).min(self.hi.x - x) / 60.0).clamp(0.0, 1.0);
        sim + edge * (2.2 * (x * 0.021 + t * 1.5).sin() + 1.3 * (x * 0.057 - t * 2.2).sin())
    }
}

struct Drop {
    p: PVec2,
    v: PVec2,
    r: f32,
    life: f32,
}

struct Ripple {
    p: PVec2,
    t0: f32,
    size: f32,
    strength: f32,
}

struct Bubble {
    p: PVec2,
    r: f32,
    t0: f32,
    life: f32,
    seed: f32,
}

/// Living water: surfaces that wave and answer every blob, splash
/// droplets, ripples under the water and bubbles.
#[derive(Resource, Default)]
pub struct Water {
    level: String,
    pools: Vec<Pool>,
    drops: Vec<Drop>,
    ripples: Vec<Ripple>,
    bubbles: Vec<Bubble>,
    /// Each blob's centroid last frame and when it last left a ripple.
    seen: std::collections::HashMap<bb_physics::BodyId, (PVec2, f32)>,
    acc: f32,
    n: u32,
}

impl Water {
    fn rnd(&mut self) -> f32 {
        self.n = self.n.wrapping_add(1);
        crate::crag::hash1(self.n as i32, 0x3a7e)
    }

    fn splash(&mut self, at: PVec2, up: f32, spread: f32, count: usize, size: f32) {
        for _ in 0..count {
            let a = std::f32::consts::FRAC_PI_2 + (self.rnd() - 0.5) * spread;
            let sp = up * (0.45 + 0.75 * self.rnd());
            let x = (self.rnd() - 0.5) * size;
            let r = 2.0 + 3.0 * self.rnd();
            self.drops.push(Drop { p: at + PVec2::new(x, 2.0), v: PVec2::from_angle(a) * sp + PVec2::new(x * 2.0, 0.0), r, life: 1.6 });
        }
        if self.drops.len() > 300 {
            let extra = self.drops.len() - 300;
            self.drops.drain(0..extra);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn update_water(
    game: Res<Game>,
    time: Res<Time>,
    mut water: ResMut<Water>,
    mut meshes: ResMut<Assets<Mesh>>,
    q: Query<&WaterVisual>,
    cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>,
) {
    let Ok(WaterVisual(handle)) = q.single() else { return };
    let level = &game.sim.level;
    let t = time.elapsed_secs();
    let dt = time.delta_secs().min(0.05);
    if water.level != level.id || game.is_added() {
        let ground = Ground::new(level);
        let pools = level
            .zones
            .iter()
            .filter(|zd| matches!(zd.kind, bb_level::ZoneKind::Water { .. }))
            .map(|zd| {
                let (lo, hi) = zd.shape.bounds();
                let n = (((hi.x - lo.x) / WAVE_DX).ceil() as usize + 1).max(2);
                let walled_side = |x: f32| (1..6).filter(|k| ground.solid(PVec2::new(x, lo.y + (hi.y - lo.y) * *k as f32 / 6.0))).count() >= 4;
                let walled_bot = (1..6).filter(|k| ground.solid(PVec2::new(lo.x + (hi.x - lo.x) * *k as f32 / 6.0, lo.y - 6.0))).count() >= 4;
                let depth = (hi.y - lo.y).max(1.0);
                let ncol = ((hi.x - lo.x) / 14.0).ceil().max(1.0) as usize;
                let gx: Vec<f32> = (0..=ncol).map(|i| lo.x + (hi.x - lo.x) * i as f32 / ncol as f32).collect();
                let mut rows = vec![0.0f32, 5.0, 12.0];
                let mut d = 24.0;
                while d < depth - 6.0 {
                    rows.push(d);
                    d += 20.0;
                }
                rows.push(depth);
                let air: Vec<f32> = rows
                    .iter()
                    .flat_map(|d| gx.iter().map(move |x| (*x, *d)))
                    .map(|(x, d)| {
                        let y = hi.y - d;
                        let probes = [PVec2::new(x - 5.0, y - 5.0), PVec2::new(x + 5.0, y - 5.0), PVec2::new(x - 5.0, y + 5.0), PVec2::new(x + 5.0, y + 5.0), PVec2::new(x, y)];
                        probes.iter().filter(|p| !ground.solid(**p)).count() as f32 / probes.len() as f32
                    })
                    .collect();
                Pool { lo, hi, h: vec![0.0; n], v: vec![0.0; n], walled: [walled_side(lo.x - 6.0), walled_side(hi.x + 6.0), walled_bot], gx, rows, air }
            })
            .collect();
        *water = Water { level: level.id.clone(), pools, ..default() };
    }
    if water.pools.is_empty() {
        return;
    }
    let theme = palette::theme(level.theme);
    let sim = &game.sim;
    // ---- blobs meeting the water
    let blobs: Vec<(bb_physics::BodyId, PVec2, PVec2, f32)> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| (p.ctl.body, p.ctl.radius))
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (n.ctl.body, n.ctl.radius)))
        .filter_map(|(id, r)| sim.world.body(id).filter(|b| b.enabled).map(|b| (id, b.centroid(), b.velocity(), r)))
        .collect();
    for (id, p, v, r) in &blobs {
        let prev = water.seen.get(id).map(|s| s.0);
        let last_ripple = water.seen.get(id).map_or(0.0, |s| s.1);
        let mut ripple_at = last_ripple;
        for k in 0..water.pools.len() {
            let (lo, hi) = (water.pools[k].lo, water.pools[k].hi);
            if p.x < lo.x - r || p.x > hi.x + r || p.y < lo.y - r || p.y > hi.y + r * 2.0 {
                continue;
            }
            let surf = hi.y + water.pools[k].surface(p.x, t);
            let was_above = prev.is_some_and(|q| q.y > surf);
            let above = p.y > surf;
            if was_above && !above && v.y < -60.0 {
                // Landing in: a dent, a crown of droplets, rings below.
                let sp = (-v.y).min(1400.0);
                water.pools[k].kick(p.x, r * 1.6, -sp * 0.45);
                let n = ((sp / 70.0) as usize).clamp(3, 18);
                water.splash(PVec2::new(p.x, surf), sp * 0.55, 1.5, n, r * 1.6);
                water.ripples.push(Ripple { p: PVec2::new(p.x, surf - r * 0.5), t0: t, size: r * 2.6, strength: (sp / 700.0).min(1.0) });
            } else if !was_above && above && prev.is_some() && v.y > 80.0 {
                // Launching out: the surface pulls up after it and sheds.
                let sp = v.y.min(1400.0);
                water.pools[k].kick(p.x, r * 1.3, sp * 0.3);
                let n = ((sp / 90.0) as usize).clamp(3, 14);
                water.splash(PVec2::new(p.x, surf), sp * 0.5, 0.9, n, r * 1.2);
            }
            if (p.y - surf).abs() < r * 1.1 && v.x.abs() > 40.0 {
                // Swimming along the top: a bow wave.
                let dv = -v.x.abs().min(600.0) * 0.9 * dt * 4.0;
                water.pools[k].kick(p.x + v.x.signum() * r, *r, dv);
                if water.rnd() < (v.x.abs() / 900.0) * dt * 30.0 {
                    let at = PVec2::new(p.x + v.x.signum() * r, surf);
                    water.splash(at, 160.0 + v.x.abs() * 0.15, 0.8, 1, r * 0.5);
                }
            }
            if p.y < surf {
                // Underwater: rings and bubbles trail a moving blob.
                let speed = v.length();
                if speed > 70.0 && t - ripple_at > (0.5 - speed / 3000.0).max(0.2) {
                    ripple_at = t;
                    water.ripples.push(Ripple { p: *p, t0: t, size: r * 1.6, strength: (speed / 900.0).clamp(0.25, 0.8) });
                    let rr = 2.0 + 3.0 * water.rnd();
                    let off = PVec2::new((water.rnd() - 0.5) * r, (water.rnd() - 0.2) * r);
                    let seed = water.rnd() * 10.0;
                    water.bubbles.push(Bubble { p: *p + off, r: rr, t0: t, life: 3.0, seed });
                }
            }
        }
        water.seen.insert(*id, (*p, ripple_at));
    }
    // ---- surface springs (fixed substeps)
    water.acc += dt;
    while water.acc >= 1.0 / 120.0 {
        water.acc -= 1.0 / 120.0;
        let h = 1.0 / 120.0;
        for pool in water.pools.iter_mut() {
            let n = pool.h.len();
            let old = pool.h.clone();
            for i in 0..n {
                let l = old[i.saturating_sub(1)];
                let r = old[(i + 1).min(n - 1)];
                let a = 600.0 * (l + r - 2.0 * old[i]) - 18.0 * old[i] - 2.2 * pool.v[i];
                pool.v[i] += a * h;
            }
            for i in 0..n {
                pool.h[i] = (pool.h[i] + pool.v[i] * h).clamp(-40.0, 40.0);
            }
        }
    }
    // ---- droplets
    let mut lands: Vec<(usize, f32, f32)> = Vec::new();
    for d in water.drops.iter_mut() {
        d.v.y -= 1500.0 * dt;
        d.p += d.v * dt;
        d.life -= dt;
    }
    {
        let Water { drops, pools, .. } = &mut *water;
        drops.retain(|d| {
            if d.life <= 0.0 {
                return false;
            }
            if d.v.y < 0.0 {
                for (k, pool) in pools.iter().enumerate() {
                    if d.p.x > pool.lo.x && d.p.x < pool.hi.x && d.p.y < pool.hi.y + pool.surface(d.p.x, t) && d.p.y > pool.hi.y - 60.0 {
                        lands.push((k, d.p.x, d.v.y));
                        return false;
                    }
                }
            }
            true
        });
    }
    for (k, x, vy) in lands {
        water.pools[k].kick(x, 12.0, vy * 0.05);
    }
    water.ripples.retain(|r| t - r.t0 < 1.4);
    water.bubbles.retain(|b| t - b.t0 < b.life);
    // Bubbles rise and pop at the surface.
    let mut popped = Vec::new();
    {
        let Water { bubbles, pools, .. } = &mut *water;
        bubbles.retain_mut(|b| {
            b.p.y += (60.0 + 25.0 * b.r) * dt;
            b.p.x += (t * 3.0 + b.seed).sin() * 20.0 * dt;
            for (k, pool) in pools.iter().enumerate() {
                if b.p.x > pool.lo.x && b.p.x < pool.hi.x && b.p.y > pool.lo.y - 10.0 && b.p.y < pool.hi.y + 50.0 {
                    if b.p.y > pool.hi.y + pool.surface(b.p.x, t) - b.r {
                        popped.push((k, b.p.x));
                        return false;
                    }
                    return true;
                }
            }
            false
        });
    }
    for (k, x) in popped {
        water.pools[k].kick(x, 10.0, 25.0);
    }

    // ---- draw
    let (vlo, vhi) = match cam.single() {
        Ok((tf, Projection::Orthographic(o))) => {
            let c = PVec2::new(tf.translation.x, tf.translation.y);
            (c + PVec2::new(o.area.min.x, o.area.min.y) - PVec2::splat(100.0), c + PVec2::new(o.area.max.x, o.area.max.y) + PVec2::splat(100.0))
        }
        _ => return,
    };
    let dark = theme.dark;
    let shallow = if dark { mix(hex(0x2f7fd8), theme.jelly, 0.25) } else { hex(0x5fb0ff) };
    let deep = if dark { mix(hex(0x06142e), theme.jelly, 0.06) } else { hex(0x1d4f9a) };
    let line = if dark { lighten(mix(hex(0x7fd0ff), theme.jelly, 0.2), 0.2) } else { hex(0xe8f7ff) };
    let (a_top, a_bot) = if dark { (0.16, 0.5) } else { (0.3, 0.55) };
    let mut buf = MeshBuf::default();
    for pool in &water.pools {
        if pool.hi.x < vlo.x || pool.lo.x > vhi.x || pool.hi.y + 60.0 < vlo.y || pool.lo.y > vhi.y {
            continue;
        }
        let depth = (pool.hi.y - pool.lo.y).max(1.0);
        let ncol = pool.gx.len();
        let i0 = pool.gx.iter().position(|x| *x > vlo.x - 30.0).unwrap_or(0).saturating_sub(1);
        let i1 = pool.gx.iter().rposition(|x| *x < vhi.x + 30.0).map_or(ncol - 1, |i| (i + 1).min(ncol - 1));
        if i1 <= i0 {
            continue;
        }
        let xs: Vec<f32> = pool.gx[i0..=i1].to_vec();
        let air = |ri: usize, ci: usize| pool.air[ri * ncol + i0 + ci];
        let feather = 40.0;
        let fade = |x: f32, y: f32| -> f32 {
            let mut k = 1.0f32;
            if !pool.walled[0] {
                k = k.min((x - pool.lo.x) / feather);
            }
            if !pool.walled[1] {
                k = k.min((pool.hi.x - x) / feather);
            }
            if !pool.walled[2] {
                k = k.min((y - pool.lo.y) / (feather * 2.0));
            }
            k.clamp(0.0, 1.0)
        };
        let base = buf.pos.len() as u32;
        let surf: Vec<f32> = xs.iter().map(|x| pool.hi.y + pool.surface(*x, t)).collect();
        for (ri, d) in pool.rows.iter().enumerate() {
            for (ci, x) in xs.iter().enumerate() {
                // The top rows ride the waves; deeper rows ease into still water.
                let wave = surf[ci] - pool.hi.y;
                let y = pool.hi.y - d + wave * (-d / 30.0).exp();
                let y = if ri == 0 { surf[ci] } else { y.min(surf[ci] - 0.5) };
                // Shimmer: light wobbling through the water (refraction-ish).
                let sh = (x * 0.031 + t * 1.3 + (y * 0.023 - t * 0.9).sin() * 1.7).sin() * (y * 0.027 + t * 0.7).cos();
                let depth_f = (d / 260.0).min(1.0).powf(0.7);
                let col = mix(shallow, deep, depth_f);
                let a = (a_top + (a_bot - a_top) * depth_f) * (1.0 + 0.18 * sh * (1.0 - depth_f)) * fade(*x, y) * air(ri, ci);
                buf.vert(PVec2::new(*x, y), 0.0, la(col, a));
            }
        }
        let w = xs.len() as u32;
        for r in 0..(pool.rows.len() - 1) as u32 {
            for c in 0..w - 1 {
                let (a, b, cc, d) = (base + r * w + c, base + r * w + c + 1, base + (r + 1) * w + c, base + (r + 1) * w + c + 1);
                buf.tri(a, b, d);
                buf.tri(a, d, cc);
            }
        }
        let open_top: Vec<f32> = (0..xs.len()).map(|ci| air(0, ci).min(air(1, ci) + 0.2)).collect();
        // Caustics: soft bright bands drifting under the surface.
        for k in 0..3 {
            let yb = 14.0 + 26.0 * k as f32;
            if yb > depth * 0.7 {
                break;
            }
            let pts: Vec<PVec2> = xs.iter().enumerate().map(|(ci, x)| PVec2::new(*x, surf[ci] - yb - 6.0 * (x * 0.02 + t * (1.1 + 0.3 * k as f32) + k as f32).sin())).collect();
            let cs: Vec<[f32; 4]> = xs
                .iter()
                .zip(&pts)
                .map(|(x, p)| {
                    let s = ((x * 0.013 - t * 0.8 + k as f32 * 2.0).sin() * 0.5 + 0.5).powi(3);
                    la(line, (if dark { 0.13 } else { 0.22 }) * s * (1.0 - k as f32 * 0.3) * fade(*x, p.y) * open_top[((x - xs[0]) / 14.0).round().clamp(0.0, (xs.len() - 1) as f32) as usize])
                })
                .collect();
            buf.stroke_cols(&pts, 5.0 - k as f32, 0.0004, &cs);
        }
        // The surface: a soft glow above, a bright line, little glints.
        let top: Vec<PVec2> = xs.iter().zip(&surf).map(|(x, y)| PVec2::new(*x, *y)).collect();
        let edge_fade: Vec<f32> = xs.iter().zip(&open_top).map(|(x, o)| fade(*x, pool.hi.y) * o).collect();
        let up: Vec<PVec2> = vec![PVec2::new(0.0, -1.0); top.len()];
        let gl: Vec<[f32; 4]> = edge_fade.iter().map(|f| la(line, if dark { 0.12 } else { 0.18 } * f)).collect();
        let clear: Vec<[f32; 4]> = edge_fade.iter().map(|_| la(line, 0.0)).collect();
        buf.band(&top, &up, 0.0, 16.0, 0.0006, &gl, &clear);
        let lc: Vec<[f32; 4]> = top
            .iter()
            .zip(&edge_fade)
            .enumerate()
            .map(|(i, (p, f))| {
                // Brighter where the surface is moving (fresh ripples).
                let slope = if i > 0 { (p.y - top[i - 1].y).abs() / 14.0 } else { 0.0 };
                la(lighten(line, (slope * 2.0).min(0.6)), (0.65 + slope.min(0.35)) * f)
            })
            .collect();
        buf.stroke_cols(&top, 2.6, 0.0008, &lc);
        for (i, p) in top.iter().enumerate().skip(1).step_by(5) {
            let g = ((p.x * 0.05 + t * 2.0).sin() * 0.5 + 0.5).powi(6);
            if g > 0.05 {
                buf.ellipse(*p + PVec2::new(0.0, -2.0), PVec2::new(5.0, 1.2), 0.0, 0.001, la(Color::WHITE, 0.5 * g * edge_fade[i]));
            }
        }
    }
    // Rings under the water.
    for r in &water.ripples {
        if r.p.x < vlo.x || r.p.x > vhi.x || r.p.y < vlo.y || r.p.y > vhi.y {
            continue;
        }
        let a = (t - r.t0) / 1.4;
        let rad = r.size * (0.6 + 1.1 * (1.0 - (1.0 - a).powi(2)));
        let ring: Vec<PVec2> = (0..=28).map(|k| r.p + PVec2::from_angle(k as f32 / 28.0 * std::f32::consts::TAU) * PVec2::new(rad, rad * 0.75)).collect();
        buf.stroke(&ring, 1.2 + 1.6 * (1.0 - a), 0.0007, la(line, 0.24 * r.strength * (1.0 - a).powi(2)));
    }
    for b in &water.bubbles {
        if b.p.x < vlo.x || b.p.x > vhi.x || b.p.y < vlo.y || b.p.y > vhi.y {
            continue;
        }
        let a = ((t - b.t0) / 0.2).min(1.0) * (1.0 - (t - b.t0) / b.life).clamp(0.0, 1.0);
        let ring: Vec<PVec2> = (0..=12).map(|k| b.p + PVec2::from_angle(k as f32 / 12.0 * std::f32::consts::TAU) * b.r).collect();
        buf.stroke(&ring, 1.0, 0.0009, la(line, 0.6 * a));
        buf.ellipse(b.p + PVec2::new(-0.35, 0.35) * b.r, PVec2::splat(b.r * 0.3), 0.0, 0.001, la(Color::WHITE, 0.6 * a));
    }
    // Droplets: stretched along their flight.
    for d in &water.drops {
        if d.p.x < vlo.x || d.p.x > vhi.x || d.p.y < vlo.y || d.p.y > vhi.y {
            continue;
        }
        let a = (d.life / 0.4).min(1.0);
        let stretch = 1.0 + (d.v.length() / 500.0).min(1.5);
        let ang = d.v.y.atan2(d.v.x);
        if dark {
            buf.halo(d.p, PVec2::splat(d.r * 4.0), -0.0001, la(line, 0.12 * a));
        }
        buf.ellipse(d.p, PVec2::new(d.r * stretch, d.r), ang, 0.0011, la(mix(line, shallow, 0.3), 0.9 * a));
        buf.ellipse(d.p + PVec2::new(-0.3, 0.3) * d.r, PVec2::splat(d.r * 0.35), 0.0, 0.0012, la(Color::WHITE, 0.8 * a));
    }
    if let Some(mut m) = meshes.get_mut(handle) {
        buf.write(&mut m);
    }
}

// ------------------------------------------------------------------- wind

/// Moving air: streaks and spores carried along the draft, fading in at
/// the upwind edge (out of a glowing chasm in the rock) and out downwind.
fn update_wind(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&WindVisual>, cam: Query<(&Transform, &Projection), With<crate::camera::MainCamera>>, mut walls: Local<(String, Vec<bool>)>) {
    let Ok(WindVisual(handle)) = q.single() else { return };
    let level = &game.sim.level;
    let t = time.elapsed_secs();
    let theme = palette::theme(level.theme);
    let zones: Vec<(PVec2, PVec2, PVec2)> = level
        .zones
        .iter()
        .filter_map(|zd| match zd.kind {
            bb_level::ZoneKind::Wind { accel } => {
                let (lo, hi) = zd.shape.bounds();
                Some((lo, hi, accel))
            }
            _ => None,
        })
        .collect();
    // Is there rock at each zone's upwind edge (a vent to draw)?
    if walls.0 != level.id || game.is_added() {
        let ground = Ground::new(level);
        walls.1 = zones
            .iter()
            .map(|(lo, hi, a)| {
                let d = a.normalize_or(PVec2::Y);
                let c = (*lo + *hi) * 0.5;
                let corners = [*lo, PVec2::new(hi.x, lo.y), *hi, PVec2::new(lo.x, hi.y)];
                let amin = corners.iter().map(|p| (*p - c).dot(d)).fold(f32::MAX, f32::min);
                let probe = c + d * (amin - 30.0);
                ground.solid(probe) || ground.solid(probe - d * 40.0)
            })
            .collect();
        walls.0 = level.id.clone();
    }
    let (vlo, vhi) = match cam.single() {
        Ok((tf, Projection::Orthographic(o))) => {
            let c = PVec2::new(tf.translation.x, tf.translation.y);
            (c + PVec2::new(o.area.min.x, o.area.min.y) - PVec2::splat(150.0), c + PVec2::new(o.area.max.x, o.area.max.y) + PVec2::splat(150.0))
        }
        _ => return,
    };
    let air = if theme.dark { lighten(mix(theme.jelly, Color::WHITE, 0.5), 0.2) } else { Color::WHITE };
    let glow = if theme.dark { mix(theme.glow, theme.jelly, 0.35) } else { hex(0xfff2c0) };
    let mut buf = MeshBuf::default();
    for (zi, (lo, hi, accel)) in zones.iter().enumerate() {
        if hi.x < vlo.x || lo.x > vhi.x || hi.y < vlo.y || lo.y > vhi.y {
            continue;
        }
        let d = accel.normalize_or(PVec2::Y);
        let side = PVec2::new(-d.y, d.x);
        let strength = (accel.length() / 1800.0).clamp(0.4, 1.6);
        let c = (*lo + *hi) * 0.5;
        // Extent along and across the draft.
        let corners = [*lo, PVec2::new(hi.x, lo.y), *hi, PVec2::new(lo.x, hi.y)];
        let (amin, amax) = corners.iter().map(|p| (*p - c).dot(d)).fold((f32::MAX, f32::MIN), |(a, b), x| (a.min(x), b.max(x)));
        let (smin, smax) = corners.iter().map(|p| (*p - c).dot(side)).fold((f32::MAX, f32::MIN), |(a, b), x| (a.min(x), b.max(x)));
        let len = amax - amin;
        let wid = smax - smin;
        let speed = 260.0 + 260.0 * strength;
        let seed = (lo.x * 0.37 + lo.y * 1.31) as i32 + zi as i32 * 977;
        let pos = |along: f32, across: f32| c + d * (amin + along) + side * (smin + across);
        // How visible at a spot: fade in leaving the vent, out at the far
        // end, and toward the sides.
        let vis = |along: f32, across: f32| -> f32 {
            let a = (along / 90.0).min(1.0) * ((len - along) / 160.0).clamp(0.0, 1.0);
            let s = (across / 50.0).min((wid - across) / 50.0).clamp(0.0, 1.0);
            a * s
        };
        // ---- the vent: a glowing chasm along the upwind edge.
        let vent_c = pos(0.0, wid * 0.5);
        let vent_hw = wid * 0.5;
        let breathe = 0.8 + 0.2 * (t * 2.3 + zi as f32).sin();
        if walls.1.get(zi).copied().unwrap_or(false) {
            // A chasm in the rock, hot with light from below: a lens-shaped
            // crack along the surface, bright deep inside, dark at its lips.
            let top: Vec<PVec2> = (0..=16)
                .map(|k| {
                    let u = k as f32 / 16.0 * 2.0 - 1.0;
                    let jag = crate::crag::hash1(seed + k, 31) * 4.0 - 2.0;
                    vent_c + side * (u * vent_hw * 0.95) - d * (2.0 + jag * (1.0 - u * u))
                })
                .collect();
            let bot: Vec<PVec2> = (0..=16)
                .map(|k| {
                    let u = k as f32 / 16.0 * 2.0 - 1.0;
                    let jag = crate::crag::hash1(seed + k, 37) * 8.0;
                    vent_c + side * (u * vent_hw * 0.95) - d * ((26.0 + jag) * (1.0 - u * u).powf(0.7) + 2.0)
                })
                .collect();
            buf.halo(vent_c, PVec2::new(vent_hw * 1.3, 60.0).max(PVec2::splat(10.0)) * if d.y.abs() > 0.5 { PVec2::ONE } else { PVec2::new(0.4, 2.5) }, -0.002, la(glow, 0.3 * breathe));
            let mut shape = top.clone();
            shape.extend(bot.iter().rev().copied());
            buf.fan(&shape, vent_c - d * 10.0, 0.0, la(lighten(glow, 0.35), 0.95 * breathe), lin(mix(Color::BLACK, glow, 0.08)));
            let rim: Vec<[f32; 4]> = (0..top.len()).map(|k| { let u = k as f32 / 16.0 * 2.0 - 1.0; la(lighten(glow, 0.3), 0.8 * (1.0 - u * u) * breathe) }).collect();
            buf.stroke_cols(&top, 2.5, 0.0005, &rim);
            buf.stroke(&bot, 2.0, 0.0005, lin(mix(Color::BLACK, glow, 0.12)));
        }
        // A plume of light breathing out of the vent along the draft.
        let rows = 10;
        let base = buf.pos.len() as u32;
        for r in 0..=rows {
            let u = r as f32 / rows as f32;
            let along = u * len.min(700.0);
            let spread = vent_hw * (0.85 + 0.35 * u);
            let a = 0.16 * (1.0 - u).powf(1.5) * breathe * (u * 8.0).min(1.0);
            let mid = pos(along, wid * 0.5) + side * (t * 1.7 + u * 4.0).sin() * 6.0 * u;
            buf.vert(mid - side * spread, -0.003, la(glow, 0.0));
            buf.vert(mid, -0.003, la(glow, a));
            buf.vert(mid + side * spread, -0.003, la(glow, 0.0));
        }
        for r in 0..rows as u32 {
            for k in 0..2u32 {
                let (p0, p1, q0, q1) = (base + r * 3 + k, base + r * 3 + k + 1, base + (r + 1) * 3 + k, base + (r + 1) * 3 + k + 1);
                buf.tri(p0, p1, q1);
                buf.tri(p0, q1, q0);
            }
        }
        // ---- streaks of moving air
        let n = ((len * wid) / (90.0 * 90.0)).clamp(6.0, 90.0) as i32;
        for k in 0..n {
            let h = |m: i32| crate::crag::hash1(seed * 31 + k * 7 + m, 0x51d);
            let across0 = h(0) * wid;
            let sl = (50.0 + 90.0 * h(1)) * strength.sqrt();
            let sp = speed * (0.75 + 0.5 * h(2));
            let travel = len + sl;
            let ph = ((t * sp + h(3) * travel) % travel + travel) % travel;
            let head = ph;
            let pts: Vec<PVec2> = (0..=6)
                .map(|i| {
                    let along = head - sl * i as f32 / 6.0;
                    let across = across0 + (along * 0.012 + h(4) * 6.0 + t * 0.8).sin() * 14.0;
                    pos(along.clamp(0.0, len), across)
                })
                .collect();
            let cs: Vec<[f32; 4]> = (0..=6)
                .map(|i| {
                    let along = head - sl * i as f32 / 6.0;
                    let across = across0;
                    let tail = 1.0 - i as f32 / 6.0;
                    let inside = if (0.0..=len).contains(&along) { 1.0 } else { 0.0 };
                    la(air, (if theme.dark { 0.42 } else { 0.55 }) * tail * vis(along.max(0.0), across) * inside * (0.6 + 0.4 * h(5)))
                })
                .collect();
            buf.stroke_cols(&pts, 2.0 + 1.8 * h(6), 0.0, &cs);
        }
        // Broad wisps: the volume of air itself, slow curling ribbons.
        let ribbons = ((wid / 70.0) as i32).clamp(2, 8);
        for k in 0..ribbons {
            let h = |m: i32| crate::crag::hash1(seed * 13 + k * 5 + m, 0x71b);
            let across0 = (k as f32 + 0.5) / ribbons as f32 * wid;
            let sl = len.min(420.0) * (0.5 + 0.4 * h(0));
            let sp = speed * 0.55;
            let travel = len + sl;
            let head = ((t * sp + h(1) * travel) % travel + travel) % travel;
            let pts: Vec<PVec2> = (0..=10)
                .map(|i| {
                    let along = (head - sl * i as f32 / 10.0).clamp(0.0, len);
                    pos(along, across0 + (along * 0.008 + t * 0.9 + h(2) * 6.0).sin() * 22.0)
                })
                .collect();
            let cs: Vec<[f32; 4]> = (0..=10)
                .map(|i| {
                    let along = head - sl * i as f32 / 10.0;
                    let env = (std::f32::consts::PI * i as f32 / 10.0).sin();
                    let inside = if (0.0..=len).contains(&along) { 1.0 } else { 0.0 };
                    la(air, 0.08 * env * inside * vis(along.clamp(0.0, len), across0))
                })
                .collect();
            buf.stroke_cols(&pts, 26.0 + 20.0 * h(3), -0.001, &cs);
        }
        // ---- spores and dust carried along (lit motes, a little faster)
        let m = ((len * wid) / (140.0 * 140.0)).clamp(4.0, 50.0) as i32;
        for k in 0..m {
            let h = |q: i32| crate::crag::hash1(seed * 17 + k * 13 + q, 0xd057);
            let sp = speed * (0.9 + 0.6 * h(0));
            let along = ((t * sp + h(1) * len) % len + len) % len;
            let across = h(2) * wid + (t * 2.0 + h(3) * 9.0).sin() * 18.0 + (along * 0.02).sin() * 10.0;
            let p = pos(along, across);
            let a = vis(along, across.clamp(0.0, wid));
            if a < 0.02 {
                continue;
            }
            let col = if k % 3 == 0 { theme.crystal } else { theme.mush };
            buf.halo(p, PVec2::splat(9.0), 0.0005, la(col, 0.25 * a));
            buf.ellipse(p, PVec2::new(2.6, 1.6), d.y.atan2(d.x), 0.0006, la(lighten(col, 0.5), 0.9 * a));
        }
    }
    if let Some(mut mesh) = meshes.get_mut(handle) {
        buf.write(&mut mesh);
    }
}

fn despawn_level_view(mut commands: Commands, q: Query<Entity, With<LevelEntity>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
