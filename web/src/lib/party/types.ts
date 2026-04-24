// ─────────────────────────────────────────────────────────────────────────────
// Party WebRTC SDK — shared types
// These mirror the REST API response shapes exactly.
// ─────────────────────────────────────────────────────────────────────────────

export type SessionStatus = "waiting" | "active" | "ended";
export type PlayerStatus = "joined" | "connected" | "disconnected";
export type SignalType = "offer" | "answer" | "ice_candidate";

export interface PartyPlayer {
  player_id: string;
  display_name: string;
  slot: number;
  status: PlayerStatus;
  joined_at: string;
  metadata: Record<string, unknown>;
}

export interface PartySession {
  session_id: string;
  join_code: string;
  game_id: string;
  status: SessionStatus;
  max_players: number;
  player_count: number;
  players: PartyPlayer[];
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

// Returned once on session creation — store host_secret immediately.
export interface CreateSessionResult {
  session_id: string;
  join_code: string;
  host_secret: string;
  expires_at: string;
}

// Returned once on player join — store player_secret immediately.
export interface JoinSessionResult {
  player_id: string;
  player_secret: string;
  slot: number;
  display_name: string;
}

export interface Signal {
  signal_id: number;
  sender_id: string;
  signal_type: SignalType;
  payload: RTCSessionDescriptionInit | RTCIceCandidateInit | Record<string, unknown>;
  created_at: string;
}

export interface PollSignalsResult {
  signals: Signal[];
  next_since_id: number;
}

export interface SessionSummary {
  session_id: string;
  join_code: string;
  game_id: string;
  status: SessionStatus;
  max_players: number;
  player_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
}

export interface ListSessionsResult {
  sessions: SessionSummary[];
}

export interface PartyClientConfig {
  /** Base URL of the Next.js deployment, e.g. "https://hexii.vercel.app" */
  baseUrl: string;
  /** Poll interval in milliseconds. Default: 1500. */
  pollIntervalMs?: number;
}

export interface HostCallbacks {
  onPlayerJoined?: (player: PartyPlayer) => void;
  onPlayerConnected?: (playerId: string) => void;
  onPlayerDisconnected?: (playerId: string) => void;
  onMessage?: (playerId: string, data: string | ArrayBuffer) => void;
  onError?: (err: Error) => void;
}

export interface ControllerCallbacks {
  onConnected?: () => void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}
