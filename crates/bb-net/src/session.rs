//! Room lifecycles on the partii engine, run off the game thread.
//!
//! [`HostSession`] creates a room and hands the game a [`PeerLink`] per member
//! (phones and guest screens alike). [`GuestSession`] joins a room as a screen
//! and hands over the link to the host. The engine does signaling, paths
//! (relay → TURN → direct), reliability and reconnects; this layer only maps
//! its members and messages onto links. The game drains events with
//! `try_recv` each frame and never awaits anything.
//!
//! On the wire, phones speak UTF-8 JSON text (the controller page's
//! protocol). Screens are both this crate, so their frames carry a one-byte
//! tag: [`TAG_TEXT`] or [`TAG_BINARY`]. `Channel::Reliable` is the engine's
//! reliable, ordered stream; `Channel::Unreliable` its latest-wins datagrams.

use std::collections::HashMap;

use async_channel::{Receiver, Sender};
use partii_engine::{Config, Engine, Event};
use serde_json::json;

use crate::transport::{link_pair, Channel, LinkDriver, Outgoing, Payload, PeerKind, PeerLink};
use crate::{NetConfig, NetError};

/// Screen-to-screen frame tags.
pub const TAG_TEXT: u8 = 0;
pub const TAG_BINARY: u8 = 1;

/// Pump interval: how often outgoing link queues are flushed to the engine.
#[cfg(not(target_arch = "wasm32"))]
const PUMP_MS: u64 = 2;
#[cfg(target_arch = "wasm32")]
const PUMP_MS: u32 = 4;

/// Bytes on the wire for a payload to a peer of `kind`.
pub(crate) fn encode(kind: PeerKind, msg: Payload) -> Vec<u8> {
    match (kind, msg) {
        (PeerKind::Phone, Payload::Text(t)) => t.into_bytes(),
        (PeerKind::Phone, Payload::Binary(b)) => b,
        (_, Payload::Text(t)) => {
            let mut v = Vec::with_capacity(t.len() + 1);
            v.push(TAG_TEXT);
            v.extend_from_slice(t.as_bytes());
            v
        }
        (_, Payload::Binary(b)) => {
            let mut v = Vec::with_capacity(b.len() + 1);
            v.push(TAG_BINARY);
            v.extend_from_slice(&b);
            v
        }
    }
}

/// A payload from bytes a peer of `kind` sent. `None` for an empty or
/// unknown-tag screen frame (dropped like a corrupt packet).
pub(crate) fn decode(kind: PeerKind, bytes: Vec<u8>) -> Option<Payload> {
    match kind {
        PeerKind::Phone => Some(Payload::Text(String::from_utf8_lossy(&bytes).into_owned())),
        _ => match bytes.split_first() {
            Some((&TAG_TEXT, rest)) => Some(Payload::Text(String::from_utf8_lossy(rest).into_owned())),
            Some((&TAG_BINARY, rest)) => Some(Payload::Binary(rest.to_vec())),
            _ => None,
        },
    }
}

fn engine_config(cfg: &NetConfig, client: &str) -> Config {
    Config {
        edge: cfg.edge.clone(),
        key: cfg.key.clone(),
        conn: Engine::new_conn_id(),
        client: format!("bouncy-blobs/{} {client}", env!("CARGO_PKG_VERSION")),
        player_token: cfg.player_token.clone(),
        no_webrtc: false,
    }
}

/// Run `step` every pump interval until it returns `false`: on its own
/// thread natively (the engine owns its runtime), on the browser loop on wasm.
fn spawn_pump(mut step: impl FnMut() -> bool + crate::rt::MaybeSend + 'static) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = std::thread::Builder::new().name("bb-net".into()).spawn(move || {
            while step() {
                std::thread::sleep(std::time::Duration::from_millis(PUMP_MS));
            }
        });
    }
    #[cfg(target_arch = "wasm32")]
    {
        crate::rt::spawn(async move {
            while step() {
                crate::rt::sleep_ms(PUMP_MS).await;
            }
        });
    }
}

/// One member's link, engine side.
struct Wire {
    kind: PeerKind,
    driver: LinkDriver,
}

impl Wire {
    /// Flush what the game queued. `false` once the game closed the link.
    fn flush(&self, engine: &Engine, mid: u16) -> bool {
        while let Ok(out) = self.driver.outgoing.try_recv() {
            match out {
                Outgoing::Send(ch, msg) => engine.send(mid, ch == Channel::Reliable, encode(self.kind, msg)),
                Outgoing::Close => return false,
            }
        }
        true
    }

    fn deliver(&self, reliable: bool, bytes: Vec<u8>) {
        if let Some(p) = decode(self.kind, bytes) {
            self.driver.deliver(if reliable { Channel::Reliable } else { Channel::Unreliable }, p);
        }
    }
}

fn failed(code: &str, message: &str) -> NetError {
    match code {
        "offline" | "timeout" => NetError::Io(message.into()),
        _ => NetError::Http { status: 0, message: format!("{code}: {message}") },
    }
}

// ─── Host ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct HostOptions {
    pub display_name: String,
    /// Peers allowed besides the host (phones + screens). 1..=8 in the UI.
    pub max_peers: u32,
    pub public: bool,
    pub password: Option<String>,
}

impl Default for HostOptions {
    fn default() -> Self {
        HostOptions { display_name: "Bouncy Lobby".into(), max_peers: 8, public: false, password: None }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RoomInfo {
    pub room_id: String,
    pub join_code: String,
    /// What the QR code encodes.
    pub controller_url: String,
}

pub enum HostEvent {
    Ready(RoomInfo),
    /// A member joined the room. Watch the link for `Open` / messages /
    /// `Closed`. `peer_id` is the member id.
    Peer { peer_id: String, kind: PeerKind, name: Option<String>, link: PeerLink },
    /// The member left the room (or was kicked).
    PeerLeft(String),
    Error(NetError),
    Ended,
}

enum HostCmd {
    SetJoinable(bool),
    Kick(String),
    End,
}

/// Game-side handle. Dropping it ends the room.
pub struct HostSession {
    events: Receiver<HostEvent>,
    cmds: Sender<HostCmd>,
}

impl HostSession {
    pub fn start(cfg: NetConfig, opts: HostOptions) -> HostSession {
        let (ev_tx, ev_rx) = async_channel::unbounded();
        let (cmd_tx, cmd_rx) = async_channel::unbounded();
        if cfg.key.is_empty() {
            let _ = ev_tx.try_send(HostEvent::Error(NetError::Config("no partii key (set BB_PARTII_KEY)".into())));
            let _ = ev_tx.try_send(HostEvent::Ended);
            return HostSession { events: ev_rx, cmds: cmd_tx };
        }
        let mut host = Host::new(&cfg, &opts, ev_tx, cmd_rx);
        spawn_pump(move || host.step());
        HostSession { events: ev_rx, cmds: cmd_tx }
    }

    pub fn try_recv(&self) -> Option<HostEvent> {
        self.events.try_recv().ok()
    }

    /// Lock or reopen the room (closed while a round is playing).
    pub fn set_joinable(&self, joinable: bool) {
        let _ = self.cmds.try_send(HostCmd::SetJoinable(joinable));
    }

    /// Drop a peer and free its seat.
    pub fn kick(&self, peer_id: &str) {
        let _ = self.cmds.try_send(HostCmd::Kick(peer_id.into()));
    }

    pub fn end(&self) {
        let _ = self.cmds.try_send(HostCmd::End);
    }
}

impl Drop for HostSession {
    fn drop(&mut self) {
        self.end();
    }
}

struct Host {
    engine: Engine,
    cfg: NetConfig,
    /// Sent once the engine is online (it refuses rooms before that).
    pending: Option<HostOptions>,
    ev: Sender<HostEvent>,
    cmds: Receiver<HostCmd>,
    wires: HashMap<u16, Wire>,
    created: bool,
}

impl Host {
    fn new(cfg: &NetConfig, opts: &HostOptions, ev: Sender<HostEvent>, cmds: Receiver<HostCmd>) -> Host {
        let engine = Engine::start(engine_config(cfg, "host"));
        Host { engine, cfg: cfg.clone(), pending: Some(opts.clone()), ev, cmds, wires: HashMap::new(), created: false }
    }

    fn end(&mut self) -> bool {
        for (_, w) in self.wires.drain() {
            w.driver.closed("room ended");
        }
        self.engine.leave();
        let _ = self.ev.try_send(HostEvent::Ended);
        false
    }

    fn step(&mut self) -> bool {
        while let Ok(cmd) = self.cmds.try_recv() {
            match cmd {
                HostCmd::SetJoinable(j) => self.engine.update(json!({ "joinable": j })),
                HostCmd::Kick(id) => {
                    if let Ok(mid) = id.parse::<u16>() {
                        self.engine.kick(mid);
                    }
                }
                HostCmd::End => return self.end(),
            }
        }
        if self.ev.is_closed() {
            return self.end();
        }
        for e in self.engine.poll() {
            match e {
                Event::Online { .. } => {
                    if let Some(o) = self.pending.take() {
                        self.engine.create(&self.cfg.game_id, Some(o.max_peers + 1), "screen", &o.display_name, json!({}));
                    }
                }
                Event::Created { room, .. } => {
                    self.created = true;
                    let info = RoomInfo { room_id: room.code.clone(), join_code: room.code.clone(), controller_url: self.cfg.controller_link(&room.code) };
                    let _ = self.ev.try_send(HostEvent::Ready(info));
                }
                Event::Failed { code, message, .. } if !self.created => {
                    let _ = self.ev.try_send(HostEvent::Error(failed(&code, &message)));
                    return self.end();
                }
                Event::MemberJoined { member } => {
                    let kind = PeerKind::parse(&member.kind);
                    let (link, driver) = link_pair(member.mid.to_string(), kind);
                    self.wires.insert(member.mid, Wire { kind, driver });
                    let _ = self.ev.try_send(HostEvent::Peer { peer_id: member.mid.to_string(), kind, name: Some(member.name), link });
                }
                Event::PeerConnected { mid, .. } => {
                    if let Some(w) = self.wires.get(&mid) {
                        w.driver.opened();
                    }
                }
                Event::Message { from, reliable, bytes } => {
                    if let Some(w) = self.wires.get(&from) {
                        w.deliver(reliable, bytes);
                    }
                }
                Event::MemberLeft { mid, reason } => {
                    if let Some(w) = self.wires.remove(&mid) {
                        w.driver.closed(reason);
                        let _ = self.ev.try_send(HostEvent::PeerLeft(mid.to_string()));
                    }
                }
                Event::RoomClosed { reason } => {
                    let _ = self.ev.try_send(HostEvent::Error(NetError::Io(format!("room closed: {reason}"))));
                    return self.end();
                }
                _ => {}
            }
        }
        let engine = &self.engine;
        let kicked: Vec<u16> = self.wires.iter().filter(|(mid, w)| !w.flush(engine, **mid)).map(|(mid, _)| *mid).collect();
        for mid in kicked {
            self.engine.kick(mid);
        }
        true
    }
}

// ─── Guest ──────────────────────────────────────────────────────────────────

pub enum GuestEvent {
    Joined { room_id: String, peer_id: String },
    /// The link to the host.
    Host(PeerLink),
    Error(NetError),
    Ended,
}

pub struct GuestSession {
    events: Receiver<GuestEvent>,
    stop: Sender<()>,
}

impl GuestSession {
    /// Join room `code` as `kind` (`Screen` for a second Bevy screen).
    pub fn join(cfg: NetConfig, code: String, display_name: String, kind: PeerKind) -> GuestSession {
        let (ev_tx, ev_rx) = async_channel::unbounded();
        let (stop_tx, stop_rx) = async_channel::bounded(1);
        if cfg.key.is_empty() {
            let _ = ev_tx.try_send(GuestEvent::Error(NetError::Config("no partii key (set BB_PARTII_KEY)".into())));
            let _ = ev_tx.try_send(GuestEvent::Ended);
            return GuestSession { events: ev_rx, stop: stop_tx };
        }
        let engine = Engine::start(engine_config(&cfg, "guest"));
        let mut guest = Guest { engine, kind, pending: Some((code.trim().to_ascii_uppercase(), display_name)), ev: ev_tx, stop: stop_rx, host: None };
        spawn_pump(move || guest.step());
        GuestSession { events: ev_rx, stop: stop_tx }
    }

    pub fn try_recv(&self) -> Option<GuestEvent> {
        self.events.try_recv().ok()
    }

    pub fn leave(&self) {
        let _ = self.stop.try_send(());
    }
}

impl Drop for GuestSession {
    fn drop(&mut self) {
        self.leave();
    }
}

struct Guest {
    engine: Engine,
    kind: PeerKind,
    /// (code, name), joined once the engine is online.
    pending: Option<(String, String)>,
    ev: Sender<GuestEvent>,
    stop: Receiver<()>,
    host: Option<(u16, Wire)>,
}

impl Guest {
    fn end(&mut self, why: &str) -> bool {
        if let Some((_, w)) = self.host.take() {
            w.driver.closed(why);
        }
        self.engine.leave();
        let _ = self.ev.try_send(GuestEvent::Ended);
        false
    }

    fn step(&mut self) -> bool {
        if self.stop.try_recv().is_ok() || self.ev.is_closed() {
            return self.end("left");
        }
        for e in self.engine.poll() {
            match e {
                Event::Online { .. } => {
                    if let Some((code, name)) = self.pending.take() {
                        self.engine.join(&code, self.kind.as_str(), &name, json!({}));
                    }
                }
                Event::Joined { room, .. } => {
                    let _ = self.ev.try_send(GuestEvent::Joined { room_id: room.code.clone(), peer_id: room.you.to_string() });
                    let (link, driver) = link_pair(room.host.to_string(), self.kind);
                    self.host = Some((room.host, Wire { kind: self.kind, driver }));
                    let _ = self.ev.try_send(GuestEvent::Host(link));
                }
                Event::Failed { code, message, .. } if self.host.is_none() => {
                    let _ = self.ev.try_send(GuestEvent::Error(failed(&code, &message)));
                    return self.end("join failed");
                }
                Event::PeerConnected { mid, .. } => {
                    if let Some((h, w)) = &self.host {
                        if *h == mid {
                            w.driver.opened();
                        }
                    }
                }
                Event::Message { from, reliable, bytes } => {
                    if let Some((h, w)) = &self.host {
                        if *h == from {
                            w.deliver(reliable, bytes);
                        }
                    }
                }
                Event::MemberLeft { mid, .. } if self.host.as_ref().is_some_and(|(h, _)| *h == mid) => return self.end("host left"),
                Event::RoomClosed { reason } => return self.end(&reason),
                _ => {}
            }
        }
        if let Some((mid, w)) = &self.host {
            if !w.flush(&self.engine, *mid) {
                return self.end("closed");
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_get_bare_text_and_screens_tagged_frames() {
        assert_eq!(encode(PeerKind::Phone, Payload::Text("{\"t\":1}".into())), b"{\"t\":1}".to_vec());
        for kind in [PeerKind::Phone, PeerKind::Screen] {
            for p in [Payload::Text("héllo".into()), Payload::Binary(vec![0, 1, 2, 255])] {
                if kind == PeerKind::Phone && matches!(p, Payload::Binary(_)) {
                    continue;
                }
                assert_eq!(decode(kind, encode(kind, p.clone())), Some(p), "{kind:?}");
            }
        }
        assert_eq!(decode(PeerKind::Screen, vec![]), None);
        assert_eq!(decode(PeerKind::Screen, vec![9, 1]), None);
    }
}
