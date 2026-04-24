import { supabase } from "../lib/supabase";

export interface SignalingMessage {
  id: number;
  session_id: number;
  role: "gamemaster" | "controller";
  player_id?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  ice_candidate?: RTCIceCandidateInit;
  created_at: string;
}

/**
 * SignalingService - Handles WebRTC signaling via Supabase database
 * Uses HTTP polling instead of realtime subscriptions
 */
export class SignalingService {
  private sessionId: number;
  private role: "gamemaster" | "controller";
  private playerId?: string;
  private pollingInterval?: number;
  private onOffer?: (offer: RTCSessionDescriptionInit) => void;
  private onAnswer?: (answer: RTCSessionDescriptionInit, playerId: string) => void;
  private onIceCandidate?: (candidate: RTCIceCandidateInit, playerId?: string) => void;

  constructor(
    sessionId: number,
    role: "gamemaster" | "controller",
    playerId?: string,
  ) {
    this.sessionId = sessionId;
    this.role = role;
    this.playerId = playerId;
  }

  /**
   * Store an offer in the database
   */
  async storeOffer(offer: RTCSessionDescriptionInit, targetPlayerId?: string): Promise<void> {
    const { error } = await supabase.from("signaling").insert({
      session_id: this.sessionId,
      role: this.role,
      player_id: targetPlayerId || this.playerId, // Use targetPlayerId if provided (for GameMaster)
      offer: offer as any,
    });

    if (error) {
      console.error("[SignalingService] Failed to store offer:", error);
      throw error;
    }
  }

  /**
   * Store an answer in the database
   */
  async storeAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    const { error } = await supabase.from("signaling").insert({
      session_id: this.sessionId,
      role: this.role,
      player_id: this.playerId,
      answer: answer as any,
    });

    if (error) {
      console.error("[SignalingService] Failed to store answer:", error);
      throw error;
    }
  }

  /**
   * Store an ICE candidate in the database
   */
  async storeIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    const { error } = await supabase.from("signaling").insert({
      session_id: this.sessionId,
      role: this.role,
      player_id: this.playerId,
      ice_candidate: candidate as any,
    });

    if (error) {
      console.error("[SignalingService] Failed to store ICE candidate:", error);
      throw error;
    }
  }

  /**
   * Poll for offers (Controller side)
   * If playerId is provided, only get offers for that specific player
   * Only returns offers from the last 30 seconds to avoid processing old offers
   */
  async pollForOffer(playerId?: string): Promise<RTCSessionDescriptionInit | null> {
    let query = supabase
      .from("signaling")
      .select("*")
      .eq("session_id", this.sessionId)
      .eq("role", "gamemaster")
      .not("offer", "is", null)
      .gte("created_at", new Date(Date.now() - 30000).toISOString()); // Only last 30 seconds

    // If playerId is provided, filter by it (offer was created for this specific player)
    if (playerId) {
      query = query.eq("player_id", playerId);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") {
        // No rows found
        return null;
      }
      console.error("[SignalingService] Failed to poll for offer:", error);
      return null;
    }

    return (data as SignalingMessage)?.offer || null;
  }

  /**
   * Poll for answers (GameMaster side)
   * Returns only answers from the last 30 seconds to avoid processing old answers
   */
  async pollForAnswers(): Promise<
    Array<{ answer: RTCSessionDescriptionInit; playerId: string }>
  > {
    const { data, error } = await supabase
      .from("signaling")
      .select("*")
      .eq("session_id", this.sessionId)
      .eq("role", "controller")
      .not("answer", "is", null)
      .gte("created_at", new Date(Date.now() - 30000).toISOString()) // Only last 30 seconds
      .order("created_at", { ascending: false })
      .limit(20); // Limit to recent answers

    if (error) {
      console.error("[SignalingService] Failed to poll for answers:", error);
      return [];
    }

    return (data as SignalingMessage[])
      .filter((msg) => msg.answer)
      .map((msg) => ({
        answer: msg.answer!,
        playerId: msg.player_id || "",
      }));
  }

  /**
   * Poll for ICE candidates
   * Only returns candidates from the last 30 seconds to avoid processing old candidates
   */
  async pollForIceCandidates(
    targetRole: "gamemaster" | "controller",
  ): Promise<Array<{ candidate: RTCIceCandidateInit; playerId?: string }>> {
    const { data, error } = await supabase
      .from("signaling")
      .select("*")
      .eq("session_id", this.sessionId)
      .eq("role", targetRole)
      .not("ice_candidate", "is", null)
      .gte("created_at", new Date(Date.now() - 30000).toISOString()) // Only last 30 seconds
      .order("created_at", { ascending: false })
      .limit(50); // Limit to recent candidates

    if (error) {
      console.error("[SignalingService] Failed to poll for ICE candidates:", error);
      return [];
    }

    return (data as SignalingMessage[])
      .filter((msg) => msg.ice_candidate)
      .map((msg) => ({
        candidate: msg.ice_candidate!,
        playerId: msg.player_id,
      }));
  }

  /**
   * Start polling for signaling messages
   */
  startPolling(
    onOffer?: (offer: RTCSessionDescriptionInit) => void,
    onAnswer?: (answer: RTCSessionDescriptionInit, playerId: string) => void,
    onIceCandidate?: (candidate: RTCIceCandidateInit, playerId?: string) => void,
  ): void {
    this.onOffer = onOffer;
    this.onAnswer = onAnswer;
    this.onIceCandidate = onIceCandidate;

    // Poll every 500ms
    this.pollingInterval = window.setInterval(async () => {
      if (this.role === "controller" && this.onOffer) {
        const offer = await this.pollForOffer();
        if (offer) {
          this.onOffer(offer);
        }
      }

      if (this.role === "gamemaster" && this.onAnswer) {
        const answers = await this.pollForAnswers();
        for (const { answer, playerId } of answers) {
          this.onAnswer(answer, playerId);
        }
      }

      // Poll for ICE candidates from the other role
      const targetRole = this.role === "gamemaster" ? "controller" : "gamemaster";
      if (this.onIceCandidate) {
        const candidates = await this.pollForIceCandidates(targetRole);
        for (const { candidate, playerId } of candidates) {
          this.onIceCandidate(candidate, playerId);
        }
      }
    }, 500);
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
  }

  /**
   * Clean up signaling data for this session
   */
  async cleanup(): Promise<void> {
    this.stopPolling();
    // Optionally delete old signaling data
    // The database function will clean up old data automatically
  }

  /**
   * Delete old signaling data for a specific player
   * Call this before reconnecting to ensure fresh signaling
   */
  async clearPlayerSignaling(playerId: string): Promise<void> {
    try {
      // Delete old offers for this player (from gamemaster)
      await supabase
        .from("signaling")
        .delete()
        .eq("session_id", this.sessionId)
        .eq("player_id", playerId)
        .lt("created_at", new Date(Date.now() - 5000).toISOString()); // Older than 5 seconds

      console.log(`[SignalingService] Cleared old signaling data for player ${playerId}`);
    } catch (error) {
      console.error("[SignalingService] Failed to clear player signaling:", error);
    }
  }
}

