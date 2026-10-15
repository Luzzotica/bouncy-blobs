//! Chapter 3 — **Mushroom Bounce** (Fungus Caverns).
//!
//! Pure joy. Pip discovers that bouncing is how you go *up*: trampoline
//! mushrooms, spring pads, a momentum chain of caps over a spiky pit, an
//! angled spring fling, a bouncy-floored cavern you climb cap by cap, and a
//! finale that remixes drips and membranes from the Drip.
//!
//! Mechanics: bouncy mushrooms (flat, dome and ball caps — swell as you
//! land to fly higher), spring pads, momentum chains, bouncy floors.

use super::*;

/// A bouncy mushroom whose cap top is at (x, cap_y), standing on `base_y`:
/// a soft flat cap that launches you straight up (swell as you land on it
/// to fly much higher).
fn tramp(c: &mut Ch, x: f32, base_y: f32, cap_y: f32, power: f32) {
    c.shroom(x, base_y, cap_y, power, MushroomShape::Flat);
}


pub fn build() -> (Blueprint, Course) {
    let mut c = Ch::new(3, "Mushroom Bounce", Theme::Fungus, -1400.0);
    c.about(&["Chapter 3 — **Mushroom Bounce** (Fungus Caverns).", "", "Pure joy. Pip discovers that bouncing is how you go *up*: trampoline", "mushrooms, spring pads, a momentum chain of caps over a spiky pit, an", "angled spring fling, a bouncy-floored cavern you climb cap by cap, and a", "finale that remixes drips and membranes from the Drip.", "", "Mechanics: bouncy mushrooms (flat, dome and ball caps — swell as you", "land to fly higher), spring pads, momentum chains, bouncy floors."]);
    c.spawn(v(0.0, 40.0));

    c.section("first boings");
    c.entry_cave(-1300.0, -500.0, 0.0, 2200.0, Theme::Drip);
    c.floor(&[v(-500.0, 0.0), v(740.0, 0.0)]);
    c.note("The cast from the intro cutscene greets you at the start.");
    for (k, x) in [-330.0, -240.0, -150.0].iter().enumerate() {
        c.npc(&format!("cap{}", k + 1), v(*x, 40.0), NpcRole::Huddle, "#ff6fa8", 26.0);
    }
    c.say(-80.0, 80.0, 0.0, "ch03_hello");
    c.say(150.0, 220.0, 0.0, "ch03_fungus");
    c.note("Secret: a spring behind the start up to a hidden shelf.");
    c.spring(v(-400.0, 0.0), 90.0, 1300.0);
    c.shelf(-500.0, -240.0, 470.0, 60.0);
    c.pickups(v(-460.0, 520.0), v(-280.0, 520.0), 4);
    c.note("A first trampoline: up to a ledge you can't jump to.");
    tramp(&mut c, 600.0, 0.0, 115.0, 1150.0);
    c.say(380.0, 440.0, 0.0, "ch03_first_trampoline");
    c.ledge(740.0, 1500.0, 330.0);
    c.pickups(v(600.0, 200.0), v(600.0, 380.0), 3);
    c.drops(950.0, 1400.0, 330.0, 3);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 440.0, 0.0).wp(Move::Jump, 600.0, 115.0).wp(Move::Spring, 860.0, 330.0);
    c.wp(Move::Walk, 1450.0, 330.0);
    c.note("Down, then a spring pad up to the next tier.");
    c.floor(&[v(1500.0, 0.0), v(2100.0, 0.0)]);
    c.spring(v(1950.0, 0.0), 90.0, 1500.0);
    c.say(1640.0, 1700.0, 0.0, "ch03_spring");
    c.pickups(v(1950.0, 200.0), v(1950.0, 560.0), 4);
    c.ledge(2100.0, 2700.0, 520.0);
    c.wp(Move::Drop, 1650.0, 0.0).wp(Move::Walk, 1950.0, 0.0).wp(Move::Spring, 2200.0, 520.0);
    c.cp(2330.0, 520.0);

    c.section("the momentum chain");
    c.say(2560.0, 2620.0, 520.0, "ch03_chain");
    c.note("The pit floor rises with the chain so its spikes stay in view (docs/LevelDesign.md rule 1: never deeper than MAX_HAZARD_DEPTH).");
    let pit1 = |x: f32| 260.0 + (x - 2700.0) / 1300.0 * 240.0;
    c.floor(&[v(2700.0, pit1(2700.0)), v(4000.0, pit1(4000.0))]);
    c.spikes(v(2700.0, pit1(2700.0)), v(4000.0, pit1(4000.0)));
    tramp(&mut c, 2950.0, pit1(2950.0), 380.0, 1150.0);
    tramp(&mut c, 3350.0, pit1(3350.0), 480.0, 1150.0);
    tramp(&mut c, 3750.0, pit1(3750.0), 580.0, 1150.0);
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

    c.section("angled spring over the gap");
    c.say(4380.0, 4420.0, 760.0, "ch03_angled");
    c.spring(v(4500.0, 760.0), 60.0, 1450.0);
    c.pickup_arc(v(4600.0, 900.0), v(5400.0, 820.0), 400.0, 5);
    c.ledge(4600.0, 5400.0, 520.0);
    c.spikes(v(4600.0, 520.0), v(5400.0, 520.0));
    c.wp(Move::Walk, 4500.0, 760.0).wp(Move::Spring, 5620.0, 760.0);

    c.section("the bouncy cavern (climb cap by cap)");
    c.ground_with(&[v(5400.0, 760.0), v(7100.0, 760.0)], 2160.0, Material::Bouncy, 0.7);
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

    c.section("finale remix");
    c.drip_hazard(v(7550.0, 2760.0), 650.0, 30.0, 0.0);
    c.spring(v(7900.0, 2050.0), 90.0, 1350.0);
    c.one_way_top(7800.0, 8100.0, 2450.0, 20.0);
    c.pickups(v(7900.0, 2200.0), v(7900.0, 2400.0), 2);
    c.ledge(8250.0, 8700.0, 2560.0);
    c.wp(Move::Walk, 7900.0, 2050.0).wp(Move::Spring, 8000.0, 2450.0).wp(Move::Jump, 8330.0, 2560.0);
    c.cp(8500.0, 2560.0);
    c.note("A last chain of caps over the dark, then up to the glow.");
    let pit3 = |x: f32| 2290.0 + (x - 8700.0) / 850.0 * 110.0;
    c.floor(&[v(8700.0, pit3(8700.0)), v(9550.0, pit3(9550.0))]);
    c.spikes(v(8700.0, pit3(8700.0)), v(9550.0, pit3(9550.0)));
    tramp(&mut c, 8950.0, pit3(8950.0), 2400.0, 1200.0);
    tramp(&mut c, 9300.0, pit3(9300.0), 2450.0, 1250.0);
    c.pickup_arc(v(8950.0, 2470.0), v(9300.0, 2520.0), 320.0, 3);
    c.pickup_arc(v(9300.0, 2520.0), v(9650.0, 2750.0), 300.0, 2);
    c.floor(&[v(9550.0, 2700.0), v(10600.0, 2700.0)]);
    c.say(9700.0, 9760.0, 2700.0, "ch03_bouncing_up");
    c.wp(Move::Walk, 8650.0, 2560.0)
        .wp(Move::Drop, 8950.0, 2400.0)
        .wp(Move::Spring, 9300.0, 2450.0)
        .wp(Move::Spring, 9660.0, 2700.0)
        .wp(Move::Walk, 11080.0, 2700.0);
    c.exit_cave(10600.0, 11400.0, 2700.0, 4300.0, Theme::Vines);

    c.section("roof");
    c.roof(&[v(-1300.0, 760.0), v(800.0, 820.0), v(1500.0, 960.0), v(2100.0, 1180.0), v(2700.0, 1300.0), v(4000.0, 1380.0), v(5500.0, 1420.0), v(5900.0, 1400.0)]);
    c.roof(&[v(6200.0, 2650.0), v(7000.0, 2700.0), v(7700.0, 2820.0), v(8100.0, 3060.0), v(9000.0, 3200.0), v(10600.0, 3300.0)]);

    c.section("decor");
    c.scatter("mushroom", -450.0, 400.0, 0.0, 140.0, -1.0);
    c.scatter("mushroom", 900.0, 1450.0, 330.0, 110.0, -1.0);
    c.scatter("mushroom", 2150.0, 2650.0, 520.0, 120.0, -1.0);
    c.scatter("mushroom", 4050.0, 4450.0, 760.0, 100.0, -1.0);
    c.scatter("mushroom", 7150.0, 7850.0, 2050.0, 140.0, -1.0);
    c.scatter("mushroom", 9650.0, 10550.0, 2700.0, 120.0, -1.0);
    c.scatter("crystal", 5550.0, 6150.0, 760.0, 200.0, -1.0);
    c.hang("glowworm", -400.0, 10500.0, 480.0);
    c.hang("drip", 7200.0, 9000.0, 450.0);
    c.finish()
}
