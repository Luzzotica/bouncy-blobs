//! Chapter 3 — **Mushroom Bounce** (Fungus Caverns).
//!
//! Pure joy. Pip discovers that bouncing is how you go *up*: trampoline
//! mushrooms, spring pads, a momentum chain of caps over a spiky pit, an
//! angled spring fling, a bouncy-floored cavern you climb cap by cap, and a
//! finale that remixes drips and membranes from the Drip.
//!
//! Mechanics: trampoline mushrooms, spring pads, momentum chains, bouncy floors.

use super::*;

/// A trampoline mushroom whose cap top is at (x, cap_y), standing on `base_y`.
fn tramp(c: &mut Ch, x: f32, base_y: f32, cap_y: f32, power: f32) {
    let cap_w = 160.0;
    let height = cap_y - base_y - cap_w * 0.28;
    if height < 130.0 {
        // A rock pedestal so nobody gets stuck under a low cap.
        c.poly(&[v(x - 70.0, base_y), v(x + 70.0, base_y), v(x + 40.0, base_y + height - 6.0), v(x - 40.0, base_y + height - 6.0)]);
    }
    c.trampoline(v(x, base_y), height, cap_w, power);
}

pub fn build() -> Course {
    let mut c = Ch::new(3, "Mushroom Bounce", Theme::Fungus, -1400.0);
    c.spawn(v(0.0, 40.0));

    // ------------------------------------------- first boings
    c.wall(-1300.0, -500.0, -1400.0, 2200.0);
    c.floor(&[v(-500.0, 0.0), v(740.0, 0.0)]);
    // The cast from the intro cutscene greets you at the start.
    for (k, x) in [-330.0, -240.0, -150.0].iter().enumerate() {
        c.npc(&format!("cap{}", k + 1), v(*x, 40.0), NpcRole::Huddle, "#ff6fa8", 26.0);
    }
    c.say(-80.0, 80.0, 0.0, "ch03_hello");
    c.say(150.0, 220.0, 0.0, "ch03_fungus");
    // Secret: a spring behind the start up to a hidden shelf.
    c.spring(v(-400.0, 0.0), 90.0, 1300.0);
    c.shelf(-500.0, -240.0, 470.0, 60.0);
    c.pickups(v(-460.0, 520.0), v(-280.0, 520.0), 4);
    // A first trampoline: up to a ledge you can't jump to.
    tramp(&mut c, 600.0, 0.0, 115.0, 1150.0);
    c.say(380.0, 440.0, 0.0, "ch03_first_trampoline");
    c.ledge(740.0, 1500.0, 330.0);
    c.pickups(v(600.0, 200.0), v(600.0, 380.0), 3);
    c.drops(950.0, 1400.0, 330.0, 3);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 440.0, 0.0).wp(Move::Jump, 600.0, 115.0).wp(Move::Spring, 860.0, 330.0);
    c.wp(Move::Walk, 1450.0, 330.0);
    // Down, then a spring pad up to the next tier.
    c.floor(&[v(1500.0, 0.0), v(2100.0, 0.0)]);
    c.spring(v(1950.0, 0.0), 90.0, 1500.0);
    c.say(1640.0, 1700.0, 0.0, "ch03_spring");
    c.pickups(v(1950.0, 200.0), v(1950.0, 560.0), 4);
    c.ledge(2100.0, 2700.0, 520.0);
    c.wp(Move::Drop, 1650.0, 0.0).wp(Move::Walk, 1950.0, 0.0).wp(Move::Spring, 2200.0, 520.0);
    c.cp(2330.0, 520.0);

    // ------------------------------------- the momentum chain
    c.say(2560.0, 2620.0, 520.0, "ch03_chain");
    c.ledge(2700.0, 4000.0, -400.0);
    c.spikes(v(2700.0, -400.0), v(4000.0, -400.0));
    tramp(&mut c, 2950.0, -400.0, 380.0, 1150.0);
    tramp(&mut c, 3350.0, -400.0, 480.0, 1150.0);
    tramp(&mut c, 3750.0, -400.0, 580.0, 1150.0);
    c.pickup_arc(v(2950.0, 450.0), v(3350.0, 550.0), 300.0, 3);
    c.pickup_arc(v(3350.0, 550.0), v(3750.0, 650.0), 300.0, 3);
    c.pickup_arc(v(3750.0, 650.0), v(4100.0, 800.0), 260.0, 2);
    c.ledge(4000.0, 4600.0, 760.0);
    c.wp(Move::Walk, 2650.0, 520.0)
        .wp(Move::Drop, 2950.0, 380.0)
        .wp(Move::Spring, 3350.0, 480.0)
        .wp(Move::Spring, 3750.0, 580.0)
        .wp(Move::Spring, 4100.0, 760.0);
    c.cp(4250.0, 760.0);

    // ---------------------------------- angled spring over the gap
    c.say(4380.0, 4420.0, 760.0, "ch03_angled");
    c.spring(v(4500.0, 760.0), 60.0, 1450.0);
    c.pickup_arc(v(4600.0, 900.0), v(5400.0, 820.0), 400.0, 5);
    c.ledge(4600.0, 5400.0, -300.0);
    c.spikes(v(4600.0, -300.0), v(5400.0, -300.0));
    c.wp(Move::Walk, 4500.0, 760.0).wp(Move::Spring, 5620.0, 760.0);

    // ------------------------- the bouncy cavern (climb cap by cap)
    c.b.ground_with(&[v(5400.0, 760.0), v(7100.0, 760.0)], 2160.0, Material::Bouncy, 0.7);
    c.say(6050.0, 6100.0, 760.0, "ch03_cavern");
    c.drops(5650.0, 6050.0, 760.0, 3);
    tramp(&mut c, 6350.0, 760.0, 875.0, 1250.0);
    c.shelf(6550.0, 6850.0, 1180.0, 80.0);
    tramp(&mut c, 6760.0, 1180.0, 1295.0, 1250.0);
    c.shelf(6200.0, 6500.0, 1600.0, 80.0);
    tramp(&mut c, 6290.0, 1600.0, 1715.0, 1250.0);
    c.shelf(6550.0, 7100.0, 2050.0, 120.0);
    c.floor(&[v(7100.0, 2050.0), v(8000.0, 2050.0)]);
    c.wall(5900.0, 6200.0, 1400.0, 3200.0);
    c.pickup(v(6650.0, 1240.0)).pickup(v(6380.0, 1660.0)).pickup(v(6560.0, 1500.0)).pickup(v(6450.0, 1950.0));
    c.wp(Move::Walk, 6200.0, 760.0)
        .wp(Move::Jump, 6350.0, 875.0)
        .wp(Move::Spring, 6650.0, 1180.0)
        .wp(Move::Jump, 6760.0, 1295.0)
        .wp(Move::Spring, 6400.0, 1600.0)
        .wp(Move::Jump, 6290.0, 1715.0)
        .wp(Move::Spring, 6700.0, 2050.0);
    c.cp(7300.0, 2050.0);

    // ------------------------------------------- finale remix
    c.drip_hazard(v(7550.0, 2760.0), 650.0, 30.0, 0.0);
    c.spring(v(7900.0, 2050.0), 90.0, 1350.0);
    c.one_way(v(7800.0, 2430.0), v(8100.0, 2450.0));
    c.pickups(v(7900.0, 2200.0), v(7900.0, 2400.0), 2);
    c.ledge(8250.0, 8700.0, 2560.0);
    c.wp(Move::Walk, 7900.0, 2050.0).wp(Move::Spring, 8000.0, 2450.0).wp(Move::Jump, 8330.0, 2560.0);
    c.cp(8500.0, 2560.0);
    // A last chain of caps over the dark, then up to the glow.
    c.ledge(8700.0, 9550.0, 1700.0);
    c.spikes(v(8700.0, 1700.0), v(9550.0, 1700.0));
    tramp(&mut c, 8950.0, 1700.0, 2400.0, 1200.0);
    tramp(&mut c, 9300.0, 1700.0, 2450.0, 1250.0);
    c.pickup_arc(v(8950.0, 2470.0), v(9300.0, 2520.0), 320.0, 3);
    c.pickup_arc(v(9300.0, 2520.0), v(9650.0, 2750.0), 300.0, 2);
    c.floor(&[v(9550.0, 2700.0), v(10600.0, 2700.0)]);
    c.say(9700.0, 9760.0, 2700.0, "ch03_bouncing_up");
    c.goal(v(10150.0, 2700.0), v(10350.0, 2920.0));
    c.wp(Move::Walk, 8650.0, 2560.0)
        .wp(Move::Drop, 8950.0, 2400.0)
        .wp(Move::Spring, 9300.0, 2450.0)
        .wp(Move::Spring, 9660.0, 2700.0)
        .wp(Move::Walk, 10250.0, 2700.0);
    c.wall(10600.0, 11400.0, -1400.0, 4300.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 760.0), v(800.0, 820.0), v(1500.0, 960.0), v(2100.0, 1180.0), v(2700.0, 1300.0), v(4000.0, 1380.0), v(5500.0, 1420.0), v(5900.0, 1400.0)]);
    c.roof(&[v(6200.0, 2650.0), v(7000.0, 2700.0), v(7700.0, 2820.0), v(8100.0, 3060.0), v(9000.0, 3200.0), v(10600.0, 3300.0)]);

    // ----------------------------------------------------------- decor
    c.scatter("mushroom", -450.0, 400.0, 0.0, 140.0, -1.0);
    c.scatter("mushroom", 900.0, 1450.0, 330.0, 110.0, -1.0);
    c.scatter("mushroom", 2150.0, 2650.0, 520.0, 120.0, -1.0);
    c.scatter("mushroom", 4050.0, 4450.0, 760.0, 100.0, -1.0);
    c.scatter("mushroom", 7150.0, 7850.0, 2050.0, 140.0, -1.0);
    c.scatter("mushroom", 9650.0, 10550.0, 2700.0, 120.0, -1.0);
    c.scatter("crystal", 5550.0, 6150.0, 760.0, 200.0, -1.0);
    c.hang("glowworm", -400.0, 10500.0, 480.0);
    c.hang("drip", 7200.0, 9000.0, 450.0);
    c.decor("lantern", v(10250.0, 3100.0), 0.8, -1.0);
    c.finish()
}
