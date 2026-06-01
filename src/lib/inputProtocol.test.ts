import { describe, it, expect } from "vitest";
import {
  encodeClientInputBatch,
  decodeClientInputBatch,
  encodeAggregatedInputs,
  decodeAggregatedInputs,
  quantizeAxis,
  quantizeAxisToInt,
  dequantizeAxis,
  MAGIC_CLIENT_INPUT,
  MAGIC_AGGREGATED_INPUTS,
  SLOT_UNASSIGNED,
  type ClientInputBatch,
  type AggregatedInputs,
} from "./inputProtocol";

describe("inputProtocol", () => {
  it("round-trips a client input batch (v1, f64)", () => {
    const batch: ClientInputBatch = {
      frames: [
        { tick: 100, moveX: 0.5, moveY: 0, expanding: false },
        { tick: 101, moveX: 0.5, moveY: -0.25, expanding: true },
        { tick: 102, moveX: -1, moveY: 1, expanding: false },
      ],
    };
    const buf = encodeClientInputBatch(batch);
    const u8 = new Uint8Array(buf);
    expect(u8[0]).toBe(MAGIC_CLIENT_INPUT);

    const out = decodeClientInputBatch(buf);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.frames).toHaveLength(3);
    expect(out.frames[0].tick).toBe(100);
    expect(out.frames[1].expanding).toBe(true);
    // ClientInputBatch is still f64 — exact match.
    expect(out.frames[0].moveX).toBe(0.5);
    expect(out.frames[1].moveY).toBe(-0.25);
    expect(out.frames[2].moveX).toBe(-1);
    expect(out.frames[2].moveY).toBe(1);
  });

  it("round-trips an empty client batch", () => {
    const buf = encodeClientInputBatch({ frames: [] });
    const out = decodeClientInputBatch(buf);
    expect(out).not.toBeNull();
    expect(out!.frames).toHaveLength(0);
  });

  it("round-trips aggregated inputs with multiple ticks + players (v2, slot-based)", () => {
    const agg: AggregatedInputs = {
      ticks: [
        {
          tick: 200,
          inputs: [
            { slot: 0, moveX: quantizeAxis(1), moveY: 0, expanding: false },
            { slot: 1, moveX: quantizeAxis(-0.5), moveY: quantizeAxis(0.5), expanding: true },
          ],
        },
        {
          tick: 201,
          inputs: [
            { slot: 0, moveX: quantizeAxis(1), moveY: 0, expanding: false },
            { slot: 1, moveX: quantizeAxis(-0.5), moveY: quantizeAxis(0.5), expanding: true },
            { slot: 2, moveX: 0, moveY: quantizeAxis(-1), expanding: true },
          ],
        },
      ],
    };
    const buf = encodeAggregatedInputs(agg);
    const u8 = new Uint8Array(buf);
    expect(u8[0]).toBe(MAGIC_AGGREGATED_INPUTS);

    const idBySlot: Record<number, string> = {
      0: "host-local",
      1: "guest-p1",
      2: "bot-aggressive-3",
    };
    const out = decodeAggregatedInputs(buf, (slot) => idBySlot[slot]);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.ticks).toHaveLength(2);
    expect(out.ticks[0].tick).toBe(200);
    expect(out.ticks[0].inputs).toHaveLength(2);
    expect(out.ticks[0].inputs[0].slot).toBe(0);
    expect(out.ticks[0].inputs[0].playerId).toBe("host-local");
    expect(out.ticks[1].inputs[2].playerId).toBe("bot-aggressive-3");
    // Quantization round-trips within 1/127.
    expect(Math.abs(out.ticks[1].inputs[2].moveY - -1)).toBeLessThan(0.01);
    expect(out.ticks[1].inputs[2].expanding).toBe(true);
  });

  it("decoder returns slot even when no resolver is supplied; playerId undefined", () => {
    const agg: AggregatedInputs = {
      ticks: [{ tick: 1, inputs: [{ slot: 5, moveX: 0, moveY: 0, expanding: false }] }],
    };
    const out = decodeAggregatedInputs(encodeAggregatedInputs(agg));
    expect(out).not.toBeNull();
    expect(out!.ticks[0].inputs[0].slot).toBe(5);
    expect(out!.ticks[0].inputs[0].playerId).toBeUndefined();
  });

  it("encoder substitutes SLOT_UNASSIGNED for out-of-range slot values", () => {
    const agg: AggregatedInputs = {
      ticks: [{ tick: 1, inputs: [{ slot: 999, moveX: 0, moveY: 0, expanding: false }] }],
    };
    const out = decodeAggregatedInputs(encodeAggregatedInputs(agg));
    expect(out!.ticks[0].inputs[0].slot).toBe(SLOT_UNASSIGNED);
  });

  it("rejects packets with the wrong magic byte", () => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setUint8(0, 0xff);
    expect(decodeClientInputBatch(buf)).toBeNull();
    expect(decodeAggregatedInputs(buf)).toBeNull();
  });

  it("rejects truncated packets", () => {
    const batch: ClientInputBatch = {
      frames: [{ tick: 5, moveX: 0, moveY: 0, expanding: false }],
    };
    const buf = encodeClientInputBatch(batch);
    const truncated = buf.slice(0, buf.byteLength - 2);
    expect(decodeClientInputBatch(truncated)).toBeNull();
  });

  it("quantize axis: round-trip preserves canonical precision", () => {
    // Quantize-then-dequantize is idempotent on the canonical value.
    for (const v of [-1, -0.7071068, -0.5, -0.1, 0, 0.1, 0.5, 0.7071068, 1]) {
      const q1 = quantizeAxis(v);
      const q2 = quantizeAxis(q1);
      expect(q2).toBe(q1);
    }
    // Out-of-range clamps.
    expect(quantizeAxisToInt(1.5)).toBe(127);
    expect(quantizeAxisToInt(-1.5)).toBe(-127);
    expect(quantizeAxisToInt(NaN)).toBe(0);
    // Dequantize edges.
    expect(dequantizeAxis(127)).toBe(1);
    expect(dequantizeAxis(-127)).toBe(-1);
    expect(dequantizeAxis(0)).toBe(0);
  });

  it("bandwidth sanity v2: K=60 redundancy × 5 players fits in ~1.5 KB per packet", () => {
    // Build a worst-case packet: 60 ticks, 5 players each tick.
    const ticks = [];
    for (let t = 0; t < 60; t++) {
      ticks.push({
        tick: t,
        inputs: [
          { slot: 0, moveX: 1, moveY: 0, expanding: true },
          { slot: 1, moveX: -1, moveY: 0, expanding: false },
          { slot: 2, moveX: 0, moveY: 1, expanding: false },
          { slot: 3, moveX: 0, moveY: -1, expanding: true },
          { slot: 4, moveX: quantizeAxis(0.7071068), moveY: quantizeAxis(0.7071068), expanding: false },
        ],
      });
    }
    const bytes = encodeAggregatedInputs({ ticks }).byteLength;
    // Expected: 3 + 60 * (4 + 1 + 5*4) = 3 + 60*25 = 1503 bytes.
    expect(bytes).toBe(1503);
    // At 60Hz broadcast, that's ~90 KB/s outbound — half of K=120.
    // Splits into ~2 SCTP fragments at typical WebRTC MTU.
    expect(bytes * 60).toBeLessThan(100 * 1024);
  });
});
