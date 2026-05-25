// ─────────────────────────────────────────────────────────────────────────────
// Steam Lobby — TS wrappers over the Rust commands defined in steam_lobby.rs.
//
// A lobby is the rendezvous: the host creates one (and sets host_steam_id
// metadata to their SteamID); friends join the lobby; the joiner reads the
// host's SteamID from lobby data and dials it over Steam Networking.
//
// Tauri events:
//   steam_lobby://join_requested   { lobbyId, friendSteamId }
//     Steam asked us to join a lobby (friend clicked "Join Game").
//   steam_lobby://member_changed   { lobbyId, userChanged }
//     A member joined/left the current lobby. Re-query members.
//   steam_lobby://launch_join      { lobbyId }
//     Game was launched with +connect_lobby <id> command-line arg.
// ─────────────────────────────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type LobbyVisibility = "public" | "friends" | "private";

export interface LobbyCreated {
  lobbyId: string;
}

export interface LobbyJoined {
  lobbyId: string;
  hostSteamId: string;
  members: string[];
}

interface RawLobbyCreated { lobby_id: string }
interface RawLobbyJoined { lobby_id: string; host_steam_id: string; members: string[] }

export async function createLobby(maxMembers: number, visibility: LobbyVisibility): Promise<LobbyCreated> {
  const raw = await invoke<RawLobbyCreated>("steam_lobby_create", { maxMembers, visibility });
  return { lobbyId: raw.lobby_id };
}

export async function joinLobby(lobbyId: string): Promise<LobbyJoined> {
  const raw = await invoke<RawLobbyJoined>("steam_lobby_join", { lobbyId });
  return { lobbyId: raw.lobby_id, hostSteamId: raw.host_steam_id, members: raw.members };
}

export async function leaveLobby(): Promise<void> {
  await invoke("steam_lobby_leave");
}

export async function openInviteOverlay(): Promise<void> {
  await invoke("steam_lobby_invite_overlay");
}

export async function getLobbyMembers(): Promise<string[]> {
  return await invoke<string[]>("steam_lobby_members");
}

export async function setLobbyData(key: string, value: string): Promise<void> {
  await invoke("steam_lobby_set_data", { key, value });
}

// ── Event subscriptions ──────────────────────────────────────────────────────

interface JoinRequestedEvent { lobby_id: string; friend_steam_id: string }
interface MemberChangedEvent { lobby_id: string; user_changed: string; state: string }

export type MemberChangeState = "entered" | "left" | "disconnected" | "kicked" | "other";
interface LaunchJoinEvent { lobby_id: string }

export function onJoinRequested(handler: (lobbyId: string, friendSteamId: string) => void): Promise<UnlistenFn> {
  return listen<JoinRequestedEvent>("steam_lobby://join_requested", (e) => {
    handler(e.payload.lobby_id, e.payload.friend_steam_id);
  });
}

export function onMemberChanged(
  handler: (lobbyId: string, userChanged: string, state: MemberChangeState) => void,
): Promise<UnlistenFn> {
  return listen<MemberChangedEvent>("steam_lobby://member_changed", (e) => {
    handler(e.payload.lobby_id, e.payload.user_changed, e.payload.state as MemberChangeState);
  });
}

export function onLaunchJoin(handler: (lobbyId: string) => void): Promise<UnlistenFn> {
  return listen<LaunchJoinEvent>("steam_lobby://launch_join", (e) => {
    handler(e.payload.lobby_id);
  });
}
