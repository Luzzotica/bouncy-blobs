//! Chapter 2 — **The Drip** (Drip Tunnels).
//!
//! Pip rolls on, drippy and sniffly, into the Drip Tunnels: plopping jelly
//! drips, sagging soft bridges over goo and nothing at all, and one-way
//! jelly membranes you boing up through. Glimmer the glowworm turns up,
//! lights the first mushroom, and the tunnels start to climb.
//!
//! Mechanics: falling jelly drops, sagging soft bridges, one-way membranes,
//! and a first push puzzle (a jelly ball into a spiky trench).

use super::*;

/// One-way jelly membrane, 20 px thick, top surface at `y`.
fn membrane(c: &mut Ch, x0: f32, x1: f32, y: f32) {
    c.one_way(v(x0, y - 20.0), v(x1, y));
}

pub fn build() -> Course {
    let mut c = Ch::new(2, "The Drip", Theme::Drip, -1400.0);
    c.spawn(v(0.0, 40.0));

    // ------------------------------------------------ plip, plop, drip
    c.entry_cave(-1300.0, -500.0, 0.0, 1700.0, Theme::Hollow);
    c.floor(&[v(-500.0, 0.0), v(560.0, 0.0), v(700.0, -30.0), v(850.0, 0.0), v(2000.0, 0.0)]);
    // The cast from the intro cutscene greets you at the start.
    c.npc("glimmer_start", v(-200.0, 200.0), NpcRole::Glimmer, "", 12.0);
    c.say(-80.0, 80.0, 0.0, "ch02_hello");
    c.say(250.0, 320.0, 0.0, "ch02_drips");
    // Drips: first one well clear of the path to show the rhythm.
    c.drip_hazard(v(480.0, 560.0), 520.0, 30.0, 0.0);
    c.drip_hazard(v(1000.0, 560.0), 520.0, 30.0, 0.35);
    c.drip_hazard(v(1250.0, 560.0), 520.0, 30.0, 0.7);
    c.drops(150.0, 450.0, 0.0, 3);
    c.drops(1080.0, 1170.0, 0.0, 2);
    c.npc("glimmer", v(1500.0, 200.0), NpcRole::Glimmer, "", 12.0);
    c.say(1380.0, 1440.0, 0.0, "ch02_meet_glimmer");
    c.decor("mushroom", v(1820.0, 0.0), 1.6, -1.0);
    c.cp(1850.0, 0.0);
    c.say(1800.0, 1900.0, 0.0, "ch02_first_light");
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 1950.0, 0.0);

    // ------------------------------------------------- sagging bridges
    // Bridge 1: firm-ish, over a goo basin you can roll out of.
    c.bridge(v(2000.0, 0.0), v(2600.0, 0.0), 26.0, 0.55);
    c.floor(&[v(2000.0, -170.0), v(2350.0, -170.0), v(2600.0, 0.0), v(3000.0, 0.0)]);
    c.zone(v(2000.0, -170.0), v(2380.0, -60.0), ZoneKind::Goo { drag: 5.0 });
    c.drops(2100.0, 2500.0, 0.0, 4);
    c.pickup(v(2200.0, -120.0));
    c.say(1990.0, 2040.0, 0.0, "ch02_bridge_wobble");
    c.wp(Move::Walk, 2300.0, 0.0).wp(Move::Walk, 2950.0, 0.0);
    // Bridge 2: long and floppy over a dark drop, with a drip on the middle.
    c.bridge(v(3000.0, 0.0), v(3700.0, 0.0), 24.0, 0.3);
    c.drip_hazard(v(3350.0, 640.0), 600.0, 34.0, 0.2);
    c.drops(3100.0, 3600.0, -20.0, 4);
    c.ledge(3700.0, 4000.0, 0.0);
    c.wp(Move::Walk, 3350.0, -30.0).wp(Move::Walk, 3800.0, 0.0);
    // Bridge 3: sagging uphill.
    c.bridge(v(4000.0, 0.0), v(4500.0, 150.0), 24.0, 0.4);
    c.floor(&[v(4500.0, 150.0), v(5640.0, 150.0)]);
    c.pickup_arc(v(4050.0, 40.0), v(4450.0, 190.0), 40.0, 3);
    c.wp(Move::Walk, 4250.0, 60.0).wp(Move::Walk, 4600.0, 150.0);
    c.cp(4720.0, 150.0);

    // -------------------------------------------- the membrane shaft
    c.say(4880.0, 4940.0, 150.0, "ch02_membranes");
    let shaft = [(5050.0, 320.0), (5330.0, 480.0), (5050.0, 640.0), (5330.0, 800.0), (5050.0, 960.0)];
    for (x, y) in shaft {
        membrane(&mut c, x, x + 300.0, y);
        c.pickup(v(x + 150.0, y + 60.0));
    }
    membrane(&mut c, 5330.0, 5640.0, 1120.0);
    c.wp(Move::Walk, 5120.0, 150.0);
    for (x, y) in shaft {
        c.wp(Move::Jump, x + 150.0, y);
    }
    c.wp(Move::Jump, 5480.0, 1120.0);
    // Secret: a membrane alcove tucked left at the top of the shaft.
    membrane(&mut c, 4820.0, 5000.0, 1240.0);
    c.pickups(v(4850.0, 1290.0), v(4970.0, 1290.0), 3);
    c.floor(&[v(5640.0, 1120.0), v(6400.0, 1120.0)]);
    c.cp(6050.0, 1120.0);
    c.wp(Move::Walk, 6000.0, 1120.0);

    // ------------------------------------ drippy heights (remix)
    c.say(6250.0, 6300.0, 1120.0, "ch02_up_feeling");
    c.bridge(v(6400.0, 1120.0), v(7000.0, 1120.0), 24.0, 0.25);
    c.drip_hazard(v(6600.0, 1760.0), 620.0, 30.0, 0.0);
    c.drip_hazard(v(6820.0, 1760.0), 620.0, 30.0, 0.5);
    c.drops(6450.0, 6950.0, 1100.0, 4);
    c.ledge(7000.0, 7300.0, 1120.0);
    c.wp(Move::Walk, 6700.0, 1080.0).wp(Move::Walk, 7230.0, 1120.0);
    // Floating membranes over the dark.
    membrane(&mut c, 7420.0, 7660.0, 1270.0);
    membrane(&mut c, 7780.0, 8000.0, 1410.0);
    c.pickup(v(7540.0, 1330.0)).pickup(v(7890.0, 1470.0));
    c.floor(&[v(8100.0, 1420.0), v(8500.0, 1420.0)]);
    c.wp(Move::Jump, 7530.0, 1270.0).wp(Move::Jump, 7870.0, 1410.0).wp(Move::Jump, 8200.0, 1420.0);
    c.cp(8320.0, 1420.0);
    // Uphill floppy bridge, then a membrane ladder to the top.
    c.bridge(v(8500.0, 1420.0), v(9100.0, 1550.0), 24.0, 0.3);
    c.drip_hazard(v(8800.0, 2160.0), 640.0, 30.0, 0.25);
    c.ledge(9100.0, 9200.0, 1550.0);
    membrane(&mut c, 9200.0, 9450.0, 1710.0);
    membrane(&mut c, 9200.0, 9450.0, 1870.0);
    c.pickup(v(9325.0, 1770.0)).pickup(v(9325.0, 1930.0));
    c.floor(&[v(9450.0, 2030.0), v(10300.0, 2030.0)]);
    c.wp(Move::Walk, 8800.0, 1450.0).wp(Move::Walk, 9150.0, 1550.0);
    c.wp(Move::Jump, 9325.0, 1710.0).wp(Move::Jump, 9325.0, 1870.0).wp(Move::Jump, 9560.0, 2030.0);
    c.cp(9580.0, 2030.0);

    // ------------------------------- the jelly ball (first push puzzle)
    // A trench far too wide to jump, spikes in plain sight at the bottom,
    // and a huge wobbly jelly ball parked by the edge. Roll it in, then
    // hop onto it and across.
    c.say(9700.0, 9740.0, 2030.0, "ch02_push");
    c.prop("jellyball", PropKind::Ball, v(10080.0, 2225.0), v(380.0, 380.0), 3.0, "#7fd1c7");
    c.ledge(10300.0, 11220.0, 1780.0);
    c.spikes(v(10300.0, 1780.0), v(11220.0, 1780.0));
    c.pickup_arc(v(10300.0, 2100.0), v(11220.0, 2100.0), 120.0, 4);
    c.floor(&[v(11220.0, 2030.0), v(12100.0, 2030.0)]);
    c.drops(11300.0, 11550.0, 2030.0, 3);
    c.wp(Move::Push, 9850.0, 2030.0).wp(Move::Prop, 10850.0, 2160.0).wp(Move::Prop, 11320.0, 2030.0);
    c.say(11500.0, 11560.0, 2030.0, "ch02_mushroom_glow");
    // Out through the tunnel to the Fungus Caverns (it glows pink).
    c.exit_cave(12100.0, 12900.0, 2030.0, 3300.0, Theme::Fungus);
    c.wp(Move::Walk, 12580.0, 2030.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 560.0), v(1700.0, 600.0), v(2600.0, 640.0), v(3300.0, 700.0), v(4300.0, 720.0), v(4760.0, 760.0), v(4800.0, 1380.0), v(5000.0, 1560.0)]);
    c.roof(&[v(5000.0, 1560.0), v(5800.0, 1600.0), v(6300.0, 1700.0), v(7100.0, 1780.0), v(8000.0, 2000.0), v(9000.0, 2200.0), v(9500.0, 2560.0), v(10500.0, 2600.0), v(12100.0, 2620.0)]);

    // ----------------------------------------------------------- decor
    c.hang("drip", -300.0, 4700.0, 330.0);
    c.hang("drip", 5100.0, 11900.0, 420.0);
    c.hang("glowworm", 100.0, 11900.0, 610.0);
    c.scatter("crystal", 2650.0, 2950.0, 0.0, 150.0, -1.0);
    c.scatter("mushroom", 4600.0, 4950.0, 150.0, 170.0, -1.0);
    c.scatter("crystal", 7020.0, 7280.0, 1120.0, 130.0, -1.0);
    c.scatter("mushroom", 11300.0, 12000.0, 2030.0, 180.0, -1.0);
    c.finish()
}
