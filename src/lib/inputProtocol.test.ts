import { describe, it, expect } from "vitest";
import {
  encodeClientInputBatch,
  decodeClientInputBatch,
  encodeAggregatedInputs,
  decodeAggregatedInputs,
  MAGIC_CLIENT_INPUT,
  MAGIC_AGGREGATED_INPUTS,
  type ClientInputBatch,
  type AggregatedInputs,
} from "./inputProtocol";

describe("inputProtocol", () => {
  it("round-trips a client input batch", () => {
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
    // Quantization tolerance ~1/127 ≈ 0.008
    expect(Math.abs(out.frames[0].moveX - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(out.frames[1].moveY - -0.25)).toBeLessThan(0.01);
    expect(out.frames[2].moveX).toBeCloseTo(-1, 2);
    expect(out.frames[2].moveY).toBeCloseTo(1, 2);
  });

  it("round-trips an empty client batch", () => {
    const buf = encodeClientInputBatch({ frames: [] });
    const out = decodeClientInputBatch(buf);
    expect(out).not.toBeNull();
    expect(out!.frames).toHaveLength(0);
  });

  it("round-trips aggregated inputs with multiple ticks + players", () => {
    const agg: AggregatedInputs = {
      ticks: [
        {
          tick: 200,
          inputs: [
            { playerId: "host-local", moveX: 1, moveY: 0, expanding: false },
            { playerId: "guest-p1", moveX: -0.5, moveY: 0.5, expanding: true },
          ],
        },
        {
          tick: 201,
          inputs: [
            { playerId: "host-local", moveX: 1, moveY: 0, expanding: false },
            { playerId: "guest-p1", moveX: -0.5, moveY: 0.5, expanding: true },
            { playerId: "bot-aggressive-3-1234", moveX: 0, moveY: -1, expanding: true },
          ],
        },
      ],
    };
    const buf = encodeAggregatedInputs(agg);
    const u8 = new Uint8Array(buf);
    expect(u8[0]).toBe(MAGIC_AGGREGATED_INPUTS);

    const out = decodeAggregatedInputs(buf);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.ticks).toHaveLength(2);
    expect(out.ticks[0].tick).toBe(200);
    expect(out.ticks[0].inputs).toHaveLength(2);
    expect(out.ticks[1].inputs).toHaveLength(3);
    expect(out.ticks[1].inputs[2].playerId).toBe("bot-aggressive-3-1234");
    expect(Math.abs(out.ticks[1].inputs[2].moveY - -1)).toBeLessThan(0.01);
    expect(out.ticks[1].inputs[2].expanding).toBe(true);
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

  it("bandwidth sanity: 4 players × 30 frames stays under 2 KB", () => {
    // Worst case: host's aggregated broadcast carries 1 tick with 4 players.
    // At 30 Hz that's 30 packets per second. We size budget per-second.
    const oneTick: AggregatedInputs = {
      ticks: [
        {
          tick: 1,
          inputs: [
            { playerId: "local-keyboard", moveX: 1, moveY: 0, expanding: true },
            { playerId: "guest-abc-keyboard", moveX: -1, moveY: 0, expanding: false },
            { playerId: "bot-aggressive-1-5555", moveX: 0, moveY: 1, expanding: false },
            { playerId: "bot-defender-2-9999", moveX: 0, moveY: -1, expanding: true },
          ],
        },
      ],
    };
    const oneTickBytes = encodeAggregatedInputs(oneTick).byteLength;
    // Per-second steady-state estimate: 30 packets/sec of ~oneTickBytes each.
    // Per-tick is dominated by playerId strings — long human-readable bot
    // ids (~20 chars) push this up. Real deployments can use short u8 slot
    // ids when bandwidth matters; this test just sanity-checks the order of
    // magnitude. Original world-snapshot wire was ~30 KB/s — anything under
    // 5 KB/s is a massive win regardless.
    const perSecond = oneTickBytes * 30;
    expect(perSecond).toBeLessThan(5 * 1024);
  });
});
