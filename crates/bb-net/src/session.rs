//! Room lifecycles, run off the game thread.
//!
//! [`HostSession`] creates a Lobbii room, polls the roster for new peers and
//! opens an offerer link to each (phones and guest screens alike), routing
//! signals both ways. [`GuestSession`] joins a room as a screen and answers
//! the host's offer. The game drains events with `try_recv` each frame and
//! never awaits anything.

use std::collections::{HashMap, HashSet, VecDeque};

use async_channel::{Receiver, Sender};
use serde_json::Value;

use crate::lobbii::{Auth, CreateRoomOpts, JoinRoomOpts, Lobbii, Signal, SignalType, default_ice_servers};
use crate::transport::{LinkWatch, PeerKind, PeerLink};
use crate::{NetConfig, NetError, rt};

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum Role {
    /// Creates the channels and sends the offer. The host is always this.
    Offerer,
    Answerer,
}

/// A signal a link wants delivered to `to` via Lobbii.
#[derive(Debug)]
pub(crate) struct OutSignal {
    pub to: String,
    pub kind: SignalType,
    pub payload: Value,
}

/// Pre-connect attempts per peer before the host gives up on it (TS
/// `MAX_CONNECT_ATTEMPTS`).
const MAX_CONNECT_ATTEMPTS: u32 = 3;
const RETRY_BACKOFF_MS: f64 = 1000.0;
const TICK_MS: u32 = 100;

/// Exactly-once signal delivery across the poll and push paths.
#[derive(Default)]
struct Seen {
    set: HashSet<i64>,
    order: VecDeque<i64>,
}

impl Seen {
    fn first_time(&mut self, id: i64) -> bool {
        if !self.set.insert(id) {
            return false;
        }
        self.order.push_back(id);
        while self.order.len() > 2048 {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// Sends queued signals in order (an answer must not overtake its offer).
fn spawn_poster(api: Lobbii, room_id: String, auth: Auth, rx: Receiver<OutSignal>) {
    rt::spawn(async move {
        while let Ok(s) = rx.recv().await {
            if let Err(e) = api.post_signal(&room_id, &auth, &s.to, s.kind, &s.payload).await {
                log::warn!("lobbii: signal to {} failed: {e}", s.to);
            }
        }
    });
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
    /// A peer joined the room and we're connecting to it. Watch the link for
    /// `Open` / messages / `Closed`. A retry after a failed attempt arrives as
    /// a fresh `Peer` with a new link.
    Peer { peer_id: String, kind: PeerKind, name: Option<String>, link: PeerLink },
    /// The peer's row left the room (or we gave up on it).
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
        rt::spawn(async move {
            if let Err(e) = host_loop(cfg, opts, &ev_tx, cmd_rx).await {
                let _ = ev_tx.try_send(HostEvent::Error(e));
            }
            let _ = ev_tx.try_send(HostEvent::Ended);
        });
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

struct HostPeer {
    signals: Sender<Signal>,
    watch: LinkWatch,
    attempts: u32,
    retry_at: f64,
}

async fn host_loop(cfg: NetConfig, opts: HostOptions, ev: &Sender<HostEvent>, cmds: Receiver<HostCmd>) -> crate::Result<()> {
    let api = Lobbii::new(cfg.clone())?;
    api.ensure_token().await;
    let created = api
        .create_room(&CreateRoomOpts {
            game_id: cfg.game_id.clone(),
            display_name: Some(opts.display_name.clone()),
            host_kind: Some("screen".into()),
            host_display_name: Some(opts.display_name.clone()),
            max_peers: Some(opts.max_peers),
            password: opts.password.clone().filter(|p| !p.is_empty()),
            visibility: Some(if opts.public { "public" } else { "private" }.into()),
            metadata: None,
        })
        .await?;
    let room_id = created.room_id.clone();
    let secret = created.host_secret.clone();
    let ice = created.ice_servers.clone().filter(|v| !v.is_empty()).unwrap_or_else(default_ice_servers);
    let _ = ev.try_send(HostEvent::Ready(RoomInfo {
        room_id: room_id.clone(),
        join_code: created.join_code.clone(),
        controller_url: cfg.controller_link(&room_id),
    }));

    let (out_tx, out_rx) = async_channel::unbounded();
    spawn_poster(api.clone(), room_id.clone(), Auth::Host { secret: secret.clone() }, out_rx);
    let push = match (&created.signal_gw, &created.room_token) {
        (Some(gw), Some(tok)) if !gw.is_empty() && !tok.is_empty() => Some(api.push_signals(&room_id, gw, tok)),
        _ => None,
    };

    let mut peers: HashMap<String, HostPeer> = HashMap::new();
    let mut seen = Seen::default();
    let mut since_id = 0i64;
    let mut next_signal_poll = 0.0;
    let mut next_room_poll = 0.0;

    let deliver = |sig: Signal, seen: &mut Seen, peers: &HashMap<String, HostPeer>| {
        if seen.first_time(sig.signal_id) {
            if let Some(p) = peers.get(&sig.sender_peer_id) {
                let _ = p.signals.try_send(sig);
            }
        }
    };

    loop {
        if ev.is_closed() {
            break;
        }
        let mut end = false;
        while let Ok(cmd) = cmds.try_recv() {
            match cmd {
                HostCmd::End => end = true,
                HostCmd::SetJoinable(j) => {
                    let (api, room, s) = (api.clone(), room_id.clone(), secret.clone());
                    rt::spawn(async move {
                        if let Err(e) = api.set_joinable(&room, &s, j).await {
                            log::warn!("lobbii: set_joinable failed: {e}");
                        }
                    });
                }
                HostCmd::Kick(peer) => {
                    peers.remove(&peer);
                    let _ = ev.try_send(HostEvent::PeerLeft(peer.clone()));
                    let (api, room, s) = (api.clone(), room_id.clone(), secret.clone());
                    rt::spawn(async move {
                        let _ = api.disconnect_peer(&room, &s, &peer).await;
                    });
                }
            }
        }
        if end || cmds.is_closed() {
            break;
        }

        if let Some((rx, _)) = &push {
            while let Ok(sig) = rx.try_recv() {
                deliver(sig, &mut seen, &peers);
            }
        }

        let now = rt::now_ms();
        if now >= next_signal_poll {
            // Push healthy and nobody mid-handshake → polling is just
            // reconciliation. During a handshake keep polling tight anyway:
            // the gateway has been seen accepting sockets without pushing.
            let handshaking = peers.values().any(|p| !p.watch.is_open() && !p.watch.is_closed());
            let push_up = !handshaking && push.as_ref().is_some_and(|(_, h)| h.is_up());
            next_signal_poll = now + if push_up { cfg.signal_poll_ms.max(5000) } else { cfg.signal_poll_ms } as f64;
            match api.poll_signals(&room_id, "host", since_id).await {
                Ok(r) => {
                    for sig in r.signals {
                        deliver(sig, &mut seen, &peers);
                    }
                    since_id = since_id.max(r.next_since_id);
                }
                Err(e) => log::warn!("lobbii: signal poll failed: {e}"),
            }
        }

        if now >= next_room_poll {
            next_room_poll = now + cfg.room_poll_ms as f64;
            match api.get_room(&room_id).await {
                Ok(room) => {
                    if room.status == "ended" {
                        return Err(NetError::Http { status: 410, message: "room ended".into() });
                    }
                    let listed: HashSet<&str> = room
                        .peers
                        .iter()
                        .filter(|p| !p.is_host && p.status != "disconnected")
                        .map(|p| p.peer_id.as_str())
                        .collect();
                    // Gone from the roster → drop (closing its signal feed ends the link).
                    let gone: Vec<String> = peers.keys().filter(|id| !listed.contains(id.as_str())).cloned().collect();
                    for id in gone {
                        peers.remove(&id);
                        let _ = ev.try_send(HostEvent::PeerLeft(id));
                    }
                    for p in room.peers.iter().filter(|p| listed.contains(p.peer_id.as_str())) {
                        let kind = PeerKind::parse(&p.kind);
                        let (attempts, ready) = match peers.get(&p.peer_id) {
                            None => (0, true),
                            Some(e) if e.watch.is_closed() => (e.attempts, now >= e.retry_at),
                            Some(_) => continue,
                        };
                        if attempts >= MAX_CONNECT_ATTEMPTS {
                            // Gave up: free the seat so the room count stays honest.
                            peers.remove(&p.peer_id);
                            let (api, room, s, id) = (api.clone(), room_id.clone(), secret.clone(), p.peer_id.clone());
                            rt::spawn(async move {
                                let _ = api.disconnect_peer(&room, &s, &id).await;
                            });
                            let _ = ev.try_send(HostEvent::PeerLeft(p.peer_id.clone()));
                            continue;
                        }
                        if !ready {
                            continue;
                        }
                        // A handshake starts: poll tightly from now on.
                        next_signal_poll = 0.0;
                        let (link, signals) = crate::rtc::spawn_peer(Role::Offerer, p.peer_id.clone(), kind, ice.clone(), out_tx.clone());
                        peers.insert(
                            p.peer_id.clone(),
                            HostPeer { signals, watch: link.watch(), attempts: attempts + 1, retry_at: now + RETRY_BACKOFF_MS },
                        );
                        let _ = ev.try_send(HostEvent::Peer {
                            peer_id: p.peer_id.clone(),
                            kind,
                            name: p.display_name.clone(),
                            link,
                        });
                    }
                }
                Err(NetError::Http { status: 404, .. }) => return Err(NetError::Http { status: 404, message: "room gone".into() }),
                Err(e) => log::warn!("lobbii: room poll failed: {e}"),
            }
        }
        rt::sleep_ms(TICK_MS).await;
    }

    drop(peers);
    api.end_room(&room_id, &secret).await
}

// ─── Guest ──────────────────────────────────────────────────────────────────

pub enum GuestEvent {
    Joined { room_id: String, peer_id: String },
    /// The link to the host (a fresh one after each pre-connect re-arm).
    Host(PeerLink),
    Error(NetError),
    Ended,
}

pub struct GuestSession {
    events: Receiver<GuestEvent>,
    stop: Sender<()>,
}

/// Silent answerer re-arms before a guest gives up (TS `MAX_HOST_REARMS`).
const MAX_REARMS: u32 = 4;

fn looks_like_room_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 24 && b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && s.chars().filter(|c| *c != '-').all(|c| c.is_ascii_hexdigit())
}

impl GuestSession {
    /// Join `room` (a room id or a join code) as `kind` (`Screen` for a
    /// second Bevy screen).
    pub fn join(cfg: NetConfig, room: String, display_name: String, kind: PeerKind) -> GuestSession {
        let (ev_tx, ev_rx) = async_channel::unbounded();
        let (stop_tx, stop_rx) = async_channel::bounded(1);
        rt::spawn(async move {
            if let Err(e) = guest_loop(cfg, room, display_name, kind, &ev_tx, stop_rx).await {
                let _ = ev_tx.try_send(GuestEvent::Error(e));
            }
            let _ = ev_tx.try_send(GuestEvent::Ended);
        });
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

async fn guest_loop(cfg: NetConfig, room: String, name: String, kind: PeerKind, ev: &Sender<GuestEvent>, stop: Receiver<()>) -> crate::Result<()> {
    let api = Lobbii::new(cfg.clone())?;
    api.ensure_token().await;
    let room_id = if looks_like_room_id(&room) { room } else { api.lookup_by_code(&room).await?.room_id };
    let joined = api
        .join_room(&room_id, &JoinRoomOpts { kind: kind.as_str().into(), display_name: Some(name), password: None, metadata: None })
        .await?;
    let peer_id = joined.peer_id.clone();
    let auth = Auth::Peer { id: peer_id.clone(), secret: joined.peer_secret.clone() };
    let ice = joined.ice_servers.clone().filter(|v| !v.is_empty()).unwrap_or_else(default_ice_servers);
    let _ = ev.try_send(GuestEvent::Joined { room_id: room_id.clone(), peer_id: peer_id.clone() });

    let (out_tx, out_rx) = async_channel::unbounded();
    spawn_poster(api.clone(), room_id.clone(), auth.clone(), out_rx);
    let push = match (&joined.signal_gw, &joined.room_token) {
        (Some(gw), Some(tok)) if !gw.is_empty() && !tok.is_empty() => Some(api.push_signals(&room_id, gw, tok)),
        _ => None,
    };

    let arm = |ev: &Sender<GuestEvent>| {
        let (link, signals) = crate::rtc::spawn_peer(Role::Answerer, "host".into(), kind, ice.clone(), out_tx.clone());
        let watch = link.watch();
        let _ = ev.try_send(GuestEvent::Host(link));
        (signals, watch)
    };
    let (mut signals, mut watch) = arm(ev);
    let mut rearms = 0;
    let mut ever_open = false;
    let mut seen = Seen::default();
    let mut since_id = 0i64;
    let mut next_poll = 0.0;

    loop {
        if ev.is_closed() || stop.try_recv().is_ok() || stop.is_closed() {
            break;
        }
        if watch.is_closed() {
            // Pre-connect failure: re-arm quietly; a lost live link is final.
            if ever_open || rearms >= MAX_REARMS {
                break;
            }
            rearms += 1;
            (signals, watch) = arm(ev);
        }
        ever_open |= watch.is_open();

        if let Some((rx, _)) = &push {
            while let Ok(sig) = rx.try_recv() {
                if seen.first_time(sig.signal_id) {
                    let _ = signals.try_send(sig);
                }
            }
        }
        let now = rt::now_ms();
        if now >= next_poll {
            let push_up = ever_open && push.as_ref().is_some_and(|(_, h)| h.is_up());
            next_poll = now + if push_up { cfg.signal_poll_ms.max(5000) } else { cfg.signal_poll_ms } as f64;
            match api.poll_signals(&room_id, &peer_id, since_id).await {
                Ok(r) => {
                    for sig in r.signals {
                        if seen.first_time(sig.signal_id) {
                            let _ = signals.try_send(sig);
                        }
                    }
                    since_id = since_id.max(r.next_since_id);
                }
                Err(e) => log::warn!("lobbii: signal poll failed: {e}"),
            }
        }
        rt::sleep_ms(TICK_MS).await;
    }
    drop(signals);
    api.leave_room(&room_id, &peer_id, &joined.peer_secret).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupes_and_bounds() {
        let mut s = Seen::default();
        assert!(s.first_time(1));
        assert!(!s.first_time(1));
        for i in 2..5000 {
            s.first_time(i);
        }
        assert!(s.set.len() <= 2048);
    }

    #[test]
    fn room_id_vs_code() {
        assert!(looks_like_room_id("8c1e7a2b-1234-4abc-8def-0123456789ab"));
        assert!(!looks_like_room_id("ABC123"));
        assert!(!looks_like_room_id("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"));
    }
}
