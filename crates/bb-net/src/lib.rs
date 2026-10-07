//! Bouncy Blobs networking.
//!
//! * [`lobbii`]: the Lobbii rooms/signaling REST client (same backend and
//!   payloads as the TS party-kit, so web phones and the Bevy host meet in the
//!   same rooms).
//! * [`transport`]: the `Transport` trait, channel-backed peer links, and an
//!   in-memory loopback for tests. WebRTC drivers live in `rtc_native`
//!   (webrtc-rs on a background tokio runtime) and `rtc_web` (browser RTC).
//! * [`session`]: host / guest lifecycles: create or join a room, poll
//!   signals, open a link per peer. Everything runs off the game thread; the
//!   game drains events with non-blocking `poll`s.
//! * [`phone`]: the existing phone-controller JSON protocol.
//! * [`wire`] + [`blend`]: eventual-consistency body sync for screen-to-screen
//!   play (owner-authoritative, no rollback).

pub mod blend;
pub mod config;
pub mod lobbii;
pub mod phone;
pub mod rt;
pub mod session;
pub mod transport;
pub mod wire;

#[cfg(not(target_arch = "wasm32"))]
mod rtc_native;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use rtc_native as rtc;
#[cfg(target_arch = "wasm32")]
mod rtc_web;
#[cfg(target_arch = "wasm32")]
pub(crate) use rtc_web as rtc;

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
