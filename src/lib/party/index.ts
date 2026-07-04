// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Rooms WebRTC SDK — public surface
//
// One service class (RoomService) for REST + signaling. One WebRTC manager
// (PeerManager) for all peer connections in a room — host or joiner, phone
// or screen, anything else.
//
// Convenience factories at the bottom wire up the most common cases:
//   createHostRoom(config, opts) → host
//   joinAsPeer(config, roomId, opts) → joiner
// ─────────────────────────────────────────────────────────────────────────────

export { RoomService } from "./RoomService";
export type { CreateRoomOpts, JoinRoomOpts, PatchRoomOpts } from "./RoomService";
export { PeerManager } from "./PeerManager";
export { rtcConfigFromIceServers } from "./transport";
export { CloudContent, type CloudContentConfig, type CloudItem } from "./cloudContent";
import { rtcConfigFromIceServers } from "./transport";
// SteamTransport is intentionally NOT re-exported here: it statically imports
// @tauri-apps/*, which only Tauri games carry. Steam builds import it directly
// from "./steamTransport" (the sync script ships that file to Tauri targets only).
export type { Transport, ChannelName } from "./transport";
export type {
  Room,
  RoomPeer,
  RoomStatus,
  RoomVisibility,
  RoomSummary,
  PeerStatus,
  SignalType,
  Signal,
  CreateRoomResult,
  JoinRoomResult,
  PollSignalsResult,
  ListRoomsResult,
  RoomClientConfig,
  Attestation,
  PeerCallbacks,
} from "./types";

import { RoomService, type CreateRoomOpts, type JoinRoomOpts } from "./RoomService";
import { PeerManager } from "./PeerManager";
import type { PeerCallbacks, RoomClientConfig, CreateRoomResult, JoinRoomResult } from "./types";

// ── Convenience factories ───────────────────────────────────────────────────

/** Create a room, become its host, and start polling for signals. The
 * caller is expected to subsequently call `manager.connectTo(peerId, kind)`
 * for each new peer it discovers via `room.getRoom()`. */
export async function createHostRoom(
  config: RoomClientConfig,
  opts: CreateRoomOpts,
  callbacks?: PeerCallbacks,
): Promise<{ result: CreateRoomResult; room: RoomService; manager: PeerManager }> {
  const room = new RoomService(config);
  const result = await room.createRoom(opts);
  const rtcConfig = rtcConfigFromIceServers(result.ice_servers);
  const manager = new PeerManager(room, "host", callbacks ?? {}, rtcConfig);
  // Host listens on "host" — both senders address it as either the literal
  // string "host" or the host_peer_id, but the server stores incoming
  // signals with recipient_peer_id="host" by convention.
  room.startPolling("host", (signal) => manager.handleSignal(signal));
  return { result, room, manager };
}

/** Join an existing room as a peer, start polling, and answer the host's
 * incoming offer when it arrives.
 *
 * The channel topology for this connection is determined by the JOINER's own
 * kind — the host always picks channels based on the remote peer's kind, so
 * the joiner must mirror that or `sendPrimary` will target a channel name
 * the host never opened. (E.g. for kind='phone' both sides use a single
 * 'data' channel; for kind='screen' both sides use 'state'+'input'.) */
export async function joinAsPeer(
  config: RoomClientConfig,
  roomId: string,
  opts: JoinRoomOpts,
  callbacks?: PeerCallbacks,
): Promise<{ result: JoinRoomResult; room: RoomService; manager: PeerManager }> {
  const room = new RoomService(config);
  const result = await room.joinRoom(roomId, opts);
  const rtcConfig = rtcConfigFromIceServers(result.ice_servers);
  // Surface the iceServers shape (sans credential) in the phase log so the
  // user can see whether TURN actually got wired up — when the API can't
  // mint creds it returns STUN-only, which silently degrades connectivity.
  callbacks?.onPhase?.("host", "ice-servers", iceServerSummary(result.ice_servers));
  const manager = new PeerManager(room, "joiner", callbacks ?? {}, rtcConfig);
  await manager.prepareForHost(opts.kind);
  room.startPolling(result.peer_id, (signal) => manager.handleSignal(signal));
  return { result, room, manager };
}

/** Build an `RTCConfiguration` for the SDK's WebRtcTransport. Falls back
 * to the transport's built-in public-STUN config when the backend didn't
 * supply servers (e.g. local dev without TURN_SHARED_SECRET in env).
 *
 * Default policy is `"all"` — ICE tries host, srflx, and relay pairs in
 * priority order. Setting `?relay=1` in the URL forces relay-only, which
 * we found gets pruned to zero pairs when both ends allocate relays on
 * the SAME coturn server (same public IP triggers Chrome's same-machine
 * self-loop pruning). Relay-only is still useful for cross-network
 * testing when the operator wants to confirm TURN-relay works at all.
 */

/** Strip credentials before logging — usernames are HMAC strings and
 * credentials are base64 hashes; safe to show urls + whether a credential
 * was attached so we can tell STUN-only from STUN+TURN at a glance. */
function iceServerSummary(servers?: import("./types").IceServerConfig[]): Record<string, unknown> {
  if (!servers || servers.length === 0) return { servers: 0, note: "stun-only-fallback" };
  const stun = servers.filter((s) => {
    const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return typeof u === "string" && u.startsWith("stun:");
  }).length;
  const turn = servers.filter((s) => {
    const u = Array.isArray(s.urls) ? s.urls[0] : s.urls;
    return typeof u === "string" && (u.startsWith("turn:") || u.startsWith("turns:"));
  }).length;
  const cfg = rtcConfigFromIceServers(servers);
  return { stun, turn, policy: cfg?.iceTransportPolicy ?? "all" };
}
