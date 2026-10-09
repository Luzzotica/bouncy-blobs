//! Chapter 5 — **The Crusher Hall** (Old Stone Works).
//!
//! The low point. Thumping stone pistons, conveyor roots and creaking lifts
//! in an abandoned works. Pip gets popped, reforms at a mushroom, and goes
//! again — until it clicks: "You popped. You came back. That's the whole
//! trick." Crushers on a corridor, an against-the-flow conveyor, a ferry
//! platform over spikes, a lift, a conveyor that rushes you under a row of
//! pistons, a lift relay up the works, the grand crusher hall, and a last
//! trampoline out into the light.
//!
//! Mechanics: crushers (pop limits!; some spiked underneath), moving
//! platforms, elevators, conveyors.

use super::*;

/// A crusher hanging from a roof at `roof` that slams down onto `floor`.
fn piston(c: &mut Ch, x: f32, roof: f32, floor: f32, phase: f32) {
    // Wide enough that puffing up can't squeeze you out from under it.
    c.crusher(v(x, roof), 210.0, roof - 120.0 - floor - 4.0, phase);
}

/// A piston with spikes on its face: don't even touch it from below.
fn spiked_piston(c: &mut Ch, x: f32, roof: f32, floor: f32, phase: f32) {
    piston(c, x, roof, floor, phase);
    c.spiked();
}

/// A ferry platform (top surface at y) ping-ponging between x0 and x1.
fn ferry(c: &mut Ch, x0: f32, x1: f32, y: f32, width: f32, period: f32) {
    c.mover(Shape::rect_at(v(x0, y - 13.0), v(width, 26.0), 0.0), &[Vec2::ZERO, v(x1 - x0, 0.0)], period, MoverMotion::PingPong);
}

/// A lift (top surface at y0 → y1) at x.
fn lift(c: &mut Ch, x: f32, y0: f32, y1: f32, width: f32, period: f32, phase: f32) {
    c.elevator(v(x, y0 - 13.0), v(x, y1 - 13.0), width, period);
    c.b.level.movers.last_mut().unwrap().phase = phase;
}

pub fn build() -> Course {
    let mut c = Ch::new(5, "The Crusher Hall", Theme::Stoneworks, -1400.0);
    c.spawn(v(0.0, 40.0));

    // ------------------------------------------------ the thumping hall
    c.entry_cave(-1300.0, -500.0, 0.0, 1800.0, Theme::Vines);
    c.floor(&[v(-500.0, 0.0), v(2600.0, 0.0)]);
    // The cast from the intro cutscene greets you at the start.
    c.npc("clonk", v(-280.0, 90.0), NpcRole::Granny, "#7d7a74", 76.0);
    c.say(-80.0, 80.0, 0.0, "ch05_hello");
    c.say(250.0, 320.0, 0.0, "ch05_thump");
    // A crate under the first piston shows what it does.
    piston(&mut c, 650.0, 560.0, 0.0, 0.0);
    c.crate_box(v(650.0, 40.0), 70.0);
    c.say(820.0, 880.0, 0.0, "ch05_crusher");
    piston(&mut c, 1150.0, 560.0, 0.0, 0.2);
    spiked_piston(&mut c, 1550.0, 560.0, 0.0, 0.5);
    piston(&mut c, 1880.0, 560.0, 0.0, 0.8);
    c.drops(1280.0, 1440.0, 0.0, 2);
    c.drops(1660.0, 1780.0, 0.0, 2);
    c.drops(2000.0, 2200.0, 0.0, 2);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 950.0, 0.0);
    c.wp(Move::Dash, 1350.0, 0.0).wp(Move::Dash, 1720.0, 0.0).wp(Move::Dash, 2100.0, 0.0);
    c.cp(2350.0, 0.0);
    c.say(2420.0, 2480.0, 0.0, "ch05_popped");

    // ------------------------------------- conveyor roots and a ferry
    c.ledge(2600.0, 3400.0, -40.0);
    c.conveyor(v(2600.0, 0.0), 800.0, -260.0);
    piston(&mut c, 3000.0, 700.0, 0.0, 0.5);
    c.drops(2700.0, 2900.0, 0.0, 2);
    c.drops(3150.0, 3350.0, 0.0, 2);
    c.ledge(3400.0, 3600.0, 0.0);
    c.wp(Move::Walk, 2850.0, 0.0).wp(Move::Dash, 3250.0, 0.0).wp(Move::Walk, 3520.0, 0.0);
    c.say(3480.0, 3530.0, 0.0, "ch05_ferry");
    c.ledge(3600.0, 4400.0, -250.0);
    c.spikes(v(3600.0, -250.0), v(4400.0, -250.0));
    ferry(&mut c, 3720.0, 4280.0, 0.0, 220.0, 5.0);
    c.pickup_arc(v(3720.0, 60.0), v(4280.0, 60.0), 60.0, 4);
    c.floor(&[v(4400.0, 0.0), v(4700.0, 0.0)]);
    c.wp(Move::Ride, 3720.0, 0.0).wp(Move::Ride, 4480.0, 0.0);
    // A lift up to the works.
    c.ledge(4700.0, 4900.0, -90.0);
    lift(&mut c, 4800.0, 0.0, 600.0, 180.0, 6.0, 0.0);
    c.pickups(v(4800.0, 160.0), v(4800.0, 520.0), 3);
    c.ledge(4900.0, 5600.0, 600.0);
    c.wp(Move::Walk, 4660.0, 0.0).wp(Move::Ride, 4750.0, 0.0).wp(Move::Ride, 5000.0, 600.0);
    c.cp(5200.0, 600.0);

    // ------------------------------- the rushing conveyor under pistons
    c.say(5450.0, 5500.0, 600.0, "ch05_rush");
    c.ledge(5600.0, 6800.0, 560.0);
    c.conveyor(v(5600.0, 600.0), 1200.0, 300.0);
    piston(&mut c, 5900.0, 1100.0, 600.0, 0.0);
    spiked_piston(&mut c, 6250.0, 1100.0, 600.0, 0.35);
    piston(&mut c, 6600.0, 1100.0, 600.0, 0.7);
    c.drops(6030.0, 6120.0, 600.0, 2);
    c.drops(6380.0, 6470.0, 600.0, 2);
    c.ledge(6800.0, 7100.0, 600.0);
    c.wp(Move::Walk, 5720.0, 600.0).wp(Move::Dash, 6075.0, 600.0).wp(Move::Dash, 6425.0, 600.0).wp(Move::Dash, 6900.0, 600.0);
    // A lift relay up the works.
    c.ledge(7100.0, 7300.0, 510.0);
    lift(&mut c, 7200.0, 600.0, 1050.0, 190.0, 6.0, 0.0);
    c.ledge(7300.0, 7550.0, 1050.0);
    c.ledge(7550.0, 7750.0, 960.0);
    lift(&mut c, 7650.0, 1050.0, 1500.0, 190.0, 6.0, 0.5);
    c.floor(&[v(7750.0, 1500.0), v(9900.0, 1500.0)]);
    c.pickups(v(7420.0, 1100.0), v(7420.0, 1200.0), 2);
    c.wp(Move::Walk, 7060.0, 600.0).wp(Move::Ride, 7150.0, 600.0).wp(Move::Ride, 7400.0, 1050.0);
    c.wp(Move::Walk, 7510.0, 1050.0).wp(Move::Ride, 7600.0, 1050.0).wp(Move::Ride, 7850.0, 1500.0);
    c.cp(8050.0, 1500.0);
    c.drops(7900.0, 8300.0, 1500.0, 3);
    c.say(8150.0, 8210.0, 1500.0, "ch05_whole_trick");

    // ------------------------------------------- the grand crusher hall
    piston(&mut c, 8550.0, 2000.0, 1500.0, 0.0);
    spiked_piston(&mut c, 8850.0, 2000.0, 1500.0, 0.5);
    piston(&mut c, 9150.0, 2000.0, 1500.0, 0.25);
    spiked_piston(&mut c, 9450.0, 2000.0, 1500.0, 0.75);
    for x in [8700.0, 9000.0, 9300.0] {
        c.pickup(v(x, 1545.0));
    }
    c.wp(Move::Walk, 8400.0, 1500.0).wp(Move::Dash, 8700.0, 1500.0).wp(Move::Dash, 9000.0, 1500.0).wp(Move::Dash, 9300.0, 1500.0).wp(Move::Dash, 9620.0, 1500.0);
    c.cp(9720.0, 1500.0);
    // Last ferry over spikes, a trampoline up into the light.
    c.ledge(9900.0, 10700.0, 1250.0);
    c.spikes(v(9900.0, 1250.0), v(10700.0, 1250.0));
    ferry(&mut c, 10020.0, 10580.0, 1500.0, 220.0, 4.5);
    c.pickup_arc(v(10020.0, 1560.0), v(10580.0, 1560.0), 80.0, 3);
    c.floor(&[v(10700.0, 1500.0), v(11050.0, 1500.0)]);
    c.wp(Move::Walk, 9850.0, 1500.0).wp(Move::Ride, 10020.0, 1500.0).wp(Move::Ride, 10760.0, 1500.0);
    let cap = 1615.0;
    c.poly(&[v(10810.0, 1500.0), v(10950.0, 1500.0), v(10920.0, cap - 51.0), v(10840.0, cap - 51.0)]);
    c.trampoline(v(10880.0, 1500.0), cap - 1500.0 - 45.0, 160.0, 1250.0);
    c.floor(&[v(11050.0, 1950.0), v(12000.0, 1950.0)]);
    c.pickups(v(10880.0, 1700.0), v(10880.0, 2000.0), 3);
    c.wp(Move::Jump, 10880.0, cap).wp(Move::Spring, 11150.0, 1950.0);
    c.say(11250.0, 11300.0, 1950.0, "ch05_light");
    // Secret: a little shelf up by the roof with a stash of drops.
    c.shelf(11420.0, 11600.0, 2150.0, 40.0);
    c.pickups(v(11440.0, 2200.0), v(11580.0, 2200.0), 4);
    c.drops(11150.0, 11400.0, 1950.0, 3);
    // Out through the tunnel; damp blue light from the Lake beyond.
    c.exit_cave(12000.0, 12800.0, 1950.0, 3500.0, Theme::Lake);
    c.wp(Move::Walk, 11600.0, 1950.0).wp(Move::Walk, 12480.0, 1950.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 560.0), v(2600.0, 560.0), v(2650.0, 700.0), v(3500.0, 700.0), v(3600.0, 820.0), v(4700.0, 820.0), v(4720.0, 1100.0), v(7100.0, 1100.0), v(7150.0, 2000.0), v(9900.0, 2000.0), v(10000.0, 2350.0), v(11000.0, 2450.0), v(12000.0, 2550.0)]);

    // ----------------------------------------------------------- decor
    c.hang("drip", 300.0, 2500.0, 700.0);
    c.hang("drip", 2700.0, 4600.0, 380.0);
    c.hang("glowworm", 7800.0, 11900.0, 520.0);
    c.hang("glowworm", 4800.0, 7000.0, 450.0);
    c.scatter("crystal", -450.0, 400.0, 0.0, 200.0, -1.0);
    c.scatter("crystal", 4950.0, 5550.0, 600.0, 200.0, -1.0);
    c.scatter("mushroom", 9700.0, 9850.0, 1500.0, 80.0, -1.0);
    c.scatter("mushroom", 11100.0, 11900.0, 1950.0, 150.0, -1.0);
    c.finish()
}
