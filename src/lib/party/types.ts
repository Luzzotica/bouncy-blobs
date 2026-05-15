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

export interface CreateRoomResult {
  room_id: string;
  join_code: string;
  host_secret: string;
  host_peer_id: string;
  host_peer_secret: string;
  expires_at: string;
}

export interface JoinRoomResult {
  peer_id: string;
  peer_secret: string;
  slot: number;
  kind: string;
  display_name: string;
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

export interface RoomClientConfig {
  /** Base URL of the hexii (or compatible) signaling backend. */
  baseUrl: string;
  /** API key sent as X-API-Key. */
  apiKey: string;
  /** Poll interval in milliseconds. Default: 1500. */
  pollIntervalMs?: number;
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
}
