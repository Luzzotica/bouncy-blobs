import { describe, it, expect } from "vitest";
import { shapeJoystickInput } from "./joystickInput";

// Phone joystick should be as easy to max out as a keyboard: up/down snaps to
// full past a small deadzone; left/right is proportional but reaches ±1 at full
// sideways tilt, independent of the vertical axis.
describe("shapeJoystickInput", () => {
  it("snaps a slight vertical tilt to full ±1", () => {
    expect(shapeJoystickInput(0, -0.2).y).toBe(-1); // slight up → full up
    expect(shapeJoystickInput(0, 0.2).y).toBe(1);   // slight down → full down
  });

  it("zeroes inputs inside the deadzones", () => {
    const s = shapeJoystickInput(0.05, 0.1); // |x|<0.1, |y|<0.15
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
  });

  it("reaches full ±1 horizontally at full sideways tilt", () => {
    expect(shapeJoystickInput(1, 0).x).toBeCloseTo(1, 5);
    expect(shapeJoystickInput(-1, 0).x).toBeCloseTo(-1, 5);
    expect(shapeJoystickInput(1, 0).y).toBe(0);
  });

  it("frees each axis on a diagonal — full up, proportional sideways (not capped at 0.707)", () => {
    const s = shapeJoystickInput(0.707, -0.707);
    expect(s.y).toBe(-1);              // vertical no longer stuck at 0.707
    expect(s.x).toBeGreaterThan(0.6);  // proportional, well above the old 0.707-cap behaviour
    expect(s.x).toBeLessThan(0.75);
  });

  it("supports 'up + near-full sideways' like a keyboard", () => {
    // Push mostly right with a slight up tilt: X stays high, Y snaps to full up.
    const s = shapeJoystickInput(0.95, -0.3);
    expect(s.y).toBe(-1);
    expect(s.x).toBeGreaterThan(0.9);
  });

  it("clamps over-range input (finger past the ring) to ±1", () => {
    expect(shapeJoystickInput(1.8, -1.8)).toEqual({ x: 1, y: -1 });
  });
});
