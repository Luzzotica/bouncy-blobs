//! Chapter 7 — **Windy Chimneys** (Updraft Flues).
//!
//! Warm air pours up through the rock. Pip learns that puffing up (holding
//! the button) turns a blob into a balloon: a strong updraft that lifts
//! anyone, then a gentle one that only lifts the puffed, a gust that blows
//! you across a gap, a tall flue full of spinning fans, a field of geysers
//! over spikes, a sticky chimney to wall-jump up, one last great updraft —
//! where a faraway giggle echoes down the flue — and glow-moth balloons
//! that carry a puffed-up blob over the last spiky gulfs. The Glow is real.
//!
//! Mechanics: updrafts, inflate-to-float, fans, gusts (plus sticky walls),
//! balloons (puff to rise, let go to sink; they pop on spikes).

use super::*;

/// An updraft column (x0..x1, y0..y1) with lift `accel` (1400 = puff to rise,
/// 2200 = lifts anyone).
fn updraft(c: &mut Ch, x0: f32, x1: f32, y0: f32, y1: f32, accel: f32) {
    // (The zone itself is drawn as a shimmering column; no decor floating
    // in mid-air.)
    c.wind(v(x0, y0), v(x1, y1), v(0.0, accel));
}

pub fn build() -> Course {
    let mut c = Ch::new(7, "Windy Chimneys", Theme::Chimney, -1400.0);
    c.spawn(v(0.0, 40.0));

    // -------------------------------------- the first warm breath
    c.entry_cave(-1300.0, -500.0, 0.0, 2400.0, Theme::Lake);
    c.floor(&[v(-500.0, 0.0), v(1100.0, 0.0)]);
    // The cast from the intro cutscene greets you at the start.
    c.npc("gust1", v(-300.0, 40.0), NpcRole::Huddle, "#bfe8ff", 20.0);
    c.npc("gust2", v(-180.0, 40.0), NpcRole::Huddle, "#bfe8ff", 20.0);
    c.say(-80.0, 80.0, 0.0, "ch07_hello");
    c.say(300.0, 360.0, 0.0, "ch07_draft");
    updraft(&mut c, 900.0, 1100.0, 0.0, 640.0, 2300.0);
    c.pickups(v(1000.0, 150.0), v(1000.0, 550.0), 3);
    c.floor(&[v(1100.0, 450.0), v(1800.0, 450.0)]);
    // Secret: drift left off the top of the first updraft onto a hidden shelf.
    c.shelf(680.0, 880.0, 600.0, 50.0);
    c.pickups(v(710.0, 650.0), v(850.0, 650.0), 4);
    c.wp(Move::Walk, 0.0, 0.0).wp(Move::Walk, 820.0, 0.0).wp(Move::Wind, 1000.0, 520.0).wp(Move::Drop, 1250.0, 450.0);
    // Now one that only lifts you when you puff up.
    c.say(1500.0, 1560.0, 450.0, "ch07_puff");
    updraft(&mut c, 1800.0, 2000.0, 450.0, 1150.0, 1400.0);
    c.pickups(v(1900.0, 650.0), v(1900.0, 1050.0), 3);
    c.shelf(2000.0, 2700.0, 1000.0, 300.0);
    c.ledge(1800.0, 2000.0, 450.0);
    c.wp(Move::Walk, 1720.0, 450.0).wp(Move::Wind, 1900.0, 1060.0).wp(Move::Drop, 2150.0, 1000.0);
    c.cp(2400.0, 1000.0);

    // --------------------------------------------- a gust across a gap
    c.say(2560.0, 2610.0, 1000.0, "ch07_gust");
    c.ledge(2700.0, 3500.0, 740.0);
    c.spikes(v(2700.0, 740.0), v(3500.0, 740.0));
    c.wind(v(2700.0, 980.0), v(3500.0, 1500.0), v(900.0, 0.0));
    c.scatter("drip", 2800.0, 3400.0, 1460.0, 200.0, -1.0);
    c.pickup_arc(v(2700.0, 1060.0), v(3500.0, 1060.0), 220.0, 5);
    c.wp(Move::Walk, 2640.0, 1000.0).wp(Move::Wind, 3600.0, 1000.0);

    // ------------------------------------------- the flue of fans
    c.say(3640.0, 3690.0, 1000.0, "ch07_fans");
    c.wall(3600.0, 3800.0, 1320.0, 3200.0);
    updraft(&mut c, 3800.0, 4100.0, 1000.0, 2470.0, 1400.0);
    c.blade(v(3875.0, 1650.0), v(110.0, 20.0), 1.1);
    c.blade(v(4025.0, 2050.0), v(110.0, 20.0), -1.1);
    c.pickups(v(3950.0, 1200.0), v(3950.0, 2300.0), 4);
    c.floor(&[v(3500.0, 1000.0), v(4100.0, 1000.0)]);
    c.floor(&[v(4100.0, 2400.0), v(4800.0, 2400.0)]);
    c.wp(Move::Walk, 3700.0, 1000.0).wp(Move::Wind, 3950.0, 2420.0).wp(Move::Drop, 4250.0, 2400.0);
    c.cp(4420.0, 2400.0);

    // ------------------------------------- geysers over the spikes
    c.say(4650.0, 4700.0, 2400.0, "ch07_geysers");
    // Vents in a shallow spiky floor: fall into a vent and it puffs you
    // back up; fall between them and... pop.
    c.ledge(4800.0, 6300.0, 2160.0);
    let vents = [4900.0, 5250.0, 5600.0, 5950.0];
    let mut x0 = 4800.0;
    for x in vents {
        c.spikes(v(x0, 2160.0), v(x, 2160.0));
        x0 = x + 200.0;
        updraft(&mut c, x, x + 200.0, 2160.0, 2470.0, 2300.0);
        c.pickup(v(x + 100.0, 2500.0));
    }
    c.spikes(v(x0, 2160.0), v(6300.0, 2160.0));
    c.floor(&[v(6300.0, 2400.0), v(7400.0, 2400.0)]);
    for x in [5175.0, 5525.0, 5875.0] {
        c.pickup(v(x, 2300.0));
    }
    c.drops(6450.0, 6950.0, 2400.0, 3);
    c.wp(Move::Walk, 4760.0, 2400.0);
    for x in [4900.0, 5250.0, 5600.0, 5950.0] {
        c.wp(Move::Wind, x + 100.0, 2420.0);
    }
    c.wp(Move::Drop, 6400.0, 2400.0);
    c.cp(6600.0, 2400.0);

    // ------------------------------------------ the sticky chimney
    c.say(7050.0, 7100.0, 2400.0, "ch07_sticky");
    c.terrain(Shape::rect(v(7340.0, 2570.0), v(7400.0, 3720.0)), Material::Sticky);
    c.terrain(Shape::rect(v(7700.0, 2400.0), v(7760.0, 3650.0)), Material::Sticky);
    c.wall(7000.0, 7340.0, 3050.0, 4800.0);
    c.ledge(7400.0, 7700.0, 2400.0);
    c.wind(v(7400.0, 2400.0), v(7700.0, 3720.0), v(0.0, 900.0));
    c.pickups(v(7550.0, 2700.0), v(7550.0, 3500.0), 4);
    c.floor(&[v(7760.0, 3650.0), v(8600.0, 3650.0)]);
    c.wp(Move::Walk, 7300.0, 2400.0).wp(Move::Wall, 7880.0, 3650.0);
    c.cp(8000.0, 3650.0);

    // ------------------------------------- the last great updraft
    c.ledge(8600.0, 9000.0, 3650.0);
    updraft(&mut c, 8600.0, 9000.0, 3650.0, 4620.0, 1400.0);
    c.wind(v(8600.0, 4400.0), v(9000.0, 4620.0), v(500.0, 0.0));
    c.pickups(v(8800.0, 3900.0), v(8800.0, 4450.0), 4);
    c.floor(&[v(9000.0, 4500.0), v(10200.0, 4500.0)]);
    c.drops(9250.0, 9550.0, 4500.0, 3);
    c.say(9100.0, 9160.0, 4500.0, "ch07_giggle");
    c.wp(Move::Walk, 8550.0, 3650.0).wp(Move::Wind, 8800.0, 4560.0).wp(Move::Drop, 9200.0, 4500.0);

    // ------------------------------------------------ balloons
    // Glow-moth balloons tethered in the flue. Touch one and it ties on:
    // {hold} to puff up and it lifts you (more puff, more lift), let go and
    // you sink. They don't last, and they pop on anything sharp.
    // First: float up onto a shelf high over safe floor.
    c.balloon(v(9450.0, 4590.0), 7.0);
    c.shelf(9800.0, 10300.0, 5120.0, 80.0);
    c.pickups(v(9500.0, 4800.0), v(9700.0, 5150.0), 3);
    c.wp(Move::Walk, 9420.0, 4500.0).wp(Move::Wind, 9950.0, 5120.0);
    // Then drift across a spiky gulf (puff to climb, let go to sink).
    c.ledge(10200.0, 11300.0, 4880.0);
    c.spikes(v(10200.0, 4880.0), v(11300.0, 4880.0));
    c.balloon(v(10180.0, 5210.0), 7.0);
    c.pickup_arc(v(10350.0, 5250.0), v(11250.0, 5250.0), 90.0, 4);
    c.shelf(11300.0, 11900.0, 5120.0, 200.0);
    c.wp(Move::Walk, 10150.0, 5120.0).wp(Move::Wind, 11450.0, 5120.0);
    c.cp(11500.0, 5120.0);
    // Last: a spiky flue, sharp above and below, with a fang hanging in the
    // middle. Rise too high and the balloon pops.
    c.balloon(v(11760.0, 5210.0), 7.0);
    c.ledge(11900.0, 12900.0, 4880.0);
    c.spikes(v(11900.0, 4880.0), v(12900.0, 4880.0));
    c.wall(12300.0, 12460.0, 5360.0, 5520.0);
    c.ceiling_spikes(12300.0, 12460.0, 5360.0);
    c.pickups(v(12080.0, 5150.0), v(12200.0, 5150.0), 2);
    c.pickup(v(12380.0, 5060.0));
    c.pickups(v(12580.0, 5150.0), v(12700.0, 5150.0), 2);
    c.floor(&[v(12900.0, 5060.0), v(13700.0, 5060.0)]);
    c.wp(Move::Walk, 11750.0, 5120.0).wp(Move::Wind, 13050.0, 5060.0);
    // Out through the tunnel: a jumble of bright toy colours beyond.
    c.exit_cave(13700.0, 14500.0, 5060.0, 6900.0, Theme::Toys);
    c.wp(Move::Walk, 14180.0, 5060.0);

    // ------------------------------------------------------------ roof
    c.roof(&[v(-1300.0, 720.0), v(850.0, 760.0), v(900.0, 1150.0), v(1750.0, 1150.0), v(1800.0, 1600.0), v(2700.0, 1650.0), v(3600.0, 1700.0)]);
    c.roof(&[v(3800.0, 2950.0), v(4800.0, 3000.0), v(6300.0, 3050.0), v(7000.0, 3050.0)]);
    c.roof(&[v(7340.0, 4300.0), v(8500.0, 4400.0), v(9000.0, 5100.0), v(9450.0, 5950.0), v(11300.0, 6050.0), v(11880.0, 6050.0), v(11900.0, 5520.0), v(12900.0, 5520.0), v(12950.0, 5900.0), v(13700.0, 5950.0)]);
    // The needle flue's roof bristles (it pops balloons).
    c.roof_spikes(11900.0, 12300.0, &[], 0.0);
    c.roof_spikes(12460.0, 12900.0, &[], 0.0);

    // ----------------------------------------------------------- decor
    c.hang("glowworm", -400.0, 11800.0, 520.0);
    c.scatter("crystal", -450.0, 700.0, 0.0, 230.0, -1.0);
    c.scatter("crystal", 2050.0, 2600.0, 1000.0, 180.0, -1.0);
    c.scatter("mushroom", 6350.0, 7250.0, 2400.0, 180.0, -1.0);
    c.scatter("crystal", 8000.0, 8550.0, 3650.0, 180.0, -1.0);
    c.finish()
}
