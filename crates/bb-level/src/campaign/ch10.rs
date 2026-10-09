//! Chapter 10 — **The Light Well** (The Old Well).
//!
//! The finale: one long climb up the Old Well toward a ring of daylight,
//! with the whole Huddle (and Granny) bouncing along behind. Every toy in
//! the box comes back: membranes and a sagging bridge, trampolines and
//! springs, a vine and a lift, a fountain column and an updraft, toy blocks,
//! a slinky, and one last great updraft — into a cave at the top of the
//! well, whose mouth opens onto daylight. Lulu waits just inside.
//!
//! It stays a cave climb to the very end: the outside world is only ever
//! seen *through* the exit mouth (sunlight pouring in), never walked into.
//!
//! The well is built as stacked chambers floored with old one-way boards
//! (about every 450–1000 px): you jump, bounce or float up through each
//! floor, and a slip only drops you to the floor of the chamber you're in,
//! never the whole climb. Everything solid sits where nothing climbs under it.

use super::*;

/// Old well boards: a full-width one-way floor at `y` between chambers.
fn boards(c: &mut Ch, x0: f32, x1: f32, y: f32) {
    c.one_way(v(x0, y - 22.0), v(x1, y));
}

fn membrane(c: &mut Ch, x0: f32, x1: f32, y: f32) {
    c.one_way(v(x0, y - 20.0), v(x1, y));
    c.pickup(v((x0 + x1) * 0.5, y + 60.0));
}

/// A trampoline mushroom (with a pedestal if low) whose cap top is at (x, cap).
fn tramp(c: &mut Ch, x: f32, base: f32, cap: f32, power: f32) {
    let height = cap - base - 160.0 * 0.28;
    if height < 130.0 {
        c.poly(&[v(x - 70.0, base), v(x + 70.0, base), v(x + 40.0, base + height - 6.0), v(x - 40.0, base + height - 6.0)]);
    }
    c.trampoline(v(x, base), height, 160.0, power);
}

fn block(c: &mut Ch, x: f32, top: f32, color: &str) {
    c.prop("", PropKind::Block, v(x, top - 60.0), Vec2::splat(120.0), 3.0, color);
    c.b.level.props.last_mut().unwrap().pinned = true;
    c.pickup(v(x, top + 50.0));
}

pub fn build() -> Course {
    let mut c = Ch::new(10, "The Light Well", Theme::Well, -1400.0);
    c.spawn(v(-1350.0, 40.0));
    // Pip climbs alone, toward the light.

    // ------------------------------- the tunnel and a sagging bridge
    c.floor(&[v(-1500.0, 0.0), v(-1100.0, 0.0), v(-1050.0, -120.0), v(-750.0, -120.0), v(-700.0, 0.0), v(0.0, 0.0)]);
    c.zone(v(-1080.0, -120.0), v(-720.0, -30.0), ZoneKind::Goo { drag: 5.0 });
    c.bridge(v(-1100.0, 0.0), v(-700.0, 0.0), 24.0, 0.3);
    c.entry_cave(-1900.0, -1500.0, 0.0, 2000.0, Theme::CaveIn);
    c.wall(-1500.0, 0.0, 520.0, 9650.0);
    c.wall(1400.0, 2400.0, -1400.0, 9650.0);
    c.say(-1150.0, -1100.0, 0.0, "ch10_well");
    c.drops(-1050.0, -750.0, -20.0, 3);
    c.drops(-500.0, -150.0, 0.0, 3);
    c.wp(Move::Walk, -1350.0, 0.0).wp(Move::Walk, -900.0, -20.0).wp(Move::Walk, -60.0, 0.0);

    // --------------------- membrane stairs (one-ways never block a jump)
    boards(&mut c, 0.0, 1400.0, 0.0);
    let a = [(80.0, 380.0, 160.0), (380.0, 680.0, 320.0), (680.0, 980.0, 480.0), (980.0, 1240.0, 640.0)];
    for (x0, x1, y) in a {
        membrane(&mut c, x0, x1, y);
        c.wp(Move::Jump, (x0 + x1) * 0.5, y);
    }
    c.shelf(1250.0, 1400.0, 800.0, 60.0);
    boards(&mut c, 0.0, 1250.0, 800.0);
    c.wp(Move::Jump, 1325.0, 800.0);
    c.cp(1330.0, 800.0);
    c.story(v(1240.0, 760.0), v(1400.0, 900.0), "ch10_huddle");
    let b = [(900.0, 1200.0, 960.0), (600.0, 900.0, 1120.0), (300.0, 600.0, 1280.0), (250.0, 550.0, 1440.0)];
    for (x0, x1, y) in b {
        membrane(&mut c, x0, x1, y);
        c.wp(Move::Jump, (x0 + x1) * 0.5, y);
    }

    // ----------------------------------------- trampolines and springs
    c.shelf(0.0, 250.0, 1600.0, 80.0);
    boards(&mut c, 250.0, 1400.0, 1600.0);
    tramp(&mut c, 100.0, 1600.0, 1715.0, 1250.0);
    c.shelf(300.0, 650.0, 2050.0, 80.0);
    c.spring(v(600.0, 2050.0), 90.0, 1450.0);
    boards(&mut c, 0.0, 300.0, 2050.0);
    boards(&mut c, 650.0, 1400.0, 2050.0);
    c.shelf(700.0, 1000.0, 2500.0, 80.0);
    c.shelf(1100.0, 1300.0, 2500.0, 80.0);
    tramp(&mut c, 1200.0, 2500.0, 2615.0, 1250.0);
    boards(&mut c, 0.0, 700.0, 2500.0);
    boards(&mut c, 1000.0, 1100.0, 2500.0);
    boards(&mut c, 1300.0, 1400.0, 2500.0);
    c.shelf(850.0, 1100.0, 2950.0, 80.0);
    boards(&mut c, 0.0, 850.0, 2950.0);
    boards(&mut c, 1100.0, 1400.0, 2950.0);
    c.pickups(v(100.0, 1800.0), v(350.0, 2150.0), 3);
    c.pickups(v(600.0, 2200.0), v(760.0, 2600.0), 3);
    c.pickups(v(1200.0, 2720.0), v(1080.0, 3000.0), 3);
    c.wp(Move::Jump, 210.0, 1600.0)
        .wp(Move::Jump, 100.0, 1715.0)
        .wp(Move::Spring, 400.0, 2050.0)
        .wp(Move::Walk, 600.0, 2050.0)
        .wp(Move::Spring, 780.0, 2500.0);
    c.cp(850.0, 2500.0);
    c.wp(Move::Walk, 950.0, 2500.0)
        .wp(Move::Jump, 1200.0, 2615.0)
        .wp(Move::Spring, 960.0, 2950.0);

    // ---------------------------------------------- a vine and a lift
    c.shelf(0.0, 620.0, 4050.0, 80.0);
    boards(&mut c, 620.0, 1150.0, 4050.0);
    c.vine(v(600.0, 3970.0), 890.0);
    c.shelf(900.0, 1400.0, 3450.0, 80.0);
    boards(&mut c, 0.0, 520.0, 3450.0);
    c.elevator(v(790.0, 3437.0), v(790.0, 4037.0), 200.0, 6.0);
    c.pickups(v(600.0, 3200.0), v(600.0, 3800.0), 3);
    c.pickups(v(790.0, 3600.0), v(790.0, 3950.0), 2);
    c.wp(Move::Walk, 880.0, 2950.0).wp(Move::Rope, 1050.0, 3450.0).wp(Move::Walk, 950.0, 3450.0);
    c.wp(Move::Ride, 850.0, 3450.0).wp(Move::Ride, 520.0, 4050.0);
    c.cp(300.0, 4050.0);
    c.story(v(0.0, 4000.0), v(700.0, 4150.0), "ch10_halfway");

    // ------------------------------------ the fountain and the updraft
    membrane(&mut c, 750.0, 1000.0, 4150.0);
    c.wall(1050.0, 1150.0, 4450.0, 5000.0);
    c.shelf(1150.0, 1400.0, 4100.0, 80.0);
    c.water(v(1150.0, 4100.0), v(1400.0, 5100.0));
    c.b.ground(&[v(650.0, 5130.0), v(1000.0, 5130.0), v(1150.0, 4980.0)], 150.0);
    boards(&mut c, 0.0, 650.0, 5130.0);
    boards(&mut c, 1150.0, 1400.0, 5130.0);
    c.pickups(v(1275.0, 4300.0), v(1275.0, 4950.0), 4);
    c.wp(Move::Jump, 875.0, 4150.0).wp(Move::Jump, 1250.0, 4100.0).wp(Move::Swim, 1275.0, 4600.0).wp(Move::Swim, 1275.0, 5040.0).wp(Move::Swim, 900.0, 5130.0);
    c.wind(v(300.0, 5000.0), v(520.0, 6170.0), v(0.0, 1400.0));
    c.shelf(0.0, 300.0, 6050.0, 80.0);
    boards(&mut c, 300.0, 560.0, 6050.0);
    c.pickups(v(410.0, 5300.0), v(410.0, 6000.0), 3);
    c.wp(Move::Walk, 700.0, 5130.0).wp(Move::Wind, 410.0, 6100.0);
    // Toy blocks across to the far side.
    block(&mut c, 620.0, 6190.0, "#ff6b6b");
    block(&mut c, 850.0, 6340.0, "#ffd93d");
    block(&mut c, 1080.0, 6490.0, "#6bcb77");
    c.shelf(1220.0, 1400.0, 6600.0, 80.0);
    c.wp(Move::Jump, 620.0, 6190.0).wp(Move::Jump, 850.0, 6340.0).wp(Move::Jump, 1080.0, 6490.0).wp(Move::Jump, 1300.0, 6600.0);
    c.cp(1310.0, 6600.0);
    c.story(v(1100.0, 6550.0), v(1400.0, 6700.0), "ch10_giggle");

    // --------------------------------- a slinky, a cap and a spring
    c.poly(&[v(816.0, 7330.0), v(884.0, 7330.0), v(864.0, 7296.0), v(836.0, 7296.0)]);
    c.rope(RopeEnd::World { at: v(850.0, 7300.0) }, RopeEnd::Free { at: v(850.0, 6700.0) }, 600.0, RopeStyle::Slinky);
    c.shelf(0.0, 450.0, 7050.0, 80.0);
    boards(&mut c, 450.0, 650.0, 7050.0);
    tramp(&mut c, 380.0, 7050.0, 7165.0, 1300.0);
    c.shelf(700.0, 1100.0, 7550.0, 80.0);
    c.pickups(v(850.0, 6800.0), v(850.0, 7200.0), 3);
    c.pickups(v(380.0, 7300.0), v(700.0, 7650.0), 3);
    c.wp(Move::Walk, 1260.0, 6600.0).wp(Move::Rope, 250.0, 7050.0).wp(Move::Walk, 200.0, 7050.0).wp(Move::Jump, 380.0, 7165.0).wp(Move::Spring, 800.0, 7550.0);
    c.cp(900.0, 7550.0);
    c.spring(v(1050.0, 7550.0), 90.0, 1500.0);
    c.shelf(450.0, 800.0, 8100.0, 80.0);
    boards(&mut c, 0.0, 450.0, 8100.0);
    boards(&mut c, 800.0, 1400.0, 8100.0);
    c.pickups(v(1050.0, 7750.0), v(700.0, 8200.0), 3);
    c.wp(Move::Walk, 1050.0, 7550.0).wp(Move::Spring, 650.0, 8100.0);

    // ------------------------- the last updraft, into the top cave
    // The well ends in a cave under a rock roof; warm light spills along
    // it from the left, where its mouth opens onto the outside.
    c.wind(v(0.0, 8000.0), v(400.0, 9950.0), v(0.0, 1400.0));
    c.wind(v(0.0, 9620.0), v(400.0, 9950.0), v(-700.0, 0.0));
    c.pickups(v(200.0, 8400.0), v(200.0, 9500.0), 5);
    c.story(v(0.0, 9100.0), v(1400.0, 9250.0), "ch10_daylight");
    c.wall(-2200.0, -1500.0, 2000.0, 9650.0);
    c.shelf(-2200.0, 0.0, 9650.0, 80.0);
    c.shelf(1400.0, 2400.0, 9650.0, 80.0);
    c.wall(2400.0, 2800.0, -1400.0, 11000.0);
    c.roof(&[v(-1400.0, 10250.0), v(-900.0, 10300.0), v(0.0, 10380.0), v(400.0, 10420.0), v(1400.0, 10300.0), v(2400.0, 10200.0)]);
    c.wp(Move::Walk, 520.0, 8100.0).wp(Move::Wind, 200.0, 9700.0).wp(Move::Drop, -200.0, 9650.0);
    c.drops(-1250.0, -500.0, 9650.0, 4);
    c.say(-1000.0, -950.0, 9650.0, "ch10_lulu");
    // The mouth: daylight. Lulu waits just inside it.
    c.exit_cave(-1400.0, -2200.0, 9650.0, 11000.0, Theme::Playroom);
    if let Some(m) = c.b.level.mouths.last_mut() {
        m.daylight = true;
    }
    c.wp(Move::Walk, -900.0, 9650.0).wp(Move::Walk, -1780.0, 9650.0);

    // ----------------------------------------------------------- decor
    c.hang("drip", -1300.0, 2300.0, 520.0);
    c.scatter("crystal", -1380.0, -1150.0, 0.0, 115.0, -1.0);
    c.scatter("crystal", -600.0, -300.0, 0.0, 150.0, -1.0);
    c.scatter("mushroom", -1400.0, -1200.0, 0.0, 200.0, -1.0);
    c.scatter("mushroom", -500.0, -200.0, 0.0, 300.0, -1.0);
    c.scatter("mushroom", -1250.0, -650.0, 9650.0, 300.0, -1.0);
    c.scatter("sock", 1500.0, 2200.0, 9650.0, 350.0, -1.0);
    c.finish()
}
