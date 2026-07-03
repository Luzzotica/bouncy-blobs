// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
import type {
  Attestation,
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

/**
 * Stable anonymous device id for identity attribution. Persisted so the same
 * browser keeps the same 'anon:<uuid>' across sessions; storage-less contexts
 * (private mode, non-browser) fall back to a per-process id.
 */
let processDeviceId: string | null = null;
function stableDeviceId(): string {
  try {
    const KEY = "arcadii_device_id";
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    if (!processDeviceId) processDeviceId = crypto.randomUUID();
    return processDeviceId;
  }
}

export class RoomService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly platform: string;
  private readonly getAttestation?: () => Promise<Attestation | string | null>;

  // Short-lived session token (minted at /api/auth/token). Cached + refreshed
  // before expiry; a single in-flight refresh is shared so concurrent calls
  // don't each mint their own token.
  private sessionToken: string | null = null;
  // After a failed token exchange, back off so we don't re-hit the endpoint on
  // EVERY signal (offer/answer/each ICE candidate) — that added a failed round
  // trip per signal, slowing the WebRTC handshake enough to blow the connect
  // budget under concurrency. We just use the API-key fallback until this passes.
  private tokenBackoffUntil = 0;
  private sessionExpiresAt = 0; // epoch ms
  private tokenRefresh: Promise<void> | null = null;

  // Set after createRoom() / joinRoom(). Either one is sufficient to auth
  // mutating requests; sendSignal picks whichever is populated.
  public roomId: string | null = null;
  /** Identity this session runs as ('steam:<id64>' | 'anon:<uuid>'), from the
   *  token exchange. Attribution only — never used client-side for auth. */
  public playerId: string | null = null;
  /** game_id for telemetry attribution — set by createRoom(); joiners may set it. */
  public gameId: string | null = null;
  /** Scoped room credential from create/join — auths room-level surfaces
   *  (the realtime signal gateway). */
  public roomToken: string | null = null;
  public hostSecret: string | null = null;
  public hostPeerId: string | null = null;    // host's own peer row
  public peerId: string | null = null;        // only set on joinRoom()
  public peerSecret: string | null = null;

  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private isPolling = false;
  private sinceId = 0;

  // ── Realtime push path (WSS signal gateway) ──
  // The gateway pushes the same durable signal rows the instant they're stored;
  // polling keeps running (relaxed) as reconciliation. BOTH paths dedupe through
  // `seenSignalIds` so a signal is applied exactly once regardless of which
  // path delivers it first. The poll cursor (`sinceId`) is advanced ONLY by
  // poll responses — they're contiguous-by-id — so a push arriving out of order
  // can never make the poll skip an undelivered earlier signal.
  public signalGwUrl: string | null = null;
  private ws: WebSocket | null = null;
  private wsUp = false;
  private wsBackoffMs = 1_000;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seenSignalIds = new Set<number>();
  /** Signaling path currently delivering ("push" while the socket is open). */
  get signalPath(): "poll" | "push" {
    return this.wsUp ? "push" : "poll";
  }

  constructor(config: RoomClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    if (!this.apiKey) throw new Error("RoomClientConfig.apiKey is required");
    this.pollIntervalMs = config.pollIntervalMs ?? 1500;
    this.platform = config.platform ?? "web";
    this.getAttestation = config.getAttestation;
    this.gameId = config.gameId ?? null;
  }

  // ─── Room lifecycle ───────────────────────────────────────────────────────

  async createRoom(opts: CreateRoomOpts): Promise<CreateRoomResult> {
    const result = (await this.post("/api/rooms", opts)) as CreateRoomResult;
    this.roomId = result.room_id;
    this.gameId = opts.game_id;
    this.roomToken = (result as { room_token?: string }).room_token ?? null;
    this.signalGwUrl = (result as { signal_gw?: string }).signal_gw ?? null;
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
  /** End the room. Uses `keepalive: true` so the PATCH still lands when
   * called from an unmount/cleanup path or just before the tab closes —
   * `patchRoom` goes through `fetchWithTimeout` which doesn't keepalive
   * and gets cancelled if the JS context is shutting down. */
  async endRoom(): Promise<void> {
    if (!this.roomId || !this.hostSecret) return;
    try {
      await fetch(`${this.baseUrl}/api/rooms/${this.roomId}`, {
        method: "PATCH",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ host_secret: this.hostSecret, status: "ended" }),
        keepalive: true,
      });
    } catch {
      /* best-effort — backend's room cleanup cron sweeps stragglers */
    }
  }
  setVisibility(v: RoomVisibility): Promise<void>     { return this.patchRoom({ visibility: v }); }
  setJoinable(joinable: boolean): Promise<void>       { return this.patchRoom({ joinable }); }
  setMaxPeers(max: number): Promise<void>             { return this.patchRoom({ max_peers: max }); }

  // ─── Peer lifecycle (joiner side) ─────────────────────────────────────────

  async joinRoom(roomId: string, opts: JoinRoomOpts): Promise<JoinRoomResult> {
    const r = (await this.post(`/api/rooms/${roomId}/peers`, opts)) as JoinRoomResult;
    this.roomId = roomId;
    this.peerId = r.peer_id;
    this.peerSecret = r.peer_secret;
    this.roomToken = (r as { room_token?: string }).room_token ?? null;
    this.signalGwUrl = (r as { signal_gw?: string }).signal_gw ?? null;
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
    // `keepalive: true` lets the DELETE complete even if the tab is closing
    // or the user navigates with hash/back — without it the browser cancels
    // the request mid-flight and the peer row lingers, inflating peer_count
    // until backend TTL cleanup.
    try {
      await fetch(
        `${this.baseUrl}/api/rooms/${this.roomId}/peers/${this.peerId}?peer_secret=${encodeURIComponent(this.peerSecret)}`,
        { method: "DELETE", headers: this.authHeaders(), keepalive: true },
      );
    } catch {
      /* best-effort — the backend's room cleanup cron sweeps stragglers */
    }
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
    this.seenSignalIds.clear();

    // Exactly-once application across both delivery paths.
    const deliver = async (sig: Signal) => {
      const id = Number(sig.signal_id);
      if (Number.isFinite(id)) {
        if (this.seenSignalIds.has(id)) return;
        this.seenSignalIds.add(id);
        // Bound the set — old ids can't recur (cursor is past them).
        if (this.seenSignalIds.size > 2048) {
          for (const old of this.seenSignalIds) {
            this.seenSignalIds.delete(old);
            if (this.seenSignalIds.size <= 1024) break;
          }
        }
      }
      await onSignal(sig);
    };

    const poll = async () => {
      if (!this.isPolling || !this.roomId) return;
      try {
        const path =
          `/api/rooms/${this.roomId}/signals` +
          `?recipient_peer_id=${encodeURIComponent(recipientPeerId)}` +
          `&since_id=${this.sinceId}&limit=50`;
        const r = (await this.get(path)) as PollSignalsResult;
        for (const sig of r.signals) await deliver(sig);
        this.sinceId = r.next_since_id;
      } catch (err) {
        console.warn("[RoomService] poll error:", err);
      }
      if (this.isPolling) {
        // Push healthy → polling is just reconciliation; back off. Push down →
        // polling is the handshake path; keep it tight.
        const interval = this.wsUp ? Math.max(this.pollIntervalMs, 5_000) : this.pollIntervalMs;
        this.pollingTimer = setTimeout(poll, interval);
      }
    };

    this.connectSignalSocket(deliver);
    poll();
  }

  /** Hold a WebSocket to the signal gateway for instant delivery. Reconnects
   *  with backoff for as long as we're listening; harmless if the backend
   *  doesn't advertise a gateway (older deploys) or the room predates tokens. */
  private connectSignalSocket(deliver: (sig: Signal) => Promise<void>): void {
    if (!this.signalGwUrl || !this.roomToken || typeof WebSocket === "undefined") return;
    if (!this.isPolling || this.ws) return;
    let url: string;
    try {
      const base = this.signalGwUrl.replace(/^http/, "ws").replace(/\/$/, "");
      url = `${base}/rooms/${this.roomId}?token=${encodeURIComponent(this.roomToken)}`;
    } catch {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsUp = true;
      this.wsBackoffMs = 1_000;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; signal?: Signal };
        if (msg.type === "signal" && msg.signal) void deliver(msg.signal);
      } catch { /* ignore malformed frames */ }
    };
    const onDown = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsUp = false;
      if (!this.isPolling) return;
      const delay = this.wsBackoffMs;
      this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, 30_000);
      this.wsReconnectTimer = setTimeout(() => this.connectSignalSocket(deliver), delay);
    };
    ws.onclose = onDown;
    ws.onerror = () => { try { ws.close(); } catch { /* already closing */ } };
  }

  stopPolling(): void {
    this.isPolling = false;
    if (this.pollingTimer !== null) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    if (this.wsReconnectTimer !== null) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.wsUp = false;
  }

  // ─── HTTP plumbing ────────────────────────────────────────────────────────

  // Auth header for a signalling call. Prefers the session token; falls back to
  // the raw API key before the first successful exchange (and while the backend
  // still accepts raw keys during the rollout).
  /**
   * Mint FRESH ICE servers for this peer (new short-TTL TURN creds). TURN
   * credentials expire ~10 minutes after join, so a deep-into-the-match ICE
   * restart re-gathers against dead relays — tier-2 recovery calls this before
   * rebuilding the peer connection. Null on any failure (caller keeps the old
   * config and lets the final grace window decide).
   */
  async refreshIce(): Promise<import("./types").IceServerConfig[] | null> {
    if (!this.roomId) return null;
    const body = this.hostSecret
      ? { host_secret: this.hostSecret }
      : this.peerSecret && this.peerId
        ? { peer_secret: this.peerSecret, peer_id: this.peerId }
        : null;
    if (!body) return null;
    try {
      const r = (await this.post(`/api/rooms/${this.roomId}/refresh-ice`, body)) as {
        ice_servers?: import("./types").IceServerConfig[];
      };
      return r.ice_servers ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fire-and-forget connection telemetry (POST /api/telemetry/connect).
   * Measurement only — must NEVER block or throw into the caller: connection
   * outcomes are how we find out which failure class hits real players.
   */
  postTelemetry(fields: {
    outcome: "connected" | "timeout" | "failed" | "recovered" | "gave_up";
    role: "host" | "peer";
    connect_ms?: number;
    candidate_type?: string;
    relay_host?: string;
    ice_restarts?: number;
    signaling_path?: "poll" | "push";
  }): void {
    try {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const uaHint =
        /iPhone|iPad/.test(ua) ? "ios" :
        /Android/.test(ua) ? "android" :
        /Firefox\//.test(ua) ? "firefox" :
        /Edg\//.test(ua) ? "edge" :
        /Chrome\//.test(ua) ? "chrome" :
        /Safari\//.test(ua) ? "safari" : "other";
      void fetch(`${this.baseUrl}/api/telemetry/connect`, {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        keepalive: true,
        body: JSON.stringify({
          signaling_path: this.signalPath,
          ...fields,
          game_id: this.gameId ?? "",
          room_id: this.roomId ?? undefined,
          ua_hint: uaHint,
        }),
      }).catch(() => { /* telemetry is best-effort */ });
    } catch { /* never let telemetry break gameplay */ }
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    if (this.sessionToken) {
      return { Authorization: `Bearer ${this.sessionToken}`, ...extra };
    }
    return { "X-API-Key": this.apiKey, ...extra };
  }

  /**
   * Ensure a fresh session token, exchanging the API key (+ attestation) at
   * /api/auth/token when missing or near expiry. Best-effort: if the exchange
   * fails we leave sessionToken null so calls fall back to the raw API key —
   * which still works until the backend flips ENFORCE_SESSION_TOKENS on.
   */
  private async ensureToken(): Promise<void> {
    const skewMs = 30_000; // refresh 30s before expiry
    if (this.sessionToken && Date.now() < this.sessionExpiresAt - skewMs) return;
    if (Date.now() < this.tokenBackoffUntil) return; // recently failed → use API key, don't re-hit
    if (this.tokenRefresh) return this.tokenRefresh;

    this.tokenRefresh = (async () => {
      try {
        let attestation: string | undefined;
        let steamId: string | undefined;
        if (this.getAttestation) {
          const a = await this.getAttestation();
          if (typeof a === "string") attestation = a;
          else if (a) {
            attestation = a.token;
            steamId = a.steamId;
          }
        }
        const res = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/token`, {
          method: "POST",
          headers: { "X-API-Key": this.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            platform: this.platform,
            attestation,
            steam_id: steamId,
            device_id: stableDeviceId(),
          }),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          throw new Error(`token exchange ${res.status}: ${b?.error ?? res.statusText}`);
        }
        const data = (await res.json()) as {
          session_token: string;
          expires_in: number;
          player_id?: string;
        };
        this.sessionToken = data.session_token;
        this.sessionExpiresAt = Date.now() + data.expires_in * 1000;
        this.playerId = data.player_id ?? null;
      } catch (err) {
        console.warn("[RoomService] token exchange failed, falling back to API key:", err);
        this.sessionToken = null;
        this.tokenBackoffUntil = Date.now() + 60_000; // don't retry every signal
      } finally {
        this.tokenRefresh = null;
      }
    })();
    return this.tokenRefresh;
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
    await this.ensureToken();
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`GET ${path} → ${res.status}: ${body?.error ?? res.statusText}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    await this.ensureToken();
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
    await this.ensureToken();
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
