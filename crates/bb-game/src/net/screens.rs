//! Screen-to-screen play: owner-authoritative body sync with blending.
//!
//! The host owns its local players, phone players, NPCs and props; each
//! guest owns its own players. Owners stream body states at 30 Hz on the
//! unreliable channel (the host relays guest players to the other guests),
//! and everyone blends what they don't own. Discrete events ride the
//! reliable channel as JSON and are owner-validated by the host.

use bb_net::blend::{BlendParams, blend_body};
use bb_net::wire::{BodyState, NetEvent, NetId, PROTOCOL_VERSION, PlayerInfo, input_flags};
use bb_net::{Channel, Payload, PeerKind, Transport};
use bb_sim::{Input, SimEvent, Who};
use bevy::prelude::*;

use super::{NetRole, NetSession, RosterEntry};
use crate::input::LocalDevices;
use crate::sim::{Game, LoadLevel, SimMsg};

/// States older than this are ignored: the owner went quiet (asleep, or a
/// stall) and the local sim is a better guess than a stale extrapolation.
const STALE_S: f64 = 1.0;
/// Importance weights for the priority accumulator.
const W_PLAYER: f32 = 4.0;
const W_NPC: f32 = 2.0;
const W_PROP: f32 = 1.0;

fn broadcast(s: &NetSession, ev: &NetEvent, except: Option<&str>) {
    let text = ev.to_text();
    for (id, p) in s.screens() {
        if Some(id.as_str()) != except {
            p.send_text(text.clone());
        }
    }
}

pub(crate) fn send_hello(s: &NetSession) {
    let Some(join) = &s.join else { return };
    if let Some(p) = s.peers.get("host") {
        p.send_text(NetEvent::Hello { version: PROTOCOL_VERSION, players: vec![join.clone()] }.to_text());
    }
}

/// Everyone the host tells screens about: net roster + its own local players.
fn roster_infos(s: &NetSession, game: Option<&Game>) -> Vec<PlayerInfo> {
    let mut v: Vec<PlayerInfo> = s
        .roster
        .iter()
        .map(|(slot, e)| PlayerInfo { slot: *slot, name: e.name.clone(), color: e.color, face: e.face, owner: e.owner.clone() })
        .collect();
    if let Some(g) = game {
        for p in &g.sim.players {
            if !s.roster.contains_key(&p.slot) {
                v.push(PlayerInfo { slot: p.slot, name: p.name.clone(), color: p.color, face: p.face, owner: "host".into() });
            }
        }
    }
    v.sort_by_key(|p| p.slot);
    v
}

fn level_event(game: &Game) -> Option<NetEvent> {
    serde_json::to_value(&game.sim.level).ok().map(|level| NetEvent::LevelLoad { level })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn on_text(
    s: &mut NetSession,
    peer: &str,
    text: &str,
    mut game: Option<&mut Game>,
    devices: &mut LocalDevices,
    load: &mut MessageWriter<LoadLevel>,
    fx: &mut MessageWriter<SimMsg>,
    now: f64,
) {
    let ev = match NetEvent::parse(text) {
        Ok(ev) => ev,
        Err(e) => {
            debug!("net: bad event from {peer}: {e}");
            return;
        }
    };
    match (&s.role, ev) {
        (_, NetEvent::Ping { t }) => {
            if let Some(p) = s.peers.get(peer) {
                p.send_text(NetEvent::Pong { t }.to_text());
            }
        }
        (_, NetEvent::Pong { t }) => {
            if let Some(p) = s.peers.get_mut(peer) {
                let rtt = (now - t).clamp(0.0, 2.0) as f32;
                p.rtt += (rtt - p.rtt) * 0.2;
            }
        }

        // ── Host ──
        (NetRole::Host, NetEvent::Hello { version, players }) => {
            if version != PROTOCOL_VERSION {
                warn!("net: screen {peer} speaks protocol {version}, we speak {PROTOCOL_VERSION}");
            }
            if s.roster.values().any(|e| e.owner == peer) {
                return; // already welcomed
            }
            for req in players.into_iter().take(4) {
                let Some(slot) = s.free_slot(game.as_deref(), devices) else { break };
                let name: String = req.name.trim().chars().take(20).collect();
                s.roster.insert(
                    slot,
                    RosterEntry { name, color: req.color & 0xFF_FFFF, face: req.face.min(15), owner: peer.into(), phone: None },
                );
            }
            let Some(p) = s.peers.get(peer) else { return };
            p.send_text(NetEvent::Welcome { peer_id: peer.into() }.to_text());
            if let Some(ev) = game.as_deref().and_then(level_event) {
                p.send_text(ev.to_text());
            }
            for info in roster_infos(s, game.as_deref()) {
                p.send_text(NetEvent::PlayerJoin(info).to_text());
            }
        }
        (NetRole::Host, NetEvent::Pop { id: NetId::Player(slot), x, y }) => {
            // Owner-validated: a screen may only pop its own players.
            let Some(e) = s.roster.get(&slot) else { return };
            if e.owner != peer {
                return;
            }
            fx.write(SimMsg(SimEvent::Popped { who: Who::Player(slot), pos: bb_sim::Vec2::new(x, y), color: e.color }));
            broadcast(s, &NetEvent::Pop { id: NetId::Player(slot), x, y }, Some(peer));
        }

        // ── Guest ──
        (NetRole::Guest, NetEvent::Welcome { peer_id }) => {
            if s.self_id.is_empty() {
                s.self_id = peer_id;
            }
        }
        (NetRole::Guest, NetEvent::PlayerJoin(info)) => {
            if info.owner == s.self_id && !s.roster.values().any(|e| e.owner == s.self_id) {
                // Our keyboard/touch now drive the slot the host gave us.
                devices.keyboard_slot = Some(info.slot);
                devices.touch_slot = Some(info.slot);
            }
            s.roster.insert(
                info.slot,
                RosterEntry { name: info.name, color: info.color, face: info.face, owner: info.owner, phone: None },
            );
        }
        (NetRole::Guest, NetEvent::PlayerLeave { slot }) => {
            s.roster.remove(&slot);
        }
        (NetRole::Guest, NetEvent::LevelLoad { level }) => match serde_json::from_value::<bb_level::Level>(level) {
            Ok(level) => {
                load.write(LoadLevel { level, players: Vec::new() });
                s.level_from_host = true;
                for p in s.peers.values_mut() {
                    p.rx = Default::default();
                }
            }
            Err(e) => warn!("net: host sent a level we can't read: {e}"),
        },
        (NetRole::Guest, NetEvent::Pop { id: NetId::Player(slot), x, y }) => {
            let color = s.roster.get(&slot).map_or(0xffffff, |e| e.color);
            fx.write(SimMsg(SimEvent::Popped { who: Who::Player(slot), pos: bb_sim::Vec2::new(x, y), color }));
        }
        (NetRole::Guest, NetEvent::Checkpoint { index }) => {
            if let Some(g) = game.as_deref_mut() {
                g.sim.checkpoint = g.sim.checkpoint.max(index as usize);
            }
        }
        (NetRole::Guest, NetEvent::Pickup { index, slot: _ }) => {
            if let Some(c) = game.as_deref_mut().and_then(|g| g.sim.collected.get_mut(index as usize)) {
                *c = true;
            }
        }
        (NetRole::Guest, NetEvent::Goal { slot }) => {
            if let Some(p) = game.as_deref_mut().and_then(|g| g.sim.player_mut(slot)) {
                p.finished = true;
            }
        }
        _ => {}
    }
}

/// Host: tell screens about roster changes and new levels.
pub(crate) fn announce_roster(session: Option<ResMut<NetSession>>, game: Option<Res<Game>>) {
    let Some(mut s) = session else { return };
    if !s.is_host() {
        return;
    }
    if let Some(g) = game.as_deref().filter(|_| game.as_ref().is_some_and(|g| g.is_added())) {
        if let Some(ev) = level_event(g) {
            broadcast(&s, &ev, None);
        }
    }
    let infos = roster_infos(&s, game.as_deref());
    if infos == s.announced {
        return;
    }
    for info in &infos {
        if !s.announced.contains(info) {
            broadcast(&s, &NetEvent::PlayerJoin(info.clone()), None);
        }
    }
    for old in &s.announced {
        if !infos.iter().any(|i| i.slot == old.slot) {
            broadcast(&s, &NetEvent::PlayerLeave { slot: old.slot }, None);
        }
    }
    s.announced = infos;
}

/// Latest fresh state for a body, from whoever owns it.
fn state_for(s: &NetSession, id: NetId, now: f64) -> Option<(BodyState, f64)> {
    let owner = match (s.role.clone(), id) {
        (NetRole::Guest, _) => "host",
        (NetRole::Host, NetId::Player(slot)) => s.roster.get(&slot)?.owner.as_str(),
        (NetRole::Host, _) => return None, // the host owns everything else
    };
    let p = s.peers.get(owner)?;
    let (st, at) = p.rx.get(id)?;
    if now - at > STALE_S {
        // Owners stop sending bodies that fall asleep; their last state IS
        // the final resting pose, so keep converging to it (eventual
        // consistency). A moving body that went quiet is a stall: let the
        // local sim guess instead of extrapolating stale motion.
        let at_rest = st.vel[0].abs() <= 4 && st.vel[1].abs() <= 4;
        return at_rest.then_some((st, now));
    }
    // Back-date arrival by half the round trip: when the owner sent it.
    Some((st, at - p.rtt as f64 * 0.5))
}

/// Remote-owned players run on the owner's buttons so the local sim
/// animates them (expand, jump, roll) between corrections.
pub(crate) fn drive_remote_players(session: Res<NetSession>, mut game: ResMut<Game>, time: Res<Time<Real>>) {
    let now = time.elapsed_secs_f64();
    let remote: Vec<u8> = game.sim.players.iter().filter(|p| !p.local).map(|p| p.slot).collect();
    for slot in remote {
        let input = state_for(&session, NetId::Player(slot), now)
            .map(|(st, _)| Input { stick: st.stick(), button: st.button() })
            .unwrap_or_default();
        game.sim.set_input(slot, input);
    }
}

pub(crate) fn blend_remote(session: Res<NetSession>, mut game: ResMut<Game>, time: Res<Time<Real>>) {
    let now = time.elapsed_secs_f64();
    let params = BlendParams::default();
    let sim = &mut game.sim;
    let mut targets: Vec<(bb_sim::BodyId, NetId)> =
        sim.players.iter().filter(|p| !p.local).map(|p| (p.ctl.body, NetId::Player(p.slot))).collect();
    if !session.is_host() {
        targets.extend(sim.npcs.iter().enumerate().map(|(i, n)| (n.ctl.body, NetId::Npc(i as u16))));
        targets.extend(sim.props.iter().enumerate().map(|(i, b)| (*b, NetId::Prop(i as u16))));
    }
    for (body, id) in targets {
        let Some((st, sent_at)) = state_for(&session, id, now) else { continue };
        if let Some(b) = sim.world.body_mut(body) {
            blend_body(b, &st, (now - sent_at) as f32, bb_sim::DT, &params);
        }
    }
}

/// 30 Hz body-state stream to every screen.
pub(crate) fn send_states(mut session: ResMut<NetSession>, game: Res<Game>, time: Res<Time<Real>>) {
    session.fixed_tick += 1;
    if session.fixed_tick % 2 != 0 {
        return;
    }
    let now = time.elapsed_secs_f64();
    let s = &mut *session;
    let sim = &game.sim;
    let mut own: Vec<(BodyState, f32)> = Vec::new();
    for p in sim.players.iter().filter(|p| p.local) {
        if let Some(b) = sim.world.body(p.ctl.body) {
            own.push((BodyState::of_body(NetId::Player(p.slot), b, input_flags(p.ctl.input.stick, p.ctl.input.button)), W_PLAYER));
        }
    }
    if s.is_host() {
        for (i, n) in sim.npcs.iter().enumerate() {
            if let Some(b) = sim.world.body(n.ctl.body) {
                own.push((BodyState::of_body(NetId::Npc(i as u16), b, 0), W_NPC));
            }
        }
        for (i, id) in sim.props.iter().enumerate() {
            if let Some(b) = sim.world.body(*id) {
                own.push((BodyState::of_body(NetId::Prop(i as u16), b, 0), W_PROP));
            }
        }
        // Relay each guest's players to the other guests, straight from
        // the owner's latest state.
        let relayed: Vec<(String, BodyState)> = s
            .roster
            .iter()
            .filter(|(_, e)| e.owner != "host")
            .filter_map(|(slot, e)| {
                let (st, at) = s.peers.get(&e.owner)?.rx.get(NetId::Player(*slot))?;
                (now - at <= STALE_S).then(|| (e.owner.clone(), st))
            })
            .collect();
        for (id, p) in s.peers.iter_mut().filter(|(_, p)| p.open && p.kind == PeerKind::Screen) {
            let mut list = own.clone();
            list.extend(relayed.iter().filter(|(owner, _)| owner != id).map(|(_, st)| (*st, W_PLAYER)));
            if let Some(pkt) = p.tx.build(&list) {
                p.link.send(Channel::Unreliable, Payload::Binary(pkt));
            }
        }
    } else if let Some(p) = s.peers.get_mut("host").filter(|p| p.open) {
        if let Some(pkt) = p.tx.build(&own) {
            p.link.send(Channel::Unreliable, Payload::Binary(pkt));
        }
    }
}

/// Owner-side gameplay events → screens.
pub(crate) fn forward_sim_events(session: Option<Res<NetSession>>, game: Option<Res<Game>>, mut events: MessageReader<SimMsg>) {
    let (Some(s), Some(game)) = (session, game) else {
        events.clear();
        return;
    };
    for SimMsg(e) in events.read() {
        let owned = |slot: u8| game.sim.player(slot).is_some_and(|p| p.local);
        let ev = match (s.is_host(), e) {
            (true, SimEvent::Checkpoint { index, .. }) => NetEvent::Checkpoint { index: *index as u32 },
            (true, SimEvent::Pickup { index, slot, .. }) => NetEvent::Pickup { index: *index as u32, slot: *slot },
            (true, SimEvent::Goal { slot }) => NetEvent::Goal { slot: *slot },
            (_, SimEvent::Popped { who: Who::Player(slot), pos, .. }) if owned(*slot) => {
                NetEvent::Pop { id: NetId::Player(*slot), x: pos.x, y: pos.y }
            }
            _ => continue,
        };
        broadcast(&s, &ev, None);
    }
}

/// 1 Hz ping to every screen for the latency estimate used in blending.
pub(crate) fn ping(session: Option<ResMut<NetSession>>, time: Res<Time<Real>>) {
    let Some(mut s) = session else { return };
    let now = time.elapsed_secs_f64();
    if now - s.last_ping < 1.0 {
        return;
    }
    s.last_ping = now;
    broadcast(&s, &NetEvent::Ping { t: now }, None);
}
