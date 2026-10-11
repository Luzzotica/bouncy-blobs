//! Screen-to-screen wire format for eventual-consistency play.
//!
//! Each body has one owner (your blob: your machine; phone blobs, props and
//! NPCs: the host). Owners stream compact [`BodyState`]s on the unreliable
//! `input` channel; receivers [`crate::blend`] toward them. Discrete things
//! (joins, level loads, pops, checkpoints) are [`NetEvent`] JSON on the
//! reliable `state` channel.
//!
//! Byte 0 demuxes: [`STATES_MAGIC`] = body-state packet, `{` = JSON event.
//! All multi-byte fields are little-endian.

use std::collections::HashMap;

use bb_physics::{Body, Vec2};
use serde::{Deserialize, Serialize};

/// Body-state packet: `u8 magic, u16 seq, u8 count, count × BodyState`.
pub const STATES_MAGIC: u8 = 0x10;
pub const HEADER_BYTES: usize = 4;
/// `u16 id, i24 x, i24 y, i16 vx, i16 vy, u16 angle, u8 scale, u8 flags`.
pub const RECORD_BYTES: usize = 16;
/// Safe single-datagram payload on every path we care about (TURN over TCP
/// included) without IP fragmentation.
pub const MTU: usize = 1100;

const POS_Q: f32 = 16.0;
const VEL_Q: f32 = 8.0;
const I24_MAX: i32 = (1 << 23) - 1;

/// Which body a state describes. Stable across machines because every peer
/// builds the same level; players are keyed by slot.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum NetId {
    Player(u8),
    Npc(u16),
    /// Index into the level's dynamic props.
    Prop(u16),
}

impl NetId {
    /// Top two bits = kind, low 14 = index.
    pub fn encode(self) -> u16 {
        match self {
            NetId::Player(s) => s as u16,
            NetId::Npc(i) => (1 << 14) | (i & 0x3FFF),
            NetId::Prop(i) => (2 << 14) | (i & 0x3FFF),
        }
    }

    pub fn decode(v: u16) -> Option<NetId> {
        let i = v & 0x3FFF;
        match v >> 14 {
            0 if i < 256 => Some(NetId::Player(i as u8)),
            1 => Some(NetId::Npc(i)),
            2 => Some(NetId::Prop(i)),
            _ => None,
        }
    }
}

pub mod flags {
    /// Body exists and isn't popped.
    pub const ALIVE: u8 = 1 << 0;
    /// The one button is held (expand / jump), so receivers animate it too.
    pub const BUTTON: u8 = 1 << 1;
    pub const STICK_RIGHT: u8 = 1 << 2;
    pub const STICK_LEFT: u8 = 1 << 3;
    pub const STICK_UP: u8 = 1 << 4;
    pub const STICK_DOWN: u8 = 1 << 5;
    pub const GROUNDED: u8 = 1 << 6;
    pub const GRABBING: u8 = 1 << 7;
}

/// One body's quantised state, ~16 bytes on the wire.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BodyState {
    pub id: NetId,
    /// Centroid in 1/16 px (fits i24: ±524 288 px).
    pub pos: [i32; 2],
    /// Mean velocity in 1/8 px/s (±4096 px/s).
    pub vel: [i16; 2],
    /// Best-fit rotation, full turn = 65536.
    pub angle: u16,
    /// `rest_scale` as `(s - 0.5) * 100` (0.5 ..= 3.05).
    pub scale: u8,
    pub flags: u8,
}

fn q(v: f32, k: f32, lim: i32) -> i32 {
    if !v.is_finite() {
        return 0;
    }
    ((v * k).round() as i64).clamp(-(lim as i64), lim as i64) as i32
}

impl BodyState {
    pub fn new(id: NetId, pos: Vec2, vel: Vec2, angle: f32, rest_scale: f32, flags: u8) -> BodyState {
        let turn = if angle.is_finite() { angle.rem_euclid(std::f32::consts::TAU) / std::f32::consts::TAU } else { 0.0 };
        BodyState {
            id,
            pos: [q(pos.x, POS_Q, I24_MAX), q(pos.y, POS_Q, I24_MAX)],
            vel: [q(vel.x, VEL_Q, i16::MAX as i32) as i16, q(vel.y, VEL_Q, i16::MAX as i32) as i16],
            angle: ((turn * 65536.0).round() as u32 & 0xFFFF) as u16,
            scale: if rest_scale.is_finite() { ((rest_scale - 0.5) * 100.0).round().clamp(0.0, 255.0) as u8 } else { 50 },
            flags,
        }
    }

    /// Capture a physics body.
    pub fn of_body(id: NetId, body: &Body, flags: u8) -> BodyState {
        let alive = if body.enabled { flags::ALIVE } else { 0 };
        BodyState::new(id, body.centroid(), body.velocity(), body.angle(), body.rest_scale, flags | alive)
    }

    pub fn position(&self) -> Vec2 {
        Vec2::new(self.pos[0] as f32, self.pos[1] as f32) / POS_Q
    }

    pub fn velocity(&self) -> Vec2 {
        Vec2::new(self.vel[0] as f32, self.vel[1] as f32) / VEL_Q
    }

    pub fn angle_rad(&self) -> f32 {
        self.angle as f32 / 65536.0 * std::f32::consts::TAU
    }

    pub fn rest_scale(&self) -> f32 {
        self.scale as f32 / 100.0 + 0.5
    }

    pub fn alive(&self) -> bool {
        self.flags & flags::ALIVE != 0
    }

    /// Stick direction packed in the flags (each axis −1/0/1).
    pub fn stick(&self) -> Vec2 {
        let ax = |pos: u8, neg: u8| {
            if self.flags & pos != 0 {
                1.0
            } else if self.flags & neg != 0 {
                -1.0
            } else {
                0.0
            }
        };
        Vec2::new(ax(flags::STICK_RIGHT, flags::STICK_LEFT), ax(flags::STICK_UP, flags::STICK_DOWN))
    }

    pub fn button(&self) -> bool {
        self.flags & flags::BUTTON != 0
    }

    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.id.encode().to_le_bytes());
        for p in self.pos {
            out.extend_from_slice(&p.to_le_bytes()[..3]);
        }
        for v in self.vel {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.angle.to_le_bytes());
        out.push(self.scale);
        out.push(self.flags);
    }

    fn read(b: &[u8]) -> Option<BodyState> {
        if b.len() < RECORD_BYTES {
            return None;
        }
        let i24 = |s: &[u8]| (((s[0] as u32) | (s[1] as u32) << 8 | (s[2] as u32) << 16) << 8) as i32 >> 8;
        Some(BodyState {
            id: NetId::decode(u16::from_le_bytes([b[0], b[1]]))?,
            pos: [i24(&b[2..5]), i24(&b[5..8])],
            vel: [i16::from_le_bytes([b[8], b[9]]), i16::from_le_bytes([b[10], b[11]])],
            angle: u16::from_le_bytes([b[12], b[13]]),
            scale: b[14],
            flags: b[15],
        })
    }
}

/// Input flags for a stick + button (what the owner is pressing).
pub fn input_flags(stick: Vec2, button: bool) -> u8 {
    let mut f = 0;
    if button {
        f |= flags::BUTTON;
    }
    if stick.x > 0.3 {
        f |= flags::STICK_RIGHT;
    } else if stick.x < -0.3 {
        f |= flags::STICK_LEFT;
    }
    if stick.y > 0.3 {
        f |= flags::STICK_UP;
    } else if stick.y < -0.3 {
        f |= flags::STICK_DOWN;
    }
    f
}

pub fn encode_states(seq: u16, states: &[BodyState]) -> Vec<u8> {
    let n = states.len().min(255);
    let mut out = Vec::with_capacity(HEADER_BYTES + n * RECORD_BYTES);
    out.push(STATES_MAGIC);
    out.extend_from_slice(&seq.to_le_bytes());
    out.push(n as u8);
    for s in &states[..n] {
        s.write(&mut out);
    }
    out
}

/// `None` on wrong magic or truncation. Records with an unknown id kind are
/// skipped rather than failing the whole packet.
pub fn decode_states(b: &[u8]) -> Option<(u16, Vec<BodyState>)> {
    if b.len() < HEADER_BYTES || b[0] != STATES_MAGIC {
        return None;
    }
    let seq = u16::from_le_bytes([b[1], b[2]]);
    let n = b[3] as usize;
    if b.len() < HEADER_BYTES + n * RECORD_BYTES {
        return None;
    }
    let states = (0..n).filter_map(|i| BodyState::read(&b[HEADER_BYTES + i * RECORD_BYTES..])).collect();
    Some((seq, states))
}

/// After this many identical at-rest sends a body counts as asleep and
/// costs nothing (a few repeats ride out loss on the unreliable channel).
const REST_REPEATS: u8 = 3;

#[derive(Clone, Debug, Default)]
struct SendEntry {
    priority: f32,
    last: Option<BodyState>,
    /// Flags seen last tick (sent or not), so a flip boosts exactly once.
    seen_flags: Option<u8>,
    rest_sent: u8,
}

/// Picks what goes in each packet with priority accumulators: every tick a
/// body earns priority by importance × motion; the packet takes the highest
/// until the MTU budget is spent, and sent bodies reset to zero. Fast,
/// important bodies go every packet; slow props trickle; sleepers stop.
#[derive(Clone, Debug)]
pub struct StateSender {
    seq: u16,
    entries: HashMap<NetId, SendEntry>,
    pub mtu: usize,
}

impl Default for StateSender {
    fn default() -> Self {
        StateSender { seq: 0, entries: HashMap::new(), mtu: MTU }
    }
}

fn at_rest(s: &BodyState, last: &BodyState) -> bool {
    s.vel[0].abs() <= 4
        && s.vel[1].abs() <= 4
        && (s.pos[0] - last.pos[0]).abs() <= 2
        && (s.pos[1] - last.pos[1]).abs() <= 2
        && s.flags == last.flags
        && s.scale == last.scale
}

impl StateSender {
    /// `bodies`: everything this peer owns (or relays) right now, with an
    /// importance weight (players ~4, props ~1). Returns the packet to send,
    /// or `None` when everything is asleep.
    pub fn build(&mut self, bodies: &[(BodyState, f32)]) -> Option<Vec<u8>> {
        let present: std::collections::HashSet<NetId> = bodies.iter().map(|b| b.0.id).collect();
        self.entries.retain(|id, _| present.contains(id));

        let mut ready: Vec<(f32, BodyState)> = Vec::new();
        for (s, weight) in bodies {
            let e = self.entries.entry(s.id).or_default();
            let sleeping = e.last.is_some_and(|l| at_rest(s, &l));
            if sleeping && e.rest_sent >= REST_REPEATS {
                continue;
            }
            let speed = s.velocity().length();
            let mut gain = weight.max(0.01) * (1.0 + speed / 300.0);
            if e.seen_flags != Some(s.flags) {
                // New bodies and state flips (pop, button) jump the queue,
                // scaled by importance so a level-load burst of props can't
                // starve the players.
                gain += weight * 3.0;
            }
            e.seen_flags = Some(s.flags);
            e.priority += gain;
            ready.push((e.priority, *s));
        }
        if ready.is_empty() {
            return None;
        }
        ready.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
        let cap = ((self.mtu.saturating_sub(HEADER_BYTES)) / RECORD_BYTES).clamp(1, 255);
        let chosen: Vec<BodyState> = ready.into_iter().take(cap).map(|r| r.1).collect();
        for s in &chosen {
            if let Some(e) = self.entries.get_mut(&s.id) {
                let rest = e.last.is_some_and(|l| at_rest(s, &l));
                e.rest_sent = if rest { e.rest_sent.saturating_add(1) } else { 0 };
                e.priority = 0.0;
                e.last = Some(*s);
            }
        }
        self.seq = self.seq.wrapping_add(1);
        Some(encode_states(self.seq, &chosen))
    }
}

/// Latest state per body from one sender, ignoring stale packets (the
/// unreliable channel reorders).
#[derive(Clone, Debug, Default)]
pub struct StateReceiver {
    latest: HashMap<NetId, (u16, BodyState, f64)>,
}

/// `a` is newer than `b` in u16 sequence space.
pub fn seq_newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

impl StateReceiver {
    /// Feed a packet received at `now` (seconds). Returns the states that
    /// were fresh.
    pub fn receive(&mut self, bytes: &[u8], now: f64) -> Vec<BodyState> {
        let Some((seq, states)) = decode_states(bytes) else { return Vec::new() };
        let mut fresh = Vec::new();
        for s in states {
            let newer = self.latest.get(&s.id).is_none_or(|(old, _, _)| seq_newer(seq, *old));
            if newer {
                self.latest.insert(s.id, (seq, s, now));
                fresh.push(s);
            }
        }
        fresh
    }

    /// Latest state and when it arrived.
    pub fn get(&self, id: NetId) -> Option<(BodyState, f64)> {
        self.latest.get(&id).map(|(_, s, t)| (*s, *t))
    }

    pub fn forget(&mut self, id: NetId) {
        self.latest.remove(&id);
    }

    pub fn iter(&self) -> impl Iterator<Item = (NetId, BodyState, f64)> + '_ {
        self.latest.iter().map(|(id, (_, s, t))| (*id, *s, *t))
    }
}

/// A player as announced on the wire.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlayerInfo {
    pub slot: u8,
    pub name: String,
    /// 0xRRGGBB.
    pub color: u32,
    #[serde(default)]
    pub face: u8,
    /// partii member id of the owning screen; `"host"` for host-owned (host
    /// keyboard and phone players).
    pub owner: String,
}

/// A local player a guest screen wants to add.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JoinRequest {
    pub name: String,
    pub color: u32,
    #[serde(default)]
    pub face: u8,
}

/// Reliable, owner-validated gameplay events between screens (JSON text on
/// `state`). The host relays guest events after checking ownership.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NetEvent {
    /// Guest → host on connect: protocol version and players to add.
    Hello { version: u32, players: Vec<JoinRequest> },
    /// Host → guest: you are this peer, here's the room so far.
    Welcome { peer_id: String },
    PlayerJoin(PlayerInfo),
    PlayerLeave { slot: u8 },
    /// Host → guests: load this level (bb-level JSON).
    LevelLoad { level: serde_json::Value },
    /// The owner of `id` saw it pop.
    Pop { id: NetId, x: f32, y: f32 },
    Checkpoint { index: u32 },
    Pickup { index: u32, slot: u8 },
    Goal { slot: u8 },
    Ping { t: f64 },
    Pong { t: f64 },
}

pub const PROTOCOL_VERSION: u32 = 1;

impl NetEvent {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn parse(text: &str) -> Result<NetEvent, String> {
        serde_json::from_str(text).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(id: NetId, x: f32, y: f32, vx: f32, vy: f32) -> BodyState {
        BodyState::new(id, Vec2::new(x, y), Vec2::new(vx, vy), 1.0, 1.28, flags::ALIVE)
    }

    #[test]
    fn netid_round_trip() {
        for id in [NetId::Player(0), NetId::Player(7), NetId::Npc(3), NetId::Prop(16383)] {
            assert_eq!(NetId::decode(id.encode()), Some(id));
        }
        assert_eq!(NetId::decode(3 << 14), None);
    }

    #[test]
    fn body_state_round_trip_and_precision() {
        let s = BodyState::new(NetId::Player(3), Vec2::new(-12345.678, 987.25), Vec2::new(-560.3, 930.0), -0.75, 1.28, 0xA5);
        let bytes = encode_states(42, &[s]);
        assert_eq!(bytes.len(), HEADER_BYTES + RECORD_BYTES);
        let (seq, out) = decode_states(&bytes).unwrap();
        assert_eq!(seq, 42);
        assert_eq!(out, vec![s]);
        let d = out[0];
        assert!((d.position() - Vec2::new(-12345.678, 987.25)).length() <= 1.0 / 16.0);
        assert!((d.velocity() - Vec2::new(-560.3, 930.0)).length() <= 1.0 / 8.0);
        let a = (d.angle_rad() - (-0.75f32).rem_euclid(std::f32::consts::TAU)).abs();
        assert!(a < 1e-3, "angle error {a}");
        assert!((d.rest_scale() - 1.28).abs() < 0.006);
        assert_eq!(d.flags, 0xA5);
    }

    #[test]
    fn extremes_clamp_instead_of_wrapping() {
        let s = BodyState::new(NetId::Prop(1), Vec2::new(1e9, -1e9), Vec2::new(1e6, f32::NAN), f32::INFINITY, 99.0, 0);
        let (_, out) = decode_states(&encode_states(0, &[s])).unwrap();
        assert!(out[0].position().x > 500_000.0 && out[0].position().y < -500_000.0);
        assert!(out[0].velocity().x > 4000.0 && out[0].velocity().y == 0.0);
        assert_eq!(out[0].scale, 255);
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_states(&[]).is_none());
        assert!(decode_states(&[0x10, 0, 0]).is_none());
        assert!(decode_states(&[0x11, 0, 0, 0]).is_none());
        // Claims 2 records, carries 1.
        let mut b = encode_states(1, &[st(NetId::Player(0), 0.0, 0.0, 0.0, 0.0)]);
        b[3] = 2;
        assert!(decode_states(&b).is_none());
    }

    #[test]
    fn stick_flags_round_trip() {
        let f = input_flags(Vec2::new(-1.0, 1.0), true);
        let s = BodyState::new(NetId::Player(1), Vec2::ZERO, Vec2::ZERO, 0.0, 1.0, f | flags::ALIVE);
        assert_eq!(s.stick(), Vec2::new(-1.0, 1.0));
        assert!(s.button() && s.alive());
    }

    #[test]
    fn eight_players_at_30hz_fit_the_budget() {
        // Everyone moving, every tick: worst case for one receiving peer.
        let mut tx = StateSender::default();
        let mut total = 0;
        for tick in 0..30 {
            let bodies: Vec<_> = (0..8)
                .map(|i| (st(NetId::Player(i), tick as f32 * 10.0 + i as f32 * 80.0, 40.0, 300.0, 0.0), 4.0))
                .collect();
            let p = tx.build(&bodies).expect("moving bodies always send");
            assert!(p.len() <= MTU);
            total += p.len();
        }
        assert!(total < 10_000, "8 players at 30 Hz = {total} B/s");
        println!("8 players @30Hz: {total} B/s");
    }

    #[test]
    fn mtu_budget_and_priority_rotation() {
        let mut tx = StateSender::default();
        let cap = (MTU - HEADER_BYTES) / RECORD_BYTES;
        // 200 slow props + 2 fast players: players every packet, props rotate.
        let mut seen = std::collections::HashSet::new();
        for tick in 0..20 {
            let mut bodies: Vec<_> = (0..200u16)
                .map(|i| (st(NetId::Prop(i), i as f32 * 50.0, 10.0 + tick as f32, 0.0, 30.0), 1.0))
                .collect();
            bodies.push((st(NetId::Player(0), tick as f32 * 20.0, 0.0, 600.0, 0.0), 4.0));
            bodies.push((st(NetId::Player(1), tick as f32 * -20.0, 0.0, -600.0, 0.0), 4.0));
            let p = tx.build(&bodies).unwrap();
            assert!(p.len() <= MTU, "{} > MTU", p.len());
            let (_, states) = decode_states(&p).unwrap();
            assert_eq!(states.len(), cap);
            if tick > 0 {
                assert!(states.iter().any(|s| s.id == NetId::Player(0)), "tick {tick} missed player 0");
                assert!(states.iter().any(|s| s.id == NetId::Player(1)));
            }
            seen.extend(states.iter().map(|s| s.id));
        }
        assert_eq!(seen.len(), 202, "every prop got a turn");
    }

    #[test]
    fn sleeping_bodies_go_quiet() {
        let mut tx = StateSender::default();
        let still = [(st(NetId::Prop(0), 5.0, 5.0, 0.0, 0.0), 1.0)];
        let mut sent = 0;
        for _ in 0..30 {
            if tx.build(&still).is_some() {
                sent += 1;
            }
        }
        assert_eq!(sent, 1 + REST_REPEATS as usize);
        // Waking up sends again immediately.
        assert!(tx.build(&[(st(NetId::Prop(0), 9.0, 5.0, 120.0, 0.0), 1.0)]).is_some());
    }

    #[test]
    fn receiver_drops_stale_packets() {
        let mut rx = StateReceiver::default();
        let a = encode_states(10, &[st(NetId::Player(0), 1.0, 0.0, 0.0, 0.0)]);
        let b = encode_states(9, &[st(NetId::Player(0), 2.0, 0.0, 0.0, 0.0)]);
        assert_eq!(rx.receive(&a, 0.0).len(), 1);
        assert!(rx.receive(&b, 0.1).is_empty());
        assert_eq!(rx.get(NetId::Player(0)).unwrap().0.position().x, 1.0);
        assert!(seq_newer(0, 65535));
        assert!(!seq_newer(65535, 0));
    }

    #[test]
    fn events_round_trip_as_json() {
        let evs = [
            NetEvent::Hello { version: PROTOCOL_VERSION, players: vec![JoinRequest { name: "Pip".into(), color: 0xff5d73, face: 2 }] },
            NetEvent::PlayerJoin(PlayerInfo { slot: 2, name: "Ann".into(), color: 0x6ecf6e, face: 7, owner: "host".into() }),
            NetEvent::PlayerLeave { slot: 2 },
            NetEvent::LevelLoad { level: serde_json::json!({"id": "sandbox"}) },
            NetEvent::Pop { id: NetId::Player(1), x: 1.5, y: -2.0 },
            NetEvent::Checkpoint { index: 3 },
            NetEvent::Pickup { index: 4, slot: 1 },
            NetEvent::Goal { slot: 0 },
            NetEvent::Ping { t: 12.5 },
        ];
        for e in evs {
            let t = e.to_text();
            assert!(t.starts_with('{'), "JSON must demux on '{{'");
            assert_eq!(NetEvent::parse(&t).unwrap(), e);
        }
        assert!(NetEvent::parse(r#"{"type":"nope"}"#).is_err());
    }
}
