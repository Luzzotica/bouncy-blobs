//! Networking in the Bevy app: hosting a partii room for phones and guest
//! screens, or joining one as a guest screen.
//!
//! * Phones send partii's `0x50` input frames plus Bouncy Blobs' join and
//!   customisation JSON, and get slots 1..7 (slot 0 is the local
//!   keyboard/touch player). Their blobs are host-owned: the host simulates
//!   them from phone input like any local player.
//! * The **home room** is made once at launch ([`HomeRoom`]), so phones can
//!   join from the menu and the code stays the same all session. Phones in
//!   it are only *seated* (given a slot and a blob) while hosting
//!   ([`NetSession::seating`]); Host opens it to guest screens, Leave closes
//!   it again and keeps the phones connected.
//! * Guest screens are owner-authoritative peers: each side simulates
//!   everything, streams [`BodyState`]s for what it owns, and blends what it
//!   doesn't ([`bb_net::blend`]). Remote-owned players have
//!   `Player::local = false`, so local input never drives them.
//!
//! All network I/O lives on bb-net's runtime; these systems only drain
//! channels, so nothing here blocks the main thread.
//!
//! Menu code drives it with [`NetCommand`] and shows [`ui::spawn_join_panel`].

pub mod phones;
pub mod screens;
#[cfg(test)]
mod tests;
pub mod ui;

use std::collections::{BTreeMap, HashMap};

use bb_net::phone::PhoneJoin;

use bb_net::session::{GuestEvent, GuestSession, HostEvent, HostSession};
pub use bb_net::session::{HostOptions, RoomInfo};
use bb_net::wire::{JoinRequest, PlayerInfo, StateReceiver, StateSender};
use bb_net::{LinkEvent, NetConfig, Payload, PeerKind, PeerLink, Transport};
use bevy::prelude::*;

use crate::input::{GatherInput, LocalDevices, RemoteSlots};
use crate::sim::{Game, Inputs, LoadLevel, SimMsg};

/// Highest slot a networked player may take (8 players: 0..=7).
pub const MAX_SLOT: u8 = 7;

/// What the menu asks the net layer to do.
#[derive(Message, Clone, Debug)]
pub enum NetCommand {
    /// Create a room and accept phones + guest screens.
    Host(HostOptions),
    /// Join a room (id or join code) as a guest screen with one local player.
    Join { room: String, name: String, color: u32 },
    /// Lock or reopen the room (e.g. while a round is playing).
    SetJoinable(bool),
    Leave,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetRole {
    Host,
    Guest,
}

#[derive(Clone, Debug, PartialEq)]
pub enum NetStatus {
    Connecting,
    Ready,
    Error(String),
    Ended,
}

/// A player the net layer manages (phones, guest-screen players, and on a
/// guest every player).
#[derive(Clone, Debug, PartialEq)]
pub struct RosterEntry {
    pub name: String,
    pub color: u32,
    pub face: u8,
    /// Who simulates the blob: `"host"` or a guest screen's peer id.
    pub owner: String,
    /// The phone driving it (host only).
    pub phone: Option<String>,
}

pub(crate) struct Peer {
    pub link: PeerLink,
    pub kind: PeerKind,
    pub name: Option<String>,
    pub open: bool,
    pub phone: bb_net::phone::PhoneInput,
    /// Body states from this peer (screens).
    pub rx: StateReceiver,
    /// Body states to this peer (screens).
    pub tx: StateSender,
    /// Smoothed round trip (s).
    pub rtt: f32,
    /// Phones: the last `seat` message sent.
    pub told: String,
}

impl Peer {
    fn new(link: PeerLink, kind: PeerKind, name: Option<String>) -> Peer {
        Peer {
            link,
            kind,
            name,
            open: false,
            phone: Default::default(),
            rx: StateReceiver::default(),
            tx: StateSender::default(),
            rtt: 0.1,
            told: String::new(),
        }
    }

    pub fn send_text(&self, text: String) -> bool {
        self.link.send(bb_net::Channel::Reliable, Payload::Text(text))
    }
}

/// The live room. Present only while hosting or joined.
#[derive(Resource)]
pub struct NetSession {
    pub role: NetRole,
    pub status: NetStatus,
    pub room: Option<RoomInfo>,
    /// `"host"` on the host, our partii member id on a guest.
    pub self_id: String,
    pub roster: BTreeMap<u8, RosterEntry>,
    host: Option<HostSession>,
    guest: Option<GuestSession>,
    /// Guest: the player we asked for.
    join: Option<JoinRequest>,
    pub(crate) peers: HashMap<String, Peer>,
    /// Host: what screens were last told about the roster.
    pub(crate) announced: Vec<PlayerInfo>,
    /// Real time of the last ping (s).
    pub(crate) last_ping: f64,
    pub(crate) fixed_tick: u64,
    /// Guest: the host's level is loaded, so the roster owns the sim.
    pub(crate) level_from_host: bool,
    /// The launch-time home room (kept across menus).
    pub home: bool,
    /// Phones get a slot and a blob (hosting). Off in a home room until Host.
    pub seating: bool,
    /// Phones that joined while not seating (or with no free slot), by peer.
    pub(crate) waiting: BTreeMap<String, PhoneJoin>,
    /// A line for the join panel while connecting (busy network, reclaim).
    pub notice: Option<String>,
}

impl NetSession {
    fn new(role: NetRole, self_id: &str) -> NetSession {
        NetSession {
            role,
            status: NetStatus::Connecting,
            room: None,
            self_id: self_id.into(),
            roster: BTreeMap::new(),
            host: None,
            guest: None,
            join: None,
            peers: HashMap::new(),
            announced: Vec::new(),
            last_ping: 0.0,
            fixed_tick: 0,
            level_from_host: false,
            home: false,
            seating: true,
            waiting: BTreeMap::new(),
            notice: None,
        }
    }

    /// A live home room we can host in.
    pub fn home_alive(&self) -> bool {
        self.home && !matches!(self.status, NetStatus::Error(_) | NetStatus::Ended)
    }

    /// Phones in the room (seated or not).
    pub fn phones(&self) -> usize {
        self.peers.values().filter(|p| p.open && p.kind == PeerKind::Phone).count()
    }

    pub fn is_host(&self) -> bool {
        self.role == NetRole::Host
    }

    /// Room members with an open link (phones and screens).
    pub fn connected(&self) -> impl Iterator<Item = (&str, PeerKind, Option<&str>)> {
        self.peers.iter().filter(|(_, p)| p.open).map(|(id, p)| (id.as_str(), p.kind, p.name.as_deref()))
    }

    /// Smallest free slot in 1..=7, skipping local devices and existing players.
    pub(crate) fn free_slot(&self, game: Option<&Game>, devices: &LocalDevices) -> Option<u8> {
        (1..=MAX_SLOT).find(|s| {
            !self.roster.contains_key(s)
                && !devices.pads.iter().any(|p| p.1 == *s)
                && devices.keyboard_slot != Some(*s)
                && devices.touch_slot != Some(*s)
                && game.is_none_or(|g| g.sim.player(*s).is_none())
        })
    }

    pub(crate) fn screens(&self) -> impl Iterator<Item = (&String, &Peer)> {
        self.peers.iter().filter(|(_, p)| p.open && p.kind == PeerKind::Screen)
    }
}

/// Keeps a home room open while nothing else is (see the module docs).
#[derive(Resource, Default)]
pub struct HomeRoom {
    pub enabled: bool,
    /// Real time (s) to (re)make it at.
    pub retry_at: f64,
    /// Why the last one ended (a partii code), for the retry delay.
    pub(crate) last_failure: Option<String>,
    /// We are hosting (Host without a Leave yet): a remade home room seats
    /// its phones and takes screens straight away.
    pub(crate) hosting: bool,
}

/// Home rooms are for real players: never in tests, headless runs, or when
/// `BB_OFFLINE` / `BB_JOIN` say so.
fn home_room_wanted() -> bool {
    if cfg!(test) || crate::platform::headless() {
        return false;
    }
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var("BB_OFFLINE").is_ok_and(|v| v != "0") || std::env::var("BB_JOIN").is_ok() || std::env::var("BB_HOST").is_ok() {
        return false;
    }
    true
}

fn home_options() -> HostOptions {
    HostOptions { home: true, ..HostOptions::default() }
}

pub struct NetPlugin;

impl Plugin for NetPlugin {
    fn build(&self, app: &mut App) {
        let windowed = app.is_plugin_added::<bevy::render::RenderPlugin>();
        app.add_message::<NetCommand>()
            .insert_resource(HomeRoom { enabled: windowed && home_room_wanted(), ..default() })
            .add_systems(
                PreUpdate,
                (keep_home, handle_commands, pump, phones::seat_waiting, phones::apply_inputs, sync_roster, screens::announce_roster, phones::tell_seats)
                    .chain()
                    .after(GatherInput),
            )
            .add_systems(
                FixedPreUpdate,
                screens::drive_remote_players.run_if(resource_exists::<NetSession>.and_then(resource_exists::<Game>)),
            )
            .add_systems(
                FixedPostUpdate,
                (screens::blend_remote, screens::send_states)
                    .chain()
                    .run_if(resource_exists::<NetSession>.and_then(resource_exists::<Game>)),
            )
            .add_systems(Update, (screens::forward_sim_events, phones::rumble, screens::ping, ui::update_join_panels, ui::copy_clicks, ui::menu_join_panel));
        #[cfg(not(target_arch = "wasm32"))]
        if std::env::var("BB_HOST").is_ok() || std::env::var("BB_JOIN").is_ok() {
            app.add_systems(Startup, dev_autostart);
        }
    }
}

/// Dev hooks until the menus exist: `BB_HOST=1` hosts a room and shows the
/// join panel; `BB_JOIN=<code or room id>` joins one as a guest screen.
#[cfg(not(target_arch = "wasm32"))]
fn dev_autostart(mut commands: Commands, mut cmds: MessageWriter<NetCommand>) {
    if let Ok(room) = std::env::var("BB_JOIN") {
        cmds.write(NetCommand::Join { room, name: "Guest".into(), color: bb_sim::PALETTE[4] });
    } else {
        cmds.write(NetCommand::Host(HostOptions::default()));
        ui::spawn_join_panel(&mut commands);
    }
}

/// What [`keep_home`] should do about the home room this frame.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HomeStep {
    Wait,
    Open,
    /// The player can't host (the demo): no room, no phones invited.
    Close,
}

/// The home room's rule: only for a player who may host (the full game).
/// While ownership is still Unknown, wait for the answer rather than open
/// a room and close it again. No `Ownership` resource (bare test apps)
/// means hosting is allowed.
pub(crate) fn home_step(enabled: bool, own: Option<&crate::ownership::Ownership>, home_open: bool, now: f64, retry_at: f64) -> HomeStep {
    use crate::ownership::{Feature, Owned, allowed};
    // Disabled (tests, headless runs, BB_OFFLINE…): hands off entirely.
    if !enabled {
        return HomeStep::Wait;
    }
    let may_host = allowed(own, Feature::Host);
    let unknown = own.is_some_and(|o| o.owned == Owned::Unknown);
    match (home_open, may_host) {
        (true, false) if !unknown => HomeStep::Close,
        (false, true) if now >= retry_at => HomeStep::Open,
        _ => HomeStep::Wait,
    }
}

/// Make the home room when none is open (at launch once ownership says we
/// may host, after leaving a friend's room, a while after partii closed
/// ours), and close it if the player can't host.
fn keep_home(
    mut commands: Commands,
    mut home: ResMut<HomeRoom>,
    session: Option<Res<NetSession>>,
    time: Res<Time<Real>>,
    own: Option<Res<crate::ownership::Ownership>>,
) {
    // Only the home room is ours to manage; a friend's room or a dev
    // BB_HOST room is left alone.
    if session.as_deref().is_some_and(|s| !s.home) {
        return;
    }
    let home_open = session.is_some();
    match home_step(home.enabled, own.as_deref(), home_open, time.elapsed_secs_f64(), home.retry_at) {
        HomeStep::Wait => {}
        HomeStep::Close => {
            info!("net: closing the home room: hosting needs the full game");
            if let Some(h) = session.as_deref().and_then(|s| s.host.as_ref()) {
                h.end();
            }
            commands.remove_resource::<NetSession>();
        }
        HomeStep::Open => {
            home.last_failure = None;
            commands.insert_resource(NetSession {
                host: Some(HostSession::start(NetConfig::from_env(), home_options())),
                home: true,
                seating: home.hosting,
                ..NetSession::new(NetRole::Host, "host")
            });
        }
    }
}

fn handle_commands(
    mut commands: Commands,
    mut cmds: MessageReader<NetCommand>,
    session: Option<ResMut<NetSession>>,
    mut game: Option<ResMut<Game>>,
    mut remote: ResMut<RemoteSlots>,
    mut devices: ResMut<LocalDevices>,
    mut inputs: ResMut<Inputs>,
    mut home: ResMut<HomeRoom>,
    own: Option<Res<crate::ownership::Ownership>>,
) {
    let mut session = session;
    for cmd in cmds.read() {
        match cmd.clone() {
            // Hosting needs the full game (joining never does).
            NetCommand::Host(_) if !crate::ownership::allowed(own.as_deref(), crate::ownership::Feature::Host) => {
                warn!("net: not hosting: hosting needs the full game");
            }
            NetCommand::Host(opts) => {
                home.hosting = true;
                // Host in the home room: same code, phones already in it.
                if let Some(s) = session.as_deref_mut().filter(|s| s.home_alive()) {
                    s.seating = true;
                    if let Some(h) = &s.host {
                        h.open_screens(true);
                    }
                    continue;
                }
                leave(&mut commands, session.as_deref_mut(), game.as_deref_mut(), &mut remote);
                commands.insert_resource(NetSession {
                    host: Some(HostSession::start(NetConfig::from_env(), opts)),
                    ..NetSession::new(NetRole::Host, "host")
                });
            }
            NetCommand::Join { room, name, color } => {
                leave(&mut commands, session.as_deref_mut(), game.as_deref_mut(), &mut remote);
                let join = JoinRequest { name: name.clone(), color, face: 0 };
                commands.insert_resource(NetSession {
                    guest: Some(GuestSession::join(NetConfig::from_env(), room, name, PeerKind::Screen)),
                    join: Some(join),
                    ..NetSession::new(NetRole::Guest, "")
                });
                // Until the host assigns our slot, keep driving slot 0.
                devices.keyboard_slot = Some(0);
                devices.touch_slot = Some(0);
            }
            NetCommand::SetJoinable(j) => {
                if let Some(h) = session.as_ref().and_then(|s| s.host.as_ref()) {
                    h.set_joinable(j);
                }
            }
            NetCommand::Leave => {
                home.hosting = false;
                // Stop hosting but keep the home room and its phones.
                if let Some(s) = session.as_deref_mut().filter(|s| s.home_alive()) {
                    go_home(s, game.as_deref_mut(), &mut remote, &mut inputs);
                    continue;
                }
                leave(&mut commands, session.as_deref_mut(), game.as_deref_mut(), &mut remote);
                session = None;
                devices.keyboard_slot = Some(0);
                devices.touch_slot = Some(0);
            }
        }
    }
}

/// Back to a plain home room: phones unseated (they stay connected and
/// keep their picks), guest screens sent away, screens refused again.
fn go_home(s: &mut NetSession, game: Option<&mut Game>, remote: &mut RemoteSlots, inputs: &mut Inputs) {
    s.seating = false;
    let mut game = game;
    let screens: Vec<String> = s.peers.iter().filter(|(_, p)| p.kind != PeerKind::Phone).map(|(id, _)| id.clone()).collect();
    for id in screens {
        if let Some(p) = s.peers.get(&id) {
            p.link.close();
        }
        phones::drop_peer(s, &id, game.as_deref_mut(), remote, inputs);
    }
    phones::unseat_all(s, game, remote, inputs);
    if let Some(h) = &s.host {
        h.open_screens(false);
        h.set_joinable(true);
    }
}

/// Tear down the current session and its players.
fn leave(commands: &mut Commands, session: Option<&mut NetSession>, game: Option<&mut Game>, remote: &mut RemoteSlots) {
    let Some(s) = session else { return };
    if let Some(g) = game {
        for slot in s.roster.keys() {
            g.sim.remove_player(*slot);
        }
        for p in g.sim.players.iter_mut() {
            p.local = true;
        }
    }
    for slot in s.roster.keys() {
        remote.0[*slot as usize] = false;
    }
    if let Some(h) = &s.host {
        h.end();
    }
    if let Some(g) = &s.guest {
        g.leave();
    }
    commands.remove_resource::<NetSession>();
}

/// Drain the session and every link, then dispatch.
#[allow(clippy::too_many_arguments)]
fn pump(
    session: Option<ResMut<NetSession>>,
    mut game: Option<ResMut<Game>>,
    mut devices: ResMut<LocalDevices>,
    mut remote: ResMut<RemoteSlots>,
    mut inputs: ResMut<Inputs>,
    mut load: MessageWriter<LoadLevel>,
    mut fx: MessageWriter<SimMsg>,
    time: Res<Time<Real>>,
    (mut commands, mut home): (Commands, ResMut<HomeRoom>),
) {
    let Some(mut session) = session else { return };
    let s = &mut *session;
    let now = time.elapsed_secs_f64();

    // Session lifecycle.
    let host_events: Vec<HostEvent> = s.host.as_ref().map(|h| std::iter::from_fn(|| h.try_recv()).collect()).unwrap_or_default();
    {
        for e in host_events {
            match e {
                HostEvent::Ready(info) => {
                    info!("net: hosting room {} (code {})", info.room_id, info.join_code);
                    if s.home && s.seating {
                        if let Some(h) = &s.host {
                            h.open_screens(true);
                        }
                    }
                    s.room = Some(info);
                    s.status = NetStatus::Ready;
                    s.notice = None;
                }
                HostEvent::Peer { peer_id, kind, name, link } => {
                    s.peers.insert(peer_id, Peer::new(link, kind, name));
                }
                HostEvent::PeerLeft(id) => {
                    phones::drop_peer(s, &id, game.as_deref_mut(), &mut remote, &mut inputs);
                }
                HostEvent::Failed(code) => home.last_failure = Some(code),
                HostEvent::Busy { retry_in_ms } => {
                    info!("net: partii is busy; retrying in {retry_in_ms} ms");
                    s.notice = Some(bb_net::play::BUSY_NOTICE.into());
                }
                HostEvent::Reclaiming => {
                    // Every member is gone (PeerLeft follows for each); the
                    // same code comes back with Ready.
                    s.status = NetStatus::Connecting;
                    s.notice = Some("Reconnecting…".into());
                }
                HostEvent::Error(e) => {
                    warn!("net: {e}");
                    s.status = NetStatus::Error(e.to_string());
                }
                HostEvent::Ended => {
                    if !matches!(s.status, NetStatus::Error(_)) {
                        s.status = NetStatus::Ended;
                    }
                    // The home room is gone (expired, edge restart, offline):
                    // make a new one after a while (phones must scan again).
                    if s.home {
                        let why = home.last_failure.clone().unwrap_or_default();
                        home.retry_at = now + bb_net::play::retry_ms(&why, None, 0.0) / 1000.0;
                        let mut g = game.as_deref_mut();
                        for slot in s.roster.keys() {
                            remote.0[*slot as usize] = false;
                            if let Some(g) = g.as_deref_mut() {
                                g.sim.remove_player(*slot);
                            }
                        }
                        commands.remove_resource::<NetSession>();
                        return;
                    }
                }
            }
        }
    }
    let guest_events: Vec<GuestEvent> = s.guest.as_ref().map(|g| std::iter::from_fn(|| g.try_recv()).collect()).unwrap_or_default();
    {
        for e in guest_events {
            match e {
                GuestEvent::Joined { room_id, peer_id } => {
                    s.self_id = peer_id;
                    let cfg = NetConfig::from_env();
                    s.room = Some(RoomInfo { controller_url: cfg.controller_link(&room_id), room_id, join_code: String::new() });
                }
                GuestEvent::Host(link) => {
                    s.peers.insert("host".into(), Peer::new(link, PeerKind::Screen, None));
                }
                GuestEvent::Error(e) => {
                    warn!("net: {e}");
                    s.status = NetStatus::Error(e.to_string());
                }
                GuestEvent::Ended => {
                    if !matches!(s.status, NetStatus::Error(_)) {
                        s.status = NetStatus::Ended;
                    }
                }
            }
        }
    }

    // Links.
    let mut events: Vec<(String, LinkEvent)> = Vec::new();
    for (id, p) in &s.peers {
        while let Some(e) = p.link.try_recv() {
            events.push((id.clone(), e));
        }
    }
    for (id, e) in events {
        let Some(kind) = s.peers.get(&id).map(|p| p.kind) else { continue };
        match e {
            LinkEvent::Open => {
                if let Some(p) = s.peers.get_mut(&id) {
                    p.open = true;
                }
                match (&s.role, kind) {
                    (NetRole::Host, PeerKind::Phone) => phones::greet(s, &id, game.as_deref()),
                    (NetRole::Guest, _) => {
                        s.status = NetStatus::Ready;
                        screens::send_hello(s);
                    }
                    _ => {}
                }
            }
            LinkEvent::Closed(reason) => {
                info!("net: link to {id} closed: {reason}");
                match s.role {
                    NetRole::Host => phones::drop_peer(s, &id, game.as_deref_mut(), &mut remote, &mut inputs),
                    NetRole::Guest => {
                        // A pre-connect failure is re-armed by the session;
                        // losing an open link to the host ends the game.
                        let was_open = s.peers.get(&id).is_some_and(|p| p.open);
                        s.peers.remove(&id);
                        if was_open {
                            s.status = NetStatus::Ended;
                        }
                    }
                }
            }
            LinkEvent::Message(_, Payload::Text(text)) => match kind {
                PeerKind::Phone => phones::on_text(s, &id, &text, game.as_deref_mut(), &devices, now),
                _ => screens::on_text(s, &id, &text, game.as_deref_mut(), &mut devices, &mut load, &mut fx, now),
            },
            LinkEvent::Message(_, Payload::Binary(bytes)) if kind == PeerKind::Phone => {
                if let Some(p) = s.peers.get_mut(&id) {
                    p.phone.apply_frame(&bytes, bb_net::rt::now_ms());
                }
            }
            LinkEvent::Message(_, Payload::Binary(bytes)) => {
                if bytes.first() == Some(&bb_net::wire::STATES_MAGIC) {
                    if let Some(p) = s.peers.get_mut(&id) {
                        p.rx.receive(&bytes, now);
                    }
                }
            }
        }
    }
}

/// Players join mid-level at the respawn point, possibly right on top of
/// someone; overlapping softbodies get flung apart. Slide the newcomer to
/// the nearest clear spot beside the spawn.
fn place_clear(sim: &mut bb_sim::Sim, slot: u8) {
    let Some(me) = sim.player(slot).map(|p| p.ctl.body) else { return };
    let r = bb_sim::control::tune::RADIUS;
    let others: Vec<bb_sim::Vec2> = sim
        .players
        .iter()
        .filter(|p| p.slot != slot)
        .filter_map(|p| sim.world.body(p.ctl.body))
        .map(|b| b.centroid())
        .collect();
    let base = sim.respawn_point() + bb_sim::Vec2::new(0.0, 40.0);
    let spot = (0..16)
        .map(|k| {
            let step = (k as f32 / 2.0).ceil() * if k % 2 == 0 { 1.0 } else { -1.0 };
            base + bb_sim::Vec2::new(step * r * 2.4, 0.0)
        })
        .find(|c| others.iter().all(|o| o.distance(*c) > r * 2.3))
        .unwrap_or(base + bb_sim::Vec2::new(0.0, r * 2.5 * (1 + others.len()) as f32));
    if let Some(b) = sim.world.body_mut(me) {
        b.reset_to(spot);
    }
}

/// Make the sim's players match the roster: add missing ones, update
/// colours/faces/ownership, remove ones that left.
fn sync_roster(session: Option<Res<NetSession>>, game: Option<ResMut<Game>>, mut tracked: Local<Vec<u8>>) {
    let (Some(s), Some(mut game)) = (session, game) else {
        tracked.clear();
        return;
    };
    if !s.is_host() && !s.level_from_host {
        return;
    }
    let sim = &mut game.sim;
    for (slot, e) in &s.roster {
        let local = e.owner == s.self_id;
        if sim.player(*slot).is_none() {
            sim.add_player(*slot, &e.name, e.color);
            place_clear(sim, *slot);
        }
        let Some(p) = sim.player_mut(*slot) else { continue };
        p.name.clone_from(&e.name);
        p.color = e.color;
        p.face = e.face;
        p.local = local;
    }
    // Remove players we added that left the roster. On a guest every player
    // comes from the host's roster.
    let stale: Vec<u8> = sim
        .players
        .iter()
        .map(|p| p.slot)
        .filter(|slot| !s.roster.contains_key(slot) && (!s.is_host() || tracked.contains(slot)))
        .collect();
    for slot in stale {
        sim.remove_player(slot);
    }
    tracked.clear();
    tracked.extend(s.roster.keys().copied());
}
