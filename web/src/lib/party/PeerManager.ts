// ─────────────────────────────────────────────────────────────────────────────
// PeerManager
//
// One class to handle every WebRTC peer connection in a room — host or
// joiner, phone or screen. Replaces the previous HostWebRTCManager +
// ControllerWebRTCManager + ScreenWebRTCManager.
//
// Channel topology is picked per remote peer based on `peerKind`:
//   - 'screen' → two channels: 'state' (ordered/reliable) + 'input' (unordered)
//   - anything else (default: 'phone') → single ordered/reliable channel 'data'
//
// All signaling goes through the unified RoomService. The host calls
// `connectTo(peerId, kind)` when a new peer appears in the room (typically
// discovered via getRoom() polling); joiners call `prepareForHost()` once
// after joining and wait for the host's offer.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoomService } from "./RoomService";
import type { PeerCallbacks, Signal } from "./types";

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

type Role = "offerer" | "answerer";

interface PeerChannels {
  /** Single channel name (for kinds like 'phone') OR the reliable channel
   * name when the kind uses split reliability ('screen'). */
  primary: string;
  /** Unreliable channel name. Only set for kinds that want split reliability. */
  unreliable?: string;
}

function channelsForKind(kind: string): PeerChannels {
  if (kind === "screen") return { primary: "state", unreliable: "input" };
  return { primary: "data" };
}

// ── One peer ────────────────────────────────────────────────────────────────

class Peer {
  private pc: RTCPeerConnection | null = null;
  private channels: Map<string, RTCDataChannel> = new Map();
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    private readonly room: RoomService,
    public readonly remoteId: string,
    public readonly remoteKind: string,
    private readonly role: Role,
    private readonly callbacks: PeerCallbacks,
    private readonly rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {}

  async start(): Promise<void> {
    this.pc = new RTCPeerConnection(this.rtcConfig);
    const chans = channelsForKind(this.remoteKind);

    this.pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      try {
        await this.room.sendSignal(this.remoteId, "ice_candidate", e.candidate.toJSON() as Record<string, unknown>);
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        this.callbacks.onPeerDisconnected?.(this.remoteId);
      }
    };

    if (this.role === "offerer") {
      // We open the channels; the answerer receives them via ondatachannel.
      const primary = this.pc.createDataChannel(chans.primary, { ordered: true });
      this.bindChannel(primary);
      if (chans.unreliable) {
        const unreliable = this.pc.createDataChannel(chans.unreliable, { ordered: false, maxRetransmits: 0 });
        this.bindChannel(unreliable);
      }

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.room.sendSignal(this.remoteId, "offer", { type: offer.type, sdp: offer.sdp });
    } else {
      // Answerer: just listen for whatever the offerer creates.
      this.pc.ondatachannel = (event) => {
        this.bindChannel(event.channel);
      };
    }
  }

  private bindChannel(ch: RTCDataChannel): void {
    this.channels.set(ch.label, ch);
    let firedOpen = false;
    ch.onopen = () => {
      // Only fire onPeerConnected once per remote peer, even if multiple
      // channels open (e.g. 'state' + 'input' for screen peers).
      if (!firedOpen) {
        firedOpen = true;
        this.callbacks.onPeerConnected?.(this.remoteId, this.remoteKind);
      }
    };
    ch.onclose = () => {
      this.channels.delete(ch.label);
      if (this.channels.size === 0) this.callbacks.onPeerDisconnected?.(this.remoteId);
    };
    ch.onmessage = (e) => this.callbacks.onMessage?.(this.remoteId, ch.label, e.data);
  }

  async handleSignal(signal: Signal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (signal.signal_type === "offer" && this.role === "answerer") {
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await pc.addIceCandidate(c);
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.room.sendSignal(this.remoteId, "answer", { type: answer.type, sdp: answer.sdp });
      } else if (signal.signal_type === "answer" && this.role === "offerer") {
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await pc.addIceCandidate(c);
        this.pendingIce = [];
      } else if (signal.signal_type === "ice_candidate") {
        if (!pc.remoteDescription) {
          this.pendingIce.push(signal.payload as RTCIceCandidateInit);
        } else {
          await pc.addIceCandidate(signal.payload as RTCIceCandidateInit);
        }
      }
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  send(channel: string | undefined, data: string | ArrayBuffer): boolean {
    const label = channel ?? channelsForKind(this.remoteKind).primary;
    const ch = this.channels.get(label);
    if (ch?.readyState === "open") {
      ch.send(data as string);
      return true;
    }
    return false;
  }

  isOpen(): boolean {
    // Open if at least one channel is open.
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") return true;
    }
    return false;
  }

  dispose(): void {
    this.pc?.close();
    this.pc = null;
    this.channels.clear();
    this.pendingIce = [];
  }
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class PeerManager {
  private peers: Map<string, Peer> = new Map();

  constructor(
    private readonly room: RoomService,
    private readonly role: "host" | "joiner",
    private readonly callbacks: PeerCallbacks = {},
    private readonly rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {}

  /** Host-side: open an outbound (offerer) connection to a peer that just
   * joined the room. Called once per peer; idempotent. */
  async connectTo(peerId: string, peerKind: string): Promise<void> {
    if (this.peers.has(peerId)) return;
    const peer = new Peer(this.room, peerId, peerKind, "offerer", this.makePeerCallbacks(peerId), this.rtcConfig);
    this.peers.set(peerId, peer);
    await peer.start();
  }

  /** Joiner-side: set up an inbound (answerer) Peer for the host.
   *
   * `selfKind` is the joiner's *own* kind, NOT the host's. The host always
   * opens channels based on the remote peer's kind, so the answerer must
   * mirror that to find the right channel names in `sendPrimary`. */
  async prepareForHost(selfKind: string): Promise<void> {
    const key = "host";
    if (this.peers.has(key)) return;
    const peer = new Peer(this.room, "host", selfKind, "answerer", this.makePeerCallbacks(key), this.rtcConfig);
    this.peers.set(key, peer);
    await peer.start();
  }

  private makePeerCallbacks(peerId: string): PeerCallbacks {
    return {
      onPeerConnected: (id, kind) => this.callbacks.onPeerConnected?.(id, kind),
      onPeerDisconnected: (id) => {
        this.callbacks.onPeerDisconnected?.(id);
        // Note: don't auto-delete from this.peers — connection state may
        // recover. Caller (or explicit disposeOne) decides when to clean up.
      },
      onMessage: (id, channel, data) => this.callbacks.onMessage?.(id, channel, data),
      onError: (err) => this.callbacks.onError?.(err),
    };
  }

  /** Route an incoming signal to the correct peer. Sender_peer_id "host"
   * resolves to the joiner-side "host" Peer; otherwise it's a remote peer id. */
  async handleSignal(signal: Signal): Promise<void> {
    const senderId = signal.sender_peer_id;
    // Joiners only have one peer (the host), keyed by literal "host".
    const peer = this.role === "joiner"
      ? this.peers.get("host")
      : this.peers.get(senderId);
    if (!peer) return;
    await peer.handleSignal(signal);
  }

  /** Send to a single peer on a named channel (or the peer's primary if omitted). */
  send(peerId: string, channel: string | undefined, data: string | ArrayBuffer): boolean {
    return this.peers.get(peerId)?.send(channel, data) ?? false;
  }

  /** Convenience: send on the peer's primary channel. */
  sendPrimary(peerId: string, data: string | ArrayBuffer): boolean {
    return this.send(peerId, undefined, data);
  }

  /** Broadcast to all connected peers on a named channel. Optional kind
   * filter so e.g. the lobby host can target only screen peers for snapshot
   * broadcast without phone peers receiving snapshot bytes. */
  broadcast(channel: string, data: string | ArrayBuffer, filterByKind?: string): void {
    for (const peer of this.peers.values()) {
      if (filterByKind && peer.remoteKind !== filterByKind) continue;
      peer.send(channel, data);
    }
  }

  getConnectedPeers(): { peerId: string; kind: string }[] {
    return [...this.peers.values()]
      .filter((p) => p.isOpen())
      .map((p) => ({ peerId: p.remoteId, kind: p.remoteKind }));
  }

  /** Dispose a single peer connection (e.g. when a remote peer's room row
   * disappears). Safe to call repeatedly. */
  disposePeer(peerId: string): void {
    this.peers.get(peerId)?.dispose();
    this.peers.delete(peerId);
  }

  dispose(): void {
    this.room.stopPolling();
    for (const p of this.peers.values()) p.dispose();
    this.peers.clear();
  }
}
