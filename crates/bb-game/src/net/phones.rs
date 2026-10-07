//! Phone controllers (host only): the deployed web controller page joins the
//! room as a `phone` peer and speaks `player_join` / `customization_update` /
//! `player_input_batch`. Each phone gets a slot in 1..7 and a host-owned blob.

use bb_net::phone::{self, PHONE_COLORS, PhoneMsg, color_hex, face_id, face_index, parse_hex};
use bb_sim::{Input, Vec2 as PVec2};
use bevy::prelude::*;

use super::{NetSession, RosterEntry};
use crate::input::{LocalDevices, RemoteSlots};
use crate::sim::{Game, Inputs};

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
            if slot_of_phone(s, peer).is_some() {
                return; // duplicate join (re-sent after a blip)
            }
            let game_ref = game.as_deref();
            let Some(slot) = s.free_slot(game_ref, devices) else {
                warn!("net: no free slot for phone {peer}");
                return;
            };
            let taken = everyone(s, game_ref);
            let color = parse_hex(&j.color)
                .filter(|c| !taken.iter().any(|t| t.1 == *c))
                .or_else(|| PHONE_COLORS.iter().filter_map(|h| parse_hex(h)).find(|c| !taken.iter().any(|t| t.1 == *c)))
                .unwrap_or(bb_sim::PALETTE[slot as usize % bb_sim::PALETTE.len()]);
            let face = face_index(&j.face_id).unwrap_or(0);
            let name: String = j.name.trim().chars().take(MAX_NAME).collect();
            let name = if name.is_empty() { format!("Player {}", slot + 1) } else { name };
            info!("net: phone {name} joined as slot {slot}");
            s.roster.insert(slot, RosterEntry { name, color, face, owner: "host".into(), phone: Some(peer.into()) });
            send_taken(s, game.as_deref());
        }
        PhoneMsg::Customize(c) => {
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
/// doesn't clear them; the last value sticks until a newer one arrives.
pub(crate) fn apply_inputs(session: Option<Res<NetSession>>, mut inputs: ResMut<Inputs>, mut remote: ResMut<RemoteSlots>) {
    let Some(s) = session else { return };
    for (slot, e) in &s.roster {
        let Some(peer) = e.phone.as_deref().and_then(|id| s.peers.get(id)) else { continue };
        let i = *slot as usize;
        remote.0[i] = true;
        inputs.slots[i] = Input { stick: PVec2::new(peer.phone.stick.x, peer.phone.stick.y), button: peer.phone.button };
        inputs.active[i] = peer.phone.stick != PVec2::ZERO || peer.phone.button;
    }
}
