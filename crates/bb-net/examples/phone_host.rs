//! Host a room and wait for a real phone controller page to join
//! (`web-controller`'s `/c/<CODE>` in a browser). Prints `ROOM <code>`
//! once the room exists, then logs the controller protocol and exits 0 when
//! it has seen a join, a stick push and a button press (as `0x50` frames).
//!
//! ```sh
//! BB_PARTII_API=http://127.0.0.1:8787 BB_PARTII_KEY=pk_... cargo run -p bb-net --example phone_host
//! ```

use std::io::Write;
use std::time::{Duration, Instant};

use bb_net::phone::{self, PhoneInput, PhoneMsg};
use bb_net::session::{HostEvent, HostOptions, HostSession};
use bb_net::{LinkEvent, NetConfig, Payload, PeerLink, Transport};

fn main() {
    let host = HostSession::start(NetConfig::from_env(), HostOptions { display_name: "bb-net phone test".into(), ..Default::default() });
    let started = Instant::now();
    let mut links: Vec<PeerLink> = Vec::new();
    let mut input = PhoneInput::default();
    let (mut joined, mut moved, mut pressed) = (false, false, false);
    while started.elapsed() < Duration::from_secs(120) {
        while let Some(e) = host.try_recv() {
            match e {
                HostEvent::Ready(info) => {
                    println!("ROOM {} {}", info.room_id, info.join_code);
                    println!("room ready at {:?}", started.elapsed());
                    let _ = std::io::stdout().flush();
                }
                HostEvent::Peer { peer_id, kind, name, link } => {
                    println!("peer {peer_id} kind {kind:?} name {name:?} at {:?}", started.elapsed());
                    links.push(link);
                }
                HostEvent::PeerLeft(id) => println!("left {id}"),
                HostEvent::Error(e) => {
                    println!("error {e}");
                    std::process::exit(2);
                }
                HostEvent::Failed(code) => println!("failed {code}"),
                HostEvent::Busy { retry_in_ms } => println!("busy, retrying in {retry_in_ms} ms"),
                HostEvent::Reclaiming => println!("room lost, reclaiming its code"),
                HostEvent::Ended => {}
            }
        }
        for l in &links {
            while let Some(e) = l.try_recv() {
                match e {
                    LinkEvent::Open => {
                        println!("link open after {:?}", started.elapsed());
                        l.send(bb_net::Channel::Reliable, Payload::Text(phone::taken_message(&["#e06070".into()], &["cat".into()])));
                        l.send(bb_net::Channel::Reliable, Payload::Text(bb_net::play::seat_msg("P2", 0x6ecf6e)));
                        l.send(bb_net::Channel::Reliable, Payload::Text(bb_net::play::layout_msg(&["EXPAND"])));
                    }
                    LinkEvent::Message(ch, Payload::Text(t)) => match phone::parse(&t) {
                        Ok(PhoneMsg::Join(j)) => {
                            println!("player_join name={:?} color={:?} face={:?} (on {ch:?})", j.name, j.color, j.face_id);
                            joined = true;
                        }
                        Ok(PhoneMsg::Customize(c)) => println!("customization_update {c:?}"),
                        Ok(PhoneMsg::Input(entries, ts)) => {
                            println!("legacy JSON input (old page?)");
                            if input.apply(&entries, ts, bb_net::rt::now_ms()) {
                                println!("input stick={} button={} (on {ch:?})", input.stick, input.button);
                            }
                            moved |= input.stick.x > 0.5;
                            pressed |= input.button;
                        }
                        Ok(PhoneMsg::Other) => println!("other: {t}"),
                        Err(e) => println!("bad message {e}: {t}"),
                    },
                    LinkEvent::Message(ch, Payload::Binary(b)) => {
                        if input.apply_frame(&b, bb_net::rt::now_ms()) {
                            moved |= input.stick.x > 0.5;
                            pressed |= input.button;
                        } else if bb_net::play::Frame::decode(&b).is_none() {
                            println!("binary on {ch:?}: {} bytes", b.len());
                        }
                    }
                    LinkEvent::Closed(r) => println!("link closed: {r}"),
                }
            }
        }
        if joined && moved && pressed {
            println!("PHONE OK in {:?}", started.elapsed());
            drop(host);
            std::thread::sleep(Duration::from_secs(2));
            return;
        }
        std::thread::sleep(Duration::from_millis(16));
    }
    println!("PHONE FAILED joined={joined} moved={moved} pressed={pressed}");
    std::process::exit(1);
}
