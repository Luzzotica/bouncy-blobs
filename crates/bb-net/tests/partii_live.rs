//! Host and guest sessions over a real partii platform: a guest screen joins
//! by code, both links open, text and binary cross both ways on both
//! channels, and the guest sees the room end when the host does.
//!
//! Runs when `BB_PARTII_API` and `BB_PARTII_KEY` are set (e.g. a local
//! `partii dev up`); otherwise it reports a skip and passes.

use std::time::{Duration, Instant};

use bb_net::session::{GuestEvent, GuestSession, HostEvent, HostOptions, HostSession};
use bb_net::{Channel, LinkEvent, NetConfig, Payload, PeerKind, PeerLink, Transport};

fn wait<T>(what: &str, secs: u64, mut f: impl FnMut() -> Option<T>) -> T {
    let until = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < until {
        if let Some(v) = f() {
            return v;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for {what}");
}

/// The next message on `link`, skipping `Open`.
fn next_msg(link: &PeerLink, what: &str) -> (Channel, Payload) {
    wait(what, 10, || match link.try_recv() {
        Some(LinkEvent::Message(ch, p)) => Some((ch, p)),
        Some(LinkEvent::Closed(r)) => panic!("{what}: link closed ({r})"),
        _ => None,
    })
}

#[test]
fn host_and_guest_screens_exchange_over_partii() {
    let cfg = NetConfig::from_env();
    if std::env::var("BB_PARTII_API").is_err() || cfg.key.is_empty() {
        eprintln!("skip: set BB_PARTII_API and BB_PARTII_KEY to run against a partii platform");
        return;
    }
    let t0 = Instant::now();
    let host = HostSession::start(cfg.clone(), HostOptions { display_name: "test host".into(), max_peers: 3, ..Default::default() });
    let room = wait("room", 10, || match host.try_recv() {
        Some(HostEvent::Ready(r)) => Some(r),
        Some(HostEvent::Error(e)) => panic!("host: {e}"),
        _ => None,
    });
    assert_eq!(room.join_code.len(), 5, "partii codes are 5 letters: {room:?}");
    assert!(room.controller_url.contains(&room.join_code));
    let created_ms = t0.elapsed().as_millis();

    let guest = GuestSession::join(cfg, room.join_code.clone(), "test guest".into(), PeerKind::Screen);
    let (mut to_host, mut guest_id) = (None, String::new());
    while to_host.is_none() {
        match wait("guest join", 10, || guest.try_recv()) {
            GuestEvent::Joined { room_id, peer_id } => {
                assert_eq!(room_id, room.join_code);
                guest_id = peer_id;
            }
            GuestEvent::Host(link) => to_host = Some(link),
            GuestEvent::Error(e) => panic!("guest: {e}"),
            GuestEvent::Ended => panic!("guest ended early"),
        }
    }
    let to_host = to_host.unwrap();
    let to_guest = wait("host sees the guest", 10, || match host.try_recv() {
        Some(HostEvent::Peer { peer_id, kind, name, link }) => {
            assert_eq!(peer_id, guest_id);
            assert_eq!(kind, PeerKind::Screen);
            assert_eq!(name.as_deref(), Some("test guest"));
            Some(link)
        }
        _ => None,
    });
    wait("both links open", 10, || (to_host.is_open() && to_guest.is_open()).then_some(()));
    let open_ms = t0.elapsed().as_millis();

    assert!(to_host.send(Channel::Reliable, Payload::Text("{\"hello\":1}".into())));
    assert_eq!(next_msg(&to_guest, "guest→host text"), (Channel::Reliable, Payload::Text("{\"hello\":1}".into())));
    assert!(to_guest.send(Channel::Reliable, Payload::Binary(vec![0, 1, 2, 255])));
    assert_eq!(next_msg(&to_host, "host→guest binary"), (Channel::Reliable, Payload::Binary(vec![0, 1, 2, 255])));
    // Unreliable may drop under loss; on a local platform one of a burst arrives.
    for i in 0..20u8 {
        to_host.send(Channel::Unreliable, Payload::Binary(vec![7, i]));
    }
    let (ch, p) = next_msg(&to_guest, "unreliable burst");
    assert_eq!(ch, Channel::Unreliable);
    assert!(matches!(p, Payload::Binary(ref b) if b[0] == 7), "{p:?}");

    // Ordered reliable stream.
    for i in 0..50u32 {
        to_guest.send(Channel::Reliable, Payload::Binary(i.to_le_bytes().to_vec()));
    }
    for i in 0..50u32 {
        loop {
            let (ch, p) = next_msg(&to_host, "ordered stream");
            if ch == Channel::Reliable {
                assert_eq!(p, Payload::Binary(i.to_le_bytes().to_vec()), "message {i} out of order");
                break;
            }
        }
    }

    host.end();
    wait("guest sees the room end", 10, || match guest.try_recv() {
        Some(GuestEvent::Ended) => Some(()),
        _ => None,
    });
    eprintln!("ok: created {created_ms} ms, links open {open_ms} ms");
}
