//! Gadgets: JellyCar-style machines a blob rides or carries.
//!
//! * **Launch plate** — a big spinning stone gear. Touch it and it grips you
//!   to its rim, spins up, and flings you off tangentially at its release
//!   point. Swell as it lets go (or just after) for the spring/mushroom
//!   swell boost (`tuning.toml` `[jump] bounce_boost / bounce_window`).
//! * **Seed pod** (launcher) — roll or fly into its mouth and it swallows
//!   you; its barrel swings; press to fire (or it fires itself) along the
//!   barrel with a strong shove.
//! * **Balloon** — touch it to tie it on. While you have it, swelling lifts
//!   you (lift scales with how puffed you are, rise speed capped) and
//!   letting go sinks you gently. Lasts a few seconds; pops on spikes,
//!   blades and kill zones (then you fall); floats back home after a beat.
//! * **Claw crane** — stand under the claw and it grabs you, carries you
//!   along its rail and lets go. Where it lets go, only a swollen blob is
//!   wide enough to wedge across the gap and reach the ledge.
//!
//! Holds (plate rim, pod, claw) steer the blob's centroid velocity after
//! each physics step, like a stiff spring to the gadget's grip point; the
//! soft body keeps wobbling inside. Levels author gadgets as
//! [`bb_level::Gadget`]s (builder: `launch_plate`, `seed_pod`, `balloon`,
//! `crane`).

use bb_level::{GadgetKind, ZoneKind};
use bb_physics::{Aabb, BodyId, Collider, StaticDesc, StaticId, Vec2, geom};

use crate::{LateBoost, Sim, SimEvent, load};

/// Gadget feel constants.
pub mod tune {
    /// Plate idle spin, as a fraction of full spin.
    pub const PLATE_IDLE: f32 = 0.16;
    /// Plates let go once spun up to this fraction of full spin.
    pub const PLATE_READY: f32 = 0.97;
    /// Seconds before a flung blob can be gripped again.
    pub const PLATE_COOLDOWN: f32 = 0.7;
    /// Bumps on the gear's rim.
    pub const PLATE_TEETH: usize = 8;
    pub const PLATE_TOOTH_H: f32 = 14.0;
    /// A blob whose centre comes this close to a pod's mouth is swallowed.
    pub const POD_CATCH: f32 = 66.0;
    /// Seconds a pod holds you before a press can fire it.
    pub const POD_MIN_HOLD: f32 = 0.3;
    pub const POD_COOLDOWN: f32 = 0.6;
    pub const BALLOON_R: f32 = 30.0;
    /// String from the top of the blob to the balloon's knot.
    pub const BALLOON_STRING: f32 = 80.0;
    /// Lift as a fraction of the blob's gravity: deflated (sinks) / fully
    /// puffed (rises).
    pub const BALLOON_LIFT_MIN: f32 = 0.62;
    pub const BALLOON_LIFT_MAX: f32 = 1.34;
    /// Fastest sink and sideways drift while ballooning.
    pub const BALLOON_SINK: f32 = 300.0;
    pub const BALLOON_DRIFT: f32 = 540.0;
    /// Seconds before a used / popped balloon floats back.
    pub const BALLOON_RESPAWN: f32 = 2.0;
    /// Claw: reach down for you, close, lift, (carry), pause, open.
    pub const CLAW_REACH: f32 = 0.35;
    pub const CLAW_CLOSE: f32 = 0.2;
    pub const CLAW_LIFT: f32 = 0.45;
    pub const CLAW_PAUSE: f32 = 0.45;
    pub const CLAW_OPEN: f32 = 0.7;
    /// How far below the claw (and either side) it notices you.
    pub const CLAW_SEE_DOWN: f32 = 230.0;
    pub const CLAW_SEE_SIDE: f32 = 64.0;
    /// While reaching, the claw follows a rolling blob this far from home.
    pub const CLAW_FOLLOW: f32 = 160.0;
    /// Velocity gain steering a held blob to its grip point (1/s).
    pub const HOLD_GAIN: f32 = 12.0;
    /// A held blob farther than this from its grip point was teleported
    /// (respawn, Kids Mode bounce home): let it go.
    pub const HOLD_SNAP: f32 = 260.0;
}

/// What a gadget did (sounds, fx, achievements).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum GadgetEvent {
    PlateGrip,
    PlateLaunch { boosted: bool },
    PodLoad,
    PodFire,
    BalloonTie,
    BalloonPop,
    /// Ran out of time: the balloon floats away.
    BalloonGone,
    CraneGrab,
    CraneDrop,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ClawPhase {
    Idle,
    Reach,
    Close,
    Lift,
    Carry,
    Pause,
    Open,
    Return,
}

#[derive(Clone, Debug)]
pub struct Rider {
    pub body: BodyId,
    /// Angle of the blob around the axle.
    pub phi: f32,
}

/// Runtime state per gadget kind.
#[derive(Clone, Debug)]
pub enum GadgetRt {
    Plate {
        id: StaticId,
        /// Outline around the axle at angle 0.
        local: Vec<Vec2>,
        angle: f32,
        /// Spin rate magnitude (rad/s) and its full value.
        spin: f32,
        full: f32,
        riders: Vec<Rider>,
    },
    Pod {
        /// Current barrel direction (radians).
        aim: f32,
        /// Swallowed blob and how long it's been inside.
        loaded: Option<(BodyId, f32)>,
        /// 1 on firing, decays (visual kick).
        recoil: f32,
    },
    Balloon {
        carrier: Option<BodyId>,
        pos: Vec2,
        vel: Vec2,
        /// Seconds of lift left.
        left: f32,
        /// > 0: gone (popped / floated off), back home when it runs out.
        away: f32,
        /// Popped (shreds) rather than floated off.
        popped: bool,
        /// 0..1 how puffed the carrier is (visual).
        inflate: f32,
        /// Squashed against a roof (visual).
        pressed: bool,
    },
    Crane {
        phase: ClawPhase,
        t: f32,
        claw: Vec2,
        claw_vel: Vec2,
        held: Option<BodyId>,
        grab_at: Vec2,
        /// 0 = closed, 1 = open (visual).
        open: f32,
    },
}

#[derive(Clone, Debug)]
pub struct GadgetState {
    pub def: bb_level::Gadget,
    pub rt: GadgetRt,
    /// Bodies recently let go (no instant re-grab): (body, seconds left).
    pub cooldown: Vec<(BodyId, f32)>,
    /// 0..1 how busy it is (glows while active).
    pub glow: f32,
    /// 1 on use, decays (pulses on use).
    pub pulse: f32,
}

impl GadgetState {
    /// Seconds-of-balloon fraction left (1 = fresh), for the view.
    pub fn balloon_left(&self) -> f32 {
        match (&self.def.kind, &self.rt) {
            (GadgetKind::Balloon { duration, .. }, GadgetRt::Balloon { left, carrier: Some(_), .. }) => (left / duration.max(0.1)).clamp(0.0, 1.0),
            _ => 1.0,
        }
    }

    /// Where the claw would be holding a blob at the drop point.
    pub fn crane_drop(&self) -> Option<Vec2> {
        match self.def.kind {
            GadgetKind::Crane { to, .. } => Some(self.def.pos + to),
            _ => None,
        }
    }
}

/// The plate's gear outline around its axle.
pub fn plate_outline(radius: f32) -> Vec<Vec2> {
    let n = 64;
    (0..n)
        .map(|i| {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            // Rounded teeth: a smooth bump per tooth.
            let k = (a * tune::PLATE_TEETH as f32).cos().max(0.0).powf(3.0);
            Vec2::from_angle(a) * (radius + tune::PLATE_TOOTH_H * k)
        })
        .collect()
}

/// Build runtime state (plates get their spinning collider).
pub(crate) fn load(sim: &mut Sim) {
    for g in sim.level.gadgets.clone() {
        let rt = match &g.kind {
            GadgetKind::LaunchPlate { radius, speed, .. } => {
                let local = plate_outline(*radius);
                let mut d = StaticDesc::polygon(local.iter().map(|p| g.pos + *p).collect());
                d.material = load::material(bb_level::Material::Stone);
                let id = sim.world.add_static(d);
                let full = speed / (radius + crate::control::tune::RADIUS);
                GadgetRt::Plate { id, local, angle: 0.0, spin: full * tune::PLATE_IDLE, full, riders: Vec::new() }
            }
            GadgetKind::Launcher { angle, .. } => GadgetRt::Pod { aim: *angle, loaded: None, recoil: 0.0 },
            GadgetKind::Balloon { .. } => GadgetRt::Balloon { carrier: None, pos: g.pos, vel: Vec2::ZERO, left: 0.0, away: 0.0, popped: false, inflate: 0.0, pressed: false },
            GadgetKind::Crane { .. } => GadgetRt::Crane { phase: ClawPhase::Idle, t: 0.0, claw: g.pos, claw_vel: Vec2::ZERO, held: None, grab_at: g.pos, open: 1.0 },
        };
        sim.gadgets.push(GadgetState { def: g, rt, cooldown: Vec::new(), glow: 0.0, pulse: 0.0 });
    }
}

/// A living blob, as gadgets see it.
#[derive(Copy, Clone, Debug)]
struct Blob {
    body: BodyId,
    /// Current (swollen) radius.
    r: f32,
    /// 0..1 how puffed up (0 = rest size, 1 = full swell).
    puff: f32,
    swell: f32,
    pressed: bool,
    /// A player (balloons are for players; followers would steal them).
    player: bool,
}

fn blobs(sim: &Sim) -> Vec<Blob> {
    let window = sim.tuning.jump.bounce_window;
    let full = (sim.tuning.jump.expand_scale - 1.0).max(0.1);
    sim.players
        .iter()
        .filter(|p| p.dead.is_none())
        .map(|p| (&p.ctl, true))
        .chain(sim.npcs.iter().filter(|n| n.dead.is_none()).map(|n| (&n.ctl, false)))
        .filter(|(c, _)| sim.world.body(c.body).is_some_and(|b| b.enabled))
        .map(|(c, player)| Blob {
            body: c.body,
            r: c.radius * c.expand.max(1.0),
            puff: ((c.expand - 1.0) / full).clamp(0.0, 1.0),
            swell: c.swell(window),
            pressed: c.just_pressed(0.15),
            player,
        })
        .collect()
}

fn wrap(a: f32) -> f32 {
    let t = std::f32::consts::TAU;
    let x = (a + std::f32::consts::PI).rem_euclid(t) - std::f32::consts::PI;
    if x <= -std::f32::consts::PI { x + t } else { x }
}

fn smooth(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Steer a body's centroid toward `target` moving at `vel`. Returns false
/// if it's too far (teleported) to keep holding.
fn steer(sim: &mut Sim, body: BodyId, target: Vec2, vel: Vec2) -> bool {
    let Some(b) = sim.world.body_mut(body).filter(|b| b.enabled) else { return false };
    let c = b.centroid();
    if c.distance(target) > tune::HOLD_SNAP {
        return false;
    }
    let want = vel + (target - c) * tune::HOLD_GAIN;
    let v = b.velocity();
    b.add_velocity(want - v);
    true
}

/// Polygons that pop a balloon: spike bands (floor, roof and spiked
/// movers), blades / lethal movers, kill zones.
fn hazards(sim: &Sim) -> Vec<Vec<Vec2>> {
    let mut out: Vec<Vec<Vec2>> = sim
        .level
        .spikes
        .iter()
        .map(|s| {
            let n = (s.b - s.a).perp().normalize_or(Vec2::Y);
            vec![s.a, s.b, s.b + n * 26.0, s.a + n * 26.0]
        })
        .collect();
    for m in &sim.movers {
        let Some(s) = sim.world.static_collider(m.id) else { continue };
        if m.def.lethal {
            out.push(s.poly.clone());
        } else if m.def.spiked {
            let bb = Aabb::from_points(s.poly.iter().copied());
            out.push(vec![Vec2::new(bb.min.x, bb.min.y - 26.0), Vec2::new(bb.max.x, bb.min.y - 26.0), Vec2::new(bb.max.x, bb.min.y + 2.0), Vec2::new(bb.min.x, bb.min.y + 2.0)]);
        }
    }
    out.extend(sim.level.zones.iter().filter(|z| matches!(z.kind, ZoneKind::Kill)).map(|z| z.shape.outline()));
    out
}

fn circle_hits(poly: &[Vec2], c: Vec2, r: f32) -> bool {
    let bb = Aabb::from_points(poly.iter().copied()).expand(r);
    if !bb.contains(c) {
        return false;
    }
    geom::point_in_polygon(c, poly) || (0..poly.len()).any(|k| geom::closest_on_segment(c, poly[k], poly[(k + 1) % poly.len()]).0.distance_squared(c) < r * r)
}

/// Before the physics step: spin plates, lift balloon carriers.
pub(crate) fn pre_step(sim: &mut Sim, dt: f32) {
    if sim.gadgets.is_empty() {
        return;
    }
    let blob_list = blobs(sim);
    let g_world = sim.world.config.gravity.length();
    for gi in 0..sim.gadgets.len() {
        let pos = sim.gadgets[gi].def.pos;
        let kind = sim.gadgets[gi].def.kind.clone();
        match (&kind, &mut sim.gadgets[gi].rt) {
            (GadgetKind::LaunchPlate { clockwise, spin_up, .. }, GadgetRt::Plate { id, local, angle, spin, full, riders }) => {
                let target = if riders.is_empty() { tune::PLATE_IDLE } else { 1.0 } * *full;
                let rate = *full / spin_up.max(0.05);
                let rate = if target > *spin { rate } else { rate * 0.4 };
                *spin += (target - *spin).clamp(-rate * dt, rate * dt);
                let dir = if *clockwise { -1.0 } else { 1.0 };
                *angle = wrap(*angle + dir * *spin * dt);
                let rot = Vec2::from_angle(*angle);
                let poly: Vec<Vec2> = local.iter().map(|p| pos + rot.rotate(*p)).collect();
                sim.world.move_static(*id, poly);
            }
            (_, GadgetRt::Balloon { carrier: Some(body), .. }) => {
                let body = *body;
                let Some(bl) = blob_list.iter().find(|b| b.body == body) else { continue };
                let Some(b) = sim.world.body_mut(body) else { continue };
                let gb = g_world * crate::runtime::gadget_gravity(b);
                let lift = tune::BALLOON_LIFT_MIN + (tune::BALLOON_LIFT_MAX - tune::BALLOON_LIFT_MIN) * bl.puff;
                b.add_accel(Vec2::Y * gb * lift);
            }
            _ => {}
        }
    }
}

/// After the physics step: grips, launches, holds, balloons, claws.
pub(crate) fn post_step(sim: &mut Sim, dt: f32) {
    if sim.gadgets.is_empty() {
        return;
    }
    let blob_list = blobs(sim);
    let boost = sim.tuning.jump.bounce_boost;
    let time = sim.time;
    // Who's already in a gadget's hands (nobody gets grabbed twice).
    let mut held: Vec<BodyId> = Vec::new();
    for g in &sim.gadgets {
        match &g.rt {
            GadgetRt::Plate { riders, .. } => held.extend(riders.iter().map(|r| r.body)),
            GadgetRt::Pod { loaded: Some((b, _)), .. } => held.push(*b),
            GadgetRt::Crane { held: Some(b), .. } => held.push(*b),
            _ => {}
        }
    }
    let carrying: Vec<BodyId> = sim.gadgets.iter().filter_map(|g| if let GadgetRt::Balloon { carrier: Some(b), .. } = g.rt { Some(b) } else { None }).collect();
    let danger = if sim.gadgets.iter().any(|g| matches!(g.rt, GadgetRt::Balloon { carrier: Some(_), .. })) { hazards(sim) } else { Vec::new() };
    let mut events: Vec<(usize, GadgetEvent, Vec2)> = Vec::new();

    for gi in 0..sim.gadgets.len() {
        {
            let g = &mut sim.gadgets[gi];
            g.cooldown.retain_mut(|c| {
                c.1 -= dt;
                c.1 > 0.0
            });
            g.pulse = (g.pulse - dt * 1.6).max(0.0);
        }
        let pos = sim.gadgets[gi].def.pos;
        let kind = sim.gadgets[gi].def.kind.clone();
        let cooling: Vec<BodyId> = sim.gadgets[gi].cooldown.iter().map(|c| c.0).collect();
        let free = |b: &Blob, held: &[BodyId]| !held.contains(&b.body) && !cooling.contains(&b.body);
        match kind {
            // ------------------------------------------------------ plate
            GadgetKind::LaunchPlate { radius, angle: launch, clockwise, .. } => {
                let GadgetRt::Plate { id, spin, full, riders, .. } = sim.gadgets[gi].rt.clone() else { continue };
                let dir = if clockwise { -1.0 } else { 1.0 };
                let omega = dir * spin;
                let release = wrap(launch - dir * std::f32::consts::FRAC_PI_2);
                let ready = spin >= full * tune::PLATE_READY;
                let mut keep = Vec::new();
                for mut r in riders {
                    let Some(bl) = blob_list.iter().find(|b| b.body == r.body).copied() else { continue };
                    let before = wrap(r.phi - release);
                    r.phi = wrap(r.phi + omega * dt);
                    let after = wrap(r.phi - release);
                    let crossed = (after - before).abs() < std::f32::consts::PI && before * dir < 0.0 && after * dir >= 0.0;
                    if ready && crossed {
                        // Let go: tangentially, at the rim speed you rode at.
                        let speed = spin * (radius + crate::control::tune::RADIUS);
                        let ldir = Vec2::from_angle(launch);
                        let Some(b) = sim.world.body_mut(r.body) else { continue };
                        let v = b.velocity();
                        let boosted = bl.swell > 0.5;
                        b.add_velocity(ldir * speed * (1.0 + boost * bl.swell) - v);
                        let c = b.centroid();
                        if boosted {
                            sim.events.push(SimEvent::SuperBounce { body: r.body, pos: c });
                        } else {
                            sim.late_boosts.push(LateBoost { body: r.body, dir: ldir, speed, age: 0.0 });
                        }
                        sim.gadgets[gi].cooldown.push((r.body, tune::PLATE_COOLDOWN));
                        sim.gadgets[gi].pulse = 1.0;
                        events.push((gi, GadgetEvent::PlateLaunch { boosted }, c));
                        continue;
                    }
                    // Ride just clear of the teeth (a swollen blob rubbing them
                    // would lose its fling).
                    let ride = radius + bl.r + 8.0;
                    let d = Vec2::from_angle(r.phi);
                    if steer(sim, r.body, pos + d * ride, d.perp() * omega * ride) {
                        keep.push(r);
                    }
                }
                // New riders: anyone touching the gear.
                let candidates: Vec<Blob> = blob_list.iter().filter(|b| free(b, &held)).copied().collect();
                for bl in candidates.iter() {
                    if keep.iter().any(|r| r.body == bl.body) {
                        continue;
                    }
                    if sim.world.contacts_of(bl.body).any(|c| c.other == Collider::Static(id)) {
                        let c = sim.world.body(bl.body).map_or(pos, |b| b.centroid());
                        keep.push(Rider { body: bl.body, phi: (c - pos).to_angle() });
                        held.push(bl.body);
                        events.push((gi, GadgetEvent::PlateGrip, c));
                    }
                }
                let g = &mut sim.gadgets[gi];
                g.glow = (spin / full.max(1e-3)).clamp(0.0, 1.0);
                if let GadgetRt::Plate { riders, .. } = &mut g.rt {
                    *riders = keep;
                }
            }
            // -------------------------------------------------------- pod
            GadgetKind::Launcher { angle, sweep, period, power, hold } => {
                let GadgetRt::Pod { loaded, recoil, .. } = sim.gadgets[gi].rt.clone() else { continue };
                let aim = angle + sweep * (time * std::f32::consts::TAU / period.max(0.1)).sin();
                let mut loaded = loaded;
                let recoil = (recoil - dt * 2.5).max(0.0);
                let mut new_recoil = recoil;
                if let Some((body, t)) = loaded {
                    let t = t + dt;
                    let bl = blob_list.iter().find(|b| b.body == body).copied();
                    match bl {
                        None => loaded = None,
                        Some(bl) if t >= tune::POD_MIN_HOLD && (bl.pressed || t >= hold) => {
                            let Some(b) = sim.world.body_mut(body) else { continue };
                            let v = b.velocity();
                            let power = power * crate::runtime::gadget_gravity(b).sqrt();
                            b.add_velocity(Vec2::from_angle(aim) * power - v);
                            loaded = None;
                            new_recoil = 1.0;
                            sim.gadgets[gi].cooldown.push((body, tune::POD_COOLDOWN));
                            sim.gadgets[gi].pulse = 1.0;
                            events.push((gi, GadgetEvent::PodFire, pos));
                        }
                        Some(_) => {
                            loaded = if steer(sim, body, pos, Vec2::ZERO) { Some((body, t)) } else { None };
                        }
                    }
                } else if let Some(bl) = blob_list.iter().filter(|b| free(b, &held)).find(|b| sim.world.body(b.body).is_some_and(|x| x.centroid().distance(pos) < tune::POD_CATCH)).copied() {
                    loaded = Some((bl.body, 0.0));
                    held.push(bl.body);
                    sim.gadgets[gi].pulse = 0.7;
                    events.push((gi, GadgetEvent::PodLoad, pos));
                }
                let g = &mut sim.gadgets[gi];
                g.glow = if loaded.is_some() { (g.glow + dt * 3.0).min(1.0) } else { (g.glow - dt * 1.5).max(0.0) };
                g.rt = GadgetRt::Pod { aim, loaded, recoil: new_recoil };
            }
            // ---------------------------------------------------- balloon
            GadgetKind::Balloon { duration, rise } => {
                let GadgetRt::Balloon { mut carrier, pos: mut bpos, mut vel, mut left, mut away, mut popped, mut inflate, .. } = sim.gadgets[gi].rt.clone() else { continue };
                let mut pressed = false;
                if away > 0.0 {
                    away -= dt;
                    vel.y += 260.0 * dt;
                    bpos += vel * dt;
                    if away <= 0.0 {
                        away = 0.0;
                        bpos = pos;
                        vel = Vec2::ZERO;
                        popped = false;
                    }
                } else if let Some(body) = carrier {
                    let bl = blob_list.iter().find(|b| b.body == body).copied();
                    let c = sim.world.body(body).filter(|b| b.enabled).map(|b| b.centroid());
                    left -= dt;
                    match (bl, c) {
                        (Some(bl), Some(c)) if left > 0.0 => {
                            inflate += (bl.puff - inflate) * (dt * 10.0).min(1.0);
                            // The balloon trails on its string above you.
                            let knot = c + Vec2::new(0.0, bl.r);
                            let want = knot + Vec2::new(0.0, tune::BALLOON_STRING + tune::BALLOON_R);
                            vel += ((want - bpos) * 90.0 - vel * 11.0) * dt;
                            bpos += vel * dt;
                            let off = bpos - knot;
                            let max = tune::BALLOON_STRING + tune::BALLOON_R;
                            if off.length() > max {
                                bpos = knot + off.normalize() * max;
                            }
                            // A roof stops the balloon (and so you).
                            let up = sim.world.raycast(c, Vec2::Y, bl.r + max + tune::BALLOON_R, load::layer::WORLD, Some(body));
                            let mut cap_up = rise;
                            if let Some((_, hit, _, d)) = up {
                                bpos.y = bpos.y.min(hit.y - tune::BALLOON_R);
                                let room = d - bl.r;
                                if room < max + tune::BALLOON_R - 6.0 {
                                    pressed = true;
                                    cap_up = ((room - (max + tune::BALLOON_R)) * 3.0).clamp(-tune::BALLOON_SINK, 0.0);
                                }
                            }
                            if let Some(b) = sim.world.body_mut(body) {
                                let v = b.velocity();
                                let mut w = v;
                                w.y = w.y.clamp(-tune::BALLOON_SINK, cap_up);
                                w.x = w.x.clamp(-tune::BALLOON_DRIFT, tune::BALLOON_DRIFT);
                                if w != v {
                                    b.add_velocity(w - v);
                                }
                            }
                            let r = tune::BALLOON_R * (0.85 + 0.3 * inflate);
                            if danger.iter().any(|h| circle_hits(h, bpos, r)) {
                                carrier = None;
                                away = tune::BALLOON_RESPAWN;
                                popped = true;
                                vel = Vec2::ZERO;
                                sim.gadgets[gi].pulse = 1.0;
                                events.push((gi, GadgetEvent::BalloonPop, bpos));
                            }
                        }
                        _ => {
                            carrier = None;
                            away = tune::BALLOON_RESPAWN;
                            popped = false;
                            vel = Vec2::new(0.0, 120.0);
                            events.push((gi, GadgetEvent::BalloonGone, bpos));
                        }
                    }
                } else {
                    // Waiting at home, bobbing.
                    inflate = 0.0;
                    bpos = pos + Vec2::new((time * 0.9 + gi as f32).sin() * 4.0, (time * 1.6 + gi as f32).sin() * 7.0);
                    vel = Vec2::ZERO;
                    let taker = blob_list.iter().filter(|b| b.player && free(b, &held) && !carrying.contains(&b.body)).find(|b| {
                        sim.world.body(b.body).is_some_and(|x| x.centroid().distance(bpos) < b.r + tune::BALLOON_R + 6.0)
                    });
                    if let Some(bl) = taker {
                        carrier = Some(bl.body);
                        left = duration;
                        sim.gadgets[gi].pulse = 1.0;
                        events.push((gi, GadgetEvent::BalloonTie, bpos));
                    }
                }
                let g = &mut sim.gadgets[gi];
                g.glow = if carrier.is_some() { 0.4 + 0.6 * inflate } else { 0.0 };
                g.rt = GadgetRt::Balloon { carrier, pos: bpos, vel, left, away, popped, inflate, pressed };
            }
            // ------------------------------------------------------ crane
            GadgetKind::Crane { to, travel } => {
                let GadgetRt::Crane { mut phase, mut t, claw, held: mut hold, mut grab_at, mut open, .. } = sim.gadgets[gi].rt.clone() else { continue };
                let home = pos;
                let drop = pos + to;
                // Return trips take as long as the way out (scaled by distance).
                let ret = (travel * grab_at.distance(home) / to.length().max(1.0)).max(tune::CLAW_LIFT);
                t += dt;
                let mut next = None;
                match phase {
                    ClawPhase::Idle => {
                        let seen = blob_list.iter().filter(|b| free(b, &held)).find_map(|b| {
                            let c = sim.world.body(b.body)?.centroid();
                            ((c.x - home.x).abs() < tune::CLAW_SEE_SIDE && c.y < home.y + 30.0 && c.y > home.y - tune::CLAW_SEE_DOWN).then_some(c)
                        });
                        if let Some(c) = seen {
                            grab_at = Vec2::new(home.x, c.y.min(home.y));
                            next = Some(ClawPhase::Reach);
                        }
                    }
                    ClawPhase::Reach if t < tune::CLAW_REACH => {
                        // Follow a blob still rolling across the pad.
                        let near = blob_list.iter().filter(|b| free(b, &held)).filter_map(|b| sim.world.body(b.body).map(|x| x.centroid())).filter(|c| c.distance(grab_at) < 160.0).min_by(|a, b| a.distance(grab_at).total_cmp(&b.distance(grab_at)));
                        if let Some(c) = near {
                            grab_at = Vec2::new(c.x.clamp(home.x - tune::CLAW_FOLLOW, home.x + tune::CLAW_FOLLOW), c.y.min(home.y));
                        }
                    }
                    ClawPhase::Reach => {
                        // Close on whoever is there now.
                        let got = blob_list.iter().filter(|b| free(b, &held)).find(|b| sim.world.body(b.body).is_some_and(|x| x.centroid().distance(grab_at) < b.r + 40.0));
                        if let Some(bl) = got {
                            hold = Some(bl.body);
                            held.push(bl.body);
                            sim.gadgets[gi].pulse = 1.0;
                            events.push((gi, GadgetEvent::CraneGrab, grab_at));
                            next = Some(ClawPhase::Close);
                        } else {
                            next = Some(ClawPhase::Return);
                        }
                    }
                    ClawPhase::Close if t >= tune::CLAW_CLOSE => next = Some(ClawPhase::Lift),
                    ClawPhase::Lift if t >= tune::CLAW_LIFT => next = Some(ClawPhase::Carry),
                    ClawPhase::Carry if t >= travel => next = Some(ClawPhase::Pause),
                    ClawPhase::Pause if t >= tune::CLAW_PAUSE => {
                        if let Some(b) = hold.take() {
                            sim.gadgets[gi].cooldown.push((b, 1.0));
                            sim.gadgets[gi].pulse = 1.0;
                            events.push((gi, GadgetEvent::CraneDrop, drop));
                        }
                        next = Some(ClawPhase::Open);
                    }
                    ClawPhase::Open if t >= tune::CLAW_OPEN => {
                        grab_at = drop;
                        next = Some(ClawPhase::Return);
                    }
                    ClawPhase::Return if t >= ret => next = Some(ClawPhase::Idle),
                    _ => {}
                }
                if let Some(p) = next {
                    phase = p;
                    t = 0.0;
                }
                // Where the claw is in its routine (`grab_at` is where a
                // return trip starts).
                let (at, closed) = match phase {
                    ClawPhase::Idle => (home + Vec2::new(0.0, (time * 1.3).sin() * 4.0), 0.0),
                    ClawPhase::Reach => (home.lerp(grab_at, smooth(t / tune::CLAW_REACH)), 0.0),
                    ClawPhase::Close => (grab_at, smooth(t / tune::CLAW_CLOSE)),
                    ClawPhase::Lift => (grab_at.lerp(home, smooth(t / tune::CLAW_LIFT)), 1.0),
                    ClawPhase::Carry => (home.lerp(drop, smooth(t / travel.max(0.1))), 1.0),
                    ClawPhase::Pause => (drop, 1.0),
                    ClawPhase::Open => (drop, 1.0 - smooth(t / 0.2)),
                    ClawPhase::Return => (grab_at.lerp(home, smooth(t / ret)), 0.0),
                };
                let claw_vel = (at - claw) / dt.max(1e-4);
                open += ((1.0 - closed) - open) * (dt * 12.0).min(1.0);
                if let Some(b) = hold {
                    if !steer(sim, b, at, claw_vel) {
                        hold = None;
                    }
                }
                let g = &mut sim.gadgets[gi];
                g.glow = if hold.is_some() { 1.0 } else if phase == ClawPhase::Idle { 0.15 } else { 0.5 };
                g.rt = GadgetRt::Crane { phase, t, claw: at, claw_vel, held: hold, grab_at, open };
            }
        }
    }
    for (index, what, pos) in events {
        sim.events.push(SimEvent::Gadget { index, what, pos });
    }
}

/// Is `body` in a gadget's grip right now (plate rim, pod, claw)?
pub fn is_held(sim: &Sim, body: BodyId) -> bool {
    sim.gadgets.iter().any(|g| match &g.rt {
        GadgetRt::Plate { riders, .. } => riders.iter().any(|r| r.body == body),
        GadgetRt::Pod { loaded, .. } => loaded.is_some_and(|l| l.0 == body),
        GadgetRt::Crane { held, .. } => *held == Some(body),
        GadgetRt::Balloon { .. } => false,
    })
}

/// Is `body` carrying a balloon?
pub fn has_balloon(sim: &Sim, body: BodyId) -> bool {
    sim.gadgets.iter().any(|g| matches!(g.rt, GadgetRt::Balloon { carrier: Some(b), .. } if b == body))
}
