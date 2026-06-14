import { describe, it, expect } from "vitest";
import { treadDirection } from "./slimeBlob";
import { vec2 } from "./vec2";

// Standard gravity points +y (down); world-up is (0,-1).
const down = vec2(0, 1);
const up = vec2(0, -1);
// Surface normals are the OUTWARD normal pushing the blob off the surface:
const floorN = vec2(0, -1);   // floor below → pushes up
const ceilingN = vec2(0, 1);  // ceiling above → pushes down
const leftWallN = vec2(1, 0); // wall on the left → pushes right

describe("treadDirection — tread only ALONG a surface, not into it", () => {
  it("does NOT tread when holding up to stick under a ceiling (into surface)", () => {
    expect(treadDirection(0, -1, down, ceilingN)).toBe(0);
  });

  it("does NOT tread pressing straight up off the floor (out of surface)", () => {
    expect(treadDirection(0, -1, down, floorN)).toBe(0);
  });

  it("does NOT tread pressing straight down into the floor", () => {
    expect(treadDirection(0, 1, down, floorN)).toBe(0);
  });

  it("treads when moving laterally along the floor", () => {
    expect(treadDirection(1, 0, down, floorN)).not.toBe(0);
    // left vs right circulate opposite ways
    expect(treadDirection(-1, 0, down, floorN)).toBe(-treadDirection(1, 0, down, floorN));
  });

  it("treads when moving laterally along a ceiling", () => {
    expect(treadDirection(1, 0, down, ceilingN)).not.toBe(0);
  });

  it("treads when climbing UP a wall (movement along the wall)", () => {
    expect(treadDirection(0, -1, down, leftWallN)).not.toBe(0);
  });

  it("treads horizontally in the air (world-up reference)", () => {
    expect(treadDirection(1, 0, down, up)).not.toBe(0);
  });
});
