// Tiny diagnostic hook: exposes `window.__rtcDebug()` so you can dump every
// peer connection's candidate-pair table from the browser console — the same
// data chrome://webrtc-internals shows, just for THIS app's peers.
//
// Usage from DevTools:
//   await window.__rtcDebug()
//
// Returns + logs an array shaped per-peer with the candidate pairs each PC
// is currently considering. The interesting columns are `state` (succeeded
// / in-progress / failed / waiting), `nominated` (the pair the ICE agent
// picked), and `local`/`remote` (candidate type + IP:port).

import type { PeerManager } from "./party";
import { WebRtcTransport } from "./party/webrtcTransport";

let installed = false;

export function installRtcDebug(getManager: () => PeerManager | null): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  (window as any).__rtcDebug = async () => {
    const m = getManager();
    if (!m) {
      console.warn("[rtcDebug] no PeerManager attached yet");
      return [];
    }
    const transports = m.getAllTransports();
    const out: Array<{ peerId: string; kind: string; isOpen: boolean; pairs: unknown[] }> = [];
    for (const t of transports) {
      const pairs = t instanceof WebRtcTransport ? await t.collectCandidatePairs() : [];
      out.push({ peerId: t.remoteId, kind: t.remoteKind, isOpen: t.isOpen(), pairs });
    }
    console.table(out.flatMap((o) => o.pairs.map((p) => ({ peer: o.peerId, ...(p as object) }))));
    return out;
  };
}
