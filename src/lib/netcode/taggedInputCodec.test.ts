import { describe, it, expect } from 'vitest';
import { encodeTaggedInputs, decodeTaggedInputs } from './taggedInputCodec';
import { quantizeAxisToInt, dequantizeAxis } from '../inputProtocol';
import type { TaggedInput } from './netPeer';

const slotOf = (pid: string) => Number(pid.slice(1)); // 'p3' → 3
const idOfSlot = (s: number) => `p${s}`;

// What every peer actually applies = quantize→dequantize of the sent value.
function canon(input: { moveX: number; moveY: number; expanding: boolean }) {
  return { moveX: dequantizeAxis(quantizeAxisToInt(input.moveX)), moveY: dequantizeAxis(quantizeAxisToInt(input.moveY)), expanding: input.expanding };
}

describe('taggedInputCodec', () => {
  it('16-input 3-state window round-trips losslessly and is tiny', () => {
    const items: TaggedInput[] = [];
    for (let i = 0; i < 16; i++) {
      items.push({ playerId: 'p0', applyTick: 1000 + i, input: { moveX: (i % 3) - 1, moveY: ((i + 1) % 3) - 1, expanding: i % 2 === 0 } });
    }
    const ab = encodeTaggedInputs(items, slotOf);
    expect(ab.byteLength).toBeLessThan(24); // was 129 (2 + 16×8)
    const d = decodeTaggedInputs(ab, idOfSlot)!;
    expect(d).toHaveLength(16);
    for (let i = 0; i < 16; i++) {
      expect(d[i].applyTick).toBe(1000 + i);
      expect(d[i].input).toEqual(canon(items[i].input));
    }
  });

  it('analog values escape to raw i8 and round-trip losslessly', () => {
    const items: TaggedInput[] = [
      { playerId: 'p1', applyTick: 5, input: { moveX: 0.5, moveY: -0.25, expanding: false } },
      { playerId: 'p1', applyTick: 6, input: { moveX: 1, moveY: 0, expanding: true } },
    ];
    const d = decodeTaggedInputs(encodeTaggedInputs(items, slotOf), idOfSlot)!;
    expect(d[0].input).toEqual(canon(items[0].input)); // 0.5 → 64/127 preserved
    expect(d[1].input).toEqual(canon(items[1].input));
  });

  it('handles multiple slots + a tick gap (separate runs)', () => {
    const items: TaggedInput[] = [
      { playerId: 'p0', applyTick: 10, input: { moveX: 1, moveY: 0, expanding: false } },
      { playerId: 'p0', applyTick: 11, input: { moveX: 1, moveY: 1, expanding: false } },
      { playerId: 'p0', applyTick: 20, input: { moveX: -1, moveY: 0, expanding: true } }, // gap → new run
      { playerId: 'p2', applyTick: 11, input: { moveX: 0, moveY: -1, expanding: false } },
    ];
    const d = decodeTaggedInputs(encodeTaggedInputs(items, slotOf), idOfSlot)!;
    const find = (pid: string, tick: number) => d.find((x) => x.playerId === pid && x.applyTick === tick)!;
    expect(find('p0', 10).input).toEqual(canon(items[0].input));
    expect(find('p0', 20).input).toEqual(canon(items[2].input));
    expect(find('p2', 11).input).toEqual(canon(items[3].input));
    expect(d).toHaveLength(4); // no phantom entry across the gap
  });

  it('drops entries for unknown slots, rejects bad magic', () => {
    const d = decodeTaggedInputs(encodeTaggedInputs([{ playerId: 'p5', applyTick: 1, input: { moveX: 0, moveY: 0, expanding: false } }], slotOf), () => undefined);
    expect(d).toEqual([]);
    expect(decodeTaggedInputs(new Uint8Array([0x99, 0]), idOfSlot)).toBeNull();
  });
});
