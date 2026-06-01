// ─────────────────────────────────────────────────────────────────────────────
// Input protocol — binary encode/decode for the input-streaming wire.
//
// Two record kinds, distinguished by a leading magic byte:
//
//   0x01  ClientInputBatch  — client → host
//     One or more (tick, moveX, moveY, flags) frames from a single client.
//     Player id is implicit — the host knows the peer that sent it. Batched
//     so input frames that piled up during a stall can be flushed at once.
//
//   0x02  AggregatedInputs  — host → all guests
//     The committed input set for one or more consecutive ticks. Each tick
//     carries a (slot, moveX_q, moveY_q, flags) record per player with input
//     this tick. Guests resolve slot→playerId via the slot table broadcast
//     in lobby_state, and apply at the tagged tick number.
//
// The world snapshot keeps the existing 0x00 magic (`wireProtocol.ts`), so a
// receiver can disambiguate any byte-channel message by inspecting byte 0:
//   0x00 → world snapshot, 0x01 → client input, 0x02 → aggregated inputs,
//   else (printable ASCII like '{') → JSON reliable event.
//
// VERSION 2 (compact) — host→guest broadcast:
//   Per-player-tick is 4 bytes: u8 slot, i8 moveX_q, i8 moveY_q, u8 flags.
//   Down from ~38 bytes in v1 (variable-length playerId + 2× f64). Enables
//   K=120-tick redundant broadcasts at ~3 KB/packet instead of ~24 KB,
//   fitting in a single SCTP fragment on the unreliable channel.
//
// Determinism rule: moveX/moveY are quantized to i8 (1/127 quantum). The
// HOST must apply the quantized value to its own sim BEFORE broadcasting,
// otherwise host's sim uses raw f64 0.7071068 while guests get
// dequantize(91)=0.7165354 — silent divergence within a few ticks.
// `quantizeAxis(v)` returns the canonical precision value (round(v*127)/127)
// and should be called wherever a moveX/moveY value enters ManagedPlayer.*.
//
//   tick:         uint32 — wraps at ~828 days of 60 Hz play.
// ─────────────────────────────────────────────────────────────────────────────

export const INPUT_VERSION = 2;
export const MAGIC_CLIENT_INPUT = 0x01;
export const MAGIC_AGGREGATED_INPUTS = 0x02;

const FLAG_EXPANDING = 0x01;

/** Slot value reserved for "unassigned / unknown." A producer must never
 *  emit this; a consumer that decodes it should drop the frame. */
export const SLOT_UNASSIGNED = 255;
/** Max usable slot index. Bumps if lobbies grow past 16 players. */
export const MAX_SLOT = 15;

/** Quantize an axis value [-1, 1] to the canonical i8 representation.
 *  Returns an integer in [-127, 127]. */
export function quantizeAxisToInt(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(clamped * 127);
}

/** Inverse of `quantizeAxisToInt`. Returns a value in [-1, 1]. */
export function dequantizeAxis(q: number): number {
  return q / 127;
}

/** Round-trip a raw axis value through quantize→dequantize so callers can
 *  store the canonical precision value into ManagedPlayer.moveX/Y. This is
 *  what enforces determinism: every consumer of moveX/Y applies the same
 *  bit-exact value the wire carries. */
export function quantizeAxis(v: number): number {
  return dequantizeAxis(quantizeAxisToInt(v));
}

export interface InputFrame {
  /** Logical tick this input applies at. */
  tick: number;
  moveX: number;    // -1..1
  moveY: number;    // -1..1
  expanding: boolean;
}

export interface ClientInputBatch {
  /** Frames from a single client, in tick order. Player id is identified by
   * the connection on the receiving end. */
  frames: InputFrame[];
}

export interface PerPlayerInput {
  /** Wire-level slot index (0..MAX_SLOT). Host assigns at player-join time;
   *  guests learn the slot↔playerId map from `lobby_state`. Producers must
   *  set this; consumers receive it directly from the wire. */
  slot: number;
  /** Resolved by the decoder when a slot→id resolver is provided. Undefined
   *  when the resolver doesn't know the slot (e.g. lobby_state not yet
   *  received). Callers should drop frames where this is undefined. */
  playerId?: string;
  /** Dequantized axis value in [-1, 1], precision = 1/127. */
  moveX: number;
  moveY: number;
  expanding: boolean;
}

export interface AggregatedTick {
  tick: number;
  inputs: PerPlayerInput[];
}

export interface AggregatedInputs {
  ticks: AggregatedTick[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const TE = new TextEncoder();
const TD = new TextDecoder();

function idBytes(id: string): Uint8Array {
  const b = TE.encode(id);
  return b.length > 255 ? b.slice(0, 255) : b;
}

// ── Client input batch (client → host) ───────────────────────────────────────
// Kept on the v1 format. ClientInputBatch is only used by tests in practice
// (GameMaster + OnlineGuest send/receive ClientInputBatch as JSON, not
// binary). Leaving it alone keeps the existing test suite passing.

const CLIENT_INPUT_VERSION = 1;

export function encodeClientInputBatch(batch: ClientInputBatch): ArrayBuffer {
  const count = Math.min(batch.frames.length, 255);
  // 1 magic + 1 ver + 1 frameCount + N * (4 tick + 8 mx + 8 my + 1 flags)
  const total = 3 + count * 21;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint8(p, MAGIC_CLIENT_INPUT); p += 1;
  dv.setUint8(p, CLIENT_INPUT_VERSION); p += 1;
  dv.setUint8(p, count); p += 1;
  for (let i = 0; i < count; i++) {
    const f = batch.frames[i];
    dv.setUint32(p, f.tick >>> 0, true); p += 4;
    dv.setFloat64(p, f.moveX, true); p += 8;
    dv.setFloat64(p, f.moveY, true); p += 8;
    dv.setUint8(p, f.expanding ? FLAG_EXPANDING : 0); p += 1;
  }
  return buf;
}

export function decodeClientInputBatch(data: ArrayBuffer | Uint8Array): ClientInputBatch | null {
  const buf = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  let p = 0;
  if (dv.getUint8(p) !== MAGIC_CLIENT_INPUT) return null;
  p += 1;
  if (dv.getUint8(p) !== CLIENT_INPUT_VERSION) return null;
  p += 1;
  const count = dv.getUint8(p); p += 1;
  if (buf.byteLength < 3 + count * 21) return null;

  const frames: InputFrame[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const tick = dv.getUint32(p, true); p += 4;
    const moveX = dv.getFloat64(p, true); p += 8;
    const moveY = dv.getFloat64(p, true); p += 8;
    const flags = dv.getUint8(p); p += 1;
    frames[i] = { tick, moveX, moveY, expanding: !!(flags & FLAG_EXPANDING) };
  }
  return { frames };
}

// Stash for backward-compat exports / silence unused TextDecoder warning.
export function _unusedIdBytes(id: string): Uint8Array { return idBytes(id); }
void TD;

// ── Aggregated inputs (host → guests, compact v2 format) ─────────────────────

export function encodeAggregatedInputs(agg: AggregatedInputs): ArrayBuffer {
  const tickCount = Math.min(agg.ticks.length, 255);
  // 1 magic + 1 ver + 1 tickCount + per-tick (4 tick + 1 playerCount + N*4 players)
  let total = 3;
  for (let t = 0; t < tickCount; t++) {
    const ti = agg.ticks[t];
    total += 4 + 1 + Math.min(ti.inputs.length, 255) * 4;
  }

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint8(p, MAGIC_AGGREGATED_INPUTS); p += 1;
  dv.setUint8(p, INPUT_VERSION); p += 1;
  dv.setUint8(p, tickCount); p += 1;

  for (let t = 0; t < tickCount; t++) {
    const ti = agg.ticks[t];
    dv.setUint32(p, ti.tick >>> 0, true); p += 4;
    const playerCount = Math.min(ti.inputs.length, 255);
    dv.setUint8(p, playerCount); p += 1;
    for (let i = 0; i < playerCount; i++) {
      const inp = ti.inputs[i];
      // Slot defaults to SLOT_UNASSIGNED if producer forgot to set it —
      // decoders will drop those frames cleanly.
      const slot = (inp.slot >= 0 && inp.slot <= MAX_SLOT) ? inp.slot : SLOT_UNASSIGNED;
      dv.setUint8(p, slot); p += 1;
      dv.setInt8(p, quantizeAxisToInt(inp.moveX)); p += 1;
      dv.setInt8(p, quantizeAxisToInt(inp.moveY)); p += 1;
      dv.setUint8(p, inp.expanding ? FLAG_EXPANDING : 0); p += 1;
    }
  }
  return buf;
}

/** Optional resolver mapping slot → playerId. If not provided (or returns
 *  undefined for a slot), the decoded `PerPlayerInput.playerId` is left
 *  undefined and the caller is expected to drop that frame. */
export type SlotResolver = (slot: number) => string | undefined;

export function decodeAggregatedInputs(
  data: ArrayBuffer | Uint8Array,
  resolveSlot?: SlotResolver,
): AggregatedInputs | null {
  const buf = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  let p = 0;
  if (dv.getUint8(p) !== MAGIC_AGGREGATED_INPUTS) return null;
  p += 1;
  if (dv.getUint8(p) !== INPUT_VERSION) return null;
  p += 1;
  const tickCount = dv.getUint8(p); p += 1;

  const ticks: AggregatedTick[] = new Array(tickCount);
  try {
    for (let t = 0; t < tickCount; t++) {
      const tick = dv.getUint32(p, true); p += 4;
      const playerCount = dv.getUint8(p); p += 1;
      const inputs: PerPlayerInput[] = new Array(playerCount);
      for (let i = 0; i < playerCount; i++) {
        const slot = dv.getUint8(p); p += 1;
        const mxq = dv.getInt8(p); p += 1;
        const myq = dv.getInt8(p); p += 1;
        const flags = dv.getUint8(p); p += 1;
        inputs[i] = {
          slot,
          playerId: resolveSlot?.(slot),
          moveX: dequantizeAxis(mxq),
          moveY: dequantizeAxis(myq),
          expanding: !!(flags & FLAG_EXPANDING),
        };
      }
      ticks[t] = { tick, inputs };
    }
  } catch {
    return null;
  }
  return { ticks };
}
