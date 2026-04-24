import type {
  CreateSessionResult,
  JoinSessionResult,
  ListSessionsResult,
  PartySession,
  PollSignalsResult,
  SessionSummary,
  Signal,
  SignalType,
  PartyClientConfig,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// SignalingService
//
// Wraps all REST calls to /api/party/**. Owns the polling loop.
//
// Usage (host):
//   const svc = new SignalingService({ baseUrl: "https://..." });
//   const { session_id, host_secret } = await svc.createSession({ game_id: "my-game" });
//   svc.hostSecret = host_secret;
//   svc.startPolling(session_id, "host", (signal) => { ... });
//
// Usage (controller):
//   const svc = new SignalingService({ baseUrl: "https://..." });
//   const { player_id, player_secret } = await svc.joinSession(session_id, "Alice");
//   // player_id and player_secret are auto-stored on the instance
//   svc.startPolling(session_id, player_id, (signal) => { ... });
// ─────────────────────────────────────────────────────────────────────────────

export class SignalingService {
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;

  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private isPolling: boolean = false;
  private sinceId: number = 0;

  // Set these after creation/join — used for authenticated sends.
  public hostSecret: string | null = null;
  public playerId: string | null = null;
  public playerSecret: string | null = null;

  constructor(config: PartyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 1500;
  }

  // ─── Session management ───────────────────────────────────────────────────

  async createSession(options?: {
    game_id?: string;
    max_players?: number;
    metadata?: Record<string, unknown>;
  }): Promise<CreateSessionResult> {
    const result = await this.post("/api/party/sessions", options ?? {}) as CreateSessionResult;
    this.hostSecret = result.host_secret;
    return result;
  }

  async getSession(sessionId: string): Promise<PartySession> {
    return this.get(`/api/party/sessions/${sessionId}`) as Promise<PartySession>;
  }

  async listSessions(gameId?: string): Promise<SessionSummary[]> {
    const params = gameId ? `?game_id=${encodeURIComponent(gameId)}` : "";
    const result = await this.get(`/api/party/sessions${params}`) as ListSessionsResult;
    return result.sessions;
  }

  async lookupByCode(code: string): Promise<SessionSummary> {
    return this.get(
      `/api/party/sessions/lookup?code=${encodeURIComponent(code.toUpperCase().trim())}`,
    ) as Promise<SessionSummary>;
  }

  async endSession(sessionId: string): Promise<void> {
    if (!this.hostSecret) throw new Error("hostSecret not set");
    await this.patch(`/api/party/sessions/${sessionId}`, {
      host_secret: this.hostSecret,
      status: "ended",
    });
  }

  // ─── Player management ───────────────────────────────────────────────────

  async joinSession(sessionId: string, displayName?: string): Promise<JoinSessionResult> {
    const result = await this.post(
      `/api/party/sessions/${sessionId}/players`,
      { display_name: displayName },
    ) as JoinSessionResult;
    this.playerId = result.player_id;
    this.playerSecret = result.player_secret;
    return result;
  }

  async updatePlayerStatus(
    sessionId: string,
    playerId: string,
    status: "connected" | "disconnected",
  ): Promise<void> {
    if (!this.playerSecret) throw new Error("playerSecret not set");
    await this.patch(`/api/party/sessions/${sessionId}/players/${playerId}`, {
      player_secret: this.playerSecret,
      status,
    });
  }

  // ─── Signaling ────────────────────────────────────────────────────────────

  async sendSignal(
    sessionId: string,
    recipientId: string,
    signalType: SignalType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      recipient_id: recipientId,
      signal_type: signalType,
      payload,
    };

    if (this.hostSecret) {
      body.host_secret = this.hostSecret;
    } else if (this.playerSecret && this.playerId) {
      body.player_secret = this.playerSecret;
      body.sender_player_id = this.playerId;
    } else {
      throw new Error("Neither hostSecret nor playerSecret is set");
    }

    await this.post(`/api/party/sessions/${sessionId}/signals`, body);
  }

  // ─── Polling loop ─────────────────────────────────────────────────────────

  startPolling(
    sessionId: string,
    recipientId: string,
    onSignal: (signal: Signal) => void | Promise<void>,
  ): void {
    if (this.isPolling) return;
    this.isPolling = true;
    this.sinceId = 0;

    const poll = async () => {
      if (!this.isPolling) return;
      try {
        const path =
          `/api/party/sessions/${sessionId}/signals` +
          `?recipient_id=${encodeURIComponent(recipientId)}` +
          `&since_id=${this.sinceId}` +
          `&limit=50`;
        const result = (await this.get(path)) as PollSignalsResult;
        if (result.signals.length > 0) {
          console.log(`[SignalingService] Received ${result.signals.length} signal(s) for ${recipientId}:`,
            result.signals.map(s => `${s.signal_type}(from:${s.sender_id})`).join(", "));
        }
        // Process signals sequentially — handlers like setRemoteDescription
        // must complete before addIceCandidate can succeed.
        for (const signal of result.signals) {
          await onSignal(signal);
        }
        this.sinceId = result.next_since_id;
      } catch (err) {
        console.warn("[SignalingService] poll error:", err);
      }
      if (this.isPolling) {
        this.pollingTimer = setTimeout(poll, this.pollIntervalMs);
      }
    };

    poll();
  }

  stopPolling(): void {
    this.isPolling = false;
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(`GET ${path} → ${res.status}: ${body?.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(`POST ${path} → ${res.status}: ${b?.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error(`PATCH ${path} → ${res.status}: ${b?.error ?? res.statusText}`);
    }
    return res.json();
  }
}
