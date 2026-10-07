//! Live smoke test against the real Lobbii backend.
//!
//! ```sh
//! BB_MP_API_KEY=... cargo run -p bb-net --example lobbii_smoke          # REST: create, get, list, lookup, end
//! BB_MP_API_KEY=... cargo run -p bb-net --example lobbii_smoke -- rtc   # + host↔guest WebRTC over real signaling
//! ```

use std::time::{Duration, Instant};

use bb_net::lobbii::{CreateRoomOpts, Lobbii};
use bb_net::session::{GuestEvent, GuestSession, HostEvent, HostOptions, HostSession};
use bb_net::{Channel, LinkEvent, NetConfig, Payload, PeerKind, Transport};

fn main() {
    let cfg = NetConfig::from_env();
    println!("api {} (key {})", cfg.api_base, if cfg.api_key.is_empty() { "missing" } else { "set" });
    let rt = bb_net::rt::runtime();
    rt.block_on(rest(cfg.clone()));
    if std::env::args().any(|a| a == "rtc") {
        rtc(cfg);
    }
}

async fn rest(cfg: NetConfig) {
    let api = Lobbii::new(cfg.clone()).expect("client");
    let room = api
        .create_room(&CreateRoomOpts {
            game_id: cfg.game_id.clone(),
            display_name: Some("bb-net smoke".into()),
            host_kind: Some("screen".into()),
            max_peers: Some(2),
            visibility: Some("public".into()),
            ..Default::default()
        })
        .await
        .expect("create room");
    println!(
        "created {} code {} ice_servers {} push {}",
        room.room_id,
        room.join_code,
        room.ice_servers.as_ref().map_or(0, |v| v.len()),
        room.signal_gw.is_some()
    );
    let got = api.get_room(&room.room_id).await.expect("get room");
    println!("get: status {} peers {}", got.status, got.peers.len());
    let list = api.list_rooms().await.expect("list rooms");
    println!("list: {} rooms, ours listed: {}", list.len(), list.iter().any(|r| r.room_id == room.room_id));
    let found = api.lookup_by_code(&room.join_code).await.expect("lookup");
    assert_eq!(found.room_id, room.room_id);
    println!("lookup by code ok");
    api.end_room(&room.room_id, &room.host_secret).await.expect("end room");
    let after = api.get_room(&room.room_id).await;
    println!("ended: {:?}", after.map(|r| r.status));
}

fn rtc(cfg: NetConfig) {
    let host = HostSession::start(cfg.clone(), HostOptions { display_name: "bb-net rtc smoke".into(), ..Default::default() });
    let started = Instant::now();
    let mut guest: Option<GuestSession> = None;
    let mut host_link = None;
    let mut guest_link = None;
    let mut got_reliable = false;
    let mut got_unreliable = false;
    let mut got_reply = false;
    while started.elapsed() < Duration::from_secs(40) {
        while let Some(e) = host.try_recv() {
            match e {
                HostEvent::Ready(info) => {
                    println!("host: room {} code {} qr {}", info.room_id, info.join_code, info.controller_url);
                    guest = Some(GuestSession::join(cfg.clone(), info.join_code, "smoke guest".into(), PeerKind::Screen));
                }
                HostEvent::Peer { peer_id, kind, link, .. } => {
                    println!("host: connecting to {kind:?} {peer_id}");
                    host_link = Some(link);
                }
                HostEvent::PeerLeft(id) => println!("host: {id} left"),
                HostEvent::Error(e) => println!("host error: {e}"),
                HostEvent::Ended => println!("host: ended"),
            }
        }
        if let Some(g) = &guest {
            while let Some(e) = g.try_recv() {
                match e {
                    GuestEvent::Joined { peer_id, .. } => println!("guest: joined as {peer_id}"),
                    GuestEvent::Host(l) => guest_link = Some(l),
                    GuestEvent::Error(e) => println!("guest error: {e}"),
                    GuestEvent::Ended => println!("guest: ended"),
                }
            }
        }
        if let Some(l) = &host_link {
            while let Some(e) = l.try_recv() {
                match e {
                    LinkEvent::Open => {
                        println!("host: link open after {:?}", started.elapsed());
                        l.send(Channel::Reliable, Payload::Text("hello from host".into()));
                    }
                    LinkEvent::Message(ch, p) => {
                        println!("host: got {ch:?} {p:?}");
                        got_reply = true;
                    }
                    LinkEvent::Closed(r) => println!("host: link closed: {r}"),
                }
            }
            if l.is_open() {
                l.send(Channel::Unreliable, Payload::Binary(vec![0x10, 1, 2, 3]));
            }
        }
        if let Some(l) = &guest_link {
            while let Some(e) = l.try_recv() {
                match e {
                    LinkEvent::Open => println!("guest: link open"),
                    LinkEvent::Message(Channel::Reliable, p) => {
                        println!("guest: reliable {p:?}");
                        got_reliable = true;
                        l.send(Channel::Reliable, Payload::Text("hello from guest".into()));
                    }
                    LinkEvent::Message(Channel::Unreliable, _) => got_unreliable = true,
                    LinkEvent::Closed(r) => println!("guest: link closed: {r}"),
                }
            }
        }
        if got_reliable && got_unreliable && got_reply {
            println!("RTC OK: both channels work in {:?}", started.elapsed());
            break;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    if !(got_reliable && got_unreliable && got_reply) {
        println!("RTC FAILED: reliable {got_reliable} unreliable {got_unreliable} reply {got_reply}");
    }
    drop(guest);
    drop(host);
    // Let the leave/end requests land.
    std::thread::sleep(Duration::from_secs(2));
}
