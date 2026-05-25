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
//     carries an explicit (playerId, moveX, moveY, flags) record per player
//     that has input that tick. Guests apply at the tagged tick number.
//
// The world snapshot keeps the existing 0x00 magic (`wireProtocol.ts`), so a
// receiver can disambiguate any byte-channel message by inspecting byte 0:
//   0x00 → world snapshot, 0x01 → client input, 0x02 → aggregated inputs,
//   else (printable ASCII like '{') → JSON reliable event.
//
// Format:
//   moveX, moveY: f64 (NOT quantized). JS numbers are natively f64; using
//                 anything smaller (f32, i16, i8) introduces a precision
//                 mismatch between host's applied value and the guest's
//                 decoded value, which breaks the deterministic sim
//                 instantly. ~16 bytes of wire per player per tick is
//                 negligible compared to the correctness it preserves.
//   tick:         uint32 — wraps at ~828 days of 60 Hz play.
// ─────────────────────────────────────────────────────────────────────────────

export const INPUT_VERSION = 1;
export const MAGIC_CLIENT_INPUT = 0x01;
export const MAGIC_AGGREGATED_INPUTS = 0x02;

const FLAG_EXPANDING = 0x01;

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
  playerId: string;
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

export function encodeClientInputBatch(batch: ClientInputBatch): ArrayBuffer {
  const count = Math.min(batch.frames.length, 255);
  // 1 magic + 1 ver + 1 frameCount + N * (4 tick + 8 mx + 8 my + 1 flags)
  const total = 3 + count * 21;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let p = 0;
  dv.setUint8(p, MAGIC_CLIENT_INPUT); p += 1;
  dv.setUint8(p, INPUT_VERSION); p += 1;
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
  if (dv.getUint8(p) !== INPUT_VERSION) return null;
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

// ── Aggregated inputs (host → guests) ────────────────────────────────────────

export function encodeAggregatedInputs(agg: AggregatedInputs): ArrayBuffer {
  const tickCount = Math.min(agg.ticks.length, 255);
  let total = 3; // magic + ver + tickCount
  for (let t = 0; t < tickCount; t++) {
    const ti = agg.ticks[t];
    total += 4 + 1; // tick + playerCount
    for (const inp of ti.inputs) {
      const idLen = idBytes(inp.playerId).length;
      total += 1 + idLen + 8 + 8 + 1; // idLen + bytes + f64 mx + f64 my + flags
    }
  }

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
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
      const ib = idBytes(inp.playerId);
      dv.setUint8(p, ib.length); p += 1;
      u8.set(ib, p); p += ib.length;
      dv.setFloat64(p, inp.moveX, true); p += 8;
      dv.setFloat64(p, inp.moveY, true); p += 8;
      dv.setUint8(p, inp.expanding ? FLAG_EXPANDING : 0); p += 1;
    }
  }
  return buf;
}

export function decodeAggregatedInputs(data: ArrayBuffer | Uint8Array): AggregatedInputs | null {
  const buf = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    : data;
  if (buf.byteLength < 3) return null;
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
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
        const idLen = dv.getUint8(p); p += 1;
        const id = TD.decode(u8.subarray(p, p + idLen)); p += idLen;
        const moveX = dv.getFloat64(p, true); p += 8;
        const moveY = dv.getFloat64(p, true); p += 8;
        const flags = dv.getUint8(p); p += 1;
        inputs[i] = { playerId: id, moveX, moveY, expanding: !!(flags & FLAG_EXPANDING) };
      }
      ticks[t] = { tick, inputs };
    }
  } catch {
    return null;
  }
  return { ticks };
}
