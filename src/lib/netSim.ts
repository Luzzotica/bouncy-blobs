// In-app network condition simulator.
//
// Two-tab WebRTC over loopback doesn't go through any throttle-able layer
// (Chrome DevTools throttling skips datachannels; macOS Network Link
// Conditioner skips loopback). This module fakes the missing layer by
// scheduling sends/receives through setTimeout with a configurable
// latency + jitter, and optionally dropping unreliable-channel messages.
//
// Latency is one-way; configure both ends if you want a true RTT effect.
// Currently wired only on the guest (the side that actually sees jitter
// in our setup — the host runs free locally).

export interface NetSimConfig {
  enabled: boolean;
  /** One-way latency floor in milliseconds. */
  latencyMs: number;
  /** Max symmetric jitter added on top of latency. Actual added delay is
   *  uniform in [latency-jitter, latency+jitter], clamped at 0. */
  jitterMs: number;
  /** Drop probability in [0, 100] — applied ONLY to messages tagged
   *  reliable=false. Dropping reliable traffic would tear down the room. */
  dropPct: number;
}

const config: NetSimConfig = {
  enabled: false,
  latencyMs: 0,
  jitterMs: 0,
  dropPct: 0,
};

const listeners = new Set<(c: NetSimConfig) => void>();

export function getNetSimConfig(): NetSimConfig {
  return { ...config };
}

export function setNetSimConfig(patch: Partial<NetSimConfig>): void {
  Object.assign(config, patch);
  for (const l of listeners) l(getNetSimConfig());
}

export function subscribeNetSim(fn: (c: NetSimConfig) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Parse `?netSim=lat,jitter,drop` (e.g. `?netSim=80,30,2`) and seed the
 *  singleton. Missing parts default to 0. Presence of the param flips
 *  `enabled` on. */
export function initNetSimFromUrl(search: string = window.location.search): void {
  const sp = new URLSearchParams(search);
  const raw = sp.get('netSim');
  if (raw === null) return;
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  const [lat = 0, jit = 0, drop = 0] = parts;
  setNetSimConfig({
    enabled: true,
    latencyMs: Math.max(0, lat),
    jitterMs: Math.max(0, jit),
    dropPct: Math.max(0, Math.min(100, drop)),
  });
}

/** Schedule `fn` after the configured delay. If the sim is disabled, runs
 *  synchronously. Returns `true` if the message was delivered (or
 *  scheduled), `false` if it was dropped. */
export function scheduleNetSim(reliable: boolean, fn: () => void): boolean {
  if (!config.enabled) {
    fn();
    return true;
  }
  if (!reliable && config.dropPct > 0 && Math.random() * 100 < config.dropPct) {
    return false;
  }
  const jitter = config.jitterMs > 0 ? (Math.random() * 2 - 1) * config.jitterMs : 0;
  const delay = Math.max(0, config.latencyMs + jitter);
  if (delay === 0) {
    fn();
  } else {
    setTimeout(fn, delay);
  }
  return true;
}

/** Channel name → reliability classifier. On WebRTC the 'input' channel is
 *  the unreliable one (ordered=false, maxRetransmits=0) and everything
 *  else is reliable. Keep this in sync with `webrtcTransport.ts`. */
export function isReliableChannel(channel: string): boolean {
  return channel !== 'input';
}
