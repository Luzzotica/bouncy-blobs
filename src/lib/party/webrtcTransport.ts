// ─────────────────────────────────────────────────────────────────────────────
// WebRtcTransport — Transport implementation backed by RTCPeerConnection.
//
// Owns the RTCPeerConnection, the data channels, and the offer/answer/ICE
// dance routed through the RoomService signaling backend. Channel topology
// is picked from the remote peer's `kind` via channelsForKind().
//
// Lifecycle:
//   1. Construct with role ("offerer" | "answerer")
//   2. Call start() — offerer creates channels + sends offer; answerer waits
//   3. Feed inbound SDP/ICE through handleSignal()
//   4. send() / isOpen() / dispose() — Transport interface
// ─────────────────────────────────────────────────────────────────────────────

import type { RoomService } from "./RoomService";
import type { PeerCallbacks, Signal } from "./types";
import { channelsForKind, type ChannelName, type Transport, type TransportRole } from "./transport";

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export class WebRtcTransport implements Transport {
  private pc: RTCPeerConnection | null = null;
  private channels: Map<string, RTCDataChannel> = new Map();
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(
    private readonly room: RoomService,
    public readonly remoteId: string,
    public readonly remoteKind: string,
    private readonly role: TransportRole,
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
    // Default RTCDataChannel binaryType is "blob" — switch to ArrayBuffer so
    // binary snapshot frames arrive in a form callers can decode directly.
    ch.binaryType = "arraybuffer";
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

  send(channel: ChannelName | string | undefined, data: string | ArrayBuffer): boolean {
    const label = channel ?? channelsForKind(this.remoteKind).primary;
    const ch = this.channels.get(label);
    if (ch?.readyState === "open") {
      ch.send(data as string);
      return true;
    }
    return false;
  }

  isOpen(): boolean {
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
