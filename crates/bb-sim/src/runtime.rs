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
            let puff = b.rest_scale * b.rest_scale;
            let v = b.velocity();
            match &z.kind {
                ZoneKind::Wind { accel } => b.add_accel(*accel * frac * puff),
                ZoneKind::Water { buoyancy, drag, current } => {
                    wet.push((id, frac));
                    let density = (b.mass() / (b.rest_area.max(1.0) / 3200.0)).max(0.2);
                    b.add_accel(Vec2::new(0.0, buoyancy * frac * puff / density));
                    b.add_accel((*current - v) * (*drag * frac));
                }
                ZoneKind::Gravity { gravity: g } => b.add_accel((*g - gravity) * frac),
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
}

pub(crate) fn post_step(sim: &mut Sim, dt: f32) {
    let bodies = dynamic_bodies(sim);

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
                let b = sim.world.body_mut(id).unwrap();
                let v = b.velocity();
                b.add_velocity(dir * (power - v.dot(dir)));
                fired = true;
            }
        }
        if fired {
            sim.springs[si].cooldown = 0.2;
            sim.springs[si].squash = 1.0;
            sim.events.push(SimEvent::Spring { index: si });
        }
    }

    // Hazards: spikes, kill zones, falling out.
    let mut to_pop: Vec<BodyId> = Vec::new();
    let spike_bands: Vec<Vec<Vec2>> = sim
        .level
        .spikes
        .iter()
        .map(|s| {
            let n = (s.b - s.a).perp().normalize_or(Vec2::Y);
            vec![s.a, s.b, s.b + n * 24.0, s.a + n * 24.0]
        })
        .collect();
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
                respawned.push((p.ctl.body, at, Who::Player(p.slot)));
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
                respawned.push((n.ctl.body, at, Who::Npc(n.index)));
                n.ctl.reset();
            }
        }
    }
    for (body, at, who) in respawned {
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
    for (i, p) in sim.level.pickups.clone().iter().enumerate() {
        if sim.collected[i] {
            continue;
        }
        if let Some((slot, _, _)) = alive.iter().find(|(_, c, r)| c.distance(*p) < r + 18.0) {
            sim.collected[i] = true;
            if let Some(pl) = sim.player_mut(*slot) {
                pl.pickups += 1;
            }
            sim.events.push(SimEvent::Pickup { index: i, pos: *p, slot: *slot });
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
