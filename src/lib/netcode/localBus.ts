// In-memory message bus for the local 8-instance netcode harness. Stands in for
// WebRTC: routes BbNetSession's bytes between game instances running in the same
// tab, applying a per-client one-way latency + jitter + (unreliable-channel)
// packet loss so we can watch how the real netcode behaves under bad networks.
//
// Star topology, like the real game: the host relays guests' inputs. A message
// between the host and client K is delayed by K's configured latency; a guest→
// guest relay therefore costs both clients' latencies (two hops via the host),
// exactly as in production.

export type BusReceiver = (fromId: string, channel: string, data: ArrayBuffer | string) => void;

export interface LinkCfg {
  latencyMs: number;
  jitterMs: number;
  /** % packet loss, applied to the unreliable 'input' channel only. */
  dropPct: number;
}

export class LocalBus {
  private receivers = new Map<string, BusReceiver>();
  private cfg = new Map<string, LinkCfg>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly hostId: string) {}

  register(id: string, recv: BusReceiver, cfg: LinkCfg): void {
    this.receivers.set(id, recv);
    this.cfg.set(id, cfg);
  }

  setLinkCfg(id: string, cfg: LinkCfg): void { this.cfg.set(id, cfg); }
  getLinkCfg(id: string): LinkCfg | undefined { return this.cfg.get(id); }

  /** The latency that governs a host↔peer link is the NON-host endpoint's. */
  private clientOf(from: string, to: string): string {
    return from === this.hostId ? to : from;
  }

  send(from: string, to: string, channel: string, data: ArrayBuffer | string): void {
    if (this.disposed) return;
    const recv = this.receivers.get(to);
    if (!recv) return; // peer not registered yet — dropped (redundancy/state-sync recovers)
    const c = this.cfg.get(this.clientOf(from, to)) ?? { latencyMs: 0, jitterMs: 0, dropPct: 0 };
    if (channel === 'input' && c.dropPct > 0 && Math.random() * 100 < c.dropPct) return;
    const delay = Math.max(0, c.latencyMs + (Math.random() * 2 - 1) * c.jitterMs);
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) recv(from, channel, data);
    }, delay);
    this.timers.add(t);
  }

  broadcast(from: string, channel: string, data: ArrayBuffer | string, exclude?: string): void {
    for (const id of this.receivers.keys()) {
      if (id === from || id === exclude) continue;
      this.send(from, id, channel, data);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.receivers.clear();
  }
}
