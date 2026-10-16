//! Bouncy Blobs networking.
//!
//! * [`transport`]: the `Transport` trait, channel-backed peer links, and an
//!   in-memory loopback for tests.
//! * [`session`]: host / guest lifecycles on the partii engine (rooms by
//!   code, relay → TURN → direct paths, reconnects): a link per member.
//!   Everything runs off the game thread; the game drains events with
//!   non-blocking `poll`s.
//! * [`play`]: the generic partii controller pieces (the `0x50` input frame,
//!   seat/layout/rumble, the QR link, home-room policy), kept apart so the
//!   shared `partii-play` crate can replace them.
//! * [`phone`]: Bouncy Blobs' own phone messages (join, colours, faces).
//! * [`wire`] + [`blend`]: eventual-consistency body sync for screen-to-screen
//!   play (owner-authoritative, no rollback).

pub mod blend;
pub mod config;
pub mod phone;
pub mod play;
pub mod rt;
pub mod session;
pub mod transport;
pub mod wire;


pub use config::{GAME_ID, NetConfig};
pub use transport::{Channel, LinkEvent, Payload, PeerKind, PeerLink, Transport};

/// Errors surfaced to the game. Network input never panics; it ends up here.
#[derive(Clone, Debug, PartialEq)]
pub enum NetError {
    /// The backend answered with a non-2xx status.
    Http { status: u16, message: String },
    /// Couldn't reach the backend / socket failure.
    Io(String),
    /// A response or message didn't parse.
    Decode(String),
    /// Missing API key, bad URL, etc.
    Config(String),
    /// WebRTC failed or timed out.
    Rtc(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::Http { status, message } => write!(f, "HTTP {status}: {message}"),
            NetError::Io(m) => write!(f, "network: {m}"),
            NetError::Decode(m) => write!(f, "decode: {m}"),
            NetError::Config(m) => write!(f, "config: {m}"),
            NetError::Rtc(m) => write!(f, "webrtc: {m}"),
        }
    }
}

impl std::error::Error for NetError {}

pub type Result<T> = std::result::Result<T, NetError>;
