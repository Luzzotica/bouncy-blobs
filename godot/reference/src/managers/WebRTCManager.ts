import { SignalingService } from "../services/signalingService";
import type { Player } from "../types/database";

export interface WebRTCMessage {
  type: string;
  playerId?: string;
  inputType?: string;
  value?: any;
  timestamp?: number;
  config?: any;
  reason?: string;
  player?: Player;
  // Batched inputs - more efficient than sending individual inputs
  inputs?: {
    joystick_left?: { x: number; y: number };
    joystick_right?: { x: number; y: number };
    button_left?: { pressed: boolean };
    button_right?: { pressed: boolean };
  };
}

/**
 * WebRTCManager - Manages WebRTC peer connections
 * Handles both GameMaster and Controller roles
 */
export class WebRTCManager {
  private readonly sessionId: number;
  private role: "gamemaster" | "controller";
  private playerId?: string;
  private signalingService: SignalingService;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private dataChannels: Map<string, RTCDataChannel> = new Map();
  private onMessage?: (message: WebRTCMessage, playerId: string) => void;
  private onConnectionStateChange?: (playerId: string, state: RTCPeerConnectionState) => void;
  private processedAnswers: Set<string> = new Set(); // Track processed answers to avoid duplicates
  private processedOffers: Set<string> = new Set(); // Track processed offers to avoid duplicates

  // STUN servers for NAT traversal
  private readonly rtcConfiguration: RTCConfiguration = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  constructor(
    sessionId: number,
    role: "gamemaster" | "controller",
    playerId?: string,
  ) {
    this.sessionId = sessionId;
    this.role = role;
    this.playerId = playerId;
    // sessionId is used here to create SignalingService
    this.signalingService = new SignalingService(sessionId, role, playerId);
  }

  /**
   * Get the session ID
   */
  getSessionId(): number {
    return this.sessionId;
  }

  /**
   * Initialize as GameMaster - wait for controllers to connect
   */
  async initializeAsGameMaster(
    onMessage: (message: WebRTCMessage, playerId: string) => void,
    onConnectionStateChange?: (playerId: string, state: RTCPeerConnectionState) => void,
  ): Promise<void> {
    this.onMessage = onMessage;
    this.onConnectionStateChange = onConnectionStateChange;

    // Start polling for answers and ICE candidates
    this.signalingService.startPolling(
      undefined, // No offers for GameMaster
      async (answer, playerId) => {
        // Create a unique key for this answer to avoid reprocessing
        const answerKey = `${playerId}_${answer.sdp?.substring(0, 50) || 'unknown'}`;
        if (this.processedAnswers.has(answerKey)) {
          return; // Already processed this answer
        }
        this.processedAnswers.add(answerKey);
        await this.handleAnswer(answer, playerId);
      },
      async (candidate, playerId) => {
        if (playerId) {
          await this.handleIceCandidate(candidate, playerId);
        }
      },
    );

    // Poll for new players and create peer connections
    this.startPlayerPolling();
  }

  /**
   * Initialize as Controller - connect to GameMaster
   */
  async initializeAsController(
    onMessage: (message: WebRTCMessage) => void,
    onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
  ): Promise<void> {
    this.onMessage = (msg, _playerId) => {
      // Controller only receives messages from GameMaster
      onMessage(msg);
    };
    if (onConnectionStateChange) {
      this.onConnectionStateChange = (playerId, state) => {
        if (playerId === "gamemaster") {
          onConnectionStateChange(state);
        }
      };
    }

    // Poll for offer with playerId (once we have it)
    const checkForOffer = async () => {
      if (!this.playerId) return;
      const offer = await this.signalingService.pollForOffer(this.playerId);
      if (offer && !this.peerConnections.has("gamemaster")) {
        await this.handleOffer(offer);
      }
    };

    // Initial check
    checkForOffer();

    // Poll every 500ms for offer
    const offerPollInterval = setInterval(checkForOffer, 500);

    // Also set up ICE candidate polling
    this.signalingService.startPolling(
      undefined, // We handle offer polling manually above
      undefined, // No answers for Controller
      async (candidate) => {
        await this.handleIceCandidate(candidate, "gamemaster");
      },
    );

    // Store interval for cleanup
    (this as any).offerPollInterval = offerPollInterval;
  }

  /**
   * Set player ID (for Controller, called after joining session)
   */
  setPlayerId(playerId: string): void {
    this.playerId = playerId;
    // Update the signaling service's playerId
    (this.signalingService as any).playerId = playerId;
  }

  /**
   * Create a peer connection for a controller (GameMaster side)
   */
  async createPeerConnectionForController(playerId: string): Promise<void> {
    if (this.role !== "gamemaster") {
      throw new Error("Only GameMaster can create peer connections for controllers");
    }

    // Check if we have an existing connection
    if (this.peerConnections.has(playerId)) {
      const existingPc = this.peerConnections.get(playerId);
      if (existingPc) {
        const state = existingPc.connectionState;
        const signalingState = existingPc.signalingState;
        
        // If connection is in progress (connecting, have-local-offer, etc.), don't create a new one
        if (state === "connecting" || state === "new" || signalingState === "have-local-offer") {
          console.log(`[WebRTCManager] Connection for ${playerId} is in progress (state: ${state}, signaling: ${signalingState}), skipping`);
          return;
        }
        
        // If connection is stable and working, don't create a new one
        if (state === "connected") {
          console.log(`[WebRTCManager] Connection for ${playerId} is already connected, skipping`);
          return;
        }
        
        // If connection is closed, failed, or disconnected, close it and create a new one
        if (state === "closed" || state === "failed" || state === "disconnected") {
          console.log(`[WebRTCManager] Existing connection for ${playerId} is ${state}, closing and recreating`);
          existingPc.close();
          this.peerConnections.delete(playerId);
          this.dataChannels.delete(playerId);
          // Clear processed answers for this player only to allow reconnection
          // (We'll filter by playerId prefix instead of clearing all)
          for (const key of this.processedAnswers) {
            if (key.startsWith(playerId)) {
              this.processedAnswers.delete(key);
            }
          }
        } else {
          console.log(`[WebRTCManager] Peer connection exists for ${playerId} with state ${state}, skipping`);
          return;
        }
      }
    }

    const pc = new RTCPeerConnection(this.rtcConfiguration);
    this.peerConnections.set(playerId, pc);

    // Create data channel
    const dataChannel = pc.createDataChannel("game", {
      ordered: true,
    });
    this.setupDataChannel(dataChannel, playerId);

    // Handle ICE candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await this.signalingService.storeIceCandidate(event.candidate.toJSON());
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTCManager] Connection state for ${playerId}: ${state}`);
      
      // Log ICE connection state for debugging
      if (pc.iceConnectionState) {
        console.log(`[WebRTCManager] ICE connection state for ${playerId}: ${pc.iceConnectionState}`);
      }
      
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(playerId, state);
      }

      if (state === "failed") {
        console.error(`[WebRTCManager] Connection failed for ${playerId}. ICE state: ${pc.iceConnectionState}`);
        // Log ICE gathering state for debugging
        console.log(`[WebRTCManager] ICE gathering state: ${pc.iceGatheringState}`);
        
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (pc.connectionState === "failed") {
            console.log(`[WebRTCManager] Attempting to reconnect ${playerId}`);
            this.reconnect(playerId);
          }
        }, 2000);
      } else if (state === "disconnected") {
        console.warn(`[WebRTCManager] Connection disconnected for ${playerId}. ICE state: ${pc.iceConnectionState}`);
      } else if (state === "connected") {
        console.log(`[WebRTCManager] Successfully connected to ${playerId}`);
      }
    };

    // Handle ICE connection state changes (more detailed than connectionState)
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log(`[WebRTCManager] ICE connection state changed for ${playerId}: ${iceState}`);
      
      if (iceState === "failed") {
        console.error(`[WebRTCManager] ICE connection failed for ${playerId}. This may indicate network/firewall issues.`);
      } else if (iceState === "disconnected") {
        console.warn(`[WebRTCManager] ICE disconnected for ${playerId}`);
      } else if (iceState === "connected" || iceState === "completed") {
        console.log(`[WebRTCManager] ICE connection established for ${playerId}`);
      }
    };

    // Create and store offer (with playerId so Controller can find it)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.signalingService.storeOffer(offer, playerId);

    console.log(`[WebRTCManager] Created peer connection for ${playerId}`);
  }

  /**
   * Handle offer from GameMaster (Controller side)
   */
  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (this.role !== "controller") {
      return;
    }

    const playerId = "gamemaster";
    
    // If we have an existing connection, check its state
    if (this.peerConnections.has(playerId)) {
      const existingPc = this.peerConnections.get(playerId);
      if (existingPc) {
        const state = existingPc.connectionState;
        const signalingState = existingPc.signalingState;
        
        // If connection is in progress, ignore new offers
        if (state === "connecting" || state === "new" || signalingState === "have-local-offer" || signalingState === "have-remote-offer") {
          console.log(`[WebRTCManager] Connection in progress (state: ${state}, signaling: ${signalingState}), ignoring new offer`);
          return;
        }
        
        // If connected, ignore new offers
        if (state === "connected") {
          console.log("[WebRTCManager] Already connected, ignoring new offer");
          return;
        }
        
        // Only close if it's disconnected, failed, or closed
        if (state === "closed" || state === "failed" || state === "disconnected") {
          console.log(`[WebRTCManager] Closing existing ${state} connection to allow reconnection`);
          existingPc.close();
          this.peerConnections.delete(playerId);
          this.dataChannels.delete(playerId);
          // Reset processed offers to allow reconnection
          this.processedOffers.clear();
        } else {
          console.log(`[WebRTCManager] Peer connection exists with state ${state}, ignoring offer`);
          return;
        }
      }
    }

    // Create a unique key for this offer to avoid reprocessing
    const offerKey = `${offer.sdp?.substring(0, 50) || 'unknown'}`;
    if (this.processedOffers.has(offerKey)) {
      console.log("[WebRTCManager] Offer already processed, ignoring");
      return;
    }
    this.processedOffers.add(offerKey);

    const pc = new RTCPeerConnection(this.rtcConfiguration);
    this.peerConnections.set(playerId, pc);

    // Handle data channel from GameMaster
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      this.setupDataChannel(dataChannel, playerId);
    };

    // Handle ICE candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await this.signalingService.storeIceCandidate(event.candidate.toJSON());
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTCManager] Connection state: ${state}`);
      
      // Log ICE connection state for debugging
      if (pc.iceConnectionState) {
        console.log(`[WebRTCManager] ICE connection state: ${pc.iceConnectionState}`);
      }
      
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(playerId, state);
      }
    };

    // Handle ICE connection state changes (more detailed)
    // This is important because connectionState might not update properly on some browsers
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      const connectionState = pc.connectionState;
      console.log(`[WebRTCManager] ICE connection state changed: ${iceState}, connection state: ${connectionState}`);
      
      if (iceState === "failed") {
        console.error(`[WebRTCManager] ICE connection failed. This may indicate network/firewall issues.`);
        console.log(`[WebRTCManager] Connection state: ${connectionState}, ICE gathering: ${pc.iceGatheringState}`);
        // Notify as failed
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(playerId, "failed");
        }
      } else if (iceState === "connected" || iceState === "completed") {
        console.log(`[WebRTCManager] ICE connection established successfully`);
        // If connectionState hasn't updated yet, manually trigger the connected callback
        // Some browsers don't update connectionState reliably
        if (connectionState !== "connected" && this.onConnectionStateChange) {
          console.log(`[WebRTCManager] Triggering connected state from ICE (connectionState was: ${connectionState})`);
          this.onConnectionStateChange(playerId, "connected");
        }
      } else if (iceState === "disconnected") {
        console.warn(`[WebRTCManager] ICE disconnected`);
        if (this.onConnectionStateChange) {
          this.onConnectionStateChange(playerId, "disconnected");
        }
      }
    };

    await pc.setRemoteDescription(offer);

    // Create and store answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signalingService.storeAnswer(answer);

    console.log("[WebRTCManager] Handled offer from GameMaster");
  }

  /**
   * Handle answer from Controller (GameMaster side)
   */
  private async handleAnswer(
    answer: RTCSessionDescriptionInit,
    playerId: string,
  ): Promise<void> {
    if (this.role !== "gamemaster") {
      return;
    }

    const pc = this.peerConnections.get(playerId);
    if (!pc) {
      console.warn(`[WebRTCManager] No peer connection found for ${playerId}`);
      return;
    }

    // Check if we're in the correct state to receive an answer
    // Answers can only be set when signalingState is "have-local-offer"
    if (pc.signalingState !== "have-local-offer") {
      // Already stable or in wrong state - silently ignore duplicate/late answers
      return;
    }

    if (pc.remoteDescription) {
      // Already set - this is expected after first time, no need to log repeatedly
      return;
    }

    try {
      await pc.setRemoteDescription(answer);
      console.log(`[WebRTCManager] Handled answer from ${playerId}`);
    } catch (error) {
      console.error(`[WebRTCManager] Failed to set remote description for ${playerId}:`, error);
    }
  }

  /**
   * Handle ICE candidate
   */
  private async handleIceCandidate(
    candidate: RTCIceCandidateInit,
    playerId: string,
  ): Promise<void> {
    const pc = this.peerConnections.get(playerId);
    if (!pc) {
      // Silently ignore - peer connection may have been closed/cleaned up
      // This is expected when players disconnect
      return;
    }

    // Check if connection is still valid
    if (pc.connectionState === "closed") {
      return;
    }

    try {
      await pc.addIceCandidate(candidate);
    } catch (error: any) {
      // Ignore "InvalidStateError" - happens when connection is closing
      if (error?.name !== "InvalidStateError") {
        console.error(`[WebRTCManager] Failed to add ICE candidate for ${playerId}:`, error);
      }
    }
  }

  /**
   * Setup data channel event handlers
   */
  private setupDataChannel(
    dataChannel: RTCDataChannel,
    playerId: string,
  ): void {
    dataChannel.onopen = () => {
      console.log(`[WebRTCManager] Data channel opened for ${playerId}`);
      this.dataChannels.set(playerId, dataChannel);
      // Data channel open is the most reliable indicator that connection is working
      // Trigger connected state in case connectionState hasn't updated
      if (this.onConnectionStateChange) {
        console.log(`[WebRTCManager] Triggering connected state from data channel open`);
        this.onConnectionStateChange(playerId, "connected");
      }
    };

    dataChannel.onclose = () => {
      console.log(`[WebRTCManager] Data channel closed for ${playerId}`);
      this.dataChannels.delete(playerId);
      // Notify about disconnection
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(playerId, "closed");
      }
    };

    dataChannel.onerror = (error) => {
      console.error(`[WebRTCManager] Data channel error for ${playerId}:`, error);
    };

    dataChannel.onmessage = (event) => {
      try {
        const message: WebRTCMessage = JSON.parse(event.data);
        if (this.onMessage) {
          this.onMessage(message, playerId);
        }
      } catch (error) {
        console.error(`[WebRTCManager] Failed to parse message:`, error);
      }
    };
  }

  /**
   * Send message to a specific player (GameMaster side)
   */
  sendToPlayer(playerId: string, message: WebRTCMessage): void {
    const dataChannel = this.dataChannels.get(playerId);
    if (dataChannel && dataChannel.readyState === "open") {
      dataChannel.send(JSON.stringify(message));
    } else {
      console.warn(`[WebRTCManager] Data channel not open for ${playerId}`);
    }
  }

  /**
   * Broadcast message to all connected players (GameMaster side)
   */
  broadcast(message: WebRTCMessage): void {
    if (this.role !== "gamemaster") {
      throw new Error("Only GameMaster can broadcast");
    }

    for (const [_playerId, dataChannel] of this.dataChannels.entries()) {
      if (dataChannel.readyState === "open") {
        dataChannel.send(JSON.stringify(message));
      }
    }
  }

  /**
   * Send message to GameMaster (Controller side)
   */
  sendToGameMaster(message: WebRTCMessage): void {
    if (this.role !== "controller") {
      throw new Error("Only Controller can send to GameMaster");
    }

    const dataChannel = this.dataChannels.get("gamemaster");
    if (dataChannel && dataChannel.readyState === "open") {
      dataChannel.send(JSON.stringify(message));
    } else {
      console.warn("[WebRTCManager] Data channel not open for GameMaster");
    }
  }

  /**
   * Poll for new players and create peer connections (GameMaster side)
   */
  private startPlayerPolling(): void {
    // This will be called from GameMaster to check for new players
    // The actual polling logic is in GameMaster component
  }

  /**
   * Reconnect a peer connection
   */
  private async reconnect(playerId: string): Promise<void> {
    console.log(`[WebRTCManager] Attempting to reconnect ${playerId}`);
    const pc = this.peerConnections.get(playerId);
    if (!pc) {
      return;
    }

    if (pc.connectionState === "failed") {
      // Close and recreate
      pc.close();
      this.peerConnections.delete(playerId);
      this.dataChannels.delete(playerId);

      if (this.role === "gamemaster") {
        await this.createPeerConnectionForController(playerId);
      }
    }
  }

  /**
   * Close a peer connection
   */
  closeConnection(playerId: string): void {
    const pc = this.peerConnections.get(playerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(playerId);
    }
    this.dataChannels.delete(playerId);
  }

  /**
   * Close all connections
   */
  closeAll(): void {
    for (const [_playerId, pc] of this.peerConnections.entries()) {
      pc.close();
    }
    this.peerConnections.clear();
    this.dataChannels.clear();
    // Clear processed sets to allow reconnection
    this.processedAnswers.clear();
    this.processedOffers.clear();
    this.signalingService.cleanup();
    
    // Clear offer polling interval if it exists
    if ((this as any).offerPollInterval) {
      clearInterval((this as any).offerPollInterval);
      (this as any).offerPollInterval = null;
    }
  }

  /**
   * Reset processed offers/answers to allow reconnection
   */
  resetProcessedSignaling(): void {
    this.processedAnswers.clear();
    this.processedOffers.clear();
  }

  /**
   * Get connection state for a player
   */
  getConnectionState(playerId: string): RTCPeerConnectionState | null {
    const pc = this.peerConnections.get(playerId);
    return pc ? pc.connectionState : null;
  }

  /**
   * Get all connected player IDs
   */
  getConnectedPlayers(): string[] {
    return Array.from(this.dataChannels.keys()).filter(
      (playerId) => this.dataChannels.get(playerId)?.readyState === "open",
    );
  }
}

