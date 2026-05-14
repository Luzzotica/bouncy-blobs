import type {
  RoomClientConfig,
  CreateRoomResult,
  JoinRoomResult,
  Room,
  RoomSummary,
  RoomVisibility,
  ListRoomsResult,
  PollSignalsResult,
  Signal,
  SignalType,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// RoomService
//
// One REST client for the unified /api/rooms surface. Subsumes everything the
// old SignalingService + MultiplayerService did:
//
//   - room lifecycle (create, list, lookup, get, patch, end)
//   - peer lifecycle (join, update, leave)
//   - WebRTC signaling (send + polling)
//
// Auth model: every method that mutates carries either `hostSecret` (set after
// createRoom) or `(peerSecret + peerId)` (set after joinRoom). sendSignal picks
// the right credential automatically based on which is populated.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatchRoomOpts {
  status?: "active" | "ended";
  visibility?: RoomVisibility;
  joinable?: boolean;
  max_peers?: number;
  metadata?: Record<string, unknown>;
}

export interface CreateRoomOpts {
  game_id: string;
  display_name?: string;
  /** Kind tag for the host's own peer row. Defaults to 'screen'. */
  host_kind?: string;
  host_display_name?: string;
  host_metadata?: Record<string, unknown>;
  max_peers?: number;
  password?: string;
  visibility?: RoomVisibility;
  metadata?: Record<string, unknown>;
}

export interface JoinRoomOpts {
  kind: string;
  display_name?: string;
  password?: string;
  metadata?: Record<string, unknown>;
}

export class RoomService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;

  // Set after createRoom() / joinRoom(). Either one is sufficient to auth
  // mutating requests; sendSignal picks whichever is populated.
  public roomId: string | null = null;
  public hostSecret: string | null = null;
  public hostPeerId: string | null = null;    // host's own peer row
  public peerId: string | null = null;        // only set on joinRoom()
  public peerSecret: string | null = null;

  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private isPolling = false;
  private sinceId = 0;

  constructor(config: RoomClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    if (!this.apiKey) throw new Error("RoomClientConfig.apiKey is required");
    this.pollIntervalMs = config.pollIntervalMs ?? 1500;
  }

  // ─── Room lifecycle ───────────────────────────────────────────────────────

  async createRoom(opts: CreateRoomOpts): Promise<CreateRoomResult> {
    const result = (await this.post("/api/rooms", opts)) as CreateRoomResult;
    this.roomId = result.room_id;
    this.hostSecret = result.host_secret;
    this.hostPeerId = result.host_peer_id;
    return result;
  }

  async listRooms(gameId?: string): Promise<RoomSummary[]> {
    const params = gameId ? `?game_id=${encodeURIComponent(gameId)}` : "";
    const r = (await this.get(`/api/rooms${params}`)) as ListRoomsResult;
    return r.rooms;
  }

  async lookupByCode(code: string): Promise<RoomSummary> {
    return this.get(`/api/rooms/lookup?code=${encodeURIComponent(code.toUpperCase().trim())}`) as Promise<RoomSummary>;
  }

  async getRoom(roomId?: string): Promise<Room> {
    const id = roomId ?? this.roomId;
    if (!id) throw new Error("roomId not set");
    return this.get(`/api/rooms/${id}`) as Promise<Room>;
  }

  async patchRoom(opts: PatchRoomOpts): Promise<void> {
    if (!this.roomId || !this.hostSecret) throw new Error("Not hosting a room");
    await this.patch(`/api/rooms/${this.roomId}`, {
      host_secret: this.hostSecret,
      ...opts,
    });
  }

  // Convenience wrappers — these are what callers use 99% of the time.
  endRoom(): Promise<void>                            { return this.patchRoom({ status: "ended" }); }
  setVisibility(v: RoomVisibility): Promise<void>     { return this.patchRoom({ visibility: v }); }
  setJoinable(joinable: boolean): Promise<void>       { return this.patchRoom({ joinable }); }
  setMaxPeers(max: number): Promise<void>             { return this.patchRoom({ max_peers: max }); }

  // ─── Peer lifecycle (joiner side) ─────────────────────────────────────────

  async joinRoom(roomId: string, opts: JoinRoomOpts): Promise<JoinRoomResult> {
    const r = (await this.post(`/api/rooms/${roomId}/peers`, opts)) as JoinRoomResult;
    this.roomId = roomId;
    this.peerId = r.peer_id;
    this.peerSecret = r.peer_secret;
    return r;
  }

  async updatePeer(opts: {
    status?: "joined" | "connected" | "disconnected";
    metadata?: Record<string, unknown>;
    display_name?: string;
  }): Promise<void> {
    if (!this.roomId || !this.peerId || !this.peerSecret) {
      throw new Error("Not joined as a peer");
    }
    await this.patch(`/api/rooms/${this.roomId}/peers/${this.peerId}`, {
      peer_secret: this.peerSecret,
      ...opts,
    });
  }

  async leaveRoom(): Promise<void> {
    if (!this.roomId || !this.peerId || !this.peerSecret) return;
    await this.fetchWithTimeout(
      `${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}?peer_secret=${encodeURIComponent(this.peerSecret)}`,
      { method: "DELETE", headers: this.authHeaders() },
    );
  }

  // ─── Signaling ────────────────────────────────────────────────────────────

  async sendSignal(
    recipientPeerId: string,
    type: SignalType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.roomId) throw new Error("roomId not set");
    const body: Record<string, unknown> = {
      recipient_peer_id: recipientPeerId,
      signal_type: type,
      payload,
    };
    if (this.hostSecret) {
      body.host_secret = this.hostSecret;
    } else if (this.peerSecret && this.peerId) {
      body.peer_secret = this.peerSecret;
      body.sender_peer_id = this.peerId;
    } else {
      throw new Error("Neither hostSecret nor (peerSecret + peerId) is set");
    }
    await this.post(`/api/rooms/${this.roomId}/signals`, body);
  }

  /** Begin polling for signals addressed to `recipientPeerId`. The host should
   * call this with `recipientPeerId = 'host'` (or its hostPeerId — both route
   * to host signals). Joiners pass their own peer_id. */
  startPolling(
    recipientPeerId: string,
    onSignal: (signal: Signal) => void | Promise<void>,
  ): void {
    if (this.isPolling) return;
    if (!this.roomId) throw new Error("roomId not set");
    this.isPolling = true;
    this.sinceId = 0;

    const poll = async () => {
      if (!this.isPolling || !this.roomId) return;
      try {
        const path =
          `/api/rooms/${this.roomId}/signals` +
          `?recipient_peer_id=${encodeURIComponent(recipientPeerId)}` +
          `&since_id=${this.sinceId}&limit=50`;
        const r = (await this.get(path)) as PollSignalsResult;
        for (const sig of r.signals) await onSignal(sig);
        this.sinceId = r.next_since_id;
      } catch (err) {
        console.warn("[RoomService] poll error:", err);
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

  // ─── HTTP plumbing ────────────────────────────────────────────────────────

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { "X-API-Key": this.apiKey, ...extra };
  }

  private readonly fetchTimeoutMs = 8000;

  private async fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    try {
      return await fetch(input, { ...init, signal: ac.signal });
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new Error(`Request to ${input} timed out after ${this.fetchTimeoutMs}ms (is the rooms API reachable?)`);
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  private async get(path: string): Promise<unknown> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`GET ${path} → ${res.status}: ${body?.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`POST ${path} → ${res.status}: ${b?.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async patch(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method: "PATCH",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`PATCH ${path} → ${res.status}: ${b?.error ?? res.statusText}`);
    }
    return res.json();
  }
}
