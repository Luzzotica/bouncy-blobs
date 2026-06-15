import { describe, it, expect } from "vitest";
import { treadDirection } from "./slimeBlob";
import { vec2 } from "./vec2";

// Standard gravity points +y (down). stickY < 0 = up (against gravity).
const down = vec2(0, 1);

describe("treadDirection — gravity-based, only on intentional A/D", () => {
  it("does NOT spin without left/right input (pure up)", () => {
    expect(treadDirection(0, -1, down, false)).toBe(0);
    expect(treadDirection(0, -1, down, true)).toBe(0); // even with overhead
  });

  it("does NOT spin without left/right input (pure down)", () => {
    expect(treadDirection(0, 1, down, false)).toBe(0);
  });

  it("spins when moving left/right, opposite signs for opposite directions", () => {
    const right = treadDirection(1, 0, down, false);
    const left = treadDirection(-1, 0, down, false);
    expect(right).not.toBe(0);
    expect(left).toBe(-right);
  });

  it("ignores tiny stick noise below the deadzone", () => {
    expect(treadDirection(0.05, 0, down, false)).toBe(0);
  });

  it("reverses when holding UP into an overhead surface (clamber)", () => {
    const normal = treadDirection(1, -1, down, false); // A/D + up, nothing above
    const overhead = treadDirection(1, -1, down, true); // A/D + up, ceiling above
    expect(normal).not.toBe(0);
    expect(overhead).toBe(-normal);
  });

  it("does NOT reverse for overhead without holding up", () => {
    expect(treadDirection(1, 0, down, true)).toBe(treadDirection(1, 0, down, false));
  });
});
