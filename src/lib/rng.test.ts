import { describe, it, expect } from "vitest";
import { createRng, hashStringSeed } from "./rng";

describe("rng", () => {
  it("two instances with the same seed produce identical streams", () => {
    const a = createRng(12345);
    const b = createRng(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("different seeds produce different streams", () => {
    const a = createRng(1);
    const b = createRng(2);
    let differences = 0;
    for (let i = 0; i < 100; i++) {
      if (a.next() !== b.next()) differences++;
    }
    // Vast majority should differ.
    expect(differences).toBeGreaterThan(90);
  });

  it("getState / setState round-trips deterministically", () => {
    const r = createRng(42);
    for (let i = 0; i < 50; i++) r.next();
    const snap = r.getState();
    const future = Array.from({ length: 20 }, () => r.next());

    r.setState(snap);
    const replayed = Array.from({ length: 20 }, () => r.next());
    expect(replayed).toEqual(future);
  });

  it("range / int respect bounds", () => {
    const r = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.range(-200, 200);
      expect(x).toBeGreaterThanOrEqual(-200);
      expect(x).toBeLessThan(200);
      const n = r.int(0, 16);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(16);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("hashStringSeed is stable and varies with content", () => {
    expect(hashStringSeed("npc-0")).toBe(hashStringSeed("npc-0"));
    expect(hashStringSeed("npc-0")).not.toBe(hashStringSeed("npc-1"));
    expect(hashStringSeed("npc-0")).not.toBe(hashStringSeed("npc-10"));
  });

  it("output uniformity is reasonable across 10k samples", () => {
    const r = createRng(2026);
    const bins = new Array(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      bins[Math.floor(r.next() * 10)]++;
    }
    // Each bin should be ~1000; allow 3x tolerance.
    for (const b of bins) {
      expect(b).toBeGreaterThan(700);
      expect(b).toBeLessThan(1300);
    }
  });
});
