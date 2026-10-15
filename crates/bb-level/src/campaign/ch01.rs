//! Chapter 1 — **Too Bouncy** (Huddle Hollow).
//!
//! Pip has just been rolled out of the Back Drip. A sad roll through the
//! outskirts that keeps turning into a happy one: roll, hop, full jump,
//! wobbly jelly stepping stones over the first pointy pit, a squish through
//! a low crawlspace, a staircase up to a ridge, a huge jelly slope with a
//! kicker leap, and finally the first look *up* a shaft towards the Glow.
//!
//! Mechanics: roll, jump (expand), squish under low ceilings, jelly ground.
//!
//! Just past the Bottom Puddle Pip meets **Glimmer**, a small grumpy light,
//! who (grudgingly) becomes Pip's tutor: every lesson in this chapter is a
//! line of hers, and she hovers along at Pip's shoulder from then on.

use super::*;

/// Level id of Glimmer the companion (`bb_sim::npc::COMPANION`).
pub const GLIMMER: &str = "glimmer_companion";

pub fn build() -> Course {
    let mut c = Ch::new(1, "Too Bouncy", Theme::Hollow, -1200.0);
    c.spawn(v(250.0, 40.0));

    // ------------------------------------------------ the Back Drip exit
    // The Bottom Puddle where Pip wakes up — alone — and the cave wall,
    // with the Back Drip tunnel home behind it (sealed: no going back).
    c.entry_cave(-1000.0, -650.0, 0.0, 1600.0, Theme::Hollow);
    c.floor(&[v(-650.0, 0.0), v(900.0, 0.0), v(1150.0, 45.0), v(1400.0, 0.0), v(1700.0, 30.0), v(2150.0, 0.0)]);
    c.say(520.0, 600.0, 0.0, "ch01_goodbye");
    // Glimmer, dozing over the puddle's far end. She tags along once Pip
    // rolls up to her (see `bb_sim::npc::COMPANION`).
    c.npc(GLIMMER, v(1250.0, 200.0), NpcRole::Glimmer, "", 12.0);
    c.say(1030.0, 1080.0, 0.0, "ch01_meet_glimmer");
    c.pickup_arc(v(1000.0, 60.0), v(1300.0, 60.0), 90.0, 3);
    c.pickup_arc(v(1550.0, 70.0), v(1850.0, 70.0), 80.0, 3);
    c.wp(Move::Walk, 250.0, 0.0).wp(Move::Walk, 2030.0, 0.0);

    // --------------------------------------------------- hop lessons
    c.say(1950.0, 2000.0, 0.0, "ch01_first_hop");
    c.ledge(2150.0, 2700.0, 80.0); // hop (+80)
    c.drops(2300.0, 2600.0, 80.0, 3);
    c.wp(Move::Jump, 2290.0, 80.0).wp(Move::Walk, 2560.0, 80.0);
    c.ledge(2700.0, 3200.0, 230.0); // full jump (+150)
    c.wp(Move::Jump, 2800.0, 230.0);
    c.cp(3000.0, 230.0);
    c.say(2930.0, 2980.0, 230.0, "ch01_flower");
    // A soft valley (safe), with a secret shelf above it.
    c.floor(&[v(3200.0, 230.0), v(3330.0, 110.0), v(3570.0, 110.0), v(3700.0, 230.0), v(4000.0, 230.0)]);
    c.drops(3360.0, 3540.0, 110.0, 3);
    c.shelf(3330.0, 3530.0, 400.0, 70.0);
    c.pickups(v(3360.0, 450.0), v(3500.0, 450.0), 4);
    c.decor("crystal", v(3500.0, 400.0), 0.7, -1.0);
    c.wp(Move::Walk, 3950.0, 230.0);

    // --------------------------------------- the first pointy pit
    c.say(3820.0, 3880.0, 230.0, "ch01_pointy");
    // (Every pit is shallow enough that its spikes stay on screen.)
    c.ledge(4000.0, 4240.0, -20.0);
    c.spikes(v(4000.0, -20.0), v(4240.0, -20.0));
    c.ledge(4240.0, 4600.0, 230.0);
    c.pickup_arc(v(3980.0, 280.0), v(4280.0, 280.0), 110.0, 3);
    c.wp(Move::Jump, 4320.0, 230.0).wp(Move::Walk, 4560.0, 230.0);
    // Wobbly jelly stepping stones over a wider spiky pit.
    c.say(4480.0, 4530.0, 230.0, "ch01_jelly_stones");
    c.ledge(4600.0, 5760.0, 30.0);
    c.spikes(v(4600.0, 30.0), v(5760.0, 30.0));
    c.jelly(v(4760.0, 180.0), v(4960.0, 260.0), 0.8);
    c.jelly(v(5120.0, 220.0), v(5320.0, 300.0), 0.8);
    c.jelly(v(5440.0, 180.0), v(5620.0, 260.0), 0.8);
    c.pickup(v(4860.0, 310.0)).pickup(v(5220.0, 350.0)).pickup(v(5530.0, 310.0));
    c.wp(Move::Jump, 4860.0, 260.0).wp(Move::Jump, 5220.0, 300.0).wp(Move::Jump, 5530.0, 260.0);
    c.floor(&[v(5760.0, 230.0), v(7950.0, 230.0)]);
    c.wp(Move::Jump, 5850.0, 230.0);
    c.cp(6150.0, 230.0);

    // ----------------------------------------------- the crawlspace
    c.say(6350.0, 6400.0, 230.0, "ch01_squish");
    c.roof(&[v(6300.0, 760.0), v(6500.0, 440.0), v(6650.0, 302.0), v(7350.0, 302.0), v(7500.0, 440.0), v(7700.0, 760.0)]);
    c.drops(6700.0, 7300.0, 220.0, 6);
    c.wp(Move::Walk, 6550.0, 230.0).wp(Move::Squeeze, 7450.0, 230.0).wp(Move::Walk, 7800.0, 230.0);

    // ---------------------------------------- stairs up to the ridge
    c.ledge(7950.0, 8200.0, 380.0);
    c.ledge(8200.0, 8450.0, 530.0);
    c.ledge(8450.0, 8700.0, 680.0);
    c.floor(&[v(8700.0, 830.0), v(9150.0, 830.0), v(9300.0, 815.0), v(10600.0, 100.0), v(11000.0, 0.0), v(11300.0, 40.0), v(11450.0, 140.0)]);
    for (x, y) in [(8075.0, 380.0), (8325.0, 530.0), (8575.0, 680.0)] {
        c.pickup(v(x, y + 60.0));
    }
    c.wp(Move::Jump, 8040.0, 380.0).wp(Move::Jump, 8290.0, 530.0).wp(Move::Jump, 8540.0, 680.0).wp(Move::Jump, 8800.0, 830.0);
    c.cp(8950.0, 830.0);
    c.say(9100.0, 9160.0, 830.0, "ch01_big_slope");

    // -------------------------------------- the big jelly slope + kicker
    c.pickups(v(9500.0, 760.0), v(10500.0, 220.0), 6);
    c.wp(Move::Walk, 9300.0, 815.0).wp(Move::Walk, 10600.0, 100.0).wp(Move::Walk, 11000.0, 0.0).wp(Move::Walk, 11400.0, 125.0);
    // Leap off the kicker (it's downhill, so it carries further than a
    // flat jump). A soft basin catches short hops; steps lead back out.
    c.pickup_arc(v(11480.0, 200.0), v(11850.0, 40.0), 200.0, 5);
    c.ledge(11450.0, 11650.0, -350.0);
    c.ledge(11650.0, 11750.0, -200.0);
    c.ledge(11750.0, 11850.0, -60.0);
    c.drops(11480.0, 11620.0, -350.0, 2);
    c.floor(&[v(11850.0, 0.0), v(14400.0, 0.0)]);
    c.wp(Move::Jump, 11860.0, 0.0);
    c.cp(12300.0, 0.0);
    c.say(12100.0, 12150.0, 0.0, "ch01_not_bad");

    // ----------------------------------------------- the first look up
    // A tall shaft (the light is somewhere far above), and at its foot the
    // tunnel on to the Drip, glowing teal.
    c.say(13150.0, 13250.0, 0.0, "ch01_look_up");
    c.drops(12600.0, 13500.0, 0.0, 4);
    c.drops(13800.0, 14250.0, 0.0, 3);
    c.wall(12000.0, 13250.0, 1150.0, 4600.0);
    c.exit_cave(14400.0, 15600.0, 0.0, 4600.0, Theme::Drip);
    c.wp(Move::Walk, 14250.0, 0.0).wp(Move::Walk, 14780.0, 0.0);
    c.scatter("crystal", 13300.0, 13600.0, 0.0, 150.0, -1.0);

    // ---------------------------------------------------------- roof
    c.roof(&[
        v(-1000.0, 600.0),
        v(600.0, 660.0),
        v(1800.0, 700.0),
        v(2600.0, 780.0),
        v(3400.0, 860.0),
        v(4400.0, 820.0),
        v(5600.0, 860.0),
        v(6300.0, 760.0),
    ]);
    c.roof(&[v(7700.0, 760.0), v(7950.0, 1100.0), v(8700.0, 1450.0), v(9400.0, 1500.0), v(10600.0, 950.0), v(11400.0, 900.0), v(12200.0, 760.0), v(13250.0, 700.0)]);

    // ---------------------------------------------------------- decor
    c.hang("glowworm", -500.0, 6200.0, 430.0);
    c.scatter("mushroom", -450.0, 1900.0, 0.0, 380.0, -1.0);
    c.hang("drip", 400.0, 6000.0, 700.0);
    c.scatter("crystal", 2780.0, 3180.0, 230.0, 200.0, -1.0);
    c.scatter("mushroom", 5800.0, 6300.0, 230.0, 160.0, -1.0);
    c.hang("glowworm", 7800.0, 12800.0, 520.0);
    c.scatter("mushroom", 12200.0, 13600.0, 0.0, 300.0, -1.0);
    c.finish()
}
