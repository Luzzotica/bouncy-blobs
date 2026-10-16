//! The wire between us and one remote peer.
//!
//! Every peer gets two channels, named exactly as the TS party-kit names them
//! so the deployed phone page and older clients keep working:
//!
//! | remote kind | reliable, ordered | unreliable (`ordered:false, maxRetransmits:0`) |
//! |---|---|---|
//! | `phone`  | `data`  | `input` |
//! | `screen` | `state` | `input` |
//!
//! Callers pick a [`Channel`]; the label is a transport detail. A
//! [`PeerLink`] is the game-side handle: `send` queues without blocking and
//! `try_recv` drains without blocking. The I/O itself (webrtc-rs tasks, browser
//! callbacks) sits behind channels, so the handle is `Send + Sync` everywhere
//! and a Bevy system can own it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use async_channel::{Receiver, Sender, TrySendError};

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Channel {
    /// `data` (phones) / `state` (screens): reliable + ordered.
    Reliable,
    /// `input`: unreliable + unordered, latest value wins.
    Unreliable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Payload {
    /// A text frame. The phone page `JSON.parse`s `event.data`, so anything
    /// for phones must be text, never bytes.
    Text(String),
    Binary(Vec<u8>),
}

impl Payload {
    pub fn len(&self) -> usize {
        match self {
            Payload::Text(s) => s.len(),
            Payload::Binary(b) => b.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum PeerKind {
    Phone,
    Screen,
    Other,
}

impl PeerKind {
    pub fn parse(s: &str) -> PeerKind {
        match s {
            "phone" => PeerKind::Phone,
            // partii's standard kind for a full game client ("screen" was
            // Bouncy Blobs' own name for it before).
            "game" | "screen" => PeerKind::Screen,
            _ => PeerKind::Other,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            PeerKind::Phone => "phone",
            PeerKind::Screen => "game",
            PeerKind::Other => "other",
        }
    }

    /// Data-channel label for a channel (`channelsForKind` in transport.ts).
    pub fn label(self, ch: Channel) -> &'static str {
        match (self, ch) {
            (_, Channel::Unreliable) => "input",
            (PeerKind::Screen, Channel::Reliable) => "state",
            (_, Channel::Reliable) => "data",
        }
    }

    pub fn channel_of(self, label: &str) -> Option<Channel> {
        if label == "input" {
            Some(Channel::Unreliable)
        } else if label == self.label(Channel::Reliable) {
            Some(Channel::Reliable)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum LinkEvent {
    /// The first channel opened (fires once).
    Open,
    Message(Channel, Payload),
    /// Terminal: the link is gone (reason for logs).
    Closed(String),
}

/// One remote peer. Implemented by [`PeerLink`] for WebRTC and loopback; an
/// Epic Online Services or Steam backend would implement it too.
pub trait Transport: Send + Sync {
    fn remote_id(&self) -> &str;
    fn kind(&self) -> PeerKind;
    /// Queue a message. `false` if the link isn't open or its queue is full
    /// (callers treat that like packet loss; realtime state self-heals).
    fn send(&self, ch: Channel, msg: Payload) -> bool;
    /// Next event, if any. Never blocks.
    fn try_recv(&self) -> Option<LinkEvent>;
    fn is_open(&self) -> bool;
    fn is_closed(&self) -> bool;
    fn close(&self);
}

/// What the game asks a backend driver to do.
#[derive(Debug)]
pub(crate) enum Outgoing {
    Send(Channel, Payload),
    Close,
}

/// Outgoing queue depth per link. ~64 KB of typical traffic; past this the
/// link is stalled and dropping beats unbounded latency (TS: `MAX_BUFFERED`).
const OUT_QUEUE: usize = 256;

#[derive(Default)]
pub(crate) struct LinkFlags {
    pub open: AtomicBool,
    pub closed: AtomicBool,
}

enum Sink {
    Driver(Sender<Outgoing>),
    /// Loopback: push straight into the other side's inbox.
    Direct { peer: Sender<LinkEvent>, peer_flags: Arc<LinkFlags>, drop_unreliable: f32, rng: AtomicU64 },
}

pub struct PeerLink {
    remote_id: String,
    kind: PeerKind,
    sink: Sink,
    inbox: Receiver<LinkEvent>,
    flags: Arc<LinkFlags>,
}

/// Backend side of a [`PeerLink`].
pub(crate) struct LinkDriver {
    pub outgoing: Receiver<Outgoing>,
    pub events: Sender<LinkEvent>,
    pub flags: Arc<LinkFlags>,
}

impl LinkDriver {
    pub fn opened(&self) {
        if !self.flags.open.swap(true, Ordering::AcqRel) {
            let _ = self.events.try_send(LinkEvent::Open);
        }
    }

    pub fn deliver(&self, ch: Channel, msg: Payload) {
        // Unbounded inbox: the game drains every frame, and dropping
        // reliable messages here would break ordering guarantees.
        let _ = self.events.try_send(LinkEvent::Message(ch, msg));
    }

    pub fn closed(&self, reason: impl Into<String>) {
        self.flags.open.store(false, Ordering::Release);
        if !self.flags.closed.swap(true, Ordering::AcqRel) {
            let _ = self.events.try_send(LinkEvent::Closed(reason.into()));
        }
    }
}

/// A link plus the driver half a backend task owns.
pub(crate) fn link_pair(remote_id: impl Into<String>, kind: PeerKind) -> (PeerLink, LinkDriver) {
    let (out_tx, out_rx) = async_channel::bounded(OUT_QUEUE);
    let (ev_tx, ev_rx) = async_channel::unbounded();
    let flags = Arc::new(LinkFlags::default());
    (
        PeerLink { remote_id: remote_id.into(), kind, sink: Sink::Driver(out_tx), inbox: ev_rx, flags: flags.clone() },
        LinkDriver { outgoing: out_rx, events: ev_tx, flags },
    )
}

impl Transport for PeerLink {
    fn remote_id(&self) -> &str {
        &self.remote_id
    }

    fn kind(&self) -> PeerKind {
        self.kind
    }

    fn send(&self, ch: Channel, msg: Payload) -> bool {
        if !self.is_open() {
            return false;
        }
        match &self.sink {
            Sink::Driver(tx) => match tx.try_send(Outgoing::Send(ch, msg)) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) | Err(TrySendError::Closed(_)) => false,
            },
            Sink::Direct { peer, peer_flags, drop_unreliable, rng } => {
                if peer_flags.closed.load(Ordering::Acquire) {
                    return false;
                }
                if ch == Channel::Unreliable && *drop_unreliable > 0.0 {
                    // xorshift: deterministic loss for tests.
                    let mut x = rng.load(Ordering::Relaxed);
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    rng.store(x, Ordering::Relaxed);
                    if (x >> 40) as f32 / (1u64 << 24) as f32 <= *drop_unreliable {
                        return true; // "sent", lost on the wire
                    }
                }
                peer.try_send(LinkEvent::Message(ch, msg)).is_ok()
            }
        }
    }

    fn try_recv(&self) -> Option<LinkEvent> {
        self.inbox.try_recv().ok()
    }

    fn is_open(&self) -> bool {
        self.flags.open.load(Ordering::Acquire) && !self.is_closed()
    }

    fn is_closed(&self) -> bool {
        self.flags.closed.load(Ordering::Acquire)
    }

    fn close(&self) {
        match &self.sink {
            Sink::Driver(tx) => {
                let _ = tx.try_send(Outgoing::Close);
            }
            Sink::Direct { peer, peer_flags, .. } => {
                peer_flags.open.store(false, Ordering::Release);
                if !peer_flags.closed.swap(true, Ordering::AcqRel) {
                    let _ = peer.try_send(LinkEvent::Closed("remote closed".into()));
                }
            }
        }
        self.flags.open.store(false, Ordering::Release);
        self.flags.closed.store(true, Ordering::Release);
    }
}

impl Drop for PeerLink {
    fn drop(&mut self) {
        if !self.is_closed() {
            self.close();
        }
    }
}

/// Two links wired to each other in memory, already open. `drop_unreliable`
/// (0..1) loses that fraction of `input`-channel messages, like a lossy link.
pub fn loopback(kind: PeerKind, a_id: &str, b_id: &str, drop_unreliable: f32) -> (PeerLink, PeerLink) {
    let (a_tx, a_rx) = async_channel::unbounded();
    let (b_tx, b_rx) = async_channel::unbounded();
    let fa = Arc::new(LinkFlags { open: AtomicBool::new(true), closed: AtomicBool::new(false) });
    let fb = Arc::new(LinkFlags { open: AtomicBool::new(true), closed: AtomicBool::new(false) });
    let _ = a_tx.try_send(LinkEvent::Open);
    let _ = b_tx.try_send(LinkEvent::Open);
    // `a` talks to the peer called b_id and vice versa.
    let a = PeerLink {
        remote_id: b_id.into(),
        kind,
        sink: Sink::Direct { peer: b_tx, peer_flags: fb.clone(), drop_unreliable, rng: AtomicU64::new(0x9E37_79B9_7F4A_7C15) },
        inbox: a_rx,
        flags: fa.clone(),
    };
    let b = PeerLink {
        remote_id: a_id.into(),
        kind,
        sink: Sink::Direct { peer: a_tx, peer_flags: fa, drop_unreliable, rng: AtomicU64::new(0xD1B5_4A32_D192_ED03) },
        inbox: b_rx,
        flags: fb,
    };
    (a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_match_party_kit() {
        assert_eq!(PeerKind::Phone.label(Channel::Reliable), "data");
        assert_eq!(PeerKind::Screen.label(Channel::Reliable), "state");
        assert_eq!(PeerKind::Phone.label(Channel::Unreliable), "input");
        assert_eq!(PeerKind::Screen.channel_of("state"), Some(Channel::Reliable));
        assert_eq!(PeerKind::Phone.channel_of("state"), None);
    }

    #[test]
    fn loopback_delivers_and_closes() {
        let (a, b) = loopback(PeerKind::Screen, "host", "guest", 0.0);
        assert_eq!(a.try_recv(), Some(LinkEvent::Open));
        assert_eq!(b.try_recv(), Some(LinkEvent::Open));
        assert!(a.send(Channel::Reliable, Payload::Text("hi".into())));
        assert_eq!(b.try_recv(), Some(LinkEvent::Message(Channel::Reliable, Payload::Text("hi".into()))));
        a.close();
        assert!(matches!(b.try_recv(), Some(LinkEvent::Closed(_))));
        assert!(!b.send(Channel::Reliable, Payload::Binary(vec![1])));
    }

    #[test]
    fn loopback_loses_some_unreliable() {
        let (a, b) = loopback(PeerKind::Screen, "a", "b", 0.3);
        let _ = b.try_recv();
        for i in 0..1000u32 {
            a.send(Channel::Unreliable, Payload::Binary(i.to_le_bytes().to_vec()));
        }
        let got = std::iter::from_fn(|| b.try_recv()).count();
        assert!(got > 600 && got < 800, "delivered {got}");
    }
}
