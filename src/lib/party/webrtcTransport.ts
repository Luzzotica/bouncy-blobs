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

// Per-attempt connect budget. Chrome's ICE agent typically reaches a
// usable pair in <2s when one exists; if we're still in `checking` at 8s
// every realistic path has failed and we should bail to the retry loop
// rather than keep waiting. Lower than this risks killing legitimate slow
// TURN allocations on flaky cellular.
const CONNECT_TIMEOUT_MS = 8_000;

const NET_DEBUG = (() => {
  try {
    return typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("net") === "debug";
  } catch {
    return false;
  }
})();

const dbg = (...args: unknown[]) => {
  if (NET_DEBUG) console.info("[webrtc]", ...args);
};

export class WebRtcConnectTimeoutError extends Error {
  constructor(public readonly remoteId: string, public readonly elapsedMs: number) {
    super(`WebRTC connect timeout after ${elapsedMs}ms for peer ${remoteId}`);
    this.name = "WebRtcConnectTimeoutError";
  }
}

export class WebRtcTransport implements Transport {
  private pc: RTCPeerConnection | null = null;
  private channels: Map<string, RTCDataChannel> = new Map();
  private pendingIce: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAtMs = 0;
  private seenCandidateTypes: Set<string> = new Set();
  private disposed = false;
  private firedDisconnect = false;

  constructor(
    private readonly room: RoomService,
    public readonly remoteId: string,
    public readonly remoteKind: string,
    private readonly role: TransportRole,
    private readonly callbacks: PeerCallbacks,
    private readonly rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {}

  private fireDisconnectOnce(reason: string): void {
    if (this.firedDisconnect || this.disposed) return;
    this.firedDisconnect = true;
    dbg("disconnect", { remoteId: this.remoteId, role: this.role, reason });
    this.emit("disconnect", { reason });
    this.callbacks.onPeerDisconnected?.(this.remoteId);
  }

  private emit(phase: string, detail?: Record<string, unknown>): void {
    this.callbacks.onPhase?.(this.remoteId, phase, detail);
  }

  async start(): Promise<void> {
    this.startedAtMs = Date.now();
    this.pc = new RTCPeerConnection(this.rtcConfig);
    const chans = channelsForKind(this.remoteKind);
    dbg("start", { remoteId: this.remoteId, role: this.role, remoteKind: this.remoteKind });
    this.emit("start", { role: this.role, remoteKind: this.remoteKind });

    this.pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      const c = e.candidate;
      const ctype = (c as RTCIceCandidate).type ?? "unknown";
      if (!this.seenCandidateTypes.has(ctype)) {
        this.seenCandidateTypes.add(ctype);
        dbg("local-candidate", { remoteId: this.remoteId, type: ctype });
        this.emit("local-candidate", { type: ctype });
      }
      try {
        await this.room.sendSignal(this.remoteId, "ice_candidate", c.toJSON() as Record<string, unknown>);
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc?.connectionState;
      dbg("connectionstate", { remoteId: this.remoteId, state: s });
      this.emit("pc-state", { state: s });
      if (s === "failed" || s === "closed" || s === "disconnected") {
        this.fireDisconnectOnce(`connectionState=${s}`);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState;
      dbg("iceconnectionstate", { remoteId: this.remoteId, state: s });
      this.emit("ice-state", { state: s });
      // Capture candidate-pair state at the moment of failure / disconnect.
      // Critical: do this BEFORE `fireDisconnectOnce` triggers higher-layer
      // dispose, which would null out `this.pc` and make getStats unreachable.
      if (s === "failed" || s === "disconnected") {
        void this.collectCandidatePairs().then((pairs) => {
          if (pairs.length > 0) {
            console.error(`[webrtc] iceConnectionState=${s} pairs for peer ${this.remoteId}`, pairs);
            this.emit("pairs-on-fail", { state: s, pairs });
          }
        }).catch(() => { /* PC may already be gone */ });
      }
      // Safari/iOS sometimes never advances `connectionState` past 'connecting'
      // even after ICE fails — listen here too.
      if (s === "failed") {
        this.fireDisconnectOnce("iceConnectionState=failed");
      }
    };

    this.pc.onicegatheringstatechange = () => {
      this.emit("ice-gathering", { state: this.pc?.iceGatheringState });
    };

    this.connectTimer = setTimeout(async () => {
      if (this.disposed) return;
      if (this.isOpen()) return;
      const elapsed = Date.now() - this.startedAtMs;
      const cs = this.pc?.connectionState;
      const ics = this.pc?.iceConnectionState;
      dbg("connect-timeout", { remoteId: this.remoteId, elapsedMs: elapsed, connectionState: cs, iceConnectionState: ics });
      // Dump candidate-pair stats so we can see WHICH pair the agent tried
      // and what state it ended in. Common patterns:
      //   - all "in-progress" → STUN binding never got a response (UDP
      //     blocked, or hairpin NAT failed, or relay's CreatePermission
      //     didn't open the right peer perm).
      //   - "failed" on every pair → routing impossible from this network.
      //   - pairs missing entirely → SDP/candidate desync between sides.
      const pairs = await this.collectCandidatePairs().catch(() => null);
      if (pairs) {
        console.error("[webrtc] connect-timeout: candidate pairs for peer", this.remoteId, pairs);
        this.emit("timeout-pairs", { pairs });
      }
      this.emit("timeout", { elapsedMs: elapsed, connectionState: cs, iceConnectionState: ics });
      this.callbacks.onError?.(new WebRtcConnectTimeoutError(this.remoteId, elapsed));
      this.fireDisconnectOnce("connect-timeout");
    }, CONNECT_TIMEOUT_MS);

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
      this.emit("offer-sent");
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
      dbg("channel-open", { remoteId: this.remoteId, label: ch.label });
      this.emit("channel-open", { label: ch.label });
      // Only fire onPeerConnected once per remote peer, even if multiple
      // channels open (e.g. 'state' + 'input' for screen peers).
      if (!firedOpen) {
        firedOpen = true;
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.callbacks.onPeerConnected?.(this.remoteId, this.remoteKind);
      }
    };
    ch.onclose = () => {
      dbg("channel-close", { remoteId: this.remoteId, label: ch.label });
      this.channels.delete(ch.label);
      if (this.channels.size === 0) this.fireDisconnectOnce("all-channels-closed");
    };
    ch.onmessage = (e) => this.callbacks.onMessage?.(this.remoteId, ch.label, e.data);
  }

  async handleSignal(signal: Signal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    dbg("signal-in", {
      remoteId: this.remoteId,
      type: signal.signal_type,
      hasRemoteDesc: !!pc.remoteDescription,
    });
    try {
      if (signal.signal_type === "offer" && this.role === "answerer") {
        this.emit("offer-received");
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await pc.addIceCandidate(c);
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.emit("answer-sent");
        await this.room.sendSignal(this.remoteId, "answer", { type: answer.type, sdp: answer.sdp });
      } else if (signal.signal_type === "answer" && this.role === "offerer") {
        this.emit("answer-received");
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await pc.addIceCandidate(c);
        this.pendingIce = [];
      } else if (signal.signal_type === "ice_candidate") {
        if (!pc.remoteDescription) {
          this.pendingIce.push(signal.payload as RTCIceCandidateInit);
        } else {
          await pc.addIceCandidate(signal.payload as RTCIceCandidateInit);
          this.emit("remote-candidate");
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

  /** Snapshot every candidate pair this PC is currently considering, plus
   * the local + remote candidates they reference. This is the same data
   * chrome://webrtc-internals shows, just dumped to console. Used by the
   * connect-timeout path and the manual __rtcDebug() helper. */
  async collectCandidatePairs(): Promise<Array<Record<string, unknown>>> {
    const pc = this.pc;
    if (!pc) return [];
    const stats = await pc.getStats();
    const locals = new Map<string, any>();
    const remotes = new Map<string, any>();
    const pairs: any[] = [];
    stats.forEach((s: any) => {
      if (s.type === "local-candidate") locals.set(s.id, s);
      else if (s.type === "remote-candidate") remotes.set(s.id, s);
      else if (s.type === "candidate-pair") pairs.push(s);
    });
    return pairs.map((p) => {
      const lc = locals.get(p.localCandidateId);
      const rc = remotes.get(p.remoteCandidateId);
      return {
        state: p.state,
        nominated: p.nominated,
        writable: p.writable,
        bytesSent: p.bytesSent,
        bytesReceived: p.bytesReceived,
        local: lc ? `${lc.candidateType} ${lc.protocol} ${lc.address}:${lc.port}` : p.localCandidateId,
        remote: rc ? `${rc.candidateType} ${rc.protocol} ${rc.address}:${rc.port}` : p.remoteCandidateId,
      };
    });
  }

  isOpen(): boolean {
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") return true;
    }
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.channels.clear();
    this.pendingIce = [];
  }
}
