// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
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
import { channelsForKind, rtcConfigFromIceServers, type ChannelName, type Transport, type TransportRole } from "./transport";

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
// Raised 8s→15s: on WiFi that forces a TURN *relay* (AP-isolation / mDNS-blocked
// direct path — the common phone case), the poll-signalled offer/answer/relay-
// candidate handshake can legitimately need >8s, especially with several peers
// joining at once. 8s was killing valid slow relay allocations mid-handshake.
const CONNECT_TIMEOUT_MS = 15_000;

// Once a connection is live, `iceConnectionState`/`connectionState` can drop
// to "disconnected" (or even "failed") on a restrictive/rebinding NAT —
// airport & hotel wifi are the classic offenders. The spec treats these as
// RECOVERABLE: ICE keeps probing other candidate pairs and will fail over to
// the TURN *relay* pair if we let it. So instead of tearing down on the first
// blip (which also auto-ends the host's room), we arm this grace window and
// kick an ICE restart. We only fire a real disconnect if the link hasn't
// recovered by the time it elapses. Generous because the offer/answer for the
// restart rides the poll-based signalling channel, which adds a round trip.
const RECOVERY_GRACE_MS = 10_000;

// Cap ICE restarts per transport so a permanently-dead network can't spin the
// signalling channel forever. Two attempts is enough to cover a one-off relay
// allocation hiccup without becoming a busy-loop.
const MAX_ICE_RESTARTS = 2;

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
  // When a peer's SCTP send buffer backs up past this, drop the send instead of
  // enqueuing. Realtime state re-sends every tick, so a dropped frame self-heals
  // — but an unbounded buffer climbs in latency and eventually makes ch.send()
  // THROW "send queue is full", which (uncaught in the broadcast loop) killed a
  // live host. Applies to both channels: a reliable channel this backed up is
  // already head-of-line-blocked and dead anyway.
  private static readonly MAX_BUFFERED = 512 * 1024;
  private pc: RTCPeerConnection | null = null;
  private channels: Map<string, RTCDataChannel> = new Map();
  private pendingIce: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestarts = 0;
  private startedAtMs = 0;
  private seenCandidateTypes: Set<string> = new Set();
  private disposed = false;
  private firedDisconnect = false;
  private reportedConnected = false;
  // ── Tier-2 recovery ── one full renegotiation per outage: fresh ICE servers
  // (TURN creds expire ~10min — the usual reason deep-match ICE restarts fail),
  // a NEW RTCPeerConnection, and a re-offer over the still-alive signaling.
  private renegotiated = false;
  private rtcConfigCurrent: RTCConfiguration | null = null;

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
    // Terminal outcome telemetry: a timeout never connected; a post-connect
    // death that exhausted recovery is a gave_up; anything else is failed.
    const outcome = reason === "connect-timeout"
      ? "timeout"
      : reason.includes("no recovery") ? "gave_up" : "failed";
    void this.reportTelemetry(outcome);
    this.emit("disconnect", { reason });
    this.callbacks.onPeerDisconnected?.(this.remoteId);
  }

  /** Best-effort RTT (ms) from the selected/nominated ICE candidate pair.
   *  Returns null before the pair is chosen or if the stat is absent. */
  async getRttMs(): Promise<number | null> {
    const pc = this.pc;
    if (!pc) return null;
    try {
      const stats = await pc.getStats();
      let rtt: number | null = null;
      stats.forEach((s: Record<string, unknown> & { type?: string }) => {
        if (
          s.type === "candidate-pair" &&
          (s as { nominated?: boolean }).nominated &&
          (s as { state?: string }).state === "succeeded"
        ) {
          const t = (s as { currentRoundTripTime?: number }).currentRoundTripTime;
          if (typeof t === "number") rtt = Math.round(t * 1000);
        }
      });
      return rtt;
    } catch {
      return null;
    }
  }

  /** Selected-pair info for telemetry: which candidate type won, and (when
   *  relayed) which TURN server carried the session. Best-effort. */
  private async selectedCandidate(): Promise<{ candidate_type?: string; relay_host?: string }> {
    const pc = this.pc;
    if (!pc) return {};
    try {
      const stats = await pc.getStats();
      const locals = new Map<string, Record<string, unknown>>();
      let selected: Record<string, unknown> | null = null;
      stats.forEach((s: Record<string, unknown> & { type?: string }) => {
        if (s.type === "local-candidate") locals.set(String(s.id), s);
        else if (s.type === "candidate-pair" && (s as { nominated?: boolean }).nominated
          && (s as { state?: string }).state === "succeeded") selected = s;
      });
      if (!selected) return {};
      const lc = locals.get(String((selected as { localCandidateId?: string }).localCandidateId));
      if (!lc) return {};
      const ctype = String((lc as { candidateType?: string }).candidateType ?? "");
      const url = (lc as { url?: string }).url;
      return {
        candidate_type: ctype || undefined,
        relay_host: ctype === "relay" && url ? String(url).slice(0, 128) : undefined,
      };
    } catch {
      return {};
    }
  }

  private async reportTelemetry(
    outcome: "connected" | "timeout" | "failed" | "recovered" | "gave_up",
  ): Promise<void> {
    const sel = await this.selectedCandidate();
    this.room.postTelemetry({
      outcome,
      role: this.role === "offerer" ? "host" : "peer",
      connect_ms: outcome === "connected" ? Date.now() - this.startedAtMs : undefined,
      ice_restarts: this.iceRestarts,
      ...sel,
    });
  }

  private emit(phase: string, detail?: Record<string, unknown>): void {
    this.callbacks.onPhase?.(this.remoteId, phase, detail);
  }

  /** Add a remote ICE candidate + log its TYPE (host/srflx/relay) so the phase
   *  log shows whether the peer offered a relay candidate — the pair we need on
   *  restrictive WiFi. (Also covers candidates buffered before setRemoteDescription,
   *  which previously weren't logged at all.) */
  private async addRemote(cand: RTCIceCandidateInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.addIceCandidate(cand);
    const m = /\btyp (\w+)/.exec(cand.candidate ?? "");
    this.emit("remote-candidate", { type: m?.[1] ?? "unknown" });
  }

  /** The link is (re)established. Cancel any pending grace teardown and let
   * a future blip earn a fresh budget of ICE restarts. */
  private onConnectionHealthy(): void {
    if (this.recoveryTimer) {
      dbg("recovery-cancelled", { remoteId: this.remoteId });
      this.emit("recovered");
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      void this.reportTelemetry("recovered");
    }
    this.iceRestarts = 0;
  }

  /** Enter recovery after a transient ICE drop instead of tearing down.
   * Kicks an ICE restart (offerer side) to force re-gathering — crucially a
   * fresh TURN relay allocation — and arms a single grace timer. We only fire
   * a real disconnect if the link is still unhealthy when it elapses.
   * Idempotent: a second drop while already recovering is a no-op. */
  private startRecovery(reason: string): void {
    if (this.disposed || this.firedDisconnect) return;
    if (this.recoveryTimer) return; // already counting down
    dbg("recovery-start", { remoteId: this.remoteId, reason });
    this.emit("recovering", { reason });
    void this.tryIceRestart();
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      const cs = this.pc?.connectionState;
      const ics = this.pc?.iceConnectionState;
      // Recovered out from under us between the timer firing and now? Bail.
      if (cs === "connected" || ics === "connected" || ics === "completed") return;
      dbg("recovery-timeout", { remoteId: this.remoteId, connectionState: cs, iceConnectionState: ics });
      if (!this.renegotiated && this.role === "offerer") {
        // Last rung before giving up: rebuild from scratch with fresh relays.
        void this.renegotiate(reason);
        return;
      }
      this.fireDisconnectOnce(`${reason} (no recovery in ${RECOVERY_GRACE_MS}ms)`);
    }, RECOVERY_GRACE_MS);
  }

  /** Offerer-only: renegotiate with `iceRestart` so both ends re-gather
   * candidates (new srflx + a fresh relay allocation) and ICE can converge on
   * the TURN relay when the direct path is dead. The answerer re-gathers
   * automatically when it receives the restart offer (see handleSignal). */
  private async tryIceRestart(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.disposed) return;
    if (this.role !== "offerer") return; // answerer waits for the restart offer
    if (this.iceRestarts >= MAX_ICE_RESTARTS) {
      dbg("ice-restart-capped", { remoteId: this.remoteId, attempts: this.iceRestarts });
      return;
    }
    this.iceRestarts += 1;
    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.emit("ice-restart", { attempt: this.iceRestarts });
      await this.room.sendSignal(this.remoteId, "offer", { type: offer.type, sdp: offer.sdp });
    } catch (err) {
      dbg("ice-restart-failed", { remoteId: this.remoteId, err: String(err) });
    }
  }

  /** Silently discard the current RTCPeerConnection: detach every handler
   *  FIRST so closing channels/pc can't fire disconnect/recovery callbacks. */
  private teardownPc(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.recoveryTimer) { clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
    for (const ch of this.channels.values()) {
      ch.onopen = null; ch.onclose = null; ch.onmessage = null;
      try { ch.close(); } catch { /* already closed */ }
    }
    this.channels.clear();
    const pc = this.pc;
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.onicegatheringstatechange = null;
      pc.ondatachannel = null;
      try { pc.close(); } catch { /* already closed */ }
    }
    this.pc = null;
    this.pendingIce = [];
  }

  /** Tier-2 recovery (offerer side): fetch fresh ICE servers, rebuild the peer
   *  connection, and re-offer with a `renegotiate` marker so the answerer
   *  rebuilds too. One shot per transport — if THIS doesn't connect within the
   *  normal connect budget, the disconnect is final. */
  private async renegotiate(reason: string): Promise<void> {
    if (this.disposed || this.firedDisconnect || this.renegotiated) return;
    this.renegotiated = true;
    dbg("renegotiate", { remoteId: this.remoteId, reason });
    this.emit("renegotiating", { reason });
    const fresh = await this.room.refreshIce();
    if (this.disposed || this.firedDisconnect) return;
    if (fresh) this.rtcConfigCurrent = rtcConfigFromIceServers(fresh) ?? null;
    this.teardownPc();
    await this.start(true);
  }

  async start(renegotiate = false): Promise<void> {
    this.startedAtMs = Date.now();
    this.pc = new RTCPeerConnection(this.rtcConfigCurrent ?? this.rtcConfig);
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
      if (s === "connected") {
        // (Re)established — cancel any pending grace teardown.
        this.onConnectionHealthy();
      } else if (s === "closed") {
        // We closed it (dispose / explicit teardown). Terminal.
        this.fireDisconnectOnce("connectionState=closed");
      } else if (s === "failed" || s === "disconnected") {
        // RECOVERABLE — do NOT tear down. Arm the grace window + ICE restart
        // so ICE can fail over to the TURN relay instead of killing the room.
        this.startRecovery(`connectionState=${s}`);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc?.iceConnectionState;
      dbg("iceconnectionstate", { remoteId: this.remoteId, state: s });
      this.emit("ice-state", { state: s });
      if (s === "connected" || s === "completed") {
        this.onConnectionHealthy();
        return;
      }
      // Capture candidate-pair state at the moment of failure / disconnect.
      // Critical: do this BEFORE any teardown nulls out `this.pc` and makes
      // getStats unreachable.
      if (s === "failed" || s === "disconnected") {
        void this.collectCandidatePairs().then((pairs) => {
          if (pairs.length > 0) {
            console.error(`[webrtc] iceConnectionState=${s} pairs for peer ${this.remoteId}`, pairs);
            this.emit("pairs-on-fail", { state: s, pairs });
          }
        }).catch(() => { /* PC may already be gone */ });
        // Recover rather than disconnect. Safari/iOS sometimes never advances
        // `connectionState` past 'connecting' even after ICE fails, so this is
        // the only signal we get there — route it through recovery too.
        this.startRecovery(`iceConnectionState=${s}`);
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
      await this.room.sendSignal(this.remoteId, "offer", {
        type: offer.type,
        sdp: offer.sdp,
        ...(renegotiate ? { renegotiate: true } : {}),
      });
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
        if (!this.reportedConnected) {
          this.reportedConnected = true;
          void this.reportTelemetry("connected");
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
    if (!this.pc) return;
    dbg("signal-in", {
      remoteId: this.remoteId,
      type: signal.signal_type,
      hasRemoteDesc: !!this.pc.remoteDescription,
    });
    try {
      // Peer-initiated tier-2 recovery: the offerer built a brand-new
      // RTCPeerConnection with fresh relays — mirror it: fresh ICE, new pc
      // (via start(): re-arms ondatachannel + the connect budget), THEN apply
      // the offer below against the new pc.
      if (
        signal.signal_type === "offer" &&
        this.role === "answerer" &&
        (signal.payload as { renegotiate?: boolean }).renegotiate === true &&
        this.pc.remoteDescription
      ) {
        dbg("renegotiate-accept", { remoteId: this.remoteId });
        this.emit("renegotiating", { reason: "peer-initiated" });
        this.renegotiated = true;
        const fresh = await this.room.refreshIce();
        if (this.disposed || this.firedDisconnect) return;
        if (fresh) this.rtcConfigCurrent = rtcConfigFromIceServers(fresh) ?? null;
        this.teardownPc();
        await this.start();
      }
      const pc = this.pc;
      if (!pc) return;
      if (signal.signal_type === "offer" && this.role === "answerer") {
        this.emit("offer-received");
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await this.addRemote(c);
        this.pendingIce = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.emit("answer-sent");
        await this.room.sendSignal(this.remoteId, "answer", { type: answer.type, sdp: answer.sdp });
      } else if (signal.signal_type === "answer" && this.role === "offerer") {
        this.emit("answer-received");
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        for (const c of this.pendingIce) await this.addRemote(c);
        this.pendingIce = [];
      } else if (signal.signal_type === "ice_candidate") {
        if (!pc.remoteDescription) {
          this.pendingIce.push(signal.payload as RTCIceCandidateInit);
        } else {
          await this.addRemote(signal.payload as RTCIceCandidateInit);
        }
      }
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  send(channel: ChannelName | string | undefined, data: string | ArrayBuffer | ArrayBufferView): boolean {
    const label = channel ?? channelsForKind(this.remoteKind).primary;
    const ch = this.channels.get(label);
    if (ch?.readyState !== "open") return false;
    if (ch.bufferedAmount > WebRtcTransport.MAX_BUFFERED) return false; // link stalled — drop
    try {
      ch.send(data as string);
      return true;
    } catch {
      // Race between the readyState/buffer checks and send (closing channel, or
      // the queue filled this tick). Drop — never let a send kill the caller.
      return false;
    }
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
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.channels.clear();
    this.pendingIce = [];
  }
}
