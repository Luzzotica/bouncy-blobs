// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Rooms WebRTC SDK — shared types
// Mirrors /api/rooms/** response shapes exactly. A "room" is a host-owned
// signaling room; "peers" are participants (host included). The platform
// doesn't interpret `peer.kind` — apps tag peers with whatever string they
// want ('phone', 'screen', 'spectator', …) and switch on it downstream.
// ─────────────────────────────────────────────────────────────────────────────

export type RoomStatus = "waiting" | "active" | "ended";
export type PeerStatus = "joined" | "connected" | "disconnected";
export type RoomVisibility = "public" | "private";
export type SignalType = "offer" | "answer" | "ice_candidate";

export interface RoomPeer {
  peer_id: string;
  kind: string;
  display_name: string;
  slot: number;
  is_host: boolean;
  status: PeerStatus;
  joined_at: string;
  metadata: Record<string, unknown>;
}

export interface Room {
  room_id: string;
  join_code: string;
  game_id: string;
  display_name: string;
  status: RoomStatus;
  max_peers: number;
  is_password_protected: boolean;
  visibility: RoomVisibility;
  joinable: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
  peers: RoomPeer[];
}

export interface RoomSummary {
  room_id: string;
  join_code: string;
  game_id: string;
  display_name: string;
  status: RoomStatus;
  max_peers: number;
  peer_count: number;
  is_password_protected: boolean;
  visibility: RoomVisibility;
  joinable: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

/** Mirrors partii's `lib/api/turn.ts` IceServer shape. The values flow
 * directly into `RTCConfiguration.iceServers` on both host and joiner. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CreateRoomResult {
  room_id: string;
  join_code: string;
  host_secret: string;
  host_peer_id: string;
  host_peer_secret: string;
  expires_at: string;
  /** Short-lived TURN credentials minted by the API. Omitted on backends
   * that don't support TURN; SDK falls back to a public STUN-only config. */
  ice_servers?: IceServerConfig[];
}

export interface JoinRoomResult {
  peer_id: string;
  peer_secret: string;
  slot: number;
  kind: string;
  display_name: string;
  /** Short-lived TURN credentials minted by the API. See CreateRoomResult. */
  ice_servers?: IceServerConfig[];
}

export interface Signal {
  signal_id: number;
  sender_peer_id: string;       // "host" or a peer id
  signal_type: SignalType;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>;
  created_at: string;
}

export interface PollSignalsResult {
  signals: Signal[];
  next_since_id: number;
}

export interface ListRoomsResult {
  rooms: RoomSummary[];
}

/** Proof the client returns to attest itself for the token exchange. */
export interface Attestation {
  /** Provider token — Cloudflare Turnstile token (web) or Steam ticket (steam). */
  token?: string;
  /** Steam-only: the steamid the ticket belongs to (optional binding). */
  steamId?: string;
}

export interface RoomClientConfig {
  /** Game identifier for room listing + telemetry attribution (e.g. "gyrii"). */
  gameId?: string;
  /** Base URL of the Lobbii / Partii signaling backend. */
  baseUrl: string;
  /**
   * API key. Exchanged once at POST /api/auth/token for a short-lived session
   * token; the raw key is no longer sent on signalling calls (it falls back to
   * X-API-Key only while the backend's ENFORCE_SESSION_TOKENS is off).
   */
  apiKey: string;
  /** Poll interval in milliseconds. Default: 1500. */
  pollIntervalMs?: number;
  /** Platform claimed at token exchange: 'web' | 'steam' | 'dev'. Default 'web'. */
  platform?: string;
  /**
   * Returns the attestation proof for the token exchange (e.g. a freshly-solved
   * Turnstile token, or a Steam auth ticket). Omit in local dev — the backend
   * waves through 'dev'/localhost. Returning null skips attestation.
   */
  getAttestation?: () => Promise<Attestation | string | null>;
}

// ── Callbacks ───────────────────────────────────────────────────────────────

/** Fired by PeerManager. Same shape regardless of whether the local side is
 * the room host or a joiner. */
export interface PeerCallbacks {
  onPeerJoined?: (peer: RoomPeer) => void;
  onPeerConnected?: (peerId: string, kind: string) => void;
  onPeerDisconnected?: (peerId: string) => void;
  onMessage?: (peerId: string, channel: string, data: string | ArrayBuffer) => void;
  onError?: (err: Error) => void;
  /** Lifecycle events from the underlying transport. Used to surface a
   * visible "what step are we on" log to the user during connect — the
   * payload is intentionally free-form so transports can include whatever
   * detail is useful (candidate type, state name, channel label, etc.). */
  onPhase?: (peerId: string, phase: string, detail?: Record<string, unknown>) => void;
}
