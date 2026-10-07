//! Visuals for level geometry and items: terrain, movers, springs, spikes,
//! zones, checkpoints, pickups, the goal, decor, and the cave backdrop.

use bb_physics::{Vec2 as PVec2, geom};
use bevy::prelude::*;

use crate::palette::{self, darken, lighten, lin, mix};
use crate::render::{MeshBuf, Shared, empty_mesh, z};
use crate::sim::Game;

/// Everything spawned for the current level (despawned on unload).
#[derive(Component)]
pub struct LevelEntity;

#[derive(Component)]
pub struct MoverVisual(pub usize, pub Handle<Mesh>);

#[derive(Component)]
pub struct SpringVisual(pub usize, pub Handle<Mesh>);

#[derive(Component)]
pub struct CheckpointVisual(pub usize, pub Handle<Mesh>);

#[derive(Component)]
pub struct PickupVisual(pub usize);

#[derive(Component)]
pub struct GoalVisual(pub Handle<Mesh>);

#[derive(Component)]
pub struct Sky;

pub struct LevelViewPlugin;

impl Plugin for LevelViewPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostUpdate, spawn_level_view.run_if(resource_added::<Game>))
            .add_systems(
                PostUpdate,
                (update_movers, update_springs, update_checkpoints, update_pickups, update_goal, follow_sky)
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
        LevelEntity,
    ));

    // Terrain.
    let mut terrain = MeshBuf::default();
    for (t, (_, mat, one_way)) in level.terrain.iter().zip(&sim.terrain) {
        let poly = t.shape.outline();
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
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::TERRAIN + 0.5), MoverVisual(i, h), LevelEntity));
    }

    // Springs.
    for i in 0..sim.springs.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS), SpringVisual(i, h), LevelEntity));
    }

    // Spikes (static).
    let mut spikes = MeshBuf::default();
    for s in &level.spikes {
        let len = (s.b - s.a).length();
        let n = (s.b - s.a).perp().normalize_or(PVec2::Y);
        let teeth = (len / 26.0).ceil().max(1.0) as usize;
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
    commands.spawn((Mesh2d(meshes.add(spikes.into_mesh())), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS), LevelEntity));

    // Zones (translucent).
    let mut zones = MeshBuf::default();
    for zd in &level.zones {
        let poly = zd.shape.outline();
        let c = geom::centroid(&poly);
        let col = match &zd.kind {
            bb_level::ZoneKind::Water { .. } => Color::srgba(0.35, 0.7, 1.0, 0.38),
            bb_level::ZoneKind::Wind { .. } => Color::srgba(1.0, 1.0, 1.0, 0.07),
            bb_level::ZoneKind::Kill => Color::srgba(1.0, 0.3, 0.4, 0.25),
            bb_level::ZoneKind::Goo { .. } => Color::srgba(0.5, 0.9, 0.3, 0.35),
            bb_level::ZoneKind::Conveyor { .. } => Color::srgba(1.0, 0.85, 0.3, 0.15),
            bb_level::ZoneKind::Gravity { .. } => Color::srgba(0.7, 0.5, 1.0, 0.15),
        };
        zones.fan(&poly, c, 0.0, lin(col), lin(col));
    }
    commands.spawn((Mesh2d(meshes.add(zones.into_mesh())), MeshMaterial2d(shared.blend.clone()), Transform::from_xyz(0.0, 0.0, z::FX + 0.5), LevelEntity));

    // Checkpoints: glow mushrooms.
    for i in 0..level.checkpoints.len() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS - 0.2), CheckpointVisual(i, h), LevelEntity));
    }

    // Pickups: glow drops.
    let drop_mat = mats.add(ColorMaterial::from(theme.glow));
    for (i, p) in level.pickups.iter().enumerate() {
        commands.spawn((
            Mesh2d(shared.circle.clone()),
            MeshMaterial2d(drop_mat.clone()),
            Transform::from_xyz(p.x, p.y, z::ITEMS + 0.1).with_scale(Vec3::splat(9.0)),
            PickupVisual(i),
            LevelEntity,
        ));
    }

    // Goal: a glowing arch.
    if level.goal.is_some() {
        let h = meshes.add(empty_mesh());
        commands.spawn((Mesh2d(h.clone()), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::ITEMS - 0.5), GoalVisual(h), LevelEntity));
    }

    // Decor.
    let mut back = MeshBuf::default();
    let mut front = MeshBuf::default();
    for d in &level.decor {
        let buf = if d.depth < 0.0 { &mut back } else { &mut front };
        decor(buf, &d.kind, d.pos, d.scale, &theme);
    }
    commands.spawn((Mesh2d(meshes.add(back.into_mesh())), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::DECOR_BACK), LevelEntity));
    commands.spawn((Mesh2d(meshes.add(front.into_mesh())), MeshMaterial2d(shared.vertex.clone()), Transform::from_xyz(0.0, 0.0, z::DECOR_FRONT), LevelEntity));
}

/// Procedural decor shapes.
pub fn decor(buf: &mut MeshBuf, kind: &str, p: PVec2, s: f32, theme: &palette::ThemeColors) {
    let accent = theme.accent;
    match kind {
        "mushroom_spots" => {
            for (dx, dy, r) in [(-30.0, 12.0, 8.0), (10.0, 22.0, 10.0), (36.0, 8.0, 6.0)] {
                buf.ellipse(p + PVec2::new(dx, dy) * s, PVec2::splat(r * s), 0.0, 0.0, lin(Color::srgba(1.0, 1.0, 1.0, 1.0)));
            }
        }
        "mushroom" => {
            buf.stroke(&[p, p + PVec2::new(0.0, 40.0 * s)], 10.0 * s, 0.0, lin(lighten(theme.far, 0.3)));
            buf.ellipse(p + PVec2::new(0.0, 44.0 * s), PVec2::new(30.0, 16.0) * s, 0.0, 0.001, lin(lighten(accent, 0.1)));
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
            for k in 0..5 {
                let q = p + PVec2::new(k as f32 * 9.0, -(k as f32 * 0.8).sin() * 6.0) * s;
                buf.ellipse(q, PVec2::splat(5.0 * s), 0.0, 0.0, lin(lighten(theme.glow, 0.3)));
            }
        }
        "drip" => {
            buf.stroke(&[p, p - PVec2::new(0.0, 60.0 * s)], 6.0 * s, 0.0, lin(theme.jelly));
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
            buf.ellipse(p, PVec2::new(24.0, 14.0) * s, 0.0, 0.0, lin(lighten(theme.rock, 0.1)));
        }
    }
}

fn update_movers(game: Res<Game>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&MoverVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    for MoverVisual(i, h) in q.iter() {
        let Some(m) = game.sim.movers.get(*i) else { continue };
        let Some(s) = game.sim.world.static_collider(m.id) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let mut buf = MeshBuf::default();
        let fill = palette::material_tint(m.def.material, theme.rock);
        poly_mesh(&s.poly, lighten(fill, 0.08), darken(fill, 0.45), 6.0, &mut buf);
        buf.write(&mut mesh);
    }
}

fn update_springs(game: Res<Game>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&SpringVisual>) {
    for SpringVisual(i, h) in q.iter() {
        let Some(s) = game.sim.springs.get(*i) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let dir = PVec2::from_angle(s.def.angle);
        let side = dir.perp() * s.def.width * 0.5;
        let lift = 18.0 + (1.0 - s.squash) * 6.0 - s.squash * 8.0;
        let mut buf = MeshBuf::default();
        let base = s.def.pos;
        // Coil.
        let coil: Vec<PVec2> = (0..=8)
            .map(|k| base + dir * (k as f32 / 8.0 * lift) + side * 0.5 * if k % 2 == 0 { -0.6 } else { 0.6 })
            .collect();
        buf.stroke(&coil, 5.0, 0.0, lin(palette::hex(0x8a8f9c)));
        let top = [base - side + dir * lift, base + side + dir * lift, base + side + dir * (lift + 12.0), base - side + dir * (lift + 12.0)];
        buf.fan(&top, base + dir * (lift + 6.0), 0.001, lin(palette::hex(0xff9fbf)), lin(palette::hex(0xff5d8f)));
        buf.write(&mut mesh);
    }
}

fn update_checkpoints(game: Res<Game>, time: Res<Time>, mut meshes: ResMut<Assets<Mesh>>, q: Query<&CheckpointVisual>) {
    let theme = palette::theme(game.sim.level.theme);
    let t = time.elapsed_secs();
    for CheckpointVisual(i, h) in q.iter() {
        let Some(cp) = game.sim.level.checkpoints.get(*i) else { continue };
        let Some(mut mesh) = meshes.get_mut(h) else { continue };
        let lit = game.sim.checkpoint > *i;
        let p = cp.pos - PVec2::new(0.0, 30.0);
        let mut buf = MeshBuf::default();
        let glow = if lit { theme.glow } else { mix(theme.far, theme.glow, 0.25) };
        if lit {
            let pulse = 1.0 + (t * 3.0).sin() * 0.08;
            buf.ellipse(p + PVec2::new(0.0, 70.0), PVec2::new(80.0, 60.0) * pulse, 0.0, -0.01, lin(Color::srgba(1.0, 0.95, 0.6, 0.25)));
        }
        buf.stroke(&[p, p + PVec2::new(0.0, 60.0)], 14.0, 0.0, lin(lighten(theme.far, 0.5)));
        let wob = (t * 2.0 + *i as f32).sin() * 0.06;
        buf.ellipse(p + PVec2::new(0.0, 66.0), PVec2::new(46.0, 24.0), wob, 0.001, lin(glow));
        buf.ellipse(p + PVec2::new(-14.0, 72.0), PVec2::new(7.0, 5.0), 0.0, 0.002, lin(lighten(glow, 0.6)));
        buf.ellipse(p + PVec2::new(14.0, 70.0), PVec2::new(5.0, 4.0), 0.0, 0.002, lin(lighten(glow, 0.6)));
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
        buf.ellipse(c, (max - min) * 0.6 * pulse, 0.0, 0.0, lin(Color::srgba(1.0, 0.97, 0.75, 1.0)));
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

fn despawn_level_view(mut commands: Commands, q: Query<Entity, With<LevelEntity>>) {
    for e in q.iter() {
        commands.entity(e).despawn();
    }
}
