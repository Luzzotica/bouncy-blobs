//! WebRTC peer links in the browser (wasm32), a straight port of the party-kit
//! `WebRtcTransport`: the offerer creates the channels, ICE trickles through
//! Lobbii, remote ICE is buffered until the remote description lands, 15 s
//! connect budget. Browser callbacks only push into channels; one
//! `spawn_local` task owns the `RTCPeerConnection`.

use std::collections::HashMap;

use async_channel::{Receiver, Sender};
use futures::FutureExt;
use js_sys::{JSON, Reflect, Uint8Array};
use serde_json::{Value, json};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    MessageEvent, RtcConfiguration, RtcDataChannel, RtcDataChannelEvent, RtcDataChannelInit, RtcDataChannelState,
    RtcDataChannelType, RtcIceCandidateInit, RtcPeerConnection, RtcPeerConnectionIceEvent, RtcPeerConnectionState,
    RtcSdpType, RtcSessionDescriptionInit,
};

use crate::lobbii::{IceServer, Signal, SignalType};
use crate::session::{OutSignal, Role};
use crate::transport::{Channel, LinkDriver, Outgoing, Payload, PeerKind, PeerLink, link_pair};

const CONNECT_TIMEOUT_MS: f64 = 15_000.0;
const RECOVERY_GRACE_MS: f64 = 10_000.0;
const MAX_BUFFERED: u32 = 512 * 1024;

enum Ev {
    Ice(Value),
    State(RtcPeerConnectionState),
    Channel(RtcDataChannel),
    Open,
    Message(Channel, Payload),
    ChannelClosed(Channel),
}

pub(crate) fn spawn_peer(role: Role, remote_id: String, kind: PeerKind, ice: Vec<IceServer>, out: Sender<OutSignal>) -> (PeerLink, Sender<Signal>) {
    let (link, driver) = link_pair(remote_id.clone(), kind);
    let (sig_tx, sig_rx) = async_channel::unbounded();
    wasm_bindgen_futures::spawn_local(async move {
        let reason = drive(role, remote_id, kind, ice, &driver, sig_rx, out).await;
        driver.closed(reason);
    });
    (link, sig_tx)
}

fn js_err(e: JsValue) -> String {
    e.as_string().unwrap_or_else(|| format!("{e:?}"))
}

/// Closures must outlive the JS objects that call them; the driver keeps
/// them here until it tears the connection down.
#[derive(Default)]
struct Keep(Vec<Box<dyn std::any::Any>>);

impl Keep {
    fn hold<T: 'static>(&mut self, c: T) {
        self.0.push(Box::new(c));
    }
}

fn bind_channel(dc: &RtcDataChannel, kind: PeerKind, tx: &Sender<Ev>, keep: &mut Keep) -> Option<Channel> {
    let ch = kind.channel_of(&dc.label())?;
    dc.set_binary_type(RtcDataChannelType::Arraybuffer);
    let t = tx.clone();
    let on_open = Closure::<dyn FnMut()>::new(move || {
        let _ = t.try_send(Ev::Open);
    });
    let t = tx.clone();
    let on_msg = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        let data = e.data();
        let msg = if let Some(s) = data.as_string() {
            Payload::Text(s)
        } else if let Some(buf) = data.dyn_ref::<js_sys::ArrayBuffer>() {
            Payload::Binary(Uint8Array::new(buf).to_vec())
        } else {
            return;
        };
        let _ = t.try_send(Ev::Message(ch, msg));
    });
    let t = tx.clone();
    let on_close = Closure::<dyn FnMut()>::new(move || {
        let _ = t.try_send(Ev::ChannelClosed(ch));
    });
    dc.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    dc.set_onmessage(Some(on_msg.as_ref().unchecked_ref()));
    dc.set_onclose(Some(on_close.as_ref().unchecked_ref()));
    keep.hold(on_open);
    keep.hold(on_msg);
    keep.hold(on_close);
    Some(ch)
}

fn send_dc(dc: &RtcDataChannel, msg: Payload) {
    if dc.ready_state() != RtcDataChannelState::Open || dc.buffered_amount() > MAX_BUFFERED {
        return;
    }
    let _ = match msg {
        Payload::Text(t) => dc.send_with_str(&t),
        Payload::Binary(b) => dc.send_with_u8_array(&b),
    };
}

async fn set_desc(pc: &RtcPeerConnection, ty: RtcSdpType, sdp: &str, remote: bool) -> Result<(), String> {
    let d = RtcSessionDescriptionInit::new(ty);
    d.set_sdp(sdp);
    let p = if remote { pc.set_remote_description(&d) } else { pc.set_local_description(&d) };
    JsFuture::from(p).await.map(|_| ()).map_err(js_err)
}

async fn add_ice(pc: &RtcPeerConnection, c: &Value) {
    let Ok(js) = JSON::parse(&c.to_string()) else { return };
    let init: RtcIceCandidateInit = js.unchecked_into();
    let _ = JsFuture::from(pc.add_ice_candidate_with_opt_rtc_ice_candidate_init(Some(&init))).await;
}

fn sdp_of(v: &JsValue) -> Option<String> {
    Reflect::get(v, &JsValue::from_str("sdp")).ok()?.as_string()
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
    let cfg = RtcConfiguration::new();
    if let Ok(servers) = JSON::parse(&serde_json::to_string(&ice).unwrap_or_else(|_| "[]".into())) {
        cfg.set_ice_servers(&servers);
    }
    let pc = match RtcPeerConnection::new_with_configuration(&cfg) {
        Ok(pc) => pc,
        Err(e) => return format!("RTCPeerConnection: {}", js_err(e)),
    };
    let (tx, rx) = async_channel::unbounded::<Ev>();
    let mut keep = Keep::default();

    let t = tx.clone();
    let on_ice = Closure::<dyn FnMut(RtcPeerConnectionIceEvent)>::new(move |e: RtcPeerConnectionIceEvent| {
        if let Some(c) = e.candidate() {
            let json = JSON::stringify(&c.to_json()).ok().and_then(|s| s.as_string());
            if let Some(v) = json.and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
                let _ = t.try_send(Ev::Ice(v));
            }
        }
    });
    pc.set_onicecandidate(Some(on_ice.as_ref().unchecked_ref()));
    keep.hold(on_ice);
    let t = tx.clone();
    let pc2 = pc.clone();
    let on_state = Closure::<dyn FnMut()>::new(move || {
        let _ = t.try_send(Ev::State(pc2.connection_state()));
    });
    pc.set_onconnectionstatechange(Some(on_state.as_ref().unchecked_ref()));
    keep.hold(on_state);
    let t = tx.clone();
    let on_dc = Closure::<dyn FnMut(RtcDataChannelEvent)>::new(move |e: RtcDataChannelEvent| {
        let _ = t.try_send(Ev::Channel(e.channel()));
    });
    pc.set_ondatachannel(Some(on_dc.as_ref().unchecked_ref()));
    keep.hold(on_dc);

    let send_signal = |kind: SignalType, payload: Value| {
        let _ = out.try_send(OutSignal { to: remote_id.clone(), kind, payload });
    };

    let mut channels: HashMap<Channel, RtcDataChannel> = HashMap::new();
    if role == Role::Offerer {
        for ch in [Channel::Reliable, Channel::Unreliable] {
            let init = RtcDataChannelInit::new();
            if ch == Channel::Reliable {
                init.set_ordered(true);
            } else {
                init.set_ordered(false);
                init.set_max_retransmits(0);
            }
            let dc = pc.create_data_channel_with_data_channel_dict(kind.label(ch), &init);
            if bind_channel(&dc, kind, &tx, &mut keep).is_some() {
                channels.insert(ch, dc);
            }
        }
        let offer = match JsFuture::from(pc.create_offer()).await {
            Ok(o) => o,
            Err(e) => return format!("create offer: {}", js_err(e)),
        };
        let Some(sdp) = sdp_of(&offer) else { return "offer without sdp".into() };
        if let Err(e) = set_desc(&pc, RtcSdpType::Offer, &sdp, false).await {
            return format!("set local offer: {e}");
        }
        send_signal(SignalType::Offer, json!({ "type": "offer", "sdp": sdp }));
    }

    let started = crate::rt::now_ms();
    let mut opened = false;
    let mut have_remote = false;
    let mut pending: Vec<Value> = Vec::new();
    let mut unhealthy_since: Option<f64> = None;

    let reason = loop {
        let mut sig = std::pin::pin!(signals.recv().fuse());
        let mut cmd = std::pin::pin!(link.outgoing.recv().fuse());
        let mut ev = std::pin::pin!(rx.recv().fuse());
        let mut tick = std::pin::pin!(crate::rt::sleep_ms(250).fuse());
        futures::select! {
            s = sig => {
                let Ok(s) = s else { break "session ended".to_string() };
                match (s.signal_type, role) {
                    (SignalType::Offer, Role::Answerer) | (SignalType::Answer, Role::Offerer) => {
                        let Some(sdp) = s.payload.get("sdp").and_then(Value::as_str) else { continue };
                        let ty = if role == Role::Answerer { RtcSdpType::Offer } else { RtcSdpType::Answer };
                        if let Err(e) = set_desc(&pc, ty, sdp, true).await {
                            log::warn!("rtc {remote_id}: bad description: {e}");
                            continue;
                        }
                        have_remote = true;
                        for c in pending.drain(..) {
                            add_ice(&pc, &c).await;
                        }
                        if role == Role::Answerer {
                            let answer = match JsFuture::from(pc.create_answer()).await {
                                Ok(a) => a,
                                Err(e) => break format!("create answer: {}", js_err(e)),
                            };
                            let Some(sdp) = sdp_of(&answer) else { break "answer without sdp".into() };
                            if let Err(e) = set_desc(&pc, RtcSdpType::Answer, &sdp, false).await {
                                break format!("set local answer: {e}");
                            }
                            send_signal(SignalType::Answer, json!({ "type": "answer", "sdp": sdp }));
                        }
                    }
                    (SignalType::IceCandidate, _) => {
                        let empty = s.payload.get("candidate").and_then(Value::as_str).is_none_or(str::is_empty);
                        if empty {
                            continue;
                        }
                        if have_remote {
                            add_ice(&pc, &s.payload).await;
                        } else {
                            pending.push(s.payload);
                        }
                    }
                    _ => {}
                }
            }
            c = cmd => match c {
                Ok(Outgoing::Send(ch, msg)) => {
                    if let Some(dc) = channels.get(&ch) {
                        send_dc(dc, msg);
                    }
                }
                Ok(Outgoing::Close) | Err(_) => break "closed locally".to_string(),
            },
            e = ev => match e {
                Ok(Ev::Ice(v)) => send_signal(SignalType::IceCandidate, v),
                Ok(Ev::State(s)) => match s {
                    RtcPeerConnectionState::Connected => unhealthy_since = None,
                    RtcPeerConnectionState::Disconnected | RtcPeerConnectionState::Failed => {
                        unhealthy_since.get_or_insert_with(crate::rt::now_ms);
                    }
                    RtcPeerConnectionState::Closed => break "connection closed".to_string(),
                    _ => {}
                },
                Ok(Ev::Channel(dc)) => {
                    if let Some(ch) = bind_channel(&dc, kind, &tx, &mut keep) {
                        channels.insert(ch, dc);
                    }
                }
                Ok(Ev::Open) => {
                    opened = true;
                    link.opened();
                }
                Ok(Ev::Message(ch, msg)) => link.deliver(ch, msg),
                Ok(Ev::ChannelClosed(ch)) => {
                    channels.remove(&ch);
                    if opened && channels.is_empty() {
                        break "all channels closed".to_string();
                    }
                }
                Err(_) => break "event feed dropped".to_string(),
            },
            _ = tick => {
                let now = crate::rt::now_ms();
                if !opened && now - started > CONNECT_TIMEOUT_MS {
                    break "connect-timeout".to_string();
                }
                if unhealthy_since.is_some_and(|t| now - t > RECOVERY_GRACE_MS) {
                    break "connection lost (no recovery)".to_string();
                }
            }
        }
    };
    for dc in channels.values() {
        dc.set_onopen(None);
        dc.set_onmessage(None);
        dc.set_onclose(None);
        dc.close();
    }
    pc.set_onicecandidate(None);
    pc.set_onconnectionstatechange(None);
    pc.set_ondatachannel(None);
    pc.close();
    drop(keep);
    reason
}
