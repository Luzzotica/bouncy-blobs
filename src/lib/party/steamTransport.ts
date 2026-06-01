// ─────────────────────────────────────────────────────────────────────────────
// SteamTransport — Transport implementation backed by ISteamNetworkingSockets.
//
// One SteamTransport instance wraps one Steam Networking connection. The Rust
// side owns the actual NetConnection and identifies each connection with a
// u32 `connHandle`; this module routes Tauri events to the right transport by
// that handle.
//
// Two ways a SteamTransport gets a connHandle:
//   - Dial out: call `connectAsClient(remoteSteamId)` → invoke('steam_net_connect')
//     returns the handle synchronously; we wait for the
//     `steam_net://connected` event before considering the link open.
//   - Accept in: a `steam_net://connected` event fires for a handle we've never
//     seen → `acceptIncoming(connHandle, remoteSteamId)` is called by the
//     host-side glue, which constructs a SteamTransport already in the open state.
//
// All Steam-Networking peers are "screen" today — phones can't speak Steam
// Networking (they're browsers), so they stay on WebRTC.
// ─────────────────────────────────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PeerCallbacks } from "./types";
import type { ChannelName, Transport } from "./transport";

interface ConnectedEvent {
  conn_handle: number;
  remote_steam_id: number;
}

interface MessageEvent {
  conn_handle: number;
  channel: string;
  /** Raw bytes from Rust as a number array. The consumer decides whether to
   * interpret as utf-8 (JSON reliable events) or as a binary world frame. */
  bin: number[];
}

interface ClosedEvent {
  conn_handle: number;
  remote_steam_id: number;
  reason: string;
}

// ── Global event router ──────────────────────────────────────────────────────
// Tauri listeners are global; we set them up once and dispatch by connHandle.

type Handlers = {
  onConnected?: () => void;
  onMessage?: (channel: string, data: string | ArrayBuffer) => void;
  onClosed?: (reason: string) => void;
};

const routes: Map<number, Handlers> = new Map();
let unlisten: UnlistenFn[] = [];
let started = false;
let pendingHandlers: Array<{ remoteSteamId: string; h: Handlers }> = [];

async function ensureListeners(): Promise<void> {
  if (started) return;
  started = true;
  unlisten.push(
    await listen<ConnectedEvent>("steam_net://connected", (evt) => {
      const { conn_handle, remote_steam_id } = evt.payload;
      // If a pre-registered handler is waiting for this remote SteamID (the
      // host-side accept flow), bind it now.
      const idx = pendingHandlers.findIndex((p) => p.remoteSteamId === String(remote_steam_id));
      if (idx >= 0) {
        const { h } = pendingHandlers.splice(idx, 1)[0];
        routes.set(conn_handle, h);
      }
      routes.get(conn_handle)?.onConnected?.();
    }),
  );
  unlisten.push(
    await listen<MessageEvent>("steam_net://message", (evt) => {
      const { conn_handle, channel, bin } = evt.payload;
      const route = routes.get(conn_handle);
      if (!route) return;
      // Bytes start with our 0x00 binary-magic marker → deliver as
      // ArrayBuffer (binary snapshot frame). Otherwise decode as utf-8 text
      // (JSON reliable event).
      const u8 = Uint8Array.from(bin);
      if (u8.length > 0 && u8[0] === 0x00) {
        route.onMessage?.(channel, u8.buffer.slice(0));
      } else {
        route.onMessage?.(channel, new TextDecoder().decode(u8));
      }
    }),
  );
  unlisten.push(
    await listen<ClosedEvent>("steam_net://closed", (evt) => {
      const { conn_handle, reason } = evt.payload;
      const h = routes.get(conn_handle);
      routes.delete(conn_handle);
      h?.onClosed?.(reason);
    }),
  );
}

/** Listen for incoming connections on this Steam user's SteamID. Idempotent. */
export async function steamNetStartListening(): Promise<void> {
  await ensureListeners();
  await invoke("steam_net_listen");
}

/** Read the local Steam user's SteamID (as a decimal string). */
export async function getSelfSteamId(): Promise<string> {
  return await invoke<string>("steam_id_self");
}

/** Local Steam user's persona (display) name. Returns null if Steam isn't
 *  available (running outside the Tauri shell or Steam isn't initialized).
 *  Used to pre-fill the host's name picker. */
export async function getSelfSteamPersonaName(): Promise<string | null> {
  try {
    const name = await invoke<string>("steam_persona_name");
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Pre-register a handler for an incoming connection from a known remote SteamID.
 * The host calls this once it expects a particular friend to dial in (e.g. via
 * a Steam Lobby chat that shares the host's SteamID). When the resulting
 * `steam_net://connected` event arrives, the handlers are bound to the new
 * connHandle automatically. */
function registerPendingIncoming(remoteSteamId: string, h: Handlers): void {
  pendingHandlers.push({ remoteSteamId, h });
}

// ── Transport implementation ────────────────────────────────────────────────

export class SteamTransport implements Transport {
  public readonly remoteKind = "screen";
  private connHandle: number | null = null;
  private opened = false;

  private constructor(public readonly remoteId: string) {}

  /** Dial out to a remote SteamID. The transport returns once the local
   * NetConnection is allocated; `onPeerConnected` fires when Steam reports
   * the connection state as Connected. */
  static async connect(remoteSteamId: string, callbacks: PeerCallbacks): Promise<SteamTransport> {
    await ensureListeners();
    const t = new SteamTransport(remoteSteamId);
    const handle = await invoke<number>("steam_net_connect", { remoteSteamId });
    t.connHandle = handle;
    routes.set(handle, t.makeHandlers(callbacks));
    return t;
  }

  /** Host-side: register a transport for an expected incoming peer identified
   * by their SteamID. The connection's local handle is bound when Steam fires
   * the connected event. */
  static async accept(remoteSteamId: string, callbacks: PeerCallbacks): Promise<SteamTransport> {
    await ensureListeners();
    const t = new SteamTransport(remoteSteamId);
    registerPendingIncoming(remoteSteamId, t.makeHandlers(callbacks));
    return t;
  }

  private makeHandlers(callbacks: PeerCallbacks): Handlers {
    return {
      onConnected: () => {
        if (this.opened) return;
        this.opened = true;
        callbacks.onPeerConnected?.(this.remoteId, this.remoteKind);
      },
      onMessage: (channel, data) => {
        callbacks.onMessage?.(this.remoteId, channel, data);
      },
      onClosed: (reason) => {
        callbacks.onPeerDisconnected?.(this.remoteId);
        if (reason && reason !== "user_close") {
          callbacks.onError?.(new Error(`steam_net closed: ${reason}`));
        }
      },
    };
  }

  send(channel: ChannelName | string | undefined, data: string | ArrayBuffer): boolean {
    if (this.connHandle === null || !this.opened) return false;
    const ch = channel ?? "state";
    if (typeof data === "string") {
      invoke("steam_net_send", { connHandle: this.connHandle, channel: ch, data }).catch(() => {});
    } else {
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      invoke("steam_net_send_bin", {
        connHandle: this.connHandle,
        channel: ch,
        data: Array.from(u8),
      }).catch(() => {});
    }
    return true;
  }

  isOpen(): boolean {
    return this.opened && this.connHandle !== null;
  }

  dispose(): void {
    if (this.connHandle !== null) {
      const h = this.connHandle;
      this.connHandle = null;
      this.opened = false;
      routes.delete(h);
      invoke("steam_net_close", { connHandle: h }).catch(() => {});
    }
  }
}

/** Tear down all Steam Networking state (commonly called on app shutdown). */
export async function steamNetCloseAll(): Promise<void> {
  routes.clear();
  pendingHandlers = [];
  for (const fn of unlisten) {
    try { fn(); } catch { /* noop */ }
  }
  unlisten = [];
  started = false;
  await invoke("steam_net_close_all").catch(() => {});
}
