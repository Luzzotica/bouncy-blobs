//! WebRTC peer links on desktop/mobile via webrtc-rs, mirroring the browser
//! `WebRtcTransport` so the deployed phone page can't tell the difference:
//! the offerer creates `data`/`state` (ordered) + `input` (unordered,
//! `maxRetransmits: 0`), trickles ICE through Lobbii, buffers remote ICE until
//! the remote description lands, and gives up after 15 s if no channel opens.
//!
//! Each link is one task on bb-net's tokio runtime; the game only sees the
//! channel-backed [`PeerLink`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_channel::{Receiver, Sender};
use bytes::BytesMut;
use serde_json::{Value, json};
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelInit};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit,
    RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSessionDescription,
};

use crate::lobbii::{IceServer, Signal, SignalType};
use crate::session::{OutSignal, Role};
use crate::transport::{Channel, LinkDriver, Outgoing, Payload, PeerKind, PeerLink, link_pair};

/// Per-attempt connect budget (TS `CONNECT_TIMEOUT_MS`): slow TURN relays on
/// AP-isolated Wi-Fi legitimately need > 8 s.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A live link that drops gets this long to recover (ICE fails over to the
/// relay pair by itself) before we call it dead (TS `RECOVERY_GRACE_MS`).
const RECOVERY_GRACE: Duration = Duration::from_secs(10);
/// Drop sends past this much unacknowledged data per channel (TS `MAX_BUFFERED`).
const MAX_BUFFERED: usize = 512 * 1024;

enum PcEvent {
    Ice(RTCIceCandidateInit),
    State(RTCPeerConnectionState),
    Channel(Arc<dyn DataChannel>),
}

struct Handler(Sender<PcEvent>);

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Ok(c) = event.candidate.to_json() {
            let _ = self.0.try_send(PcEvent::Ice(c));
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.0.try_send(PcEvent::State(state));
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.0.try_send(PcEvent::Channel(dc));
    }
}

/// Start a link to `remote_id`. Feed its inbound signals through the
/// returned sender; its outbound signals go to `out`.
pub(crate) fn spawn_peer(role: Role, remote_id: String, kind: PeerKind, ice: Vec<IceServer>, out: Sender<OutSignal>) -> (PeerLink, Sender<Signal>) {
    let (link, driver) = link_pair(remote_id.clone(), kind);
    let (sig_tx, sig_rx) = async_channel::unbounded();
    crate::rt::spawn(async move {
        let reason = drive(role, remote_id, kind, ice, &driver, sig_rx, out).await;
        driver.closed(reason);
    });
    (link, sig_tx)
}

fn rtc_ice(ice: &[IceServer]) -> Vec<RTCIceServer> {
    ice.iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone().unwrap_or_default(),
            credential: s.credential.clone().unwrap_or_default(),
        })
        .collect()
}

fn ice_json(c: &RTCIceCandidateInit) -> Value {
    json!({
        "candidate": c.candidate,
        "sdpMid": c.sdp_mid,
        "sdpMLineIndex": c.sdp_mline_index,
        "usernameFragment": c.username_fragment,
    })
}

fn parse_ice(v: &Value) -> Option<RTCIceCandidateInit> {
    let c: RTCIceCandidateInit = serde_json::from_value(v.clone()).ok()?;
    // An empty candidate is the browser's end-of-candidates marker.
    if c.candidate.is_empty() { None } else { Some(c) }
}

async fn send_dc(dc: &Arc<dyn DataChannel>, msg: Payload) {
    // try_send* fail fast when the channel's buffer is over the limit: drop,
    // like the browser transport, rather than stall the link task.
    let _ = match msg {
        Payload::Text(t) => dc.try_send_text(&t).await,
        Payload::Binary(b) => dc.try_send(BytesMut::from(&b[..])).await,
    };
}

async fn drive(
    role: Role,
    remote_id: String,
    kind: PeerKind,
    ice: Vec<IceServer>,
    link: &LinkDriver,
    signals: Receiver<Signal>,
    out: Sender<OutSignal>,
) -> String {
    let (pc_tx, pc_rx) = async_channel::unbounded();
    let config = RTCConfigurationBuilder::new().with_ice_servers(rtc_ice(&ice)).build();
    let pc = match PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_handler(Arc::new(Handler(pc_tx)))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .with_data_channel_send_buffer_limit(MAX_BUFFERED)
        .build()
        .await
    {
        Ok(pc) => pc,
        Err(e) => return format!("peer connection: {e}"),
    };

    // Channel events from every data channel, merged.
    let (dc_tx, dc_rx) = async_channel::unbounded::<(Channel, Option<DataChannelEvent>)>();
    let mut channels: HashMap<Channel, Arc<dyn DataChannel>> = HashMap::new();
    let pump = |ch: Channel, dc: Arc<dyn DataChannel>, tx: Sender<(Channel, Option<DataChannelEvent>)>| {
        crate::rt::spawn(async move {
            while let Some(ev) = dc.poll().await {
                if tx.send((ch, Some(ev))).await.is_err() {
                    return;
                }
            }
            let _ = tx.send((ch, None)).await;
        });
    };

    let send_signal = |kind: SignalType, payload: Value| {
        let _ = out.try_send(OutSignal { to: remote_id.clone(), kind, payload });
    };

    if role == Role::Offerer {
        let reliable = RTCDataChannelInit { ordered: true, ..Default::default() };
        let unreliable = RTCDataChannelInit { ordered: false, max_retransmits: Some(0), ..Default::default() };
        for (ch, init) in [(Channel::Reliable, reliable), (Channel::Unreliable, unreliable)] {
            match pc.create_data_channel(kind.label(ch), Some(init)).await {
                Ok(dc) => {
                    pump(ch, dc.clone(), dc_tx.clone());
                    channels.insert(ch, dc);
                }
                Err(e) => return format!("create {} channel: {e}", kind.label(ch)),
            }
        }
        let offer = match pc.create_offer(None).await {
            Ok(o) => o,
            Err(e) => return format!("create offer: {e}"),
        };
        let sdp = offer.sdp.clone();
        if let Err(e) = pc.set_local_description(offer).await {
            return format!("set local offer: {e}");
        }
        send_signal(SignalType::Offer, json!({ "type": "offer", "sdp": sdp }));
    }

    let started = Instant::now();
    let mut opened = false;
    let mut have_remote = false;
    let mut pending_ice: Vec<RTCIceCandidateInit> = Vec::new();
    let mut unhealthy_since: Option<Instant> = None;
    let mut ticker = tokio::time::interval(Duration::from_millis(250));

    let reason = loop {
        tokio::select! {
            sig = signals.recv() => {
                let Ok(sig) = sig else { break "session ended".to_string() };
                match (sig.signal_type, role) {
                    (SignalType::Offer, Role::Answerer) => {
                        let Some(sdp) = sig.payload.get("sdp").and_then(Value::as_str) else { continue };
                        let Ok(desc) = RTCSessionDescription::offer(sdp.to_string()) else { continue };
                        if let Err(e) = pc.set_remote_description(desc).await {
                            log::warn!("rtc {remote_id}: bad offer: {e}");
                            continue;
                        }
                        have_remote = true;
                        for c in pending_ice.drain(..) {
                            let _ = pc.add_ice_candidate(c).await;
                        }
                        let answer = match pc.create_answer(None).await {
                            Ok(a) => a,
                            Err(e) => break format!("create answer: {e}"),
                        };
                        let sdp = answer.sdp.clone();
                        if let Err(e) = pc.set_local_description(answer).await {
                            break format!("set local answer: {e}");
                        }
                        send_signal(SignalType::Answer, json!({ "type": "answer", "sdp": sdp }));
                    }
                    (SignalType::Answer, Role::Offerer) => {
                        let Some(sdp) = sig.payload.get("sdp").and_then(Value::as_str) else { continue };
                        let Ok(desc) = RTCSessionDescription::answer(sdp.to_string()) else { continue };
                        if let Err(e) = pc.set_remote_description(desc).await {
                            log::warn!("rtc {remote_id}: bad answer: {e}");
                            continue;
                        }
                        have_remote = true;
                        for c in pending_ice.drain(..) {
                            let _ = pc.add_ice_candidate(c).await;
                        }
                    }
                    (SignalType::IceCandidate, _) => {
                        if let Some(c) = parse_ice(&sig.payload) {
                            if have_remote {
                                let _ = pc.add_ice_candidate(c).await;
                            } else {
                                pending_ice.push(c);
                            }
                        }
                    }
                    _ => {}
                }
            }
            cmd = link.outgoing.recv() => match cmd {
                Ok(Outgoing::Send(ch, msg)) => {
                    if let Some(dc) = channels.get(&ch) {
                        send_dc(dc, msg).await;
                    }
                }
                Ok(Outgoing::Close) | Err(_) => break "closed locally".to_string(),
            },
            ev = pc_rx.recv() => match ev {
                Ok(PcEvent::Ice(c)) => send_signal(SignalType::IceCandidate, ice_json(&c)),
                Ok(PcEvent::State(s)) => match s {
                    RTCPeerConnectionState::Connected => unhealthy_since = None,
                    RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                        // Recoverable: ICE may still fail over to the relay pair.
                        unhealthy_since.get_or_insert_with(Instant::now);
                    }
                    RTCPeerConnectionState::Closed => break "connection closed".to_string(),
                    _ => {}
                },
                Ok(PcEvent::Channel(dc)) => {
                    let label = dc.label().await.unwrap_or_default();
                    if let Some(ch) = kind.channel_of(&label) {
                        pump(ch, dc.clone(), dc_tx.clone());
                        channels.insert(ch, dc);
                    }
                }
                Err(_) => break "peer connection dropped".to_string(),
            },
            ev = dc_rx.recv() => match ev {
                Ok((ch, Some(DataChannelEvent::OnOpen))) => {
                    let _ = ch;
                    opened = true;
                    link.opened();
                }
                Ok((ch, Some(DataChannelEvent::OnMessage(m)))) => {
                    let msg = if m.is_string {
                        match String::from_utf8(m.data.to_vec()) {
                            Ok(t) => Payload::Text(t),
                            Err(_) => continue,
                        }
                    } else {
                        Payload::Binary(m.data.to_vec())
                    };
                    link.deliver(ch, msg);
                }
                Ok((ch, Some(DataChannelEvent::OnClose))) | Ok((ch, None)) => {
                    channels.remove(&ch);
                    if opened && channels.is_empty() {
                        break "all channels closed".to_string();
                    }
                }
                Ok(_) => {}
                Err(_) => {}
            },
            _ = ticker.tick() => {
                if !opened && started.elapsed() > CONNECT_TIMEOUT {
                    break "connect-timeout".to_string();
                }
                if unhealthy_since.is_some_and(|t| t.elapsed() > RECOVERY_GRACE) {
                    break "connection lost (no recovery)".to_string();
                }
            }
        }
    };
    let _ = pc.close().await;
    reason
}
