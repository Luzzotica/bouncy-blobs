// Compact binary codec for the symmetric input wire — a list of TaggedInputs
// ({playerId, applyTick, input}). Players are identified by their wire slot (u8);
// the lobby_state slot↔playerId map resolves them on receipt.
//
// The redundant 16-frame window is almost always ONE slot's CONSECUTIVE ticks, so
// instead of repeating the slot (1 B) + absolute applyTick (4 B) on every entry,
// we group into RUNS of consecutive ticks per slot:
//
//   magic 0x03, u8 runCount, then per run:
//     u8 slot, u32 baseApplyTick, u8 count, u8 mode, <payload>
//       mode 0 (PACKED): ceil(count*5/8) bytes; each input = 5 bits
//                        [ bit4=expand | bits3-2=myIdx | bits1-0=mxIdx ],
//                        idx 0/1/2 ↔ quantized axis −127/0/+127 ({−1,0,+1}).
//       mode 1 (RAW i8): count*3 bytes — i8 moveX_q, i8 moveY_q, u8 flags —
//                        for any analog value the packed form can't represent.
//
// A 16-input window thus costs ~19 B (was 129). LOSSLESS: packed mode is exact
// for 3-state inputs (round-trips to the same dequantized value as i8); anything
// else escapes to raw i8, so the wire value still equals what every peer applies.

import { quantizeAxisToInt, dequantizeAxis, MAX_SLOT } from '../inputProtocol';
import type { TaggedInput } from './netPeer';

export const MAGIC_TAGGED_INPUTS = 0x03;
const FLAG_EXPANDING = 0x01;
// Quantized 3-state axis values → packed index, and back.
const Q_TO_IDX = new Map<number, number>([[-127, 0], [0, 1], [127, 2]]);
const IDX_TO_Q = [-127, 0, 127];

export type SlotOf = (playerId: string) => number | undefined;
export type IdOfSlot = (slot: number) => string | undefined;

interface Entry { tick: number; mxq: number; myq: number; exp: boolean }

export function encodeTaggedInputs(items: TaggedInput[], slotOf: SlotOf): ArrayBuffer {
  // Group by slot, dedupe by tick (keep last), quantize axes once.
  const bySlot = new Map<number, Map<number, Entry>>();
  for (const t of items) {
    const s = slotOf(t.playerId);
    if (s === undefined || s < 0 || s > MAX_SLOT) continue;
    let m = bySlot.get(s);
    if (!m) { m = new Map(); bySlot.set(s, m); }
    m.set(t.applyTick >>> 0, {
      tick: t.applyTick >>> 0,
      mxq: quantizeAxisToInt(t.input.moveX),
      myq: quantizeAxisToInt(t.input.moveY),
      exp: t.input.expanding,
    });
  }

  // Split each slot into consecutive-tick runs (≤255 each).
  const runs: { slot: number; base: number; items: Entry[] }[] = [];
  for (const [slot, m] of bySlot) {
    const list = [...m.values()].sort((a, b) => a.tick - b.tick);
    let run: { slot: number; base: number; items: Entry[] } | null = null;
    for (const e of list) {
      if (run && e.tick === run.base + run.items.length && run.items.length < 255) {
        run.items.push(e);
      } else {
        if (run) runs.push(run);
        run = { slot, base: e.tick, items: [e] };
      }
    }
    if (run) runs.push(run);
  }

  const out: number[] = [MAGIC_TAGGED_INPUTS, Math.min(runs.length, 255)];
  for (const run of runs.slice(0, 255)) {
    const packed = run.items.every((e) => Q_TO_IDX.has(e.mxq) && Q_TO_IDX.has(e.myq));
    out.push(run.slot);
    out.push(run.base & 0xff, (run.base >>> 8) & 0xff, (run.base >>> 16) & 0xff, (run.base >>> 24) & 0xff);
    out.push(run.items.length);
    out.push(packed ? 0 : 1);
    if (packed) {
      let bitBuf = 0, bitCnt = 0;
      for (const e of run.items) {
        const v = (Q_TO_IDX.get(e.mxq)!) | (Q_TO_IDX.get(e.myq)! << 2) | ((e.exp ? 1 : 0) << 4);
        bitBuf |= v << bitCnt; bitCnt += 5;
        while (bitCnt >= 8) { out.push(bitBuf & 0xff); bitBuf >>>= 8; bitCnt -= 8; }
      }
      if (bitCnt > 0) out.push(bitBuf & 0xff);
    } else {
      for (const e of run.items) {
        out.push(e.mxq & 0xff, e.myq & 0xff, e.exp ? FLAG_EXPANDING : 0);
      }
    }
  }
  return Uint8Array.from(out).buffer;
}

export function decodeTaggedInputs(data: ArrayBuffer | Uint8Array, idOfSlot: IdOfSlot): TaggedInput[] | null {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.byteLength < 2 || u8[0] !== MAGIC_TAGGED_INPUTS) return null;
  let p = 1;
  const runCount = u8[p++];
  const out: TaggedInput[] = [];
  for (let r = 0; r < runCount; r++) {
    if (p + 7 > u8.byteLength) return null;
    const slot = u8[p++];
    const base = (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0; p += 4;
    const count = u8[p++];
    const mode = u8[p++];
    const playerId = idOfSlot(slot);
    if (mode === 0) {
      const need = Math.ceil(count * 5 / 8);
      if (p + need > u8.byteLength) return null;
      let bitBuf = 0, bitCnt = 0, bp = p;
      for (let i = 0; i < count; i++) {
        while (bitCnt < 5) { bitBuf |= u8[bp++] << bitCnt; bitCnt += 8; }
        const v = bitBuf & 0x1f; bitBuf >>>= 5; bitCnt -= 5;
        if (playerId !== undefined) {
          out.push({
            playerId, applyTick: (base + i) >>> 0,
            input: { moveX: dequantizeAxis(IDX_TO_Q[v & 0x3]), moveY: dequantizeAxis(IDX_TO_Q[(v >> 2) & 0x3]), expanding: !!((v >> 4) & 0x1) },
          });
        }
      }
      p += need;
    } else {
      if (p + count * 3 > u8.byteLength) return null;
      for (let i = 0; i < count; i++) {
        const mxq = (u8[p] << 24) >> 24; const myq = (u8[p + 1] << 24) >> 24; const flags = u8[p + 2]; p += 3;
        if (playerId !== undefined) {
          out.push({ playerId, applyTick: (base + i) >>> 0, input: { moveX: dequantizeAxis(mxq), moveY: dequantizeAxis(myq), expanding: !!(flags & FLAG_EXPANDING) } });
        }
      }
    }
  }
  return out;
}
