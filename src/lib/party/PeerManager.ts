// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// PeerManager
//
// One class to handle every peer connection in a room — host or joiner, phone
// or screen. Holds a registry of Transports keyed by remote peer id and
// routes sends, broadcasts, and (WebRTC) signaling to the right one.
//
// Today the only Transport implementation is WebRtcTransport. A Steam
// Networking transport will plug in here without touching the call sites in
// game / party / controller code.
//
// Channel topology per peer kind is owned by the Transport (see
// channelsForKind in transport.ts):
//   - 'screen' → 'state' (reliable) + 'input' (unreliable)
//   - 'phone'  → 'data' (reliable)
//
// All signaling for the WebRTC transport goes through the unified
// RoomService. The host calls `connectTo(peerId, kind)` when a new peer
// appears in the room; joiners call `prepareForHost()` once after joining
// and wait for the host's offer.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoomService } from "./RoomService";
import type { PeerCallbacks, Signal } from "./types";
import type { Transport } from "./transport";
import { WebRtcTransport } from "./webrtcTransport";

export class PeerManager {
  private peers: Map<string, Transport> = new Map();

  constructor(
    /** WebRTC signaling backend. Only required when a WebRTC transport is used —
     * Steam-Networking-only setups can pass `null`. */
    private readonly room: RoomService | null,
    private readonly role: "host" | "joiner",
    private readonly callbacks: PeerCallbacks = {},
    private readonly rtcConfig?: RTCConfiguration,
  ) {}

  /** Build the callbacks that a Transport receives. Exposed so external code
   * (e.g. a SteamTransport factory in a lobby flow) can wire a transport into
   * this manager via `attachTransport`. */
  callbacksFor(peerId: string): PeerCallbacks {
    return this.makePeerCallbacks(peerId);
  }

  /** Register an already-constructed Transport (typically a SteamTransport
   * that completed its handshake outside of PeerManager's WebRTC paths). */
  attachTransport(transport: Transport): void {
    this.peers.set(transport.remoteId, transport);
  }

  /** Host-side: open an outbound (offerer) WebRTC connection to a peer that
   * just joined the room. Called once per peer; idempotent. */
  async connectTo(peerId: string, peerKind: string): Promise<void> {
    if (this.peers.has(peerId)) return;
    if (!this.room) throw new Error("PeerManager: WebRTC connectTo requires a RoomService");
    const peer = new WebRtcTransport(
      this.room,
      peerId,
      peerKind,
      "offerer",
      this.makePeerCallbacks(peerId),
      this.rtcConfig,
    );
    this.peers.set(peerId, peer);
    await peer.start();
  }

  /** Joiner-side: set up an inbound (answerer) WebRTC connection for the host.
   *
   * `selfKind` is the joiner's *own* kind, NOT the host's. The host always
   * opens channels based on the remote peer's kind, so the answerer must
   * mirror that to find the right channel names in `sendPrimary`. */
  async prepareForHost(selfKind: string): Promise<void> {
    const key = "host";
    if (this.peers.has(key)) return;
    if (!this.room) throw new Error("PeerManager: WebRTC prepareForHost requires a RoomService");
    const peer = new WebRtcTransport(
      this.room,
      "host",
      selfKind,
      "answerer",
      this.makePeerCallbacks(key),
      this.rtcConfig,
    );
    this.peers.set(key, peer);
    await peer.start();
  }

  private makePeerCallbacks(peerId: string): PeerCallbacks {
    return {
      onPeerConnected: (id, kind) => this.callbacks.onPeerConnected?.(id, kind),
      onPeerDisconnected: (id) => {
        this.callbacks.onPeerDisconnected?.(id);
        // Note: don't auto-delete from this.peers — connection state may
        // recover. Caller (or explicit disposePeer) decides when to clean up.
      },
      onMessage: (id, channel, data) => this.callbacks.onMessage?.(id, channel, data),
      onError: (err) => this.callbacks.onError?.(err),
      onPhase: (id, phase, detail) => this.callbacks.onPhase?.(id, phase, detail),
    };
  }

  /** Route an incoming signal to the correct WebRTC peer. Non-WebRTC
   * transports ignore signals (Steam Networking has its own connection
   * lifecycle and doesn't use SDP/ICE). */
  async handleSignal(signal: Signal): Promise<void> {
    const senderId = signal.sender_peer_id;
    // Joiners only have one peer (the host), keyed by literal "host".
    const peer = this.role === "joiner"
      ? this.peers.get("host")
      : this.peers.get(senderId);
    if (peer instanceof WebRtcTransport) {
      await peer.handleSignal(signal);
    }
  }

  /** Send to a single peer on a named channel (or the peer's primary if omitted). */
  send(peerId: string, channel: string | undefined, data: string | ArrayBuffer | ArrayBufferView): boolean {
    return this.peers.get(peerId)?.send(channel, data) ?? false;
  }

  /** Convenience: send on the peer's primary channel. */
  sendPrimary(peerId: string, data: string | ArrayBuffer | ArrayBufferView): boolean {
    return this.send(peerId, undefined, data);
  }

  /** Broadcast to all connected peers on a named channel. Optional kind
   * filter so e.g. the lobby host can target only screen peers for snapshot
   * broadcast without phone peers receiving snapshot bytes. */
  broadcast(channel: string, data: string | ArrayBuffer | ArrayBufferView, filterByKind?: string): void {
    for (const peer of this.peers.values()) {
      if (filterByKind && peer.remoteKind !== filterByKind) continue;
      peer.send(channel, data);
    }
  }

  /** The remote kind ('phone' | 'screen' | …) of a known peer, or undefined
   * if no transport is registered for that id. Used by the host to route
   * incoming messages by peer kind rather than by channel name (phones and
   * screens now share the unreliable 'input' channel but speak different
   * message schemas on it). */
  getPeerKind(peerId: string): string | undefined {
    return this.peers.get(peerId)?.remoteKind;
  }

  getConnectedPeers(): { peerId: string; kind: string }[] {
    return [...this.peers.values()]
      .filter((p) => p.isOpen())
      .map((p) => ({ peerId: p.remoteId, kind: p.remoteKind }));
  }

  /** Returns every transport for diagnostics (e.g. dumping candidate pairs).
   * Don't use this to drive game logic — `getConnectedPeers` is the live set. */
  getAllTransports(): Transport[] {
    return [...this.peers.values()];
  }

  /** Dispose a single peer connection (e.g. when a remote peer's room row
   * disappears). Safe to call repeatedly. */
  disposePeer(peerId: string): void {
    this.peers.get(peerId)?.dispose();
    this.peers.delete(peerId);
  }

  dispose(): void {
    this.room?.stopPolling();
    for (const p of this.peers.values()) p.dispose();
    this.peers.clear();
  }
}
