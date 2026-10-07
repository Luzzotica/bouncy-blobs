//! Chapter 4 — **Vine Gardens** (Glowroot Grotto).
//!
//! Glowing roots and hanging vines. Pip learns to grab (touch a vine in the
//! air), swing (stick), climb (stick up/down) and let go (button) for a big
//! fling: a safe first swing, a swing chain over spikes, a climbing vine up
//! a cliff, floppy rope bridges and leaf slabs, a rising vine traverse, a
//! vine well, and a trampoline-to-vine finale over drips and goo.
//!
//! Mechanics: vines (grab, swing, climb, let go), rope bridges, swinging chains.
//! "Friends are just ropes you choose."

use super::*;

/// A vine hanging from a little root knob (so it never hangs from nothing).
fn vine(c: &mut Ch, x: f32, top: f32, len: f32) {
    c.poly(&[v(x - 34.0, top + 30.0), v(x + 34.0, top + 30.0), v(x + 14.0, top - 4.0), v(x - 14.0, top - 4.0)]);
    c.vine(v(x, top), len);
}

/// A floppy rope bridge (thin, very soft).
fn rope_bridge(c: &mut Ch, a: Vec2, b: Vec2) {
    c.bridge(a, b, 16.0, 0.12);
}

pub fn build() -> Course {
    let mut c = Ch::new(4, "Vine Gardens", Theme::Vines, -1400.0);
    c.spawn(v(0.0, 40.0));

    // ------------------------------------------------ the first swing
    c.wall(-1300.0, -500.0, -1400.0, 2200.0);
    c.floor(&[v(-500.0, 0.0), v(650.0, 0.0)]);
    // The cast from the intro cutscene greets you at the start.
    c.npc("tangle1", v(-300.0, 40.0), NpcRole::Huddle, "#6fd36a", 24.0);
    c.npc("tangle2", v(-170.0, 40.0), NpcRole::Huddle, "#6fd36a", 24.0);
    c.say(-80.0, 80.0, 0.0, "ch04_hello");
    c.say(250.0, 320.0, 0.0, "ch04_vines");
    vine(&mut c, 900.0, 620.0, 400.0);
    // A soft basin under the first vine; a ramp leads back out.
    c.floor(&[v(650.0, -160.0), v(1000.0, -160.0), v(1150.0, 0.0), v(1500.0, 0.0)]);
    c.drops(700.0, 950.0, -160.0, 3);
    c.pickup_arc(v(650.0, 120.0), v(1200.0, 80.0), 260.0, 4);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 600.0, 0.0).wp(Move::Rope, 1250.0, 0.0).wp(Move::Walk, 1440.0, 0.0);
    // A swing chain over spikes.
    c.say(1380.0, 1430.0, 0.0, "ch04_swing_chain");
    c.ledge(1500.0, 2550.0, -350.0);
    c.spikes(v(1500.0, -350.0), v(2550.0, -350.0));
    vine(&mut c, 1750.0, 660.0, 420.0);
    vine(&mut c, 2230.0, 660.0, 420.0);
    c.pickup_arc(v(1750.0, 260.0), v(2230.0, 260.0), 160.0, 3);
    c.pickup_arc(v(2230.0, 260.0), v(2650.0, 60.0), 200.0, 2);
    c.floor(&[v(2550.0, 0.0), v(3300.0, 0.0)]);
    c.wp(Move::Rope, 2680.0, 0.0);
    c.cp(2800.0, 0.0);

    // ------------------------------------------- the climbing vine
    c.say(2950.0, 3000.0, 0.0, "ch04_climb");
    c.ceiling(&[v(3080.0, 1060.0), v(3300.0, 1060.0)], 300.0);
    c.vine(v(3200.0, 1060.0), 840.0);
    c.pickups(v(3200.0, 450.0), v(3200.0, 950.0), 4);
    c.floor(&[v(3300.0, 650.0), v(4200.0, 650.0)]);
    c.wp(Move::Walk, 3080.0, 0.0).wp(Move::Rope, 3450.0, 650.0);
    // Floppy rope bridge over spikes, then leaf slabs up to a ledge.
    c.ledge(4200.0, 5600.0, 100.0);
    c.spikes(v(4200.0, 100.0), v(5600.0, 100.0));
    rope_bridge(&mut c, v(4200.0, 650.0), v(4850.0, 650.0));
    c.ledge(4850.0, 4950.0, 650.0);
    c.drops(4280.0, 4780.0, 600.0, 4);
    c.slab(v(5150.0, 740.0), v(200.0, 34.0), 0.35);
    c.slab(v(5420.0, 830.0), v(200.0, 34.0), 0.35);
    c.pickup(v(5150.0, 800.0)).pickup(v(5420.0, 890.0));
    c.floor(&[v(5600.0, 900.0), v(6100.0, 900.0)]);
    c.wp(Move::Walk, 4500.0, 620.0).wp(Move::Walk, 4900.0, 650.0);
    c.wp(Move::Jump, 5150.0, 757.0).wp(Move::Jump, 5420.0, 847.0).wp(Move::Jump, 5700.0, 900.0);
    c.cp(5850.0, 900.0);

    // ------------------------------------- the rising vine traverse
    c.say(5980.0, 6040.0, 900.0, "ch04_traverse");
    c.ledge(6100.0, 7700.0, 200.0);
    c.spikes(v(6100.0, 200.0), v(7700.0, 200.0));
    vine(&mut c, 6380.0, 1650.0, 640.0);
    vine(&mut c, 6880.0, 1760.0, 640.0);
    vine(&mut c, 7360.0, 1860.0, 620.0);
    c.pickup_arc(v(6380.0, 1150.0), v(6880.0, 1250.0), 200.0, 3);
    c.pickup_arc(v(6880.0, 1250.0), v(7360.0, 1350.0), 200.0, 3);
    c.floor(&[v(7700.0, 1250.0), v(9000.0, 1250.0)]);
    c.wp(Move::Walk, 6050.0, 900.0).wp(Move::Rope, 7850.0, 1250.0);

    // --------------------------------------------------- the vine well
    c.say(8000.0, 8060.0, 1250.0, "ch04_well");
    vine(&mut c, 8520.0, 1950.0, 640.0);
    c.shelf(8720.0, 9000.0, 1700.0, 90.0);
    c.ceiling(&[v(8560.0, 2510.0), v(8640.0, 2510.0)], 200.0);
    c.vine(v(8600.0, 2510.0), 640.0);
    c.wall(9000.0, 9300.0, 1250.0, 2250.0);
    c.floor(&[v(9000.0, 2250.0), v(9600.0, 2250.0)]);
    c.pickups(v(8520.0, 1400.0), v(8520.0, 1800.0), 3);
    c.pickups(v(8800.0, 1760.0), v(8950.0, 1760.0), 2);
    c.pickups(v(8600.0, 2000.0), v(8600.0, 2400.0), 3);
    c.wp(Move::Walk, 8380.0, 1250.0).wp(Move::Rope, 8860.0, 1700.0).wp(Move::Rope, 8600.0, 2050.0).wp(Move::Rope, 9150.0, 2250.0);
    c.cp(9250.0, 2250.0);

    // ---------------------------------------------- the finale remix
    c.say(9450.0, 9500.0, 2250.0, "ch04_remix");
    rope_bridge(&mut c, v(9600.0, 2250.0), v(10300.0, 2250.0));
    c.drip_hazard(v(9820.0, 2920.0), 650.0, 30.0, 0.0);
    c.drip_hazard(v(10080.0, 2920.0), 650.0, 30.0, 0.5);
    c.floor(&[v(9600.0, 1980.0), v(10050.0, 1980.0), v(10300.0, 2250.0)]);
    c.zone(v(9600.0, 1980.0), v(10070.0, 2100.0), ZoneKind::Goo { drag: 5.0 });
    c.drops(9680.0, 10220.0, 2230.0, 4);
    c.ledge(10300.0, 10700.0, 2250.0);
    c.wp(Move::Walk, 9950.0, 2200.0).wp(Move::Walk, 10380.0, 2250.0);
    c.cp(10420.0, 2250.0);
    // Trampoline up to a high vine, fling to the goal.
    let (tx, cap) = (10560.0, 2365.0);
    c.trampoline(v(tx, 2250.0), cap - 2250.0 - 160.0 * 0.28, 160.0, 1150.0);
    c.ledge(10700.0, 11250.0, 1700.0);
    c.spikes(v(10700.0, 1700.0), v(11250.0, 1700.0));
    vine(&mut c, 10800.0, 3120.0, 560.0);
    c.pickup_arc(v(10560.0, 2450.0), v(10800.0, 2700.0), 150.0, 2);
    c.pickup_arc(v(10800.0, 2650.0), v(11400.0, 2650.0), 200.0, 3);
    c.floor(&[v(11250.0, 2600.0), v(12100.0, 2600.0)]);
    c.wp(Move::Jump, tx, cap).wp(Move::Rope, 11400.0, 2600.0);
    c.say(11450.0, 11500.0, 2600.0, "ch04_friends");
    c.goal(v(11700.0, 2600.0), v(11900.0, 2820.0));
    c.wp(Move::Walk, 11800.0, 2600.0);
    c.wall(12100.0, 12900.0, -1400.0, 4200.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 820.0), v(600.0, 860.0), v(1500.0, 900.0), v(2600.0, 900.0), v(3080.0, 1060.0)]);
    c.roof(&[v(3300.0, 1300.0), v(4200.0, 1340.0), v(5600.0, 1400.0), v(6100.0, 1480.0), v(6380.0, 1680.0), v(6880.0, 1790.0), v(7360.0, 1890.0), v(7700.0, 1900.0), v(8200.0, 1900.0)]);
    c.wall(7900.0, 8250.0, 1900.0, 3500.0);
    c.roof(&[v(8250.0, 2950.0), v(9600.0, 2950.0), v(10300.0, 3000.0), v(10800.0, 3200.0), v(12100.0, 3250.0)]);

    // ----------------------------------------------------------- decor
    c.hang("glowworm", -400.0, 12000.0, 420.0);
    c.hang("drip", 9300.0, 10500.0, 300.0);
    c.scatter("mushroom", -450.0, 600.0, 0.0, 150.0, -1.0);
    c.scatter("crystal", 1170.0, 1450.0, 0.0, 140.0, -1.0);
    c.scatter("mushroom", 2600.0, 3050.0, 0.0, 150.0, -1.0);
    c.scatter("crystal", 3400.0, 4100.0, 650.0, 230.0, -1.0);
    c.scatter("mushroom", 7750.0, 8350.0, 1250.0, 150.0, -1.0);
    c.scatter("crystal", 11300.0, 12000.0, 2600.0, 200.0, -1.0);
    c.decor("lantern", v(11800.0, 3000.0), 0.8, -1.0);
    c.finish()
}
