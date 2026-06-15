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

export type ChannelName = "state" | "input" | "data";
export type TransportRole = "offerer" | "answerer";

export interface Transport {
  readonly remoteId: string;
  readonly remoteKind: string;
  send(channel: ChannelName | string | undefined, data: string | ArrayBuffer): boolean;
  isOpen(): boolean;
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
  return { primary: "data" };
}
