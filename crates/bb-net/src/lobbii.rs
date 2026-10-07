//! Lobbii rooms + WebRTC signaling over REST (the TS `RoomService`).
//!
//! Same endpoints, payloads and auth as the party-kit SDK so a Bevy host and
//! the deployed phone page share rooms:
//! `POST /api/auth/token`, `POST|GET /api/rooms`, `GET /api/rooms/lookup`,
//! `GET|PATCH /api/rooms/:id`, `POST|PATCH|DELETE /api/rooms/:id/peers[/:peer]`,
//! `POST|GET /api/rooms/:id/signals`, `POST /api/rooms/:id/refresh-ice`, plus
//! the optional push socket `${signal_gw}/rooms/:id?token=`.
//!
//! Auth: `Authorization: Bearer <session_token>` once the token exchange has
//! worked, else `X-API-Key` (accepted while the backend's
//! `ENFORCE_SESSION_TOKENS` is off). Mutations carry `host_secret` or
//! `peer_secret`.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{NetConfig, NetError, Result, rt};

// ─── Types (mirror party-kit `types.ts`) ────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct IceServer {
    #[serde(deserialize_with = "one_or_many")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

fn one_or_many<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(String),
        Many(Vec<String>),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::One(s) => vec![s],
        OneOrMany::Many(v) => v,
    })
}

/// Public STUN used when the backend mints no TURN credentials.
pub fn default_ice_servers() -> Vec<IceServer> {
    vec![IceServer {
        urls: vec!["stun:stun.l.google.com:19302".into(), "stun:stun1.l.google.com:19302".into()],
        username: None,
        credential: None,
    }]
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct CreateRoomOpts {
    pub game_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Kind tag for the host's own peer row (`screen`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_peers: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// `public` | `private`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CreateRoomResult {
    pub room_id: String,
    pub join_code: String,
    pub host_secret: String,
    #[serde(default)]
    pub host_peer_id: String,
    #[serde(default)]
    pub host_peer_secret: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub ice_servers: Option<Vec<IceServer>>,
    #[serde(default)]
    pub room_token: Option<String>,
    #[serde(default)]
    pub signal_gw: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct JoinRoomOpts {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct JoinRoomResult {
    pub peer_id: String,
    pub peer_secret: String,
    #[serde(default)]
    pub slot: i64,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub ice_servers: Option<Vec<IceServer>>,
    #[serde(default)]
    pub room_token: Option<String>,
    #[serde(default)]
    pub signal_gw: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct RoomPeer {
    pub peer_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub slot: Option<i64>,
    #[serde(default)]
    pub is_host: bool,
    /// `joined` | `connected` | `disconnected`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Room {
    pub room_id: String,
    #[serde(default)]
    pub join_code: String,
    #[serde(default)]
    pub game_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// `waiting` | `active` | `ended`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub max_peers: Option<u32>,
    #[serde(default)]
    pub joinable: Option<bool>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub peers: Vec<RoomPeer>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RoomSummary {
    pub room_id: String,
    #[serde(default)]
    pub join_code: String,
    #[serde(default)]
    pub game_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub max_peers: Option<u32>,
    #[serde(default)]
    pub peer_count: Option<u32>,
    #[serde(default)]
    pub is_password_protected: bool,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub joinable: Option<bool>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignalType {
    Offer,
    Answer,
    IceCandidate,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Signal {
    pub signal_id: i64,
    /// `"host"` or a peer id.
    pub sender_peer_id: String,
    pub signal_type: SignalType,
    /// SDP `{type, sdp[, renegotiate]}` or ICE `{candidate, sdpMid, sdpMLineIndex, usernameFragment}`.
    pub payload: Value,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PollSignalsResult {
    #[serde(default)]
    pub signals: Vec<Signal>,
    pub next_since_id: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct ListRoomsResult {
    #[serde(default)]
    rooms: Vec<RoomSummary>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PatchRoomOpts {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub joinable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_peers: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Who is signing a mutation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    Host { secret: String },
    Peer { id: String, secret: String },
}

// ─── Client ─────────────────────────────────────────────────────────────────

#[derive(Default)]
struct TokenState {
    token: Option<String>,
    /// Epoch ms.
    expires_at: f64,
    backoff_until: f64,
}

/// REST client. Cheap to clone (shares the HTTP pool and session token).
#[derive(Clone)]
pub struct Lobbii {
    http: reqwest::Client,
    cfg: Arc<NetConfig>,
    token: Arc<Mutex<TokenState>>,
    device_id: Arc<String>,
}

#[cfg(not(target_arch = "wasm32"))]
const FETCH_TIMEOUT_MS: u64 = 8000;

impl Lobbii {
    pub fn new(cfg: NetConfig) -> Result<Lobbii> {
        if cfg.api_key.is_empty() {
            return Err(NetError::Config("no Lobbii API key: set BB_MP_API_KEY".into()));
        }
        #[cfg(not(target_arch = "wasm32"))]
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
            .build()
            .map_err(|e| NetError::Config(e.to_string()))?;
        #[cfg(target_arch = "wasm32")]
        let http = reqwest::Client::new();
        Ok(Lobbii {
            http,
            cfg: Arc::new(cfg),
            token: Arc::new(Mutex::new(TokenState::default())),
            device_id: Arc::new(rt::uuid_v4()),
        })
    }

    pub fn config(&self) -> &NetConfig {
        &self.cfg
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.cfg.api_base, path)
    }

    /// Mint (or refresh 30 s before expiry) a session token. Best effort: on
    /// failure, back off 60 s and fall back to the raw API key, exactly like
    /// the TS client, so a missing attestation never blocks signaling.
    pub async fn ensure_token(&self) {
        let now = rt::now_ms();
        {
            let t = self.token.lock().unwrap_or_else(|e| e.into_inner());
            if t.token.is_some() && now < t.expires_at - 30_000.0 {
                return;
            }
            if now < t.backoff_until {
                return;
            }
        }
        let res = self.exchange_token().await;
        let mut t = self.token.lock().unwrap_or_else(|e| e.into_inner());
        match res {
            Ok((token, expires_in)) => {
                t.token = Some(token);
                t.expires_at = rt::now_ms() + expires_in * 1000.0;
            }
            Err(e) => {
                log::info!("lobbii: token exchange failed ({e}); using API key");
                t.token = None;
                t.backoff_until = rt::now_ms() + 60_000.0;
            }
        }
    }

    async fn exchange_token(&self) -> Result<(String, f64)> {
        #[derive(Deserialize)]
        struct Tok {
            session_token: String,
            #[serde(default)]
            expires_in: f64,
        }
        // `player` attests with an anonymous Lobbii player JWT (the mobile
        // path in partyConfig.ts). It needs no Steam ticket or Turnstile, so
        // native builds can mint real session tokens.
        let attestation = if self.cfg.platform == "player" { self.anon_player_token().await.ok() } else { None };
        let req = self.http.post(self.url("/api/auth/token")).header("X-API-Key", &self.cfg.api_key).json(&json!({
            "platform": self.cfg.platform,
            "attestation": attestation,
            "device_id": *self.device_id,
        }));
        let tok: Tok = read_json(req.send().await).await?;
        Ok((tok.session_token, if tok.expires_in > 0.0 { tok.expires_in } else { 600.0 }))
    }

    /// `POST /api/players/login {provider:"anon", device_id}` → player JWT.
    async fn anon_player_token(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Login {
            player_token: String,
        }
        let req = self
            .http
            .post(self.url("/api/players/login"))
            .header("X-API-Key", &self.cfg.api_key)
            .json(&json!({ "provider": "anon", "device_id": *self.device_id }));
        let l: Login = read_json(req.send().await).await?;
        Ok(l.player_token)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let t = self.token.lock().unwrap_or_else(|e| e.into_inner());
        match &t.token {
            Some(tok) => req.bearer_auth(tok),
            None => req.header("X-API-Key", &self.cfg.api_key),
        }
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        self.ensure_token().await;
        read_json(self.auth(self.http.get(self.url(path))).send().await).await
    }

    async fn send_json<T: for<'de> Deserialize<'de>>(&self, method: reqwest::Method, path: &str, body: &impl Serialize) -> Result<T> {
        self.ensure_token().await;
        read_json(self.auth(self.http.request(method, self.url(path))).json(body).send().await).await
    }

    // ── Rooms ──

    pub async fn create_room(&self, opts: &CreateRoomOpts) -> Result<CreateRoomResult> {
        self.send_json(reqwest::Method::POST, "/api/rooms", opts).await
    }

    pub async fn list_rooms(&self) -> Result<Vec<RoomSummary>> {
        let r: ListRoomsResult = self.get(&format!("/api/rooms?game_id={}", enc(&self.cfg.game_id))).await?;
        Ok(r.rooms)
    }

    pub async fn lookup_by_code(&self, code: &str) -> Result<RoomSummary> {
        self.get(&format!("/api/rooms/lookup?code={}", enc(&code.trim().to_uppercase()))).await
    }

    pub async fn get_room(&self, room_id: &str) -> Result<Room> {
        self.get(&format!("/api/rooms/{}", enc(room_id))).await
    }

    pub async fn patch_room(&self, room_id: &str, host_secret: &str, opts: &PatchRoomOpts) -> Result<()> {
        let mut body = serde_json::to_value(opts).map_err(|e| NetError::Decode(e.to_string()))?;
        if let Value::Object(m) = &mut body {
            m.insert("host_secret".into(), host_secret.into());
        }
        let _: Value = self.send_json(reqwest::Method::PATCH, &format!("/api/rooms/{}", enc(room_id)), &body).await?;
        Ok(())
    }

    pub async fn end_room(&self, room_id: &str, host_secret: &str) -> Result<()> {
        self.patch_room(room_id, host_secret, &PatchRoomOpts { status: Some("ended".into()), ..Default::default() }).await
    }

    pub async fn set_joinable(&self, room_id: &str, host_secret: &str, joinable: bool) -> Result<()> {
        self.patch_room(room_id, host_secret, &PatchRoomOpts { joinable: Some(joinable), ..Default::default() }).await
    }

    // ── Peers ──

    pub async fn join_room(&self, room_id: &str, opts: &JoinRoomOpts) -> Result<JoinRoomResult> {
        self.send_json(reqwest::Method::POST, &format!("/api/rooms/{}/peers", enc(room_id)), opts).await
    }

    pub async fn leave_room(&self, room_id: &str, peer_id: &str, peer_secret: &str) -> Result<()> {
        self.ensure_token().await;
        let path = format!("/api/rooms/{}/peers/{}?peer_secret={}", enc(room_id), enc(peer_id), enc(peer_secret));
        let _: Value = read_json(self.auth(self.http.delete(self.url(&path))).send().await).await?;
        Ok(())
    }

    /// Host frees a seat (kick / dead link). 404 counts as done.
    pub async fn disconnect_peer(&self, room_id: &str, host_secret: &str, peer_id: &str) -> Result<()> {
        self.ensure_token().await;
        let path = format!("/api/rooms/{}/peers/{}?host_secret={}", enc(room_id), enc(peer_id), enc(host_secret));
        match read_json::<Value>(self.auth(self.http.delete(self.url(&path))).send().await).await {
            Ok(_) | Err(NetError::Http { status: 404, .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    // ── Signaling ──

    pub async fn post_signal(&self, room_id: &str, auth: &Auth, recipient: &str, kind: SignalType, payload: &Value) -> Result<()> {
        let mut body = json!({ "recipient_peer_id": recipient, "signal_type": kind, "payload": payload });
        match auth {
            Auth::Host { secret } => body["host_secret"] = secret.clone().into(),
            Auth::Peer { id, secret } => {
                body["peer_secret"] = secret.clone().into();
                body["sender_peer_id"] = id.clone().into();
            }
        }
        let _: Value = self.send_json(reqwest::Method::POST, &format!("/api/rooms/{}/signals", enc(room_id)), &body).await?;
        Ok(())
    }

    /// Signals for `recipient` (`"host"` for the host) after `since_id`.
    pub async fn poll_signals(&self, room_id: &str, recipient: &str, since_id: i64) -> Result<PollSignalsResult> {
        self.get(&format!(
            "/api/rooms/{}/signals?recipient_peer_id={}&since_id={}&limit=50",
            enc(room_id),
            enc(recipient),
            since_id
        ))
        .await
    }

    /// Fresh short-lived TURN credentials (they expire ~10 min after join).
    pub async fn refresh_ice(&self, room_id: &str, auth: &Auth) -> Result<Vec<IceServer>> {
        #[derive(Deserialize)]
        struct R {
            #[serde(default)]
            ice_servers: Option<Vec<IceServer>>,
        }
        let body = match auth {
            Auth::Host { secret } => json!({ "host_secret": secret }),
            Auth::Peer { id, secret } => json!({ "peer_secret": secret, "peer_id": id }),
        };
        let r: R = self.send_json(reqwest::Method::POST, &format!("/api/rooms/{}/refresh-ice", enc(room_id)), &body).await?;
        Ok(r.ice_servers.unwrap_or_default())
    }

    /// Optional realtime push: a socket on the signal gateway that delivers
    /// the same signal rows the instant they're stored. Reconnects with
    /// backoff (1 s → 30 s) until `stop` closes. Callers dedupe by
    /// `signal_id` against the poll path.
    pub fn push_signals(&self, room_id: &str, gw: &str, room_token: &str) -> (async_channel::Receiver<Signal>, PushHandle) {
        let (tx, rx) = async_channel::unbounded();
        let (stop_tx, stop_rx) = async_channel::bounded::<()>(1);
        let base = gw.trim_end_matches('/').replacen("http", "ws", 1);
        let url = format!("{base}/rooms/{}?token={}", enc(room_id), enc(room_token));
        let up = Arc::new(std::sync::atomic::AtomicBool::new(false));
        rt::spawn(push_loop(url, tx, stop_rx, up.clone()));
        (rx, PushHandle { _stop: stop_tx, up })
    }
}

/// Keeps the push socket alive; dropping it stops reconnecting.
pub struct PushHandle {
    _stop: async_channel::Sender<()>,
    up: Arc<std::sync::atomic::AtomicBool>,
}

impl PushHandle {
    pub fn is_up(&self) -> bool {
        self.up.load(std::sync::atomic::Ordering::Relaxed)
    }
}

fn parse_push_frame(text: &str) -> Option<Signal> {
    #[derive(Deserialize)]
    struct Frame {
        #[serde(rename = "type")]
        ty: String,
        signal: Option<Signal>,
    }
    let f: Frame = serde_json::from_str(text).ok()?;
    if f.ty == "signal" { f.signal } else { None }
}

#[cfg(not(target_arch = "wasm32"))]
async fn push_loop(url: String, tx: async_channel::Sender<Signal>, stop: async_channel::Receiver<()>, up: Arc<std::sync::atomic::AtomicBool>) {
    use futures::StreamExt;
    use std::sync::atomic::Ordering;
    let mut backoff = 1000u32;
    loop {
        if stop.is_closed() || tx.is_closed() {
            return;
        }
        if let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url.as_str()).await {
            up.store(true, Ordering::Relaxed);
            backoff = 1000;
            loop {
                tokio::select! {
                    msg = ws.next() => match msg {
                        Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                            if let Some(s) = parse_push_frame(t.as_str()) {
                                let _ = tx.try_send(s);
                            }
                        }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    _ = stop.recv() => {
                        let _ = ws.close(None).await;
                        up.store(false, Ordering::Relaxed);
                        return;
                    }
                }
            }
            up.store(false, Ordering::Relaxed);
        }
        rt::sleep_ms(backoff).await;
        backoff = (backoff * 2).min(30_000);
    }
}

#[cfg(target_arch = "wasm32")]
async fn push_loop(url: String, tx: async_channel::Sender<Signal>, stop: async_channel::Receiver<()>, up: Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering;
    use wasm_bindgen::JsCast;
    use wasm_bindgen::closure::Closure;
    let mut backoff = 1000u32;
    loop {
        if stop.is_closed() || tx.is_closed() {
            return;
        }
        if let Ok(ws) = web_sys::WebSocket::new(&url) {
            let (down_tx, down_rx) = async_channel::bounded::<()>(1);
            let tx2 = tx.clone();
            let on_msg = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
                if let Some(t) = e.data().as_string() {
                    if let Some(s) = parse_push_frame(&t) {
                        let _ = tx2.try_send(s);
                    }
                }
            });
            let up2 = up.clone();
            let on_open = Closure::<dyn FnMut()>::new(move || up2.store(true, Ordering::Relaxed));
            let d2 = down_tx.clone();
            let on_close = Closure::<dyn FnMut()>::new(move || {
                let _ = d2.try_send(());
            });
            ws.set_onmessage(Some(on_msg.as_ref().unchecked_ref()));
            ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
            ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));
            ws.set_onerror(Some(on_close.as_ref().unchecked_ref()));
            let stopped = futures::select! {
                _ = futures::FutureExt::fuse(down_rx.recv()) => false,
                _ = futures::FutureExt::fuse(stop.recv()) => true,
            };
            ws.set_onmessage(None);
            ws.set_onopen(None);
            ws.set_onclose(None);
            ws.set_onerror(None);
            let _ = ws.close();
            up.store(false, Ordering::Relaxed);
            drop((on_msg, on_open, on_close));
            if stopped {
                return;
            }
        }
        rt::sleep_ms(backoff).await;
        backoff = (backoff * 2).min(30_000);
    }
}

/// Percent-encode a query/path component.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn read_json<T: for<'de> Deserialize<'de>>(res: reqwest::Result<reqwest::Response>) -> Result<T> {
    let res = res.map_err(|e| NetError::Io(e.to_string()))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| NetError::Io(e.to_string()))?;
    if !status.is_success() {
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str().map(String::from)))
            .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
        return Err(NetError::Http { status: status.as_u16(), message });
    }
    // Some mutations answer 204 / empty bodies.
    let text = if text.trim().is_empty() { "null" } else { &text };
    serde_json::from_str(text).map_err(|e| NetError::Decode(format!("{e}: {}", text.chars().take(200).collect::<String>())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_backend_shapes() {
        let r: CreateRoomResult = serde_json::from_str(
            r#"{"room_id":"8c1e7a2b-0000-4000-8000-000000000000","join_code":"ABC123","host_secret":"s","host_peer_id":"h","host_peer_secret":"x","expires_at":"t","ice_servers":[{"urls":"stun:a"},{"urls":["turn:b?transport=tcp","turns:c"],"username":"u","credential":"c"}],"room_token":"rt","signal_gw":"https://gw"}"#,
        )
        .unwrap();
        let ice = r.ice_servers.unwrap();
        assert_eq!(ice[0].urls, vec!["stun:a"]);
        assert_eq!(ice[1].urls.len(), 2);
        assert_eq!(ice[1].username.as_deref(), Some("u"));

        let room: Room = serde_json::from_str(
            r#"{"room_id":"r","join_code":"ABC123","game_id":"bouncy-blobs","status":"waiting","peers":[{"peer_id":"h","kind":"screen","display_name":"Host","slot":0,"is_host":true,"status":"joined","joined_at":"t","metadata":{}},{"peer_id":"p","kind":"phone","display_name":null,"slot":1,"is_host":false,"status":"joined","metadata":{}}]}"#,
        )
        .unwrap();
        assert_eq!(room.peers.len(), 2);
        assert!(room.peers[0].is_host);
        assert_eq!(room.peers[1].kind, "phone");

        let p: PollSignalsResult = serde_json::from_str(
            r#"{"signals":[{"signal_id":7,"sender_peer_id":"p","signal_type":"ice_candidate","payload":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0},"created_at":"t"}],"next_since_id":7}"#,
        )
        .unwrap();
        assert_eq!(p.signals[0].signal_type, SignalType::IceCandidate);
        assert_eq!(p.next_since_id, 7);
    }

    #[test]
    fn push_frames_and_encoding() {
        let s = parse_push_frame(r#"{"type":"signal","signal":{"signal_id":1,"sender_peer_id":"host","signal_type":"offer","payload":{"type":"offer","sdp":"v=0"}}}"#);
        assert_eq!(s.unwrap().signal_type, SignalType::Offer);
        assert!(parse_push_frame(r#"{"type":"hello"}"#).is_none());
        assert!(parse_push_frame("garbage").is_none());
        assert_eq!(enc("a b/č"), "a%20b%2F%C4%8D");
        assert_eq!(serde_json::to_value(SignalType::IceCandidate).unwrap(), "ice_candidate");
    }

    #[test]
    fn needs_an_api_key() {
        assert!(matches!(Lobbii::new(NetConfig::default()), Err(NetError::Config(_))));
    }
}
