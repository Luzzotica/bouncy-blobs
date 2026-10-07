// GENERATED from packages/party-kit — edit there, then run scripts/sync-party-kit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Transport — abstracts the wire between two peers.
//
// A Transport carries messages on named "channels" between the local process
// and one remote peer. Reliability is a transport concern: a transport may
// map channel names to different reliability guarantees (e.g. WebRTC uses an
// unreliable RTCDataChannel for "input" but reliable/ordered for "state").
// Callers send by channel name, not by reliability flag.
//
// PeerManager holds a registry of Transports keyed by remote peer id. A
// remote peer's kind ("phone" vs "screen") determines which channels exist:
//   - "screen" → "state" (reliable) + "input" (unreliable, no retransmits)
//   - anything else (default "phone") → "data" (reliable)
// ─────────────────────────────────────────────────────────────────────────────

export type ChannelName = "state" | "input" | "data" | "game-reliable" | "game-unreliable";
export type TransportRole = "offerer" | "answerer";

export interface Transport {
  readonly remoteId: string;
  readonly remoteKind: string;
  send(channel: ChannelName | string | undefined, data: string | ArrayBuffer | ArrayBufferView): boolean;
  isOpen(): boolean;
  /** Best-effort round-trip time in ms (selected ICE candidate pair), or null
   *  when unavailable. Optional — non-WebRTC transports may omit it. */
  getRttMs?(): Promise<number | null>;
  dispose(): void;
}

export interface ChannelTopology {
  /** Reliable/ordered channel name. Used as the default when callers omit a channel. */
  primary: ChannelName;
  /** Unreliable channel name. Only set for kinds that want split reliability. */
  unreliable?: ChannelName;
}

export function channelsForKind(kind: string): ChannelTopology {
  if (kind === "screen") return { primary: "state", unreliable: "input" };
  // Phones get an unreliable "input" channel alongside reliable "data" so the
  // continuous 30Hz joystick stream is sent latest-value/UDP-like. On a lossy
  // link a reliable-ordered channel head-of-line-blocks: one dropped packet
  // stalls every later one until retransmit. Discrete events stay on "data".
  if (kind === "phone") return { primary: "data", unreliable: "input" };
  // Game peers (gyrii-style rollback netcode): reliable channel for keyframes/
  // roster/beacons, unreliable for the per-tick input/relay stream.
  if (kind === "player") return { primary: "game-reliable", unreliable: "game-unreliable" };
  return { primary: "data" };
}

export function rtcConfigFromIceServers(servers?: import("./types").IceServerConfig[]): RTCConfiguration | undefined {
  if (!servers || servers.length === 0) return undefined;
  let forceRelay = false;
  let turnProto: string | null = null;
  try {
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search);
      if (q.get("relay") === "1") forceRelay = true;
      turnProto = q.get("turnproto"); // "tcp" | "tls" — connectivity-matrix testing
    }
  } catch { /* non-browser context */ }

  // ?turnproto=tcp|tls filters the minted TURN urls so the connectivity matrix
  // can prove each relay protocol works in isolation (tls = only turns: — the
  // 443 path UDP-blocked networks depend on). STUN entries stay for srflx
  // unless relay is also forced.
  let effective = servers as RTCIceServer[];
  if (turnProto === "tcp" || turnProto === "tls") {
    effective = effective
      .map((s) => {
        const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => {
          if (typeof u !== "string") return false;
          if (u.startsWith("stun:")) return true;
          return turnProto === "tls"
            ? u.startsWith("turns:")
            : u.startsWith("turn:") && u.includes("transport=tcp");
        });
        return { ...s, urls };
      })
      .filter((s) => (Array.isArray(s.urls) ? s.urls.length > 0 : true));
  }

  const cfg: RTCConfiguration = { iceServers: effective };
  if (forceRelay) cfg.iceTransportPolicy = "relay";
  return cfg;
}
