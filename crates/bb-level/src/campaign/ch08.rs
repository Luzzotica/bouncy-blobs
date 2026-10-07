//! Chapter 8 — **The Toy Pile** (Lost-Toy Midden).
//!
//! Everything that ever fell down the well ends up here: balls, blocks,
//! crayons, socks, wind-up cars, slinkies. The crazy chapter. Push a huge
//! bouncy ball into a pit to make a bridge (JellyCar-style), wobble over a
//! see-saw, ride a wind-up car across a spiky track, swing up slinkies,
//! climb a tower of toy blocks, and bounce up onto the toy box — where a
//! crayon drawing says *LULU ♥ BOUNCY THINGS*.
//!
//! Mechanics: pushable balls, see-saws, wind-up cars (movers), slinky ropes,
//! block towers.

use super::*;

/// A wind-up car: a flat-topped toy body (you ride on the roof), `w` wide,
/// roof at `at.y`, `h` tall, with a little bumper at each end.
fn car_shape(at: Vec2, w: f32, h: f32) -> Shape {
    let (hw, b) = (w * 0.5, at.y - h);
    Shape::Poly {
        points: vec![
            v(at.x - hw + 16.0, b),
            v(at.x + hw - 16.0, b),
            v(at.x + hw, b + 18.0),
            v(at.x + hw, b + h - 10.0),
            v(at.x + hw - 10.0, b + h),
            v(at.x - hw + 10.0, b + h),
            v(at.x - hw, b + h - 10.0),
            v(at.x - hw, b + 18.0),
        ],
    }
}

/// A pinned toy block (wobbles, never falls) with its top at `top`.
fn toy_block(c: &mut Ch, x: f32, top: f32, size: f32, color: &str) {
    c.prop("", PropKind::Block, v(x, top - size * 0.5), Vec2::splat(size), 3.0, color);
    c.b.level.props.last_mut().unwrap().pinned = true;
}

pub fn build() -> Course {
    let mut c = Ch::new(8, "The Toy Pile", Theme::Toys, -1400.0);
    c.spawn(v(0.0, 40.0));
    c.npc("glimmer", v(-120.0, 220.0), NpcRole::Glimmer, "", 12.0);

    // ----------------------------------------------------- the midden
    c.wall(-1300.0, -500.0, -1400.0, 2400.0);
    c.floor(&[v(-500.0, 0.0), v(1600.0, 0.0)]);
    c.say(250.0, 320.0, 0.0, "ch08_midden");
    c.ball(v(450.0, 40.0), 28.0, "#ff6b6b");
    c.ball(v(700.0, 40.0), 22.0, "#4d96ff");
    c.crate_box(v(560.0, 40.0), 50.0);
    c.decor("block_letters", v(850.0, 0.0), 1.0, -1.0);
    c.decor("crayon", v(1050.0, 30.0), 1.2, -1.0);
    c.decor("sock", v(200.0, 0.0), 1.0, -1.0);
    c.drops(400.0, 1100.0, 0.0, 5);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 1150.0, 0.0);
    // Push the big ball into the V pit to make a bridge.
    c.say(1100.0, 1160.0, 0.0, "ch08_ball_bridge");
    c.prop("bigball", PropKind::Ball, v(1250.0, 135.0), Vec2::splat(260.0), 2.5, "#ff9f43");
    // The far rim is higher, so the ball settles in the V instead of rolling out.
    c.floor(&[v(1600.0, 0.0), v(1880.0, -240.0), v(2140.0, 100.0), v(2650.0, 100.0), v(2850.0, -20.0), v(3000.0, -20.0)]);
    c.spikes(v(1600.0, 0.0), v(1880.0, -240.0));
    c.spikes(v(1880.0, -240.0), v(2140.0, 100.0));
    c.pickup_arc(v(1600.0, 40.0), v(1870.0, 130.0), 120.0, 2);
    c.pickup_arc(v(1870.0, 130.0), v(2200.0, 150.0), 120.0, 2);
    c.wp(Move::Push, 1560.0, 0.0).wp(Move::Prop, 1870.0, 60.0).wp(Move::Prop, 2240.0, 100.0);
    c.cp(2450.0, 100.0);

    // ------------------------------------------- the see-saw bridge
    c.say(2850.0, 2900.0, -20.0, "ch08_seesaw");
    c.floor(&[v(3000.0, -320.0), v(3700.0, -320.0), v(3800.0, -20.0)]);
    c.b.ground_with(&[v(3000.0, -320.0), v(3500.0, -320.0)], 100.0, Material::Bouncy, 0.8);
    c.ball(v(3150.0, -280.0), 34.0, "#6bcb77");
    c.ball(v(3250.0, -280.0), 30.0, "#ffd93d");
    c.wall(3375.0, 3425.0, -320.0, -150.0);
    c.seesaw("saw", v(3400.0, -49.0), 790.0, 2.0);
    c.pickups(v(3150.0, 40.0), v(3650.0, 40.0), 4);
    c.floor(&[v(3800.0, -20.0), v(4600.0, -20.0)]);
    c.wp(Move::Walk, 2985.0, -20.0).wp(Move::Walk, 3400.0, -20.0).wp(Move::Walk, 3880.0, -20.0);

    // --------------------------------------- the wind-up car track
    c.say(4400.0, 4450.0, -20.0, "ch08_car");
    c.ledge(4600.0, 5800.0, -320.0);
    c.spikes(v(4600.0, -320.0), v(5800.0, -320.0));
    c.mover(car_shape(v(4750.0, -20.0), 280.0, 80.0), &[Vec2::ZERO, v(900.0, 0.0)], 6.0, MoverMotion::PingPong);
    c.b.level.movers.last_mut().unwrap().material = Material::Sticky;
    c.pickup_arc(v(4740.0, 40.0), v(5660.0, 40.0), 60.0, 4);
    c.floor(&[v(5800.0, -20.0), v(6300.0, -20.0)]);
    c.wp(Move::Walk, 4560.0, -20.0).wp(Move::Ride, 4720.0, -20.0).wp(Move::Ride, 5880.0, -20.0);
    c.cp(5950.0, -20.0);

    // ------------------------------------------- slinkies up the pile
    c.say(6000.0, 6050.0, -20.0, "ch08_slinky");
    c.ceiling(&[v(6060.0, 900.0), v(6140.0, 900.0)], 160.0);
    c.rope(RopeEnd::World { at: v(6100.0, 900.0) }, RopeEnd::Free { at: v(6100.0, 200.0) }, 700.0, RopeStyle::Slinky);
    c.shelf(6300.0, 6700.0, 700.0, 120.0);
    c.ceiling(&[v(6860.0, 1500.0), v(6940.0, 1500.0)], 160.0);
    c.rope(RopeEnd::World { at: v(6900.0, 1500.0) }, RopeEnd::Free { at: v(6900.0, 850.0) }, 650.0, RopeStyle::Slinky);
    c.floor(&[v(7100.0, 1300.0), v(7700.0, 1300.0)]);
    c.pickups(v(6100.0, 300.0), v(6100.0, 800.0), 3);
    c.pickups(v(6900.0, 950.0), v(6900.0, 1400.0), 3);
    c.wp(Move::Walk, 6000.0, -20.0).wp(Move::Rope, 6450.0, 700.0).wp(Move::Walk, 6620.0, 700.0).wp(Move::Rope, 7250.0, 1300.0);
    c.cp(7380.0, 1300.0);

    // ---------------------------------------------- the block tower
    c.say(7500.0, 7550.0, 1300.0, "ch08_blocks");
    let steps = [(7800.0, 1430.0, "#ff6b6b"), (7980.0, 1580.0, "#ffd93d"), (8160.0, 1730.0, "#6bcb77"), (8340.0, 1880.0, "#4d96ff")];
    for (x, top, col) in steps {
        toy_block(&mut c, x, top, 120.0, col);
        c.pickup(v(x, top + 50.0));
    }
    // Loose blocks on the top step tumble when you land.
    c.crate_box(v(8360.0, 1920.0), 50.0);
    c.floor(&[v(8450.0, 2000.0), v(9300.0, 2000.0)]);
    c.wp(Move::Walk, 7660.0, 1300.0);
    for (x, top, _) in steps {
        c.wp(Move::Jump, x, top);
    }
    c.wp(Move::Jump, 8560.0, 2000.0);
    c.cp(8700.0, 2000.0);

    // ------------------------------------------------- the toy box
    c.say(8900.0, 8950.0, 2000.0, "ch08_toybox");
    c.spring(v(9150.0, 2000.0), 90.0, 1450.0);
    c.terrain(Shape::rect(v(9300.0, -1400.0), v(10300.0, 2560.0)), Material::Ground);
    c.b.ground(&[v(9300.0, 2560.0), v(10300.0, 2560.0)], 60.0);
    c.decor("block_letters", v(9600.0, 2700.0), 1.6, -1.0);
    c.decor("crayon", v(9500.0, 2620.0), 1.4, -1.0);
    c.decor("crayon", v(9900.0, 2640.0), 1.1, -1.0);
    c.pickups(v(9150.0, 2200.0), v(9150.0, 2550.0), 3);
    c.wp(Move::Walk, 9150.0, 2000.0).wp(Move::Spring, 9420.0, 2560.0);
    c.say(9600.0, 9660.0, 2560.0, "ch08_lulu_drawing");
    c.goal(v(10000.0, 2560.0), v(10200.0, 2780.0));
    c.wp(Move::Walk, 10100.0, 2560.0);
    c.wall(10300.0, 11100.0, -1400.0, 4000.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 760.0), v(1400.0, 820.0), v(2300.0, 700.0), v(3000.0, 700.0), v(4600.0, 650.0), v(5800.0, 700.0), v(6060.0, 1060.0)]);
    c.roof(&[v(6140.0, 1060.0), v(6860.0, 1660.0)]);
    c.roof(&[v(6940.0, 1660.0), v(7700.0, 2100.0), v(8450.0, 2600.0), v(9300.0, 3100.0), v(10300.0, 3300.0)]);

    // ----------------------------------------------------------- decor
    c.hang("glowworm", -400.0, 10200.0, 480.0);
    c.scatter("block_letters", 2350.0, 2900.0, -20.0, 320.0, -1.0);
    c.scatter("crayon", 3850.0, 4500.0, -10.0, 220.0, -1.0);
    c.scatter("sock", 5850.0, 6250.0, -20.0, 200.0, -1.0);
    c.scatter("crayon", 7150.0, 7650.0, 1310.0, 200.0, -1.0);
    c.scatter("block_letters", 8500.0, 9100.0, 2000.0, 300.0, -1.0);
    c.decor("sun", v(10100.0, 3150.0), 0.5, -1.0);
    c.finish()
}
