// The partii connection engine (wasm) for the phone controller.
//
// The engine is vendored next to the page in public/engine/ (copied from
// partii/platform/sdk/engine-web by `npm run engine`) and loaded at run time,
// not bundled: one engine per page. It joins rooms, keeps the session alive
// (reconnecting by itself through short drops) and routes messages over the
// best path it has (WebRTC when up, the edge relay otherwise).

export const GAME_ID = 'bouncy-blobs';

const DEFAULT_EDGE = 'https://partii-edge-staging.partii-games.workers.dev';

export interface EngineEvent {
  ev: string;
  [k: string]: any;
}

export interface Engine {
  poll(): EngineEvent[];
  join(code: string, kind: string, name: string, meta: unknown): number;
  send(to: number, reliable: boolean, bytes: Uint8Array): void;
  leave(): void;
  online(): boolean;
  pathName(id: number): string;
}

/** Platform settings: `?k=<publishable key>&e=<edge url>` override the
 *  build-time defaults (VITE_PARTII_KEY / VITE_PARTII_API). */
export function partiiSettings(search: string = location.search): { edge: string; key: string } {
  const q = new URLSearchParams(search);
  const edge = q.get('e') || import.meta.env.VITE_PARTII_API || DEFAULT_EDGE;
  const key = q.get('k') || import.meta.env.VITE_PARTII_KEY || '';
  return { edge, key };
}

/** Keep only the override params (k, e) so they survive /join → /controller. */
export function carriedQuery(search: string = location.search): string {
  const q = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const k of ['k', 'e']) {
    const v = q.get(k);
    if (v) out.set(k, v);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export async function startEngine(edge: string, key: string): Promise<Engine> {
  const url = new URL('/engine/partii_engine.js', location.href).href;
  const mod: any = await import(/* @vite-ignore */ url);
  await mod.default();
  const client = `bouncy-blobs-controller/${navigator.userAgent.includes('Mobile') ? 'phone' : 'web'}`;
  const e = new mod.WebEngine(JSON.stringify({ edge, key, conn: '', client, player_token: null, no_webrtc: false }));
  return {
    poll: () => JSON.parse(e.poll()),
    join: (code, kind, name, meta) => e.join(code, kind, name, JSON.stringify(meta)),
    send: (to, reliable, bytes) => e.send(to, reliable, bytes),
    leave: () => e.leave(),
    online: () => e.online(),
    pathName: (id) => {
      try { return String(mod.WebEngine.pathName(id)); } catch { return String(id); }
    },
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const encodeText = (s: string): Uint8Array => enc.encode(s);
export const decodeText = (bytes: number[] | Uint8Array): string => dec.decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
