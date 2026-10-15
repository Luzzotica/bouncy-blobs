//! Chapter 5 — **The Crusher Hall** (Old Stone Works).
//!
//! The low point. Thumping stone pistons, conveyor roots and creaking lifts
//! in an abandoned works. Pip gets popped, reforms at a mushroom, and goes
//! again — until it clicks: "You popped. You came back. That's the whole
//! trick." Crushers on a corridor, an against-the-flow conveyor, a ferry
//! platform over spikes, a lift, a conveyor that rushes you under a row of
//! pistons, a lift relay up the works, the grand crusher hall, and the
//! great spinning gears that fling you up into the light.
//!
//! Mechanics: crushers (pop limits!; some spiked underneath), moving
//! platforms, elevators, conveyors, spinning launch gears (swell as they
//! let go to fly higher).

use super::*;

/// A crusher hanging from a roof at `roof` that slams down onto `floor`.
fn piston(c: &mut Ch, x: f32, roof: f32, floor: f32, phase: f32) {
    // Wide enough that puffing up can't squeeze you out from under it.
    c.piston(x, roof, floor, phase, false);
}

/// A piston with spikes on its face: don't even touch it from below.
fn spiked_piston(c: &mut Ch, x: f32, roof: f32, floor: f32, phase: f32) {
    c.piston(x, roof, floor, phase, true);
}

/// A ferry platform (top surface at y) ping-ponging between x0 and x1.
fn ferry(c: &mut Ch, x0: f32, x1: f32, y: f32, width: f32, period: f32) {
    c.mover(Shape::rect_at(v(x0, y - 13.0), v(width, 26.0), 0.0), &[Vec2::ZERO, v(x1 - x0, 0.0)], period, MoverMotion::PingPong);
}

/// A spinning launch gear (radius 130) hanging just above the floor at
/// `floor`, so a rolling blob touches its underside: it grips, spins up and
/// flings you along `angle` (degrees) at `speed` px/s (clockwise, so it
/// throws you to the right).
fn gear(c: &mut Ch, x: f32, floor: f32, speed: f32, angle: f32) {
    c.launch_plate(v(x, floor + 192.0), 130.0, speed, angle, true);
}

/// A lift (top surface at y0 → y1) at x.
fn lift(c: &mut Ch, x: f32, y0: f32, y1: f32, width: f32, period: f32, phase: f32) {
    c.elevator_phase(v(x, y0 - 13.0), v(x, y1 - 13.0), width, period, phase);
}

pub fn build() -> (Blueprint, Course) {
    let mut c = Ch::new(5, "The Crusher Hall", Theme::Stoneworks, -1400.0);
    c.about(&["Chapter 5 — **The Crusher Hall** (Old Stone Works).", "", "The low point. Thumping stone pistons, conveyor roots and creaking lifts", "in an abandoned works. Pip gets popped, reforms at a mushroom, and goes", "again — until it clicks: \"You popped. You came back. That's the whole", "trick.\" Crushers on a corridor, an against-the-flow conveyor, a ferry", "platform over spikes, a lift, a conveyor that rushes you under a row of", "pistons, a lift relay up the works, the grand crusher hall, and the", "great spinning gears that fling you up into the light.", "", "Mechanics: crushers (pop limits!; some spiked underneath), moving", "platforms, elevators, conveyors, spinning launch gears (swell as they", "let go to fly higher)."]);
    c.spawn(v(0.0, 40.0));

    c.section("the thumping hall");
    c.entry_cave(-1300.0, -500.0, 0.0, 1800.0, Theme::Vines);
    c.floor(&[v(-500.0, 0.0), v(2600.0, 0.0)]);
    c.note("The cast from the intro cutscene greets you at the start.");
    c.npc("clonk", v(-280.0, 90.0), NpcRole::Granny, "#7d7a74", 76.0);
    c.say(-80.0, 80.0, 0.0, "ch05_hello");
    c.say(250.0, 320.0, 0.0, "ch05_thump");
    c.note("A crate under the first piston shows what it does.");
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

    c.section("conveyor roots and a ferry");
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
    c.note("A lift up to the works.");
    c.ledge(4700.0, 4900.0, -90.0);
    lift(&mut c, 4800.0, 0.0, 600.0, 180.0, 6.0, 0.0);
    c.pickups(v(4800.0, 160.0), v(4800.0, 520.0), 3);
    c.ledge(4900.0, 5600.0, 600.0);
    c.wp(Move::Walk, 4660.0, 0.0).wp(Move::Ride, 4750.0, 0.0).wp(Move::Ride, 5000.0, 600.0);
    c.cp(5200.0, 600.0);

    c.section("the rushing conveyor under pistons");
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
    c.note("A lift relay up the works.");
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

    c.section("the grand crusher hall");
    piston(&mut c, 8550.0, 2000.0, 1500.0, 0.0);
    spiked_piston(&mut c, 8850.0, 2000.0, 1500.0, 0.5);
    piston(&mut c, 9150.0, 2000.0, 1500.0, 0.25);
    spiked_piston(&mut c, 9450.0, 2000.0, 1500.0, 0.75);
    for x in [8700.0, 9000.0, 9300.0] {
        c.pickup(v(x, 1545.0));
    }
    c.wp(Move::Walk, 8400.0, 1500.0).wp(Move::Dash, 8700.0, 1500.0).wp(Move::Dash, 9000.0, 1500.0).wp(Move::Dash, 9300.0, 1500.0).wp(Move::Dash, 9620.0, 1500.0);
    c.cp(9720.0, 1500.0);

    c.section("the spinning gears");
    c.note("The works' great stone gears still turn. Touch one and it grips you to its rim, winds up and FLINGS you. A first gear tosses you up onto a ledge over safe floor; the next throws you across a spike pit; the last one only gets you up to the light if you swell as it lets go.");
    c.ledge(9900.0, 10650.0, 1500.0);
    c.say(9950.0, 10010.0, 1500.0, "ch05_gears");
    gear(&mut c, 10350.0, 1500.0, 1300.0, 62.0);
    c.pickup_arc(v(10230.0, 1800.0), v(10720.0, 1860.0), 230.0, 4);
    c.ledge(10650.0, 11400.0, 1800.0);
    c.wp(Move::Walk, 10330.0, 1500.0).wp(Move::Spring, 10760.0, 1800.0);
    c.note("Across the pit (wider than any jump; roof far out of reach).");
    gear(&mut c, 11250.0, 1800.0, 1700.0, 40.0);
    c.ledge(11400.0, 12350.0, 1560.0);
    c.spikes(v(11400.0, 1560.0), v(12350.0, 1560.0));
    c.pickup_arc(v(11160.0, 2140.0), v(12450.0, 1900.0), 220.0, 5);
    c.ledge(12350.0, 14000.0, 1800.0);
    c.wp(Move::Walk, 11230.0, 1800.0).wp(Move::Spring, 12560.0, 1800.0);
    c.cp(12750.0, 1800.0);
    c.note("The last gear: a plain fling falls back beside it; swell as it lets go and it throws you twice as high, up onto the floating shelf.");
    gear(&mut c, 13300.0, 1800.0, 1250.0, 75.0);
    c.drops(12900.0, 13100.0, 1800.0, 2);
    c.pickups(v(13330.0, 2350.0), v(13450.0, 2560.0), 2);
    c.shelf(13480.0, 15000.0, 2430.0, 70.0);
    c.ledge(14000.0, 15800.0, 1560.0);
    c.spikes(v(14000.0, 1560.0), v(15000.0, 1560.0));
    c.wp(Move::Walk, 13280.0, 1800.0).wp(Move::Spring, 13700.0, 2430.0);
    c.say(13900.0, 13950.0, 2430.0, "ch05_light");
    c.drops(13800.0, 14700.0, 2430.0, 4);
    c.note("Out through the tunnel; damp blue light from the Lake beyond.");
    c.exit_cave(15000.0, 15800.0, 2430.0, 4000.0, Theme::Lake);
    c.wp(Move::Walk, 14600.0, 2430.0).wp(Move::Walk, 15480.0, 2430.0);

    c.section("roof");
    c.roof(&[v(-1300.0, 560.0), v(2600.0, 560.0), v(2650.0, 700.0), v(3500.0, 700.0), v(3600.0, 820.0), v(4700.0, 820.0), v(4720.0, 1100.0), v(7100.0, 1100.0), v(7150.0, 2000.0), v(9900.0, 2000.0), v(10000.0, 2500.0), v(11000.0, 2750.0), v(12300.0, 2800.0), v(13300.0, 3000.0), v(15000.0, 3000.0)]);

    c.section("decor");
    c.hang("drip", 300.0, 2500.0, 700.0);
    c.hang("drip", 2700.0, 4600.0, 380.0);
    c.hang("glowworm", 7800.0, 11900.0, 520.0);
    c.hang("glowworm", 4800.0, 7000.0, 450.0);
    c.scatter("crystal", -450.0, 400.0, 0.0, 200.0, -1.0);
    c.scatter("crystal", 4950.0, 5550.0, 600.0, 200.0, -1.0);
    c.scatter("mushroom", 10750.0, 11050.0, 1800.0, 150.0, -1.0);
    c.scatter("mushroom", 14100.0, 14800.0, 2430.0, 175.0, -1.0);
    c.finish()
}
