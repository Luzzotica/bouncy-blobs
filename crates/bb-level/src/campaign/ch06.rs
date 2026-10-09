//! Chapter 6 — **Puddle Lake** (Underground Lake).
//!
//! A vast, still, glittering lake. Pip learns to float (jelly floats; puff
//! up to bob higher), hops across lily pads to an island where **Reg** —
//! His Royal Softness, King Reginald Sock the First — holds court in a
//! teacup. Then a current river with bobbing crates, a counter-current
//! lily crossing, a fountain column that floats you straight up, and the
//! upper terraces.
//!
//! Mechanics: water (buoyancy & drag), floating lily pads, currents.

use super::*;

/// Floating jelly lily pad on the water surface at (x, surface).
fn pad(c: &mut Ch, x: f32, surface: f32) {
    c.lily(v(x, surface), 180.0);
}

/// Reg's teacup: a little U of rock (walls `h` tall) standing at `y`.
fn teacup(c: &mut Ch, x0: f32, x1: f32, y: f32, h: f32) {
    c.stone(v(x0, y), v(x1, y + 22.0));
    c.stone(v(x0, y), v(x0 + 22.0, y + h));
    c.stone(v(x1 - 22.0, y), v(x1, y + h));
    // The handle.
    c.terrain(Shape::Poly { points: vec![v(x1, y + h - 20.0), v(x1 + 40.0, y + h - 30.0), v(x1 + 44.0, y + 30.0), v(x1, y + 30.0), v(x1 + 22.0, y + 46.0), v(x1 + 24.0, y + h - 46.0)] }, Material::Stone);
}

pub fn build() -> Course {
    let mut c = Ch::new(6, "Puddle Lake", Theme::Lake, -1400.0);
    c.spawn(v(0.0, 120.0));

    // -------------------------------------------- the shore and a paddle
    c.entry_cave(-1300.0, -500.0, 80.0, 2400.0, Theme::Stoneworks);
    // The near bank is a beach: anyone who falls in the lake drifts back to it.
    c.floor(&[v(-500.0, 80.0), v(1000.0, 80.0), v(1150.0, -120.0), v(1550.0, -120.0), v(1800.0, 80.0), v(2050.0, 80.0), v(2400.0, -220.0), v(3400.0, -220.0)]);
    // The cast from the intro cutscene greets you at the start.
    c.npc("reg_start", v(-250.0, 160.0), NpcRole::Reg, "", 30.0);
    c.say(-80.0, 80.0, 80.0, "ch06_hello");
    c.water(v(1000.0, -120.0), v(1800.0, 40.0));
    c.say(300.0, 360.0, 80.0, "ch06_lake");
    c.say(880.0, 940.0, 80.0, "ch06_float");
    c.pickups(v(1150.0, 70.0), v(1650.0, 70.0), 4);
    c.wp(Move::Walk, 0.0, 80.0).wp(Move::Walk, 950.0, 80.0).wp(Move::Swim, 1400.0, -30.0).wp(Move::Swim, 1900.0, 80.0);

    // ------------------------------------ lily pads to Reg's island
    c.current(v(2050.0, -220.0), v(3400.0, 0.0), v(-150.0, 0.0));
    let pads = [2400.0, 2670.0, 2940.0, 3210.0];
    for x in pads {
        pad(&mut c, x, 0.0);
        c.pickup(v(x, 100.0));
    }
    c.floor(&[v(3400.0, 120.0), v(4400.0, 120.0)]);
    c.wp(Move::Walk, 2010.0, 80.0);
    for x in pads {
        c.wp(Move::Jump, x, 42.0);
    }
    c.wp(Move::Jump, 3490.0, 120.0);
    c.cp(3600.0, 120.0);
    c.say(3300.0, 3360.0, 42.0, "ch06_reg_hail");
    // The throne: a teacup with a sock in it.
    teacup(&mut c, 3780.0, 4020.0, 120.0, 110.0);
    c.npc("reg", v(3900.0, 190.0), NpcRole::Reg, "", 30.0);
    c.decor("sock", v(4250.0, 120.0), 0.8, -1.0);
    c.say(3700.0, 3760.0, 120.0, "ch06_reg_tale");
    c.pickups(v(3830.0, 190.0), v(3970.0, 190.0), 2);
    c.pickup(v(3791.0, 270.0)).pickup(v(4009.0, 270.0));
    c.drops(4100.0, 4350.0, 120.0, 2);
    c.wp(Move::Walk, 3680.0, 120.0).wp(Move::Jump, 3900.0, 142.0).wp(Move::Jump, 4150.0, 120.0);

    // ------------------------------------------------ the current river
    c.say(4280.0, 4330.0, 120.0, "ch06_current");
    c.ledge(4400.0, 5700.0, -400.0);
    c.floor(&[v(5700.0, -400.0), v(6300.0, 0.0), v(6500.0, 120.0), v(6800.0, 120.0), v(7050.0, -80.0)]);
    c.current(v(4400.0, -400.0), v(6320.0, 0.0), v(250.0, 0.0));
    c.drip_hazard(v(4950.0, 840.0), 840.0, 30.0, 0.0);
    c.drip_hazard(v(5550.0, 840.0), 840.0, 30.0, 0.5);
    c.crate_box(v(4800.0, 0.0), 70.0);
    c.crate_box(v(5300.0, 0.0), 60.0);
    c.ball(v(5800.0, 0.0), 34.0, "#ffd166");
    c.pickups(v(4600.0, 40.0), v(6100.0, 40.0), 6);
    c.wp(Move::Walk, 4350.0, 120.0).wp(Move::Swim, 5300.0, -30.0).wp(Move::Swim, 6250.0, -40.0).wp(Move::Walk, 6550.0, 120.0);
    c.cp(6650.0, 120.0);

    // --------------------------------- lily pads against the current
    c.say(6760.0, 6810.0, 120.0, "ch06_against");
    // (The current carries anyone who falls in back to the beach.)
    c.ledge(7050.0, 8300.0, -500.0);
    c.current(v(6950.0, -500.0), v(8300.0, 0.0), v(-300.0, 0.0));
    for x in [7200.0, 7470.0, 7740.0, 8010.0] {
        pad(&mut c, x, 0.0);
        c.pickup(v(x, 100.0));
    }
    c.ledge(8300.0, 8500.0, 120.0);
    c.wp(Move::Walk, 6960.0, 0.0);
    for x in [7200.0, 7470.0, 7740.0, 8010.0] {
        c.wp(Move::Jump, x, 42.0);
    }
    c.wp(Move::Jump, 8370.0, 120.0);

    // --------------------------------------- the fountain column
    c.say(8350.0, 8400.0, 120.0, "ch06_fountain");
    c.ledge(8500.0, 8700.0, 0.0);
    c.water(v(8500.0, 0.0), v(8700.0, 1300.0));
    c.wall(8100.0, 8500.0, 420.0, 1800.0);
    c.floor(&[v(8700.0, 1180.0), v(8900.0, 1330.0), v(9650.0, 1330.0)]);
    c.pickups(v(8600.0, 300.0), v(8600.0, 1100.0), 5);
    c.wp(Move::Walk, 8450.0, 120.0).wp(Move::Swim, 8600.0, 600.0).wp(Move::Swim, 8600.0, 1230.0).wp(Move::Swim, 8900.0, 1330.0);
    c.cp(9000.0, 1330.0);
    c.drops(9100.0, 9550.0, 1330.0, 3);

    // ----------------------------------------- the upper terraces
    // Beaches on both sides of the terrace pool.
    c.floor(&[v(9650.0, 1330.0), v(9950.0, 1000.0), v(10150.0, 1000.0), v(10650.0, 1400.0), v(10900.0, 1400.0)]);
    c.current(v(9650.0, 1000.0), v(10600.0, 1330.0), v(150.0, 0.0));
    pad(&mut c, 10000.0, 1330.0);
    pad(&mut c, 10300.0, 1330.0);
    c.pickup(v(10000.0, 1430.0)).pickup(v(10300.0, 1430.0));
    c.wp(Move::Walk, 9640.0, 1330.0).wp(Move::Jump, 10000.0, 1372.0).wp(Move::Jump, 10300.0, 1372.0).wp(Move::Jump, 10680.0, 1400.0);
    c.cp(10780.0, 1400.0);
    // A last vine over the spiky shallows.
    c.ledge(10900.0, 11600.0, 1140.0);
    c.spikes(v(10900.0, 1140.0), v(11600.0, 1140.0));
    c.poly(&[v(11066.0, 2130.0), v(11134.0, 2130.0), v(11114.0, 2096.0), v(11086.0, 2096.0)]);
    c.vine(v(11100.0, 2100.0), 560.0);
    c.pickup_arc(v(10900.0, 1480.0), v(11700.0, 1480.0), 260.0, 4);
    c.floor(&[v(11600.0, 1400.0), v(12500.0, 1400.0)]);
    c.wp(Move::Walk, 10850.0, 1400.0).wp(Move::Rope, 11750.0, 1400.0);
    c.say(11850.0, 11900.0, 1400.0, "ch06_true_softness");
    // Out through the tunnel; a warm lilac draught from the Chimneys.
    c.exit_cave(12500.0, 13300.0, 1400.0, 3200.0, Theme::Chimney);
    c.wp(Move::Walk, 12200.0, 1400.0).wp(Move::Walk, 12980.0, 1400.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 760.0), v(1000.0, 820.0), v(2100.0, 900.0), v(3400.0, 950.0), v(4400.0, 900.0), v(6300.0, 860.0), v(7000.0, 900.0), v(8100.0, 950.0)]);
    c.roof(&[v(8500.0, 1800.0), v(9800.0, 1900.0), v(10900.0, 2130.0), v(12500.0, 2200.0)]);
    c.roof_spikes(10900.0, 11600.0, &[11100.0], 80.0);

    // ----------------------------------------------------------- decor
    c.hang("glowworm", -400.0, 12400.0, 360.0);
    c.hang("drip", 4300.0, 6400.0, 400.0);
    c.scatter("crystal", -450.0, 900.0, 80.0, 220.0, -1.0);
    c.scatter("crystal", 2050.0, 2080.0, 80.0, 40.0, -1.0);
    c.scatter("mushroom", 3420.0, 3700.0, 120.0, 90.0, -1.0);
    c.scatter("crystal", 6500.0, 6800.0, 120.0, 120.0, -1.0);
    c.scatter("mushroom", 8950.0, 9600.0, 1330.0, 160.0, -1.0);
    c.scatter("crystal", 11650.0, 12400.0, 1400.0, 180.0, -1.0);
    c.finish()
}
