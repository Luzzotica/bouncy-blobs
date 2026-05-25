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
export { SteamTransport, steamNetStartListening, getSelfSteamId, steamNetCloseAll } from "./steamTransport";
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
  const manager = new PeerManager(room, "host", callbacks ?? {});
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
  const manager = new PeerManager(room, "joiner", callbacks ?? {});
  await manager.prepareForHost(opts.kind);
  room.startPolling(result.peer_id, (signal) => manager.handleSignal(signal));
  return { result, room, manager };
}
