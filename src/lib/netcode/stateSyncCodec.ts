// Host → guest state-correction wire formats.
//
// TWO packets, both on the 'state' channel:
//
//  • HASH BEACON (magic 0x05) — `u32 tick, u64 hash`. Sent EVERY tick (tiny,
//    13 B). The guest compares it to its own hash for that tick; a match means
//    prediction was correct (the common case → nothing sent). This is what makes
//    streaming cheap: we broadcast a 13-byte fingerprint, not a 6 KB snapshot.
//
//  • FULL STATE (magic 0x04) — the complete lossless engine snapshot + TS manager
//    state, DEFLATE-compressed, with the tick + hash in a readable header. Sent
//    only (a) on a guest's keyframe request after a beacon mismatch, (b) as an
//    occasional keyframe for late-joiners. The engine bytes are lossless so the
//    rebase is EXACT — no quantization (quantizing would make the guest's hash
//    never match the host's → permanent re-sync). Compression is the only size
//    reduction that preserves that exactness.
//
//   0x04: u8 magic, u32 tick, u64 hash, u32 deflatedLen, <deflate( u32 engineLen,
//         engineBytes, utf8 JSON(gameState) )>

import { deflateSync, inflateSync } from 'fflate';

export const MAGIC_STATE_SYNC = 0x04;
export const MAGIC_HASH_BEACON = 0x05;

export interface StateSync {
  tick: number;
  hash: string;
  engineState: Uint8Array;
  gameState: unknown;
}

const TE = new TextEncoder();
const TD = new TextDecoder();

// hash is the engine's `state_hash()` string: '0x' + 16 hex chars (64-bit).
function hashToU64(hash: string): bigint { try { return BigInt(hash) & 0xffffffffffffffffn; } catch { return 0n; } }
function u64ToHash(n: bigint): string { return '0x' + n.toString(16).padStart(16, '0'); }

// ── Hash beacon (0x05) ───────────────────────────────────────────────────────
export function encodeHashBeacon(tick: number, hash: string): ArrayBuffer {
  const buf = new ArrayBuffer(1 + 4 + 8);
  const dv = new DataView(buf);
  dv.setUint8(0, MAGIC_HASH_BEACON);
  dv.setUint32(1, tick >>> 0, true);
  dv.setBigUint64(5, hashToU64(hash), true);
  return buf;
}

export function decodeHashBeacon(data: ArrayBuffer | Uint8Array): { tick: number; hash: string } | null {
  const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
  if (buf.byteLength < 13) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== MAGIC_HASH_BEACON) return null;
  return { tick: dv.getUint32(1, true), hash: u64ToHash(dv.getBigUint64(5, true)) };
}

// ── Full state (0x04, compressed) ────────────────────────────────────────────
export function encodeStateSync(s: StateSync): ArrayBuffer {
  const gameJson = TE.encode(JSON.stringify(s.gameState ?? null));
  const payload = new Uint8Array(4 + s.engineState.byteLength + gameJson.byteLength);
  new DataView(payload.buffer).setUint32(0, s.engineState.byteLength >>> 0, true);
  payload.set(s.engineState, 4);
  payload.set(gameJson, 4 + s.engineState.byteLength);
  const deflated = deflateSync(payload);

  const buf = new ArrayBuffer(1 + 4 + 8 + 4 + deflated.byteLength);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, MAGIC_STATE_SYNC);
  dv.setUint32(1, s.tick >>> 0, true);
  dv.setBigUint64(5, hashToU64(s.hash), true);
  dv.setUint32(13, deflated.byteLength >>> 0, true);
  u8.set(deflated, 17);
  return buf;
}

export function decodeStateSync(data: ArrayBuffer | Uint8Array): StateSync | null {
  const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
  if (buf.byteLength < 17) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== MAGIC_STATE_SYNC) return null;
  const tick = dv.getUint32(1, true);
  const hash = u64ToHash(dv.getBigUint64(5, true));
  const deflatedLen = dv.getUint32(13, true);
  if (17 + deflatedLen > buf.byteLength) return null;
  let payload: Uint8Array;
  try { payload = inflateSync(new Uint8Array(buf, 17, deflatedLen)); } catch { return null; }
  if (payload.byteLength < 4) return null;
  const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const engineLen = pv.getUint32(0, true);
  if (4 + engineLen > payload.byteLength) return null;
  const engineState = payload.slice(4, 4 + engineLen);
  let gameState: unknown = null;
  try { gameState = JSON.parse(TD.decode(payload.subarray(4 + engineLen))); } catch { return null; }
  return { tick, hash, engineState, gameState };
}
