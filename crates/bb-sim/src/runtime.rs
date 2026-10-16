//! Level runtime: movers, zones, springs, spikes, checkpoints, pickups,
//! goal, story triggers, falling out, respawns.

use bb_level::{MoverMotion, ZoneKind};
use bb_physics::{BodyId, Collider, Vec2, geom};

use crate::{BodyTag, Sim, SimEvent, Who};

fn ease_in(t: f32) -> f32 {
    t * t * t
}

fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Offset of a mover along its path at time `t`.
pub(crate) fn mover_offset(m: &bb_level::Mover, t: f32) -> (Vec2, f32) {
    let path = &m.path;
    match m.motion {
        MoverMotion::Spin { speed } => (Vec2::ZERO, speed * t + m.phase * std::f32::consts::TAU),
        MoverMotion::Lift { hold } => {
            let travel = m.period.max(0.1);
            let cycle = 2.0 * (travel + hold);
            let u = (t + m.phase * cycle).rem_euclid(cycle);
            let f = if u < hold {
                0.0
            } else if u < hold + travel {
                smooth((u - hold) / travel)
            } else if u < 2.0 * hold + travel {
                1.0
            } else {
                1.0 - smooth((u - 2.0 * hold - travel) / travel)
            };
            let end = path.last().copied().unwrap_or(Vec2::ZERO);
            let start = path.first().copied().unwrap_or(Vec2::ZERO);
            (start.lerp(end, f), 0.0)
        }
        MoverMotion::Crusher { slam, hold, rise, wait } => {
            let cycle = slam + hold + rise + wait;
            let target = path.get(1).copied().unwrap_or(Vec2::ZERO);
            let mut u = (t + m.phase * cycle).rem_euclid(cycle);
            let f = if u < wait {
                0.0
            } else {
                u -= wait;
                if u < slam {
                    ease_in(u / slam)
                } else {
                    u -= slam;
                    if u < hold { 1.0 } else { 1.0 - smooth(((u - hold) / rise).min(1.0)) }
                }
            };
            (target * f, 0.0)
        }
        MoverMotion::Loop | MoverMotion::PingPong => {
            if path.len() < 2 {
                return (path.first().copied().unwrap_or(Vec2::ZERO), 0.0);
            }
            let period = m.period.max(0.05);
            let mut u = ((t / period) + m.phase).rem_euclid(1.0);
            let pts: Vec<Vec2> = if matches!(m.motion, MoverMotion::PingPong) {
                if u > 0.5 {
                    u = 1.0 - u;
                }
                u *= 2.0;
                path.clone()
            } else {
                let mut p = path.clone();
                p.push(path[0]);
                p
            };
            let lens: Vec<f32> = pts.windows(2).map(|w| (w[1] - w[0]).length()).collect();
            let total: f32 = lens.iter().sum::<f32>().max(1e-3);
            // Smooth the ends of ping-pong travel so riders don't get flung.
            let s = if matches!(m.motion, MoverMotion::PingPong) { smooth(u) } else { u } * total;
            let mut acc = 0.0;
            for (k, l) in lens.iter().enumerate() {
                if s <= acc + l || k == lens.len() - 1 {
                    let f = if *l > 0.0 { ((s - acc) / l).clamp(0.0, 1.0) } else { 0.0 };
                    return (pts[k].lerp(pts[k + 1], f), 0.0);
                }
                acc += l;
            }
            (Vec2::ZERO, 0.0)
        }
    }
}

fn dynamic_bodies(sim: &Sim) -> Vec<(BodyId, BodyTag)> {
    let mut v: Vec<(BodyId, BodyTag)> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| (p.ctl.body, BodyTag::Player(p.slot)))
        .collect();
    v.extend(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (n.ctl.body, BodyTag::Npc(n.index))));
    v.extend(sim.props.iter().map(|b| (*b, BodyTag::Prop)));
    v
}

/// Ids of `plate:<id>` story triggers that a player, NPC or prop is on.
pub(crate) fn pressed_plates(sim: &Sim) -> Vec<String> {
    let mut out = Vec::new();
    let bodies = dynamic_bodies(sim);
    for st in &sim.level.story {
        let Some(id) = st.script.strip_prefix("plate:") else { continue };
        let poly = st.shape.outline();
        let bb = bb_physics::Aabb::from_points(poly.iter().copied());
        let hit = bodies.iter().any(|(b, _)| {
            sim.world.body(*b).is_some_and(|b| {
                b.enabled && b.aabb.overlaps(&bb) && b.boundary.iter().any(|&i| geom::point_in_polygon(b.x[i as usize], &poly))
            })
        });
        if hit {
            out.push(id.to_string());
        }
    }
    out
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
enum PlateMode {
    Held,
    Toggle,
    Once,
}

/// Parse a mover trigger spec: `a|b` (any), `a&b` (all), optional
/// `#toggle` / `#once` suffix.
fn plate_condition(spec: &str, pressed: &[String]) -> (bool, PlateMode) {
    let (ids, mode) = match spec.split_once('#') {
        Some((ids, "toggle")) => (ids, PlateMode::Toggle),
        Some((ids, "once")) => (ids, PlateMode::Once),
        Some((ids, _)) => (ids, PlateMode::Held),
        None => (spec, PlateMode::Held),
    };
    let on = |id: &str| pressed.iter().any(|p| p == id.trim());
    let cond = if ids.contains('&') { ids.split('&').all(on) } else { ids.split('|').any(on) };
    (cond, mode)
}

pub(crate) fn pre_step(sim: &mut Sim, dt: f32) {
    // Movers.
    let t = sim.time;
    let plates = if sim.movers.iter().any(|m| !m.def.trigger.is_empty()) { pressed_plates(sim) } else { Vec::new() };
    for m in sim.movers.iter_mut() {
        if !m.def.trigger.is_empty() {
            // Plate-driven: travel to the end of the path while the plate
            // condition holds (or is latched), back to rest otherwise.
            let (cond, mode) = plate_condition(&m.def.trigger, &plates);
            let target = match mode {
                PlateMode::Held => cond,
                PlateMode::Toggle => {
                    if cond && !m.pressed {
                        m.latched = !m.latched;
                    }
                    m.latched
                }
                PlateMode::Once => {
                    m.latched |= cond;
                    m.latched
                }
            };
            m.pressed = cond;
            m.active = target;
            let half = (m.def.period * 0.5).max(0.05);
            let goal = if target { 1.0 } else { 0.0 };
            let before = m.progress;
            m.progress += (goal - m.progress).clamp(-dt / half, dt / half);
            if before == m.progress && m.progress == 0.0 {
                continue;
            }
            let mut def = m.def.clone();
            def.motion = bb_level::MoverMotion::PingPong;
            def.phase = 0.0;
            let (off, _) = mover_offset(&def, m.progress * half);
            let poly: Vec<Vec2> = m.base.iter().map(|p| *p + off).collect();
            sim.world.move_static(m.id, poly);
            continue;
        }
        if !m.active {
            continue;
        }
        let (off, ang) = mover_offset(&m.def, t + dt);
        let c = geom::centroid(&m.base);
        let rot = Vec2::from_angle(ang);
        let poly: Vec<Vec2> = m.base.iter().map(|p| c + rot.rotate(*p - c) + off).collect();
        sim.world.move_static(m.id, poly);
    }

    for p in sim.players.iter_mut() {
        p.ctl.in_water = 0.0;
    }
    for n in sim.npcs.iter_mut() {
        n.ctl.in_water = 0.0;
    }
    let mut wet: Vec<(BodyId, f32)> = Vec::new();

    // Zones.
    let bodies = dynamic_bodies(sim);
    let gravity = sim.world.config.gravity;
    for z in &sim.level.zones {
        let outline = z.shape.outline();
        let (zmin, zmax) = z.shape.bounds();
        for &(id, _) in &bodies {
            let Some(b) = sim.world.body_mut(id) else { continue };
            if !b.enabled || b.aabb.max.x < zmin.x || b.aabb.min.x > zmax.x || b.aabb.max.y < zmin.y || b.aabb.min.y > zmax.y {
                continue;
            }
            let n = b.boundary.len().max(1);
            let inside = b.boundary.iter().filter(|&&i| geom::point_in_polygon(b.x[i as usize], &outline)).count();
            if inside == 0 {
                continue;
            }
            let frac = inside as f32 / n as f32;
            // Puffing up floats you more, but cap it.
            let puff = (b.rest_scale * b.rest_scale).min(1.7);
            let v = b.velocity();
            // Blobs fall at 2.x's stronger gravity (gravity_scale > 1); zone
            // forces were authored against world gravity, so scale them too.
            let gs = gadget_gravity(b);
            match &z.kind {
                ZoneKind::Wind { accel } => b.add_accel(*accel * frac * puff * gs),
                ZoneKind::Water { buoyancy, drag, current } => {
                    wet.push((id, frac));
                    let density = (b.mass() / (b.rest_area.max(1.0) / 3200.0)).max(0.2);
                    b.add_accel(Vec2::new(0.0, buoyancy * frac * puff * gs / density));
                    b.add_accel((*current - v) * (*drag * frac));
                }
                ZoneKind::Gravity { gravity: g } => b.add_accel((*g - gravity) * gs * frac),
                ZoneKind::Goo { drag } => b.add_accel(-v * (*drag * frac)),
                ZoneKind::Conveyor { speed } => b.add_accel(Vec2::new((speed - v.x) * 6.0 * frac, 0.0)),
                ZoneKind::Kill => {}
            }
        }
    }

    for (id, frac) in wet {
        if let Some(p) = sim.players.iter_mut().find(|p| p.ctl.body == id) {
            p.ctl.in_water = p.ctl.in_water.max(frac);
        } else if let Some(n) = sim.npcs.iter_mut().find(|n| n.ctl.body == id) {
            n.ctl.in_water = n.ctl.in_water.max(frac);
        }
    }

    for s in sim.springs.iter_mut() {
        s.cooldown = (s.cooldown - dt).max(0.0);
        s.squash = (s.squash - dt * 4.0).max(0.0);
    }
    crate::gadgets::pre_step(sim, dt);
}

pub(crate) fn post_step(sim: &mut Sim, dt: f32) {
    let bodies = dynamic_bodies(sim);

    // Crushers and drips: a softbody can always ooze around a slab's corner
    // (puffed up, it wraps the crusher instead of flattening), so closing
    // on a blob whose middle is underneath pops it outright.
    let mut crushed = Vec::new();
    for m in &sim.movers {
        let bb_level::MoverMotion::Crusher { .. } = m.def.motion else { continue };
        let Some(s) = sim.world.static_collider(m.id) else { continue };
        let (mut lo, mut hi) = (Vec2::splat(f32::MAX), Vec2::splat(f32::MIN));
        for p in &s.poly {
            lo = lo.min(*p);
            hi = hi.max(*p);
        }
        let base_bottom = m.base.iter().map(|p| p.y).fold(f32::MAX, f32::min);
        let closed_bottom = base_bottom + m.def.path.get(1).map_or(0.0, |d| d.y);
        let blobs = sim.players.iter().filter(|p| p.dead.is_none()).map(|p| (p.ctl.body, p.ctl.radius)).chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (n.ctl.body, n.ctl.radius)));
        for (id, r) in blobs {
            let Some(b) = sim.world.body(id).filter(|b| b.enabled) else { continue };
            let c = b.centroid();
            let inside_x = c.x > lo.x + 6.0 && c.x < hi.x - 6.0;
            let nearly_closed = lo.y < closed_bottom + r * 0.9;
            if inside_x && nearly_closed && c.y < lo.y && c.y > closed_bottom - r * 3.0 {
                crushed.push(id);
            }
        }
        // Droplets caught underneath just go (squeezed between the slab and
        // jelly ground they'd make the ground lurch).
        if lo.y < closed_bottom + 40.0 {
            for d in sim.droplets.iter_mut() {
                if let Some(b) = sim.world.body(d.0) {
                    let c = b.centroid();
                    if c.x > lo.x - 10.0 && c.x < hi.x + 10.0 && c.y < lo.y + 10.0 && c.y > closed_bottom - 80.0 {
                        d.1 = 0.0;
                    }
                }
            }
        }
    }
    // Lethal movers (blades, spiky drips): touching one pops you. Checked
    // geometrically (not just last-substep contacts) so a fast drip can't
    // pass through a blob between frames unnoticed.
    for m in sim.movers.iter().filter(|m| m.def.lethal) {
        let Some(s) = sim.world.static_collider(m.id) else { continue };
        if !s.enabled {
            continue;
        }
        let poly = &s.poly;
        let reach = s.aabb.expand(6.0);
        let blobs = sim.players.iter().filter(|p| p.dead.is_none()).map(|p| p.ctl.body).chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| n.ctl.body));
        for id in blobs {
            let Some(b) = sim.world.body(id).filter(|b| b.enabled) else { continue };
            if !b.aabb.overlaps(&reach) {
                continue;
            }
            let margin = b.params.radius + 3.0;
            let touching = b.boundary.iter().any(|&i| {
                let p = b.x[i as usize];
                geom::point_in_polygon(p, poly)
                    || (0..poly.len()).any(|k| geom::closest_on_segment(p, poly[k], poly[(k + 1) % poly.len()]).0.distance_squared(p) < margin * margin)
            }) || sim.world.contacts_of(id).any(|c| c.other == Collider::Static(m.id));
            if touching {
                crushed.push(id);
            }
        }
    }
    crushed.sort();
    crushed.dedup();
    for id in crushed {
        sim.pop(id);
    }

    // How hard each blob is swelling right now (spring / mushroom boosts).
    let window = sim.tuning.jump.bounce_window;
    let boost = sim.tuning.jump.bounce_boost;
    let swell: Vec<(BodyId, f32, bool)> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| &p.ctl)
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| &n.ctl))
        .map(|c| (c.body, c.swell(window), c.just_pressed(dt * 1.5)))
        .collect();
    let swell_of = |id: BodyId| swell.iter().find(|s| s.0 == id).map_or((0.0, false), |s| (s.1, s.2));

    // Late presses: swelling just after a launch still counts.
    let mut late = std::mem::take(&mut sim.late_boosts);
    late.retain_mut(|l| {
        l.age += dt;
        if swell_of(l.body).1 {
            if let Some(b) = sim.world.body_mut(l.body) {
                if b.velocity().dot(l.dir) > 0.0 {
                    b.add_velocity(l.dir * (l.speed * boost));
                    let pos = b.centroid();
                    sim.events.push(SimEvent::SuperBounce { body: l.body, pos });
                }
            }
            return false;
        }
        l.age < window * 0.5
    });

    // Springs.
    for si in 0..sim.springs.len() {
        if sim.springs[si].cooldown > 0.0 {
            continue;
        }
        let sid = sim.springs[si].id;
        let dir = Vec2::from_angle(sim.springs[si].def.angle);
        let power = sim.springs[si].def.power;
        let mut fired = false;
        for &(id, _) in &bodies {
            let hit = sim.world.contacts_of(id).any(|c| c.other == Collider::Static(sid) && c.normal.dot(dir) > 0.5);
            if hit {
                let (sw, _) = swell_of(id);
                let b = sim.world.body_mut(id).unwrap();
                let v = b.velocity();
                // Same launch height whatever the body's gravity.
                let power = power * gadget_gravity(b).sqrt();
                // Swelling as you land on it stores and releases energy.
                let speed = power * (1.0 + boost * sw);
                b.add_velocity(dir * (speed - v.dot(dir)));
                let pos = b.centroid();
                fired = true;
                if sw > 0.5 {
                    sim.events.push(SimEvent::SuperBounce { body: id, pos });
                } else if swell.iter().any(|s| s.0 == id) {
                    late.push(crate::LateBoost { body: id, dir, speed: power, age: 0.0 });
                }
            }
        }
        if fired {
            sim.springs[si].cooldown = 0.2;
            sim.springs[si].squash = 1.0;
            sim.events.push(SimEvent::Spring { index: si });
        }
    }

    // Bouncy mushrooms: physical caps that launch whatever lands on them
    // (flat: along the cap's direction; dome: along its surface normal;
    // ball: away from its centre).
    for mi in 0..sim.mushrooms.len() {
        let m = &mut sim.mushrooms[mi];
        m.squash = (m.squash - dt * 4.0).max(0.0);
        m.cooldown.retain_mut(|c| {
            c.1 -= dt;
            c.1 > 0.0
        });
        let cap = m.body;
        let (def, center, cooling) = (m.def.clone(), m.center, m.cooldown.iter().map(|c| c.0).collect::<Vec<_>>());
        let mut launched = Vec::new();
        for &(id, _) in &bodies {
            if cooling.contains(&id) {
                continue;
            }
            let touching = sim.world.contacts_of(id).any(|c| c.other == Collider::Body(cap)) || sim.world.contacts_of(cap).any(|c| c.other == Collider::Body(id));
            if !touching {
                continue;
            }
            let Some(b) = sim.world.body(id) else { continue };
            let c = b.centroid();
            let dir = match def.shape {
                bb_level::MushroomShape::Flat => {
                    let d = Vec2::from_angle(def.angle);
                    // Only from the launching face.
                    if (c - center).dot(d) <= 0.0 {
                        continue;
                    }
                    d
                }
                bb_level::MushroomShape::Dome => {
                    // Normal of the (half-ellipse) dome under the blob.
                    let a = def.size * 0.5;
                    let h = def.shape.cap_height(def.size);
                    let r = c - center;
                    let n = Vec2::new(r.x / (a * a), r.y / (h * h)).normalize_or(Vec2::Y);
                    if n.y < -0.2 {
                        continue; // bumped its underside
                    }
                    n
                }
                bb_level::MushroomShape::Ball => (c - center).normalize_or(Vec2::Y),
            };
            launched.push((id, dir));
        }
        for (id, dir) in launched {
            let (sw, _) = swell_of(id);
            let Some(b) = sim.world.body_mut(id) else { continue };
            let v = b.velocity();
            let power = def.power * gadget_gravity(b).sqrt();
            let speed = power * (1.0 + boost * sw);
            let along = v.dot(dir);
            if along < speed {
                b.add_velocity(dir * (speed - along));
            }
            let pos = b.centroid();
            let blob = swell.iter().any(|s| s.0 == id);
            if sw > 0.5 {
                sim.events.push(SimEvent::SuperBounce { body: id, pos });
            } else if blob {
                late.push(crate::LateBoost { body: id, dir, speed: power, age: 0.0 });
            }
            // The cap gives: squish it away from the launch so it wobbles.
            if let Some(capb) = sim.world.body_mut(cap) {
                let n = capb.len();
                for i in 0..n {
                    let k = 1.0 - (capb.x[i] - pos).length() / (def.size.max(60.0) * 1.2);
                    if k > 0.0 && capb.w[i] > 0.0 {
                        capb.v[i] -= dir * (380.0 * k * (1.0 + sw));
                    }
                }
            }
            let m = &mut sim.mushrooms[mi];
            m.cooldown.push((id, 0.25));
            m.squash = 1.0;
            sim.events.push(SimEvent::Mushroom { index: mi, pos, boosted: sw > 0.5 });
        }
    }
    sim.late_boosts = late;
    crate::gadgets::post_step(sim, dt);

    // Hazards: spikes, kill zones, falling out.
    let mut to_pop: Vec<BodyId> = Vec::new();
    let mut spike_bands: Vec<Vec<Vec2>> = sim
        .level
        .spikes
        .iter()
        .map(|s| {
            let n = (s.b - s.a).perp().normalize_or(Vec2::Y);
            vec![s.a, s.b, s.b + n * 24.0, s.a + n * 24.0]
        })
        .collect();
    // Spiked movers (falling rocks): teeth along the underside, wherever
    // the mover is right now.
    for m in sim.movers.iter().filter(|m| m.def.spiked) {
        let Some(s) = sim.world.static_collider(m.id) else { continue };
        let bb = bb_physics::Aabb::from_points(s.poly.iter().copied());
        let (x0, x1, y) = (bb.min.x + 4.0, bb.max.x - 4.0, bb.min.y);
        spike_bands.push(vec![Vec2::new(x0, y - 24.0), Vec2::new(x1, y - 24.0), Vec2::new(x1, y + 2.0), Vec2::new(x0, y + 2.0)]);
    }
    let kill_zones: Vec<Vec<Vec2>> =
        sim.level.zones.iter().filter(|z| matches!(z.kind, ZoneKind::Kill)).map(|z| z.shape.outline()).collect();
    for &(id, tag) in &bodies {
        let Some(b) = sim.world.body(id) else { continue };
        if !b.enabled {
            continue;
        }
        let c = b.centroid();
        if c.y < sim.level.kill_y {
            to_pop.push(id);
            continue;
        }
        if tag == BodyTag::Prop {
            continue;
        }
        let touches = |poly: &Vec<Vec2>| {
            let bb = bb_physics::Aabb::from_points(poly.iter().copied());
            b.aabb.overlaps(&bb) && b.boundary.iter().any(|&i| geom::point_in_polygon(b.x[i as usize], poly))
        };
        if spike_bands.iter().any(touches) || kill_zones.iter().any(|z| geom::point_in_polygon(c, z)) {
            to_pop.push(id);
        }
    }
    for id in to_pop {
        if sim.tags.get(&id) == Some(&BodyTag::Prop) {
            // Props that fall out return to where they started.
            if let Some(i) = sim.props.iter().position(|p| *p == id) {
                if let Some(start) = sim.level.props.get(i).map(|p| p.center) {
                    sim.world.respawn(id, start);
                }
            }
            continue;
        }
        sim.pop(id);
    }

    // Respawns.
    let base = sim.respawn_point();
    let mut respawned = Vec::new();
    for (k, p) in sim.players.iter_mut().enumerate() {
        if let Some(t) = p.dead.as_mut() {
            *t -= dt;
            if *t <= 0.0 {
                p.dead = None;
                let at = base + Vec2::new((k as f32 - 1.0) * 20.0, 30.0 + k as f32 * 12.0);
                respawned.push((p.ctl.body, p.ctl.radius, at, Who::Player(p.slot)));
                p.ctl.reset();
            }
        }
    }
    for n in sim.npcs.iter_mut() {
        if let Some(t) = n.dead.as_mut() {
            *t -= dt;
            if *t <= 0.0 {
                n.dead = None;
                let at = if n.following { base + Vec2::new(-60.0, 60.0) } else { n.home };
                respawned.push((n.ctl.body, n.ctl.radius, at, Who::Npc(n.index)));
                n.ctl.reset();
            }
        }
    }
    // One at a time, each clear of the blobs already there (two players
    // popped on the same spikes come back side by side, not inside each
    // other or inside whoever is waiting at the checkpoint).
    for (body, radius, at, who) in respawned {
        let at = sim.free_spot(at, radius, Some(body));
        sim.world.respawn(body, at);
        sim.events.push(SimEvent::Respawned { who, pos: at });
    }

    // Progression (players only).
    let alive: Vec<(u8, Vec2, f32)> = sim
        .players
        .iter()
        .filter(|p| p.dead.is_none())
        .filter_map(|p| sim.world.body(p.ctl.body).map(|b| (p.slot, b.centroid(), p.ctl.radius * p.ctl.expand)))
        .collect();
    let checkpoints: Vec<Vec2> = sim.level.checkpoints.iter().map(|c| c.pos).collect();
    for (i, cp) in checkpoints.iter().enumerate() {
        if i + 1 > sim.checkpoint && alive.iter().any(|(_, c, _)| c.distance(*cp) < 110.0) {
            sim.checkpoint = i + 1;
            sim.events.push(SimEvent::Checkpoint { index: i, pos: *cp });
        }
    }
    // Amoebas squirm (pseudopod wiggles) and get eaten on touch.
    let t = sim.time;
    for i in 0..sim.amoebas.len() {
        let Some(id) = sim.amoebas[i] else { continue };
        let Some(b) = sim.world.body_mut(id) else { continue };
        let c = b.centroid();
        let n = b.boundary.len();
        for k in 0..n {
            let pi = b.boundary[k] as usize;
            let ang = k as f32 / n as f32 * std::f32::consts::TAU;
            let wave = (t * 3.1 + i as f32 * 1.7 + ang * 2.0).sin() * (t * 1.3 + i as f32).cos();
            let out = (b.x[pi] - c).normalize_or_zero();
            b.add_point_accel(pi, out * wave * 900.0);
        }
        let eaten_by = alive.iter().find(|(_, pc, r)| pc.distance(c) < r + 16.0).map(|a| a.0);
        if let Some(slot) = eaten_by {
            sim.collected[i] = true;
            sim.amoebas[i] = None;
            sim.tags.remove(&id);
            sim.world.remove_body(id);
            let color = crate::amoeba_color(i);
            // Where on the eater's hull it went in: the hull point nearest
            // the amoeba (the colour soaks in from there).
            let contact = sim
                .player(slot)
                .and_then(|p| sim.world.body(p.ctl.body))
                .and_then(|pb| pb.outline().min_by(|a, b| a.distance_squared(c).total_cmp(&b.distance_squared(c))))
                .unwrap_or(c);
            if let Some(pl) = sim.player_mut(slot) {
                pl.pickups += 1;
                pl.color = color;
            }
            sim.events.push(SimEvent::Pickup { index: i, pos: c, slot, color, contact });
        }
    }
    if let Some(goal) = sim.level.goal.as_ref().map(|g| g.outline()) {
        for (slot, c, _) in &alive {
            if geom::point_in_polygon(*c, &goal) {
                let first = !sim.completed;
                if let Some(p) = sim.player_mut(*slot) {
                    if !p.finished {
                        p.finished = true;
                        if first {
                            sim.completed = true;
                            sim.events.push(SimEvent::Goal { slot: *slot });
                        }
                    }
                }
            }
        }
    }
    for (i, st) in sim.level.story.clone().iter().enumerate() {
        if st.script.starts_with("plate:") {
            continue;
        }
        if st.once && sim.story_fired[i] {
            continue;
        }
        let poly = st.shape.outline();
        if let Some((slot, _, _)) = alive.iter().find(|(_, c, _)| geom::point_in_polygon(*c, &poly)) {
            if !sim.story_fired[i] {
                sim.story_fired[i] = true;
                sim.events.push(SimEvent::Story { script: st.script.clone(), slot: *slot });
            }
        }
    }
}

/// How much stronger than world gravity this body falls (blobs use 2.x's
/// gravity). Clinging bodies (scale 0) count as 1.
pub(crate) fn gadget_gravity(b: &bb_physics::Body) -> f32 {
    if b.params.gravity_scale > 0.0 { b.params.gravity_scale } else { 1.0 }
}
