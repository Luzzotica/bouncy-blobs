//! Headless net tests over in-memory loopback links: a phone joining and
//! driving a blob, and a guest screen mirroring the host (and vice versa).

use std::time::Duration;

use bb_level::{LevelBuilder, Theme, v};
use bb_net::transport::loopback;
use bb_net::wire::JoinRequest;
use bb_net::{Channel, LinkEvent, Payload, PeerKind, PeerLink, Transport};
use bevy::prelude::*;
use bevy::time::TimeUpdateStrategy;

use super::{NetPlugin, NetRole, NetSession, Peer};
use crate::input::{InputPlugin, RemoteSlots};
use crate::sim::{Game, Inputs, LoadLevel, SimPlugin};

fn level() -> bb_level::Level {
    let mut b = LevelBuilder::new("flat", "Flat", Theme::Hollow);
    b.spawn(v(0.0, 60.0)).ground(&[v(-3000.0, 0.0), v(6000.0, 0.0)], 300.0).crate_box(v(300.0, 120.0), 60.0);
    b.build()
}

fn app() -> App {
    let mut app = App::new();
    app.add_plugins((MinimalPlugins, bevy::input::InputPlugin, SimPlugin, InputPlugin, NetPlugin));
    // One fixed step per update, independent of wall-clock speed.
    app.insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)));
    app
}

fn host_app(local_players: Vec<(u8, String, u32)>) -> App {
    let mut app = app();
    app.world_mut().write_message(LoadLevel { level: level(), players: local_players });
    app.update();
    app.insert_resource(NetSession::new(NetRole::Host, "host"));
    app
}

fn attach(app: &mut App, id: &str, link: PeerLink, kind: PeerKind) {
    app.world_mut().resource_mut::<NetSession>().peers.insert(id.into(), Peer::new(link, kind, None));
}

fn texts(link: &PeerLink) -> Vec<String> {
    std::iter::from_fn(|| link.try_recv())
        .filter_map(|e| match e {
            LinkEvent::Message(_, Payload::Text(t)) => Some(t),
            _ => None,
        })
        .collect()
}

fn centre(app: &App, slot: u8) -> Option<Vec2> {
    let g = app.world().get_resource::<Game>()?;
    let p = g.sim.player(slot)?;
    let c = g.sim.world.body(p.ctl.body)?.centroid();
    Some(Vec2::new(c.x, c.y))
}

#[test]
fn phone_joins_customizes_drives_and_leaves() {
    let mut host = host_app(vec![(0, "Pip".into(), 0xff5d73)]);
    let (host_end, phone) = loopback(PeerKind::Phone, "host", "phone-1", 0.0);
    attach(&mut host, "phone-1", host_end, PeerKind::Phone);
    host.update();
    // The host greets the phone with what's taken: the host's own blob.
    let greet = texts(&phone);
    assert!(greet.iter().any(|t| t.contains("customization_update") && t.contains("#ff5d73")), "{greet:?}");

    let join = r##"{"type":"player_join","player":{"player_id":"phone-1","name":"Ann","session_id":"x","slot":0,"status":"connected","controller_config":null,"joined_at":"t","color":"","faceId":"default"}}"##;
    phone.send(Channel::Reliable, Payload::Text(join.into()));
    host.update();
    host.update();
    {
        let s = host.world().resource::<NetSession>();
        let e = s.roster.get(&1).expect("phone got slot 1");
        assert_eq!(e.name, "Ann");
        assert_eq!(e.phone.as_deref(), Some("phone-1"));
        let g = host.world().resource::<Game>();
        let p = g.sim.player(1).expect("phone blob spawned");
        assert!(p.local, "phone blobs are host-owned");
    }
    let _ = texts(&phone);

    // Pick a colour and face; the host applies it and confirms the picks of
    // others (the phone never sees its own pick as taken).
    phone.send(
        Channel::Reliable,
        Payload::Text(r##"{"type":"customization_update","value":{"color":"#6ecf6e","faceId":"cat"}}"##.into()),
    );
    host.update();
    {
        let g = host.world().resource::<Game>();
        let p = g.sim.player(1).unwrap();
        assert_eq!(p.color, 0x6ecf6e);
        assert_eq!(p.face, 7);
    }
    let after = texts(&phone);
    assert!(after.iter().all(|t| !t.contains("#6ecf6e")), "own colour reported as taken: {after:?}");

    // Stick right + up (screen y = -1), button held.
    let x0 = centre(&host, 1).unwrap().x;
    for i in 0..60 {
        let batch = format!(
            r#"{{"type":"player_input_batch","timestamp":{},"inputs":{{"joystick_left":{{"x":1,"y":-1}},"button_right":{{"pressed":{}}}}}}}"#,
            1000 + i * 33,
            i < 5
        );
        phone.send(Channel::Unreliable, Payload::Text(batch));
        host.update();
    }
    assert!(host.world().resource::<RemoteSlots>().0[1]);
    let input = host.world().resource::<Inputs>().slots[1];
    assert_eq!((input.stick.x, input.stick.y), (1.0, 1.0));
    let x1 = centre(&host, 1).unwrap().x;
    assert!(x1 - x0 > 100.0, "phone blob should roll right: {x0} → {x1}");

    // Phone leaves: blob and slot are freed.
    phone.close();
    host.update();
    host.update();
    assert!(host.world().resource::<NetSession>().roster.is_empty());
    assert!(host.world().resource::<Game>().sim.player(1).is_none());
    assert!(!host.world().resource::<RemoteSlots>().0[1]);
    assert!(host.world().resource::<Game>().sim.player(0).is_some(), "host's own player stays");
}

#[test]
fn guest_screen_mirrors_the_host_and_owns_its_blob() {
    let mut host = host_app(vec![(0, "Pip".into(), 0xff5d73)]);
    let mut guest = app();
    let mut gs = NetSession::new(NetRole::Guest, "guest-1");
    gs.join = Some(JoinRequest { name: "Gus".into(), color: 0x4d96ff, face: 2 });
    guest.insert_resource(gs);

    let (host_end, guest_end) = loopback(PeerKind::Screen, "host", "guest-1", 0.0);
    attach(&mut host, "guest-1", host_end, PeerKind::Screen);
    attach(&mut guest, "host", guest_end, PeerKind::Screen);

    // Handshake: Hello → slot + Welcome + level + roster.
    for _ in 0..6 {
        guest.update();
        host.update();
    }
    {
        let s = host.world().resource::<NetSession>();
        let e = s.roster.get(&1).expect("guest player got slot 1");
        assert_eq!(e.owner, "guest-1");
        let g = host.world().resource::<Game>();
        assert!(!g.sim.player(1).unwrap().local, "host mirrors the guest's blob");
    }
    {
        let g = guest.world().get_resource::<Game>().expect("guest loaded the host's level");
        assert_eq!(g.sim.level.id, "flat");
        assert!(!g.sim.player(0).unwrap().local, "guest mirrors the host's blob");
        assert!(g.sim.player(1).unwrap().local, "guest owns its own blob");
        assert_eq!(g.sim.player(1).unwrap().color, 0x4d96ff);
        let devices = guest.world().resource::<crate::input::LocalDevices>();
        assert_eq!(devices.keyboard_slot, Some(1), "guest keyboard drives its assigned slot");
    }

    // The guest spawned left of the host: host runs right, guest runs
    // left, for two seconds.
    let mut worst = 0.0f32;
    for tick in 0..120 {
        host.world_mut().resource_mut::<ButtonInput<KeyCode>>().press(KeyCode::KeyD);
        guest.world_mut().resource_mut::<ButtonInput<KeyCode>>().press(KeyCode::KeyA);
        host.update();
        guest.update();
        if tick > 45 {
            for slot in [0, 1] {
                let d = centre(&host, slot).unwrap().distance(centre(&guest, slot).unwrap());
                worst = worst.max(d);
            }
        }
    }
    let (h0, h1) = (centre(&host, 0).unwrap(), centre(&host, 1).unwrap());
    let (g0, g1) = (centre(&guest, 0).unwrap(), centre(&guest, 1).unwrap());
    println!("host sees {h0} {h1}; guest sees {g0} {g1}; worst divergence {worst:.1} px");
    assert!(h0.x > 300.0 && g1.x < -300.0, "both owners moved");
    // Jelly ground gives a little under each blob; mirrors follow the jiggle.
    assert!(worst < 32.0, "screens diverged by {worst} px");

    // Props are host-owned and mirrored too.
    let prop = |app: &App| {
        let g = app.world().resource::<Game>();
        g.sim.world.body(g.sim.props[0]).unwrap().centroid()
    };
    // Eventual consistency: while being shoved the guest's copy may lead or
    // lag, but once things settle it must agree with the owner.
    for _ in 0..90 {
        host.update();
        guest.update();
    }
    let d = prop(&host).distance(prop(&guest));
    assert!(d < 10.0, "prop disagrees by {d} px after settling");
}
