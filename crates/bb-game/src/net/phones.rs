//! Phone controllers (host only): the controller page
//! (`https://bouncy-blobs.partii.games/c/<CODE>`) joins the room as a
//! `phone` member, sends `player_join` / `customization_update` JSON and
//! streams partii's `0x50` input frames. While seating, each phone gets a
//! slot in 1..7 and a host-owned blob; the phone is told its seat (`seat`),
//! its button (`layout`) and feels its pops (`rumble`).

use bb_net::phone::{self, PHONE_COLORS, PhoneJoin, PhoneMsg, color_hex, face_id, face_index, parse_hex};
use bb_net::play;
use bb_sim::{SimEvent, Who};
use bb_sim::{Input, Vec2 as PVec2};
use bevy::prelude::*;

use super::{NetSession, RosterEntry};
use crate::input::{LocalDevices, RemoteSlots};
use crate::sim::{Game, Inputs, SimMsg};

/// The phone's one button, as its label says (partii `layout`).
pub const BUTTONS: [&str; 1] = ["EXPAND"];
/// How long a pop buzzes the phone.
const POP_RUMBLE_MS: u32 = 160;

/// Names longer than the phone's own input limit are cut.
const MAX_NAME: usize = 20;

fn slot_of_phone(s: &NetSession, peer: &str) -> Option<u8> {
    s.roster.iter().find(|(_, e)| e.phone.as_deref() == Some(peer)).map(|(slot, _)| *slot)
}

/// (slot, colour, face) of everyone playing: roster plus the host's own
/// local players.
fn everyone(s: &NetSession, game: Option<&Game>) -> Vec<(u8, u32, u8)> {
    let mut v: Vec<(u8, u32, u8)> = s.roster.iter().map(|(slot, e)| (*slot, e.color, e.face)).collect();
    if let Some(g) = game {
        for p in &g.sim.players {
            if !s.roster.contains_key(&p.slot) {
                v.push((p.slot, p.color, p.face));
            }
        }
    }
    v
}

pub(crate) fn on_text(s: &mut NetSession, peer: &str, text: &str, game: Option<&mut Game>, devices: &LocalDevices, _now: f64) {
    let msg = match phone::parse(text) {
        Ok(m) => m,
        Err(e) => {
            debug!("net: bad phone message from {peer}: {e}");
            return;
        }
    };
    match msg {
        PhoneMsg::Join(j) => {
            if slot_of_phone(s, peer).is_some() || s.waiting.contains_key(peer) {
                return; // duplicate join (re-sent after a blip, or hello + player_join)
            }
            if !s.seating || !seat(s, peer, &j, game.as_deref(), devices) {
                s.waiting.insert(peer.into(), j);
            }
            send_taken(s, game.as_deref());
        }
        PhoneMsg::Customize(c) => {
            if let Some(w) = s.waiting.get_mut(peer) {
                if let Some(col) = c.color {
                    w.color = col;
                }
                if let Some(f) = c.face_id {
                    w.face_id = f;
                }
                return;
            }
            let Some(slot) = slot_of_phone(s, peer) else { return };
            let others: Vec<(u8, u32, u8)> = everyone(s, game.as_deref()).into_iter().filter(|t| t.0 != slot).collect();
            let Some(e) = s.roster.get_mut(&slot) else { return };
            if let Some(col) = c.color.as_deref().and_then(parse_hex) {
                if !others.iter().any(|t| t.1 == col) {
                    e.color = col;
                }
            }
            if let Some(face) = c.face_id.as_deref().and_then(face_index) {
                if !others.iter().any(|t| t.2 == face) {
                    e.face = face;
                }
            }
            send_taken(s, game.as_deref());
        }
        PhoneMsg::Input(entries, ts) => {
            if let Some(p) = s.peers.get_mut(peer) {
                p.phone.apply(&entries, ts, bb_net::rt::now_ms());
            }
        }
        PhoneMsg::Other => {}
    }
}

/// Give a phone a slot and a blob. `false` when every slot is taken.
fn seat(s: &mut NetSession, peer: &str, j: &PhoneJoin, game: Option<&Game>, devices: &LocalDevices) -> bool {
    let Some(slot) = s.free_slot(game, devices) else {
        warn!("net: no free slot for phone {peer}");
        return false;
    };
    let taken = everyone(s, game);
    let color = parse_hex(&j.color)
        .filter(|c| !taken.iter().any(|t| t.1 == *c))
        .or_else(|| PHONE_COLORS.iter().filter_map(|h| parse_hex(h)).find(|c| !taken.iter().any(|t| t.1 == *c)))
        .unwrap_or(bb_sim::PALETTE[slot as usize % bb_sim::PALETTE.len()]);
    let face = face_index(&j.face_id).unwrap_or(0);
    let name: String = j.name.trim().chars().take(MAX_NAME).collect();
    let name = if name.is_empty() { format!("Player {}", slot + 1) } else { name };
    info!("net: phone {name} joined as slot {slot}");
    s.roster.insert(slot, RosterEntry { name, color, face, owner: "host".into(), phone: Some(peer.into()) });
    true
}

/// Seat the phones that joined while we weren't hosting.
pub(crate) fn seat_waiting(session: Option<ResMut<NetSession>>, game: Option<Res<Game>>, devices: Res<LocalDevices>) {
    let Some(mut session) = session else { return };
    if !session.seating || session.waiting.is_empty() {
        return;
    }
    let s = &mut *session;
    let mut seated = false;
    for (peer, j) in std::mem::take(&mut s.waiting) {
        if !s.peers.contains_key(&peer) {
            continue;
        }
        if seat(s, &peer, &j, game.as_deref(), &devices) {
            seated = true;
        } else {
            s.waiting.insert(peer, j);
        }
    }
    if seated {
        send_taken(s, game.as_deref());
    }
}

/// Stop hosting: every phone gives up its slot and blob but stays
/// connected, keeping its name and picks for next time.
pub(crate) fn unseat_all(s: &mut NetSession, game: Option<&mut Game>, remote: &mut RemoteSlots, inputs: &mut Inputs) {
    let mut game = game;
    let phones: Vec<(u8, String)> = s.roster.iter().filter_map(|(slot, e)| Some((*slot, e.phone.clone()?))).collect();
    for (slot, peer) in phones {
        let Some(e) = s.roster.remove(&slot) else { continue };
        s.waiting.insert(peer.clone(), PhoneJoin { player_id: peer.clone(), name: e.name, color: color_hex(e.color), face_id: face_id(e.face).into() });
        if let Some(p) = s.peers.get_mut(&peer) {
            p.told.clear();
        }
        remote.0[slot as usize] = false;
        inputs.slots[slot as usize] = Input::default();
        inputs.active[slot as usize] = false;
        if let Some(g) = game.as_deref_mut() {
            g.sim.remove_player(slot);
        }
    }
}

/// A phone's link opened: what's taken, and its button's label.
pub(crate) fn greet(s: &NetSession, peer: &str, game: Option<&Game>) {
    if let Some(p) = s.peers.get(peer) {
        p.send_text(play::layout_msg(&BUTTONS));
    }
    send_taken(s, game);
}

/// `seat` to every seated phone whose label or colour changed.
pub(crate) fn tell_seats(session: Option<ResMut<NetSession>>) {
    let Some(mut session) = session else { return };
    if !session.is_host() {
        return;
    }
    let s = &mut *session;
    for (slot, e) in &s.roster {
        let Some(p) = e.phone.as_deref().and_then(|id| s.peers.get_mut(id)) else { continue };
        if !p.open {
            continue;
        }
        let msg = play::seat_msg(&format!("P{}", slot + 1), e.color);
        if p.told != msg && p.send_text(msg.clone()) {
            p.told = msg;
        }
    }
}

/// A phone player popped: buzz that phone.
pub(crate) fn rumble(session: Option<Res<NetSession>>, mut events: MessageReader<SimMsg>) {
    let Some(s) = session.filter(|s| s.is_host()) else {
        events.clear();
        return;
    };
    for SimMsg(e) in events.read() {
        let SimEvent::Popped { who: Who::Player(slot), .. } = e else { continue };
        if let Some(p) = s.roster.get(slot).and_then(|e| e.phone.as_deref()).and_then(|id| s.peers.get(id)) {
            p.send_text(play::rumble_msg(POP_RUMBLE_MS));
        }
    }
}

/// Personalised `customization_update` to every phone: what *other*
/// players hold, so its picker greys those out.
pub(crate) fn send_taken(s: &NetSession, game: Option<&Game>) {
    let all = everyone(s, game);
    for (id, p) in s.peers.iter().filter(|(_, p)| p.open && p.kind == bb_net::PeerKind::Phone) {
        let mine = slot_of_phone(s, id);
        let mut colors: Vec<String> = Vec::new();
        let mut faces: Vec<String> = Vec::new();
        for (slot, color, face) in &all {
            if Some(*slot) == mine {
                continue;
            }
            let c = color_hex(*color);
            if !colors.contains(&c) {
                colors.push(c);
            }
            let f = face_id(*face).to_string();
            if !faces.contains(&f) {
                faces.push(f);
            }
        }
        p.send_text(phone::taken_message(&colors, &faces));
    }
}

/// A peer's link or room row is gone: free its slots and blobs.
pub(crate) fn drop_peer(s: &mut NetSession, id: &str, game: Option<&mut Game>, remote: &mut RemoteSlots, inputs: &mut Inputs) {
    s.peers.remove(id);
    s.waiting.remove(id);
    let gone: Vec<u8> = s
        .roster
        .iter()
        .filter(|(_, e)| e.owner == id || e.phone.as_deref() == Some(id))
        .map(|(slot, _)| *slot)
        .collect();
    let mut game = game;
    for slot in &gone {
        s.roster.remove(slot);
        remote.0[*slot as usize] = false;
        inputs.slots[*slot as usize] = Input::default();
        inputs.active[*slot as usize] = false;
        if let Some(g) = game.as_deref_mut() {
            g.sim.remove_player(*slot);
        }
        info!("net: slot {slot} left");
    }
    if !gone.is_empty() {
        send_taken(s, game.as_deref());
    }
}

/// Phones → `Inputs`. Their slots are marked remote so local gathering
/// doesn't clear them; the last value sticks until a newer one arrives (a
/// framed phone silent for 3 s lets go).
pub(crate) fn apply_inputs(session: Option<ResMut<NetSession>>, mut inputs: ResMut<Inputs>, mut remote: ResMut<RemoteSlots>) {
    let Some(mut session) = session else { return };
    let now = bb_net::rt::now_ms();
    for p in session.peers.values_mut().filter(|p| p.kind == bb_net::PeerKind::Phone) {
        p.phone.refresh(now);
    }
    let s = &*session;
    for (slot, e) in &s.roster {
        let Some(peer) = e.phone.as_deref().and_then(|id| s.peers.get(id)) else { continue };
        let i = *slot as usize;
        remote.0[i] = true;
        inputs.slots[i] = Input { stick: PVec2::new(peer.phone.stick.x, peer.phone.stick.y), button: peer.phone.button };
        inputs.active[i] = peer.phone.stick != PVec2::ZERO || peer.phone.button;
    }
}
