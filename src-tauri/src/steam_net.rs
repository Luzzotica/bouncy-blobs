// ─────────────────────────────────────────────────────────────────────────────
// Steam Networking transport (host ↔ peer via ISteamNetworkingSockets).
//
// Wraps Steam's P2P networking-sockets API behind a small Tauri command +
// event surface. Mirrors the WebRTC PeerManager contract so the TypeScript
// side can plug a SteamTransport into the existing party plumbing.
//
// Wire format (single Steam message per app message):
//   byte 0  = channel tag — 0=state (reliable), 1=input (unreliable, no nagle), 2=data (reliable)
//   bytes…  = utf-8 payload (JSON, same shape as the WebRTC data channels carry)
//
// Tauri commands emit work onto a dedicated poll thread that owns the
// listen socket and the connection registry. Commands and the poll thread
// communicate via a `parking_lot::Mutex` over shared state — fine because
// the poll loop only holds the lock briefly per tick.
//
// Tauri events emitted from the poll thread:
//   steam_net://connected   { conn_handle, remote_steam_id }
//   steam_net://message     { conn_handle, channel, data }   // data is utf-8 string
//   steam_net://closed      { conn_handle, reason }
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use steamworks::networking_sockets::{ListenSocket, NetConnection};
use steamworks::networking_types::{
    ListenSocketEvent, NetConnectionEnd, NetworkingConfigEntry, NetworkingIdentity, SendFlags,
};
use steamworks::{ClientManager, SteamId};
use tauri::{AppHandle, Emitter, State};

use crate::steam::{SteamCmdError, SteamState};

const POLL_INTERVAL_MS: u64 = 5;
const RECEIVE_BATCH: usize = 64;
const VIRTUAL_PORT: i32 = 0;

pub struct SteamNetState {
    inner: Mutex<Inner>,
    poll_started: AtomicBool,
}

struct Inner {
    listen: Option<ListenSocket<ClientManager>>,
    connections: HashMap<u32, NetConnection<ClientManager>>,
    remote_ids: HashMap<u32, u64>,
    next_handle: u32,
}

impl Inner {
    fn alloc_handle(&mut self) -> u32 {
        let h = self.next_handle;
        self.next_handle = self.next_handle.wrapping_add(1).max(1);
        h
    }
}

impl SteamNetState {
    pub fn empty() -> Self {
        Self {
            inner: Mutex::new(Inner {
                listen: None,
                connections: HashMap::new(),
                remote_ids: HashMap::new(),
                next_handle: 1,
            }),
            poll_started: AtomicBool::new(false),
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn channel_tag(channel: &str) -> u8 {
    match channel {
        "state" => 0,
        "input" => 1,
        _ => 2, // "data" and any other channel name falls back to reliable.
    }
}

fn channel_name(tag: u8) -> &'static str {
    match tag {
        0 => "state",
        1 => "input",
        _ => "data",
    }
}

fn send_flags_for(tag: u8) -> SendFlags {
    match tag {
        // Snapshots/state — reliable, ordered.
        0 => SendFlags::RELIABLE,
        // Input frames — unreliable, no batching delay. Maps to WebRTC
        // {ordered:false, maxRetransmits:0}.
        1 => SendFlags::UNRELIABLE_NO_DELAY,
        // Phone data + everything else — reliable.
        _ => SendFlags::RELIABLE,
    }
}

fn ensure_poll_thread(state: Arc<SteamNetState>, client: Arc<steamworks::Client>, app: AppHandle) {
    if state.poll_started.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("steam-net-poll".into())
        .spawn(move || poll_loop(state, client, app))
        .expect("spawn steam-net-poll");
}

fn poll_loop(state: Arc<SteamNetState>, _client: Arc<steamworks::Client>, app: AppHandle) {
    loop {
        let mut outbound_events: Vec<EmitEvent> = Vec::new();
        {
            let mut inner = state.inner.lock();

            // 1. Drain ListenSocket events (incoming connection requests, state changes).
            if inner.listen.is_some() {
                loop {
                    let evt = inner.listen.as_ref().and_then(|l| l.try_receive_event());
                    let Some(evt) = evt else { break };
                    handle_listen_event(&mut inner, evt, &mut outbound_events);
                }
            }

            // 2. Drain pending messages on every tracked connection.
            let handles: Vec<u32> = inner.connections.keys().copied().collect();
            for handle in handles {
                let Some(conn) = inner.connections.get_mut(&handle) else { continue };
                let msgs = match conn.receive_messages(RECEIVE_BATCH) {
                    Ok(m) => m,
                    Err(_) => {
                        // Connection went invalid — drop it.
                        inner.connections.remove(&handle);
                        let remote = inner.remote_ids.remove(&handle).unwrap_or(0);
                        outbound_events.push(EmitEvent::Closed(ClosedPayload {
                            conn_handle: handle,
                            remote_steam_id: remote,
                            reason: "receive_failed".into(),
                        }));
                        continue;
                    }
                };
                for msg in msgs {
                    let bytes = msg.data();
                    if bytes.is_empty() {
                        continue;
                    }
                    let tag = bytes[0];
                    outbound_events.push(EmitEvent::Message(MessagePayload {
                        conn_handle: handle,
                        channel: channel_name(tag).into(),
                        bin: bytes[1..].to_vec(),
                    }));
                }
            }
        }

        for evt in outbound_events {
            evt.emit(&app);
        }

        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}

fn handle_listen_event(
    inner: &mut Inner,
    evt: ListenSocketEvent<ClientManager>,
    out: &mut Vec<EmitEvent>,
) {
    match evt {
        ListenSocketEvent::Connecting(req) => {
            // Auto-accept for now. Higher-level lobby logic gates who can
            // discover the SteamID, so receiving a Connecting here means an
            // invited friend is dialing in.
            let _ = req.accept();
        }
        ListenSocketEvent::Connected(c) => {
            let remote_steam_id = c.remote().steam_id().map(|s| s.raw()).unwrap_or(0);
            let conn = c.take_connection();
            let handle = inner.alloc_handle();
            inner.connections.insert(handle, conn);
            inner.remote_ids.insert(handle, remote_steam_id);
            out.push(EmitEvent::Connected(ConnectedPayload {
                conn_handle: handle,
                remote_steam_id,
            }));
        }
        ListenSocketEvent::Disconnected(d) => {
            let remote_steam_id = d.remote().steam_id().map(|s| s.raw()).unwrap_or(0);
            // We don't get the connection handle on disconnect — find by remote id.
            let handle = inner
                .remote_ids
                .iter()
                .find_map(|(h, id)| (*id == remote_steam_id).then_some(*h));
            if let Some(handle) = handle {
                inner.connections.remove(&handle);
                inner.remote_ids.remove(&handle);
                out.push(EmitEvent::Closed(ClosedPayload {
                    conn_handle: handle,
                    remote_steam_id,
                    reason: format!("{:?}", d.end_reason()),
                }));
            }
        }
    }
}

// ── Event payloads ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct ConnectedPayload {
    conn_handle: u32,
    remote_steam_id: u64,
}

#[derive(Serialize, Clone)]
struct MessagePayload {
    conn_handle: u32,
    channel: String,
    /// Raw bytes. The JS receiver decides whether to interpret as utf-8
    /// (for JSON reliable events) or as a binary world snapshot — typically
    /// by checking a magic byte at index 0.
    bin: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct ClosedPayload {
    conn_handle: u32,
    remote_steam_id: u64,
    reason: String,
}

enum EmitEvent {
    Connected(ConnectedPayload),
    Message(MessagePayload),
    Closed(ClosedPayload),
}

impl EmitEvent {
    fn emit(self, app: &AppHandle) {
        match self {
            EmitEvent::Connected(p) => {
                let _ = app.emit("steam_net://connected", p);
            }
            EmitEvent::Message(p) => {
                let _ = app.emit("steam_net://message", p);
            }
            EmitEvent::Closed(p) => {
                let _ = app.emit("steam_net://closed", p);
            }
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn steam_id_self(state: State<'_, SteamState>) -> Result<String, SteamCmdError> {
    let client = state.client()?;
    Ok(client.user().steam_id().raw().to_string())
}

/// Open a listen socket so other peers can `connect_p2p` to us by SteamID.
/// Idempotent: safe to call multiple times; subsequent calls are no-ops.
#[tauri::command]
pub fn steam_net_listen(
    app: AppHandle,
    steam_state: State<'_, SteamState>,
    net_state: State<'_, Arc<SteamNetState>>,
) -> Result<(), SteamCmdError> {
    let client = steam_state.client()?;
    {
        let mut inner = net_state.inner.lock();
        if inner.listen.is_some() {
            return Ok(());
        }
        let opts: Vec<NetworkingConfigEntry> = Vec::new();
        let listen = client
            .networking_sockets()
            .create_listen_socket_p2p(VIRTUAL_PORT, opts)
            .map_err(|_| SteamCmdError::Sdk("create_listen_socket_p2p failed".into()))?;
        inner.listen = Some(listen);
    }
    ensure_poll_thread(net_state.inner_clone(), client, app);
    Ok(())
}

/// Dial a remote peer by their SteamID. Returns the local connection handle —
/// later messages on `steam_net://connected` / `steam_net://message` reference
/// this handle.
#[tauri::command]
pub fn steam_net_connect(
    app: AppHandle,
    steam_state: State<'_, SteamState>,
    net_state: State<'_, Arc<SteamNetState>>,
    remote_steam_id: String,
) -> Result<u32, SteamCmdError> {
    let client = steam_state.client()?;
    let id: u64 = remote_steam_id
        .parse()
        .map_err(|_| SteamCmdError::Sdk("invalid SteamID".into()))?;
    let identity = NetworkingIdentity::new_steam_id(SteamId::from_raw(id));
    let opts: Vec<NetworkingConfigEntry> = Vec::new();
    let conn = client
        .networking_sockets()
        .connect_p2p(identity, VIRTUAL_PORT, opts)
        .map_err(|_| SteamCmdError::Sdk("connect_p2p failed".into()))?;
    let handle = {
        let mut inner = net_state.inner.lock();
        let h = inner.alloc_handle();
        inner.connections.insert(h, conn);
        inner.remote_ids.insert(h, id);
        h
    };
    ensure_poll_thread(net_state.inner_clone(), client, app);
    Ok(handle)
}

#[tauri::command]
pub fn steam_net_send(
    net_state: State<'_, Arc<SteamNetState>>,
    conn_handle: u32,
    channel: String,
    data: String,
) -> Result<(), SteamCmdError> {
    send_bytes(&net_state, conn_handle, &channel, data.as_bytes())
}

/// Same as `steam_net_send` but accepts raw bytes for binary snapshot frames.
#[tauri::command]
pub fn steam_net_send_bin(
    net_state: State<'_, Arc<SteamNetState>>,
    conn_handle: u32,
    channel: String,
    data: Vec<u8>,
) -> Result<(), SteamCmdError> {
    send_bytes(&net_state, conn_handle, &channel, &data)
}

fn send_bytes(
    net_state: &Arc<SteamNetState>,
    conn_handle: u32,
    channel: &str,
    data: &[u8],
) -> Result<(), SteamCmdError> {
    let tag = channel_tag(channel);
    let mut framed = Vec::with_capacity(1 + data.len());
    framed.push(tag);
    framed.extend_from_slice(data);

    let inner = net_state.inner.lock();
    let conn = inner
        .connections
        .get(&conn_handle)
        .ok_or_else(|| SteamCmdError::Sdk("unknown conn_handle".into()))?;
    conn.send_message(&framed, send_flags_for(tag))
        .map_err(|e| SteamCmdError::Sdk(format!("send_message: {:?}", e)))?;
    Ok(())
}

#[tauri::command]
pub fn steam_net_close(
    net_state: State<'_, Arc<SteamNetState>>,
    conn_handle: u32,
) -> Result<(), SteamCmdError> {
    let mut inner = net_state.inner.lock();
    if let Some(conn) = inner.connections.remove(&conn_handle) {
        conn.close(NetConnectionEnd::AppGeneric, Some("user_close"), false);
    }
    inner.remote_ids.remove(&conn_handle);
    Ok(())
}

#[tauri::command]
pub fn steam_net_close_all(net_state: State<'_, Arc<SteamNetState>>) -> Result<(), SteamCmdError> {
    let mut inner = net_state.inner.lock();
    for (_, conn) in inner.connections.drain() {
        conn.close(NetConnectionEnd::AppGeneric, Some("close_all"), false);
    }
    inner.remote_ids.clear();
    inner.listen = None;
    Ok(())
}

// ── Helper trait so we can hand out a clonable Arc to the poll thread ───────

trait ArcInner {
    fn inner_clone(&self) -> Arc<SteamNetState>;
}

impl ArcInner for Arc<SteamNetState> {
    fn inner_clone(&self) -> Arc<SteamNetState> {
        Arc::clone(self)
    }
}
