import { SignalingService } from "./SignalingService";
import type {
  Signal,
  HostCallbacks,
  ControllerCallbacks,
} from "./types";

const DEFAULT_RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// HostWebRTCManager
//
// Manages one RTCPeerConnection + RTCDataChannel per connected player.
// Call connectToPlayer(playerId) when a new player appears in the session.
// Pass signals from the polling loop to handleSignal().
// ─────────────────────────────────────────────────────────────────────────────

export class HostWebRTCManager {
  private readonly signaling: SignalingService;
  private readonly sessionId: string;
  private readonly callbacks: HostCallbacks;
  private readonly rtcConfig: RTCConfiguration;

  private peers: Map<string, RTCPeerConnection> = new Map();
  private channels: Map<string, RTCDataChannel> = new Map();
  // Buffer ICE candidates that arrive before the answer (remoteDescription)
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();

  constructor(
    sessionId: string,
    signaling: SignalingService,
    callbacks: HostCallbacks = {},
    rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {
    this.sessionId = sessionId;
    this.signaling = signaling;
    this.callbacks = callbacks;
    this.rtcConfig = rtcConfig;
  }

  async handleSignal(signal: Signal): Promise<void> {
    const { sender_id, signal_type, payload } = signal;
    console.log(`[Host] handleSignal: type=${signal_type} from=${sender_id}`);
    const pc = this.peers.get(sender_id);
    if (!pc) {
      console.warn(`[Host] No peer for sender_id=${sender_id}, known peers:`, [...this.peers.keys()]);
      return;
    }

    try {
      if (signal_type === "answer") {
        console.log(`[Host] Setting remote description (answer) from ${sender_id}`);
        await pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
        console.log(`[Host] Remote description set successfully, signalingState=${pc.signalingState}`);
        // Flush any ICE candidates that arrived before the answer
        const pending = this.pendingCandidates.get(sender_id);
        if (pending && pending.length > 0) {
          console.log(`[Host] Flushing ${pending.length} buffered ICE candidates for ${sender_id}`);
          for (const candidate of pending) {
            await pc.addIceCandidate(candidate);
          }
          this.pendingCandidates.delete(sender_id);
        }
      } else if (signal_type === "ice_candidate") {
        if (!pc.remoteDescription) {
          // Buffer — answer hasn't arrived yet
          let pending = this.pendingCandidates.get(sender_id);
          if (!pending) {
            pending = [];
            this.pendingCandidates.set(sender_id, pending);
          }
          pending.push(payload as RTCIceCandidateInit);
          console.log(`[Host] Buffered ICE candidate from ${sender_id} (total: ${pending.length})`);
        } else {
          console.log(`[Host] Adding ICE candidate from ${sender_id}`);
          await pc.addIceCandidate(payload as RTCIceCandidateInit);
        }
      }
    } catch (err) {
      console.error(`[Host] handleSignal error (${signal_type}):`, err);
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async connectToPlayer(playerId: string): Promise<void> {
    if (this.peers.has(playerId)) return;

    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peers.set(playerId, pc);

    const dc = pc.createDataChannel("game-input", { ordered: true });
    this.channels.set(playerId, dc);

    dc.onopen = () => this.callbacks.onPlayerConnected?.(playerId);
    dc.onclose = () => this.callbacks.onPlayerDisconnected?.(playerId);
    dc.onmessage = (e) => this.callbacks.onMessage?.(playerId, e.data);

    pc.onicecandidate = async (event) => {
      if (!event.candidate) {
        console.log(`[Host] ICE gathering complete for ${playerId}`);
        return;
      }
      console.log(`[Host] Sending ICE candidate to ${playerId}: ${event.candidate.candidate.slice(0, 60)}...`);
      try {
        await this.signaling.sendSignal(
          this.sessionId,
          playerId,
          "ice_candidate",
          event.candidate.toJSON() as Record<string, unknown>,
        );
      } catch (err) {
        console.error(`[Host] Failed to send ICE candidate to ${playerId}:`, err);
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[Host] Peer ${playerId} ICE connection state: ${pc.iceConnectionState}`);
    };

    pc.onicegatheringstatechange = () => {
      console.log(`[Host] Peer ${playerId} ICE gathering state: ${pc.iceGatheringState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Host] Peer ${playerId} connection state: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.callbacks.onPlayerDisconnected?.(playerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.signaling.sendSignal(this.sessionId, playerId, "offer", {
        type: offer.type,
        sdp: offer.sdp,
      });
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  send(playerId: string, data: string | ArrayBuffer): void {
    const dc = this.channels.get(playerId);
    if (dc?.readyState === "open") dc.send(data as string);
  }

  broadcast(data: string | ArrayBuffer): void {
    for (const [playerId] of this.channels) {
      this.send(playerId, data);
    }
  }

  getConnectedPlayers(): string[] {
    return [...this.channels.entries()]
      .filter(([, dc]) => dc.readyState === "open")
      .map(([id]) => id);
  }

  dispose(): void {
    this.signaling.stopPolling();
    for (const [, pc] of this.peers) pc.close();
    this.peers.clear();
    this.channels.clear();
    this.pendingCandidates.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ControllerWebRTCManager
//
// Manages a single RTCPeerConnection to the host.
// Call startListening() after joining the session.
// ─────────────────────────────────────────────────────────────────────────────

export class ControllerWebRTCManager {
  private readonly signaling: SignalingService;
  private readonly sessionId: string;
  private readonly playerId: string;
  private readonly callbacks: ControllerCallbacks;
  private readonly rtcConfig: RTCConfiguration;

  private pc: RTCPeerConnection | null = null;
  public dataChannel: RTCDataChannel | null = null;
  // Buffer ICE candidates that arrive before the offer (remoteDescription)
  private pendingCandidates: RTCIceCandidateInit[] = [];

  constructor(
    sessionId: string,
    playerId: string,
    signaling: SignalingService,
    callbacks: ControllerCallbacks = {},
    rtcConfig: RTCConfiguration = DEFAULT_RTC_CONFIG,
  ) {
    this.sessionId = sessionId;
    this.playerId = playerId;
    this.signaling = signaling;
    this.callbacks = callbacks;
    this.rtcConfig = rtcConfig;
  }

  startListening(): void {
    this.pc = new RTCPeerConnection(this.rtcConfig);

    this.pc.ondatachannel = (event) => {
      console.log(`[Controller] Data channel received: ${event.channel.label}`);
      this.dataChannel = event.channel;
      this.dataChannel.onopen = () => {
        console.log("[Controller] Data channel OPEN");
        this.callbacks.onConnected?.();
      };
      this.dataChannel.onclose = () => {
        console.log("[Controller] Data channel closed");
        this.callbacks.onDisconnected?.();
      };
      this.dataChannel.onmessage = (e) => this.callbacks.onMessage?.(e.data);
    };

    this.pc.onconnectionstatechange = () => {
      console.log(`[Controller] Connection state: ${this.pc?.connectionState}`);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log(`[Controller] ICE connection state: ${this.pc?.iceConnectionState}`);
    };

    this.pc.onicegatheringstatechange = () => {
      console.log(`[Controller] ICE gathering state: ${this.pc?.iceGatheringState}`);
    };

    this.pc.onicecandidate = async (event) => {
      if (!event.candidate) {
        console.log("[Controller] ICE gathering complete");
        return;
      }
      console.log(`[Controller] Sending ICE candidate to host: ${event.candidate.candidate.slice(0, 60)}...`);
      try {
        await this.signaling.sendSignal(
          this.sessionId,
          "host",
          "ice_candidate",
          event.candidate.toJSON() as Record<string, unknown>,
        );
      } catch (err) {
        console.error("[Controller] Failed to send ICE candidate:", err);
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    this.signaling.startPolling(this.sessionId, this.playerId, (signal) => {
      return this.handleSignal(signal);
    });
  }

  private async handleSignal(signal: Signal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;

    console.log(`[Controller] handleSignal: type=${signal.signal_type} from=${signal.sender_id}`);

    try {
      if (signal.signal_type === "offer") {
        console.log("[Controller] Received offer, setting remote description...");
        await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
        console.log(`[Controller] Remote description set, signalingState=${pc.signalingState}`);
        // Flush any ICE candidates that arrived before the offer
        if (this.pendingCandidates.length > 0) {
          console.log(`[Controller] Flushing ${this.pendingCandidates.length} buffered ICE candidates`);
          for (const candidate of this.pendingCandidates) {
            await pc.addIceCandidate(candidate);
          }
          this.pendingCandidates = [];
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("[Controller] Sending answer...");
        await this.signaling.sendSignal(this.sessionId, "host", "answer", {
          type: answer.type,
          sdp: answer.sdp,
        });
        console.log("[Controller] Answer sent successfully");
      } else if (signal.signal_type === "ice_candidate") {
        if (!pc.remoteDescription) {
          // Buffer — offer hasn't arrived yet
          this.pendingCandidates.push(signal.payload as RTCIceCandidateInit);
          console.log(`[Controller] Buffered ICE candidate (total: ${this.pendingCandidates.length})`);
        } else {
          console.log("[Controller] Adding ICE candidate from host");
          await pc.addIceCandidate(signal.payload as RTCIceCandidateInit);
        }
      }
    } catch (err) {
      console.error(`[Controller] handleSignal error (${signal.signal_type}):`, err);
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(data as string);
    }
  }

  dispose(): void {
    this.signaling.stopPolling();
    this.pc?.close();
    this.pc = null;
    this.dataChannel = null;
    this.pendingCandidates = [];
  }
}
