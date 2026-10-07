//! Menus that fall in: jelly tiles drop from above the screen under real
//! gravity, and when one reaches its slot a home tether engages whose
//! compliance ramps from soft to firm, so it overshoots, bounces and wobbles
//! into place. Works on any `bb_physics::World` (the game's, or the pause
//! overlay's).

use bb_physics::{BodyId, Vec2 as PVec2, World};

#[derive(Clone, Copy, Debug)]
pub struct DropStyle {
    /// How far above its slot a body starts.
    pub lift: f32,
    /// Initial downward speed.
    pub fall_speed: f32,
    /// Gravity multiplier while falling (the world must have gravity).
    pub gravity_scale: f32,
    /// Home-tether compliance at the moment of the catch (soft = bouncy).
    pub soft: f32,
    /// Seconds for the tether to ramp from soft to the body's own stiffness.
    pub settle: f32,
    /// Fraction of the fall speed kept at the catch (rest is "absorbed").
    pub keep: f32,
    /// Linear damping while settling.
    pub damping: f32,
}

impl DropStyle {
    /// Title screen, sub-pages and the party lobby.
    pub const MENU: DropStyle = DropStyle { lift: 1050.0, fall_speed: 1600.0, gravity_scale: 2.2, soft: 3e-3, settle: 0.5, keep: 0.3, damping: 7.0 };
    /// The pause menu: shorter, softer drop.
    pub const GENTLE: DropStyle = DropStyle { lift: 650.0, fall_speed: 700.0, gravity_scale: 1.6, soft: 4e-3, settle: 0.45, keep: 0.35, damping: 4.0 };
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum State {
    Waiting,
    Falling(f32),
    Settling(f32),
    Done,
}

#[derive(Clone, Debug)]
struct Item {
    body: BodyId,
    slot: Vec<PVec2>,
    slot_y: f32,
    delay: f32,
    state: State,
    firm: f32,
    mask: u32,
    gravity: f32,
    damping: f32,
    /// Collisions restored (only once it no longer overlaps another tile,
    /// so an overshooting tile never wedges into its neighbour).
    solid: bool,
}

#[derive(Clone, Debug)]
pub struct DropIn {
    pub style: DropStyle,
    items: Vec<Item>,
    t: f32,
}

impl DropIn {
    pub fn new(style: DropStyle) -> DropIn {
        DropIn { style, items: Vec::new(), t: 0.0 }
    }

    /// Take a body that's sitting in its slot (home-anchored or not), lift
    /// it out of sight and schedule it to drop after `delay` seconds.
    pub fn add(&mut self, world: &mut World, id: BodyId, delay: f32) {
        let lift = self.style.lift;
        let Some(b) = world.body_mut(id) else { return };
        let slot = b.home.take().unwrap_or_else(|| b.x.clone());
        let slot_y = slot.iter().map(|p| p.y).sum::<f32>() / slot.len().max(1) as f32;
        let item = Item {
            body: id,
            slot,
            slot_y,
            delay: self.t + delay,
            state: State::Waiting,
            firm: b.home_compliance,
            mask: b.mask,
            gravity: b.params.gravity_scale,
            damping: b.params.linear_damping,
            solid: false,
        };
        b.mask = 0;
        b.params.gravity_scale = 0.0;
        b.translate(PVec2::new(0.0, lift));
        b.v.iter_mut().for_each(|v| *v = PVec2::ZERO);
        self.items.push(item);
    }

    pub fn clear(&mut self) {
        self.items.clear();
        self.t = 0.0;
    }

    /// True once every body has landed and firmed up.
    pub fn done(&self) -> bool {
        self.items.iter().all(|i| i.state == State::Done && i.solid)
    }

    /// Has this body been caught by its slot yet (it's tappable either way)?
    pub fn landed(&self, id: BodyId) -> bool {
        self.items.iter().find(|i| i.body == id).is_none_or(|i| matches!(i.state, State::Settling(_) | State::Done))
    }

    pub fn update(&mut self, world: &mut World, dt: f32) {
        self.t += dt;
        let s = self.style;
        for it in self.items.iter_mut() {
            let Some(b) = world.body_mut(it.body) else {
                it.state = State::Done;
                continue;
            };
            match it.state {
                State::Waiting => {
                    if self.t >= it.delay {
                        it.state = State::Falling(0.0);
                        b.params.gravity_scale = s.gravity_scale;
                        b.v.iter_mut().for_each(|v| *v = PVec2::new(0.0, -s.fall_speed));
                    }
                }
                State::Falling(t) => {
                    let t = t + dt;
                    it.state = State::Falling(t);
                    if b.centroid().y <= it.slot_y || t > 1.5 {
                        // Caught: a soft spring to the slot, gravity off.
                        b.params.gravity_scale = it.gravity;
                        b.params.linear_damping = s.damping;
                        b.home = Some(it.slot.clone());
                        b.home_compliance = s.soft;
                        for v in b.v.iter_mut() {
                            *v *= s.keep;
                        }
                        it.state = State::Settling(0.0);
                    }
                }
                State::Settling(t) => {
                    let t = t + dt;
                    let k = (t / s.settle).clamp(0.0, 1.0);
                    let e = k * k * (3.0 - 2.0 * k);
                    b.home_compliance = (s.soft.ln() + (it.firm.ln() - s.soft.ln()) * e).exp();
                    if k >= 1.0 {
                        b.home_compliance = it.firm;
                        b.params.linear_damping = it.damping;
                        it.state = State::Done;
                    } else {
                        it.state = State::Settling(t);
                    }
                }
                State::Done => {}
            }
        }
        // Ghosts become solid again once clear of every other tile.
        for k in 0..self.items.len() {
            let it = &self.items[k];
            if it.solid || matches!(it.state, State::Waiting | State::Falling(_)) {
                continue;
            }
            let Some(aabb) = world.body(it.body).map(|b| b.aabb) else { continue };
            let blocked = self.items.iter().enumerate().any(|(j, o)| {
                j != k && !matches!(o.state, State::Waiting) && world.body(o.body).is_some_and(|ob| ob.aabb.overlaps(&aabb))
            });
            if !blocked {
                let it = &mut self.items[k];
                it.solid = true;
                if let Some(b) = world.body_mut(it.body) {
                    b.mask = it.mask;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bb_physics::{BodyDesc, Config};

    fn tile(world: &mut World, c: PVec2) -> BodyId {
        let mut d = BodyDesc::grid(c - PVec2::new(200.0, 35.0), c + PVec2::new(200.0, 35.0), 18, 3, 11.0);
        d.params.shape_compliance = Some(2e-4);
        d.params.edge_compliance = 2e-5;
        d.params.tri_compliance = 2e-5;
        d.params.internal_damping = 2.5;
        d.params.gravity_scale = 0.0;
        let id = world.add_body(d);
        world.body_mut(id).unwrap().anchor_home(2e-4);
        id
    }

    #[test]
    fn tiles_fall_overshoot_and_settle_in_time() {
        let mut world = World::new(Config::default());
        let slot = PVec2::new(0.0, 300.0);
        let id = tile(&mut world, slot);
        let mut drop = DropIn::new(DropStyle::MENU);
        drop.add(&mut world, id, 0.5);
        assert!(world.body(id).unwrap().centroid().y > slot.y + 1000.0);
        let dt = 1.0 / 60.0;
        let mut min_y = f32::MAX;
        let mut t = 0.0;
        while t < 1.6 {
            drop.update(&mut world, dt);
            world.step(dt);
            t += dt;
            min_y = min_y.min(world.body(id).unwrap().centroid().y);
        }
        let b = world.body(id).unwrap();
        assert!(drop.done(), "settled by 1.6 s (0.5 s delay)");
        assert!(slot.y - min_y > 8.0, "overshoots its slot for a bounce (min {min_y})");
        assert!(slot.y - min_y < 140.0, "but not wildly (min {min_y})");
        assert!((b.centroid() - slot).length() < 6.0, "back home: {}", b.centroid());
        assert_eq!(b.mask, u32::MAX);
    }

    #[test]
    fn gentle_style_works_in_a_weightless_world_with_gravity() {
        let mut world = World::new(Config::default());
        let id = tile(&mut world, PVec2::ZERO);
        let mut drop = DropIn::new(DropStyle::GENTLE);
        drop.add(&mut world, id, 0.0);
        for _ in 0..80 {
            drop.update(&mut world, 1.0 / 60.0);
            world.step(1.0 / 60.0);
        }
        assert!(drop.done());
        assert!(world.body(id).unwrap().centroid().length() < 6.0);
    }
}
