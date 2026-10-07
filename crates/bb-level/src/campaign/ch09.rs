//! Chapter 9 — **The Cave-In** (Collapsed Hollow).
//!
//! A rumble. The Huddle had followed Pip up ("It was too quiet without
//! you") and got trapped when the tunnels collapsed. Pip goes back through
//! everything it has learned — a squeeze, falling rubble, a vine over a
//! collapse, a flooded hall, an updraft — freeing Huddle blobs one by one
//! (touch a trapped blob and it follows you), and finally Granny Gloop.
//!
//! Mechanics: rescue (trapped NPCs → followers), ropes, crushers, plus a
//! remix of the squeeze, water and updrafts.

use super::*;

/// A trapped Grumble (grumpy grey rock-blob) on the surface at (x, y).
fn trapped(c: &mut Ch, id: &str, x: f32, y: f32) {
    c.npc(id, v(x, y + 30.0), NpcRole::Trapped, "#8a8f86", 28.0);
}

/// Falling rubble: a stone block that drops from the roof onto the floor.
fn rubble(c: &mut Ch, x: f32, roof: f32, floor: f32, phase: f32) {
    c.crusher(v(x, roof), 150.0, roof - 120.0 - floor - 4.0, phase);
}

pub fn build() -> Course {
    let mut c = Ch::new(9, "The Cave-In", Theme::CaveIn, -1400.0);
    c.spawn(v(0.0, 40.0));

    // ---------------------------------------------- the collapse
    c.wall(-1300.0, -500.0, -1400.0, 2200.0);
    c.floor(&[v(-500.0, 0.0), v(700.0, 0.0), v(800.0, -80.0), v(1000.0, -80.0), v(1100.0, 0.0), v(2600.0, 0.0)]);
    c.say(250.0, 320.0, 0.0, "ch09_rumble");
    trapped(&mut c, "t1", 900.0, -80.0);
    c.say(760.0, 820.0, 0.0, "ch09_first_rescue");
    c.drops(780.0, 1020.0, -80.0, 3);
    // A squeeze under the fallen roof (followers squeeze too).
    c.roof(&[v(1150.0, 560.0), v(1250.0, 300.0), v(1300.0, 74.0), v(1600.0, 74.0), v(1650.0, 300.0), v(1750.0, 560.0)]);
    c.drops(1330.0, 1570.0, -12.0, 4);
    // Falling rubble with a trapped blob between the drops.
    rubble(&mut c, 1900.0, 560.0, 0.0, 0.0);
    rubble(&mut c, 2160.0, 560.0, 0.0, 0.5);
    trapped(&mut c, "t2", 2030.0, 0.0);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 900.0, -80.0).wp(Move::Walk, 1250.0, 0.0).wp(Move::Squeeze, 1700.0, 0.0);
    c.wp(Move::Dash, 2030.0, 0.0).wp(Move::Dash, 2300.0, 0.0);
    c.cp(2420.0, 0.0);
    c.say(2480.0, 2540.0, 0.0, "ch09_too_quiet");

    // -------------------------------------- a vine over the collapse
    c.ledge(2600.0, 3400.0, -400.0);
    c.spikes(v(2600.0, -400.0), v(3400.0, -400.0));
    c.poly(&[v(2816.0, 650.0), v(2884.0, 650.0), v(2864.0, 616.0), v(2836.0, 616.0)]);
    c.vine(v(2850.0, 620.0), 420.0);
    c.pickup_arc(v(2600.0, 120.0), v(3400.0, 120.0), 200.0, 4);
    c.floor(&[v(3400.0, 0.0), v(5200.0, 0.0)]);
    trapped(&mut c, "t3", 3600.0, 0.0);
    c.drops(3700.0, 3950.0, 0.0, 3);
    c.wp(Move::Walk, 2560.0, 0.0).wp(Move::Rope, 3520.0, 0.0);
    // The rubble corridor.
    c.say(3850.0, 3900.0, 0.0, "ch09_rubble");
    rubble(&mut c, 4250.0, 600.0, 0.0, 0.0);
    rubble(&mut c, 4560.0, 600.0, 0.0, 0.4);
    rubble(&mut c, 4870.0, 600.0, 0.0, 0.8);
    trapped(&mut c, "t4", 4405.0, 0.0);
    c.drops(4700.0, 4720.0, 0.0, 1);
    c.wp(Move::Walk, 4080.0, 0.0).wp(Move::Dash, 4405.0, 0.0).wp(Move::Dash, 4715.0, 0.0).wp(Move::Dash, 5050.0, 0.0);
    c.cp(5100.0, 0.0);

    // --------------------------------------------- the flooded hall
    c.say(5150.0, 5200.0, 0.0, "ch09_flooded");
    c.floor(&[v(5200.0, 0.0), v(5380.0, -300.0), v(6400.0, -300.0), v(6800.0, 40.0), v(7400.0, 40.0)]);
    c.water(v(5200.0, -300.0), v(6700.0, -10.0));
    for x in [5500.0, 5800.0, 6100.0, 6400.0] {
        c.lily(v(x, -10.0), 180.0);
        c.pickup(v(x, 90.0));
    }
    trapped(&mut c, "t5", 6950.0, 40.0);
    c.wp(Move::Walk, 5200.0, 0.0);
    for x in [5500.0, 5800.0, 6100.0, 6400.0] {
        c.wp(Move::Jump, x, 32.0);
    }
    c.wp(Move::Jump, 6800.0, 40.0).wp(Move::Walk, 7300.0, 40.0);
    // An updraft up the old ventilation shaft.
    c.ledge(7400.0, 7600.0, 40.0);
    c.wind(v(7400.0, 40.0), v(7600.0, 1320.0), v(0.0, 1400.0));
    c.wall(7100.0, 7400.0, 420.0, 1900.0);
    c.pickups(v(7500.0, 300.0), v(7500.0, 1100.0), 4);
    c.floor(&[v(7600.0, 1250.0), v(8400.0, 1250.0)]);
    trapped(&mut c, "t6", 7850.0, 1250.0);
    c.drops(7950.0, 8300.0, 1250.0, 3);
    // Drops along the bank by the old shaft.
    c.pickups(v(6900.0, 90.0), v(7250.0, 90.0), 4);
    c.wp(Move::Wind, 7500.0, 1290.0).wp(Move::Drop, 7750.0, 1250.0);
    c.cp(8050.0, 1250.0);

    // ----------------------------------------- the climb to Granny
    c.say(8250.0, 8300.0, 1250.0, "ch09_climb");
    c.ledge(8400.0, 8650.0, 1400.0);
    c.ledge(8650.0, 8900.0, 1550.0);
    c.ledge(8900.0, 9150.0, 1700.0);
    c.floor(&[v(9150.0, 1850.0), v(9450.0, 1850.0)]);
    rubble(&mut c, 9025.0, 2350.0, 1700.0, 0.3);
    for (x, y) in [(8525.0, 1400.0), (8775.0, 1550.0), (9025.0, 1700.0)] {
        c.pickup(v(x, y + 50.0));
    }
    c.wp(Move::Walk, 8330.0, 1250.0).wp(Move::Jump, 8500.0, 1400.0).wp(Move::Jump, 8750.0, 1550.0).wp(Move::Jump, 9000.0, 1700.0).wp(Move::Jump, 9250.0, 1850.0);
    c.cp(9330.0, 1850.0);
    // A last vine to Granny's ledge.
    c.ledge(9450.0, 10000.0, 1300.0);
    c.spikes(v(9450.0, 1300.0), v(10000.0, 1300.0));
    c.poly(&[v(9666.0, 2630.0), v(9734.0, 2630.0), v(9714.0, 2596.0), v(9686.0, 2596.0)]);
    c.vine(v(9700.0, 2600.0), 560.0);
    c.pickup_arc(v(9450.0, 1950.0), v(10050.0, 1950.0), 220.0, 4);
    c.floor(&[v(10000.0, 1900.0), v(11000.0, 1900.0)]);
    // Old Grumbletop: the biggest, grumpiest Grumble.
    c.npc("grumbletop", v(10350.0, 1980.0), NpcRole::Trapped, "#6f746c", 72.0);
    c.say(10150.0, 10200.0, 1900.0, "ch09_granny");
    c.wp(Move::Walk, 9420.0, 1850.0).wp(Move::Rope, 10120.0, 1900.0).wp(Move::Walk, 10350.0, 1900.0);
    c.say(10550.0, 10600.0, 1900.0, "ch09_all_together");
    c.drops(10450.0, 10700.0, 1900.0, 3);
    c.goal(v(10750.0, 1900.0), v(10950.0, 2120.0));
    c.wp(Move::Walk, 10850.0, 1900.0);
    c.wall(11000.0, 11800.0, -1400.0, 3600.0);
    c.decor("lantern", v(10850.0, 2400.0), 0.8, -1.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 560.0), v(1150.0, 560.0)]);
    c.roof(&[v(1750.0, 560.0), v(2600.0, 560.0), v(3000.0, 650.0), v(3400.0, 600.0), v(5200.0, 600.0), v(6000.0, 700.0), v(7100.0, 720.0)]);
    c.roof(&[v(7400.0, 1900.0), v(8400.0, 1950.0), v(9150.0, 2350.0), v(9500.0, 2630.0), v(10000.0, 2650.0), v(11000.0, 2700.0)]);

    // ----------------------------------------------------------- decor
    c.hang("drip", -400.0, 10900.0, 380.0);
    c.hang("glowworm", -200.0, 10900.0, 700.0);
    c.scatter("crystal", -450.0, 650.0, 0.0, 220.0, -1.0);
    c.scatter("crystal", 3450.0, 3900.0, 0.0, 150.0, -1.0);
    c.scatter("mushroom", 6800.0, 7300.0, 40.0, 160.0, -1.0);
    c.scatter("crystal", 7650.0, 8350.0, 1250.0, 230.0, -1.0);
    c.scatter("mushroom", 10050.0, 10700.0, 1900.0, 160.0, -1.0);
    c.finish()
}
