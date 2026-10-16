//! The generic partii phone-controller pieces, kept in ONE module so they can
//! be swapped for partii-backend's shared `partii-play` crate when it lands
//! (the TS twin is `web-controller/src/lib/play.ts`, to become
//! `@partii/controller-kit`). Nothing in here is Bouncy Blobs specific.
//!
//! * The 10-byte `0x50` input frame (partii `docs/CONTROLLER.md`): codec, seq
//!   ordering, the 80 ms press latch and the 3 s idle release.
//! * Game → phone messages: `seat`, `layout`, `rumble`.
//! * The controller link the QR code encodes.
//! * The home room: the room settings it is made with and its retry policy.

use glam::Vec2;
use serde_json::{Value, json};

/// First byte of an input frame ("P").
pub const FRAME_TAG: u8 = 0x50;
/// Bytes in an input frame (the last one is reserved; 9 is accepted).
pub const FRAME_LEN: usize = 10;

/// Button bits (`docs/CONTROLLER.md`).
pub mod button {
    pub const PRIMARY: u16 = 1;
    pub const SECONDARY: u16 = 2;
    pub const START: u16 = 4;
    pub const LEAVE: u16 = 8;
    pub const CONFIRM: u16 = 16;
    pub const BACK: u16 = 32;
}

/// A button-down stays visible this long, so a tap whose release came in
/// the same frame (or bundle) still lands.
pub const PRESS_LATCH_MS: f64 = 80.0;
/// A phone that sends nothing this long lets go of everything.
pub const IDLE_MS: f64 = 3000.0;

/// One decoded input frame. Sticks are −1..1 with **+y down**, as sent.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub seq: u16,
    pub left: Vec2,
    pub right: Vec2,
    pub buttons: u16,
}

fn axis(v: f32) -> i8 {
    let v = if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 };
    (v * 127.0).round() as i8
}

impl Frame {
    pub fn encode(&self) -> [u8; FRAME_LEN] {
        let mut b = [0u8; FRAME_LEN];
        b[0] = FRAME_TAG;
        b[1..3].copy_from_slice(&self.seq.to_le_bytes());
        b[3] = axis(self.left.x) as u8;
        b[4] = axis(self.left.y) as u8;
        b[5] = axis(self.right.x) as u8;
        b[6] = axis(self.right.y) as u8;
        b[7..9].copy_from_slice(&self.buttons.to_le_bytes());
        b
    }

    /// `None` for anything that isn't a frame.
    pub fn decode(b: &[u8]) -> Option<Frame> {
        if b.len() < FRAME_LEN - 1 || b[0] != FRAME_TAG {
            return None;
        }
        let ax = |i: usize| (b[i] as i8).max(-127) as f32 / 127.0;
        Some(Frame {
            seq: u16::from_le_bytes([b[1], b[2]]),
            left: Vec2::new(ax(3), ax(4)),
            right: Vec2::new(ax(5), ax(6)),
            buttons: u16::from_le_bytes([b[7], b[8]]),
        })
    }
}

/// Is `seq` newer than `prev` (wrapping u16)?
pub fn seq_newer(seq: u16, prev: u16) -> bool {
    let d = seq.wrapping_sub(prev);
    d != 0 && d < 0x8000
}

/// One phone as a pad: the newest frame, plus recent presses.
#[derive(Clone, Debug, Default)]
pub struct Pad {
    last: Option<Frame>,
    /// When the newest frame arrived (ms).
    at: f64,
    /// When each button last went down (ms), for the latch.
    pressed_at: [Option<f64>; 16],
}

impl Pad {
    /// Take a frame. Stale or duplicate frames are dropped (`false`).
    pub fn apply(&mut self, f: Frame, now_ms: f64) -> bool {
        if let Some(prev) = self.last {
            if !seq_newer(f.seq, prev.seq) {
                return false;
            }
        }
        let was = self.last.map_or(0, |p| p.buttons);
        for bit in 0..16 {
            if f.buttons & (1 << bit) != 0 && was & (1 << bit) == 0 {
                self.pressed_at[bit] = Some(now_ms);
            }
        }
        self.last = Some(f);
        self.at = now_ms;
        true
    }

    /// The pad heard from in the last [`IDLE_MS`].
    pub fn live(&self, now_ms: f64) -> bool {
        self.last.is_some() && now_ms - self.at < IDLE_MS
    }

    /// Left stick (+y down), zero when idle.
    pub fn left(&self, now_ms: f64) -> Vec2 {
        match self.last {
            Some(f) if self.live(now_ms) => f.left,
            _ => Vec2::ZERO,
        }
    }

    /// Buttons held now, with presses latched for [`PRESS_LATCH_MS`].
    pub fn buttons(&self, now_ms: f64) -> u16 {
        let held = match self.last {
            Some(f) if self.live(now_ms) => f.buttons,
            _ => 0,
        };
        let latched = (0..16).filter(|b| self.pressed_at[*b].is_some_and(|t| now_ms - t < PRESS_LATCH_MS)).fold(0u16, |m, b| m | (1 << b));
        held | latched
    }
}

// ─── Game → phone ───────────────────────────────────────────────────────────

/// `{"t":"seat","label":"P2","color":"#3b82f6"}`: the phone tints itself.
pub fn seat_msg(label: &str, color: u32) -> String {
    format!(r##"{{"t":"seat","label":{},"color":"#{:06x}"}}"##, Value::from(label), color & 0xFF_FFFF)
}

/// `{"t":"layout","buttons":["JUMP"]}`: labels for the phone's buttons.
pub fn layout_msg(buttons: &[&str]) -> String {
    format!(r#"{{"t":"layout","buttons":{}}}"#, Value::from(buttons.to_vec()))
}

/// `{"t":"rumble","ms":120}`: vibrate if the phone can.
pub fn rumble_msg(ms: u32) -> String {
    format!(r#"{{"t":"rumble","ms":{ms}}}"#)
}

/// `{"t":"hello",...}` from a phone: its name (and signed-in player id).
pub fn parse_hello(text: &str) -> Option<(String, Option<String>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("t")?.as_str()? != "hello" {
        return None;
    }
    let name = v.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    Some((name, v.get("player").and_then(Value::as_str).map(str::to_string)))
}

// ─── The QR link ────────────────────────────────────────────────────────────

/// Percent-encode a query value.
pub fn encode_query(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `<page>/c/<CODE>?k=<key>&e=<edge>&g=<game>`. `page` is the controller
/// site (`https://<game>.partii.games`), with or without `/c/` at the end.
pub fn controller_url(page: &str, code: &str, key: &str, edge: &str, game: &str) -> String {
    let base = page.trim_end_matches('/');
    let base = base.strip_suffix("/c").unwrap_or(base);
    format!("{base}/c/{code}?k={}&e={}&g={}", encode_query(key), encode_query(edge), encode_query(game))
}

/// The room code in a controller link (`…/c/CODE?…`, `…/p/CODE`, or the
/// older `…/controller/CODE`).
pub fn code_in_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    for seg in ["/c/", "/p/", "/controller/"] {
        if let Some((_, rest)) = path.rsplit_once(seg) {
            let code: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if !code.is_empty() {
                return Some(code.to_ascii_uppercase());
            }
        }
    }
    None
}

/// What streamer mode shows instead of a room code.
pub fn masked_code(code: &str) -> String {
    "•".repeat(code.chars().count().max(5))
}

// ─── The home room ──────────────────────────────────────────────────────────

/// Members a home room takes (partii's maximum).
pub const HOME_MAX_MEMBERS: u32 = 32;
/// Stop retrying a refused create after this long (and say so).
pub const GIVE_UP_MS: f64 = 60_000.0;

/// Settings for the home room (partii `docs/PROTOCOL.md` "Kinds"): phones
/// are always welcome; full game clients of kind `game_kind` get a clean
/// `not_joinable` until the host opens them with [`open_kind`].
pub fn home_settings(game_kind: &str) -> Value {
    json!({ "max_members": HOME_MAX_MEMBERS, "kinds": { game_kind: { "joinable": false } } })
}

/// `settings` plus a reclaim of `code` with the host's token, so a host
/// whose session timed out gets the same code back (and the QR stays valid).
pub fn with_reclaim(mut settings: Value, code: &str, token: &str) -> Value {
    settings["reclaim"] = json!({ "code": code, "token": token });
    settings
}

/// The `update` patch that opens or closes one member kind.
pub fn open_kind(kind: &str, joinable: bool) -> Value {
    json!({ "kinds": { kind: { "joinable": joinable } } })
}

/// How long to wait before trying again after a refusal with `code`:
/// partii's `retry_after_ms` (plus up to `jitter_ms`) when it gave one,
/// else 10 s when busy and 5 s for anything else.
pub fn retry_ms(code: &str, retry_after_ms: Option<u64>, jitter_ms: f64) -> f64 {
    match retry_after_ms {
        Some(ms) => ms as f64 + jitter_ms.clamp(0.0, 1000.0),
        None if code == "rate_limited" => 10_000.0,
        None => 5_000.0,
    }
}

/// A partii close reason after which the host may reclaim its code.
pub fn reclaimable(reason: &str) -> bool {
    reason == "host_lost"
}

/// What to tell the player while partii is busy and we wait to retry.
pub const BUSY_NOTICE: &str = "Lots of players on this network right now. Still trying…";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_golden_vector() {
        // Shared with web-controller/test/frame.test.mjs.
        let f = Frame { seq: 0x0102, left: Vec2::new(1.0, -1.0), right: Vec2::new(0.0, 0.5), buttons: button::PRIMARY | button::CONFIRM };
        let b = f.encode();
        assert_eq!(b, [0x50, 0x02, 0x01, 127, 0x81, 0, 64, 17, 0, 0]);
        let d = Frame::decode(&b).unwrap();
        assert_eq!(d.seq, 0x0102);
        assert_eq!(d.left, Vec2::new(1.0, -1.0));
        assert!((d.right.y - 64.0 / 127.0).abs() < 1e-6);
        assert_eq!(d.buttons, 17);
        // 9 bytes is fine, -128 clamps, junk isn't a frame.
        assert_eq!(Frame::decode(&[0x50, 0, 0, 0x80, 0, 0, 0, 0, 0]).unwrap().left.x, -1.0);
        assert!(Frame::decode(&b[..8]).is_none());
        assert!(Frame::decode(b"{\"type\":1}").is_none());
    }

    #[test]
    fn seq_wraps() {
        assert!(seq_newer(1, 0));
        assert!(seq_newer(0, 0xffff));
        assert!(!seq_newer(5, 5));
        assert!(!seq_newer(4, 5));
    }

    #[test]
    fn pad_drops_stale_latches_taps_and_idles() {
        let mut p = Pad::default();
        let f = |seq, x: f32, b| Frame { seq, left: Vec2::new(x, 0.0), buttons: b, ..Default::default() };
        assert!(p.apply(f(10, 1.0, 0), 0.0));
        assert!(!p.apply(f(9, -1.0, 0), 10.0), "older frame dropped");
        assert_eq!(p.left(10.0).x, 1.0);
        // A tap: down and up in consecutive frames still shows for 80 ms.
        p.apply(f(11, 0.0, button::PRIMARY), 20.0);
        p.apply(f(12, 0.0, 0), 21.0);
        assert_eq!(p.buttons(30.0), button::PRIMARY);
        assert_eq!(p.buttons(120.0), 0);
        // Held, then silent for 3 s: let go.
        p.apply(f(13, 1.0, button::PRIMARY), 200.0);
        assert_eq!(p.buttons(1000.0), button::PRIMARY);
        assert_eq!(p.buttons(3300.0), 0);
        assert_eq!(p.left(3300.0), Vec2::ZERO);
    }

    #[test]
    fn messages_and_links() {
        assert_eq!(seat_msg("P2", 0x3B82F6), r##"{"t":"seat","label":"P2","color":"#3b82f6"}"##);
        assert_eq!(layout_msg(&["EXPAND"]), r#"{"t":"layout","buttons":["EXPAND"]}"#);
        assert_eq!(rumble_msg(120), r#"{"t":"rumble","ms":120}"#);
        assert_eq!(parse_hello(r#"{"t":"hello","name":"Sam","player":null,"profile":null}"#), Some(("Sam".into(), None)));
        assert_eq!(parse_hello(r#"{"type":"player_join"}"#), None);
        let url = controller_url("https://bouncy-blobs.partii.games/c/", "KXQPT", "pk_x", "https://api.partii.games", "bouncy-blobs");
        assert_eq!(url, "https://bouncy-blobs.partii.games/c/KXQPT?k=pk_x&e=https%3A%2F%2Fapi.partii.games&g=bouncy-blobs");
        assert_eq!(controller_url("https://x.partii.games", "AB", "k", "e", "g"), "https://x.partii.games/c/AB?k=k&e=e&g=g");
        assert_eq!(code_in_url(&url).as_deref(), Some("KXQPT"));
        assert_eq!(code_in_url("https://old.vercel.app/controller/abcde").as_deref(), Some("ABCDE"));
        assert_eq!(code_in_url("https://x/join"), None);
        assert_eq!(masked_code("KXQPT"), "•••••");
    }

    #[test]
    fn home_room_policy() {
        let s = home_settings("game");
        assert_eq!(s["max_members"], 32);
        assert_eq!(s["kinds"]["game"]["joinable"], false);
        assert!(s["kinds"].get("phone").is_none(), "phones always welcome");
        let r = with_reclaim(s, "KXQPT", "tok");
        assert_eq!(r["reclaim"]["code"], "KXQPT");
        assert_eq!(r["reclaim"]["token"], "tok");
        assert_eq!(open_kind("game", true)["kinds"]["game"]["joinable"], true);
        assert_eq!(retry_ms("rate_limited", Some(2500), 300.0), 2800.0);
        assert_eq!(retry_ms("rate_limited", Some(2500), 9e9), 3500.0);
        assert_eq!(retry_ms("rate_limited", None, 0.0), 10_000.0);
        assert_eq!(retry_ms("offline", None, 0.0), 5_000.0);
        assert!(reclaimable("host_lost") && !reclaimable("host_left") && !reclaimable("expired"));
    }
}
