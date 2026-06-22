// Joystick input shaping for phone controllers.
//
// A raw joystick vector clamped to magnitude 1 caps each axis at ~0.707 on a
// diagonal, so the phone could never push as hard as a keyboard (which gives a
// full ±1 per axis independently). Shape the raw vector so it's just as easy to
// max out:
//   • Up/down: snaps to full ±1 past a small deadzone (keyboard-like). A slight
//     up tilt = 100% up, which also frees the thumb to push mostly sideways.
//   • Left/right: proportional steering, per-axis, rescaled so it reaches ±1 at
//     full sideways tilt and stays independent of the vertical axis.

// Deadzones in radius-fraction units.
export const DEADZONE_X = 0.1;   // small — kills thumb drift, keeps fine steering
export const DEADZONE_Y = 0.15;  // "slight up/down" threshold before snapping to full

export function shapeJoystickInput(dx: number, dy: number): { x: number; y: number } {
  const ax = Math.min(1, Math.abs(dx));
  const x = ax <= DEADZONE_X ? 0 : Math.sign(dx) * (ax - DEADZONE_X) / (1 - DEADZONE_X);
  const y = Math.abs(dy) < DEADZONE_Y ? 0 : Math.sign(dy);
  return { x, y };
}
