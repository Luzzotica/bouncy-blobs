import { describe, it, expect } from "vitest";
import { shapeJoystickInput, BAND_HALF, DEADZONE_X } from "./joystickInput";

// Square pad with a horizontal band: horizontal snaps to ±1 past a deadzone and
// is always active; vertical is 3 zones (above band = up, in band = none, below
// band = down).
describe("shapeJoystickInput", () => {
  it("snaps horizontal straight to ±1 past the deadzone", () => {
    expect(shapeJoystickInput(0.2, 0).x).toBe(1);   // barely right → full right
    expect(shapeJoystickInput(-0.2, 0).x).toBe(-1);
    expect(shapeJoystickInput(1, 0).x).toBe(1);
  });

  it("ignores tiny horizontal drift inside the deadzone", () => {
    expect(shapeJoystickInput(DEADZONE_X - 0.01, 0).x).toBe(0);
  });

  it("is pure left/right while inside the band", () => {
    expect(shapeJoystickInput(0.5, 0)).toEqual({ x: 1, y: 0 });
    expect(shapeJoystickInput(0.5, BAND_HALF - 0.01)).toEqual({ x: 1, y: 0 });
    expect(shapeJoystickInput(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("maps above the band to up, below the band to down", () => {
    expect(shapeJoystickInput(0, -(BAND_HALF + 0.01)).y).toBe(-1); // above → up
    expect(shapeJoystickInput(0, BAND_HALF + 0.01).y).toBe(1);     // below → down
  });

  it("allows diagonals — left/right stays active above/below the band", () => {
    expect(shapeJoystickInput(0.5, -0.9)).toEqual({ x: 1, y: -1 });  // up-right
    expect(shapeJoystickInput(-0.5, 0.9)).toEqual({ x: -1, y: 1 });  // down-left
  });
});
