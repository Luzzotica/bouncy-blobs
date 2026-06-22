// Joystick input shaping for phone controllers.
//
// The pad is treated as a SQUARE with a horizontal BAND across the middle:
//   • Horizontal: snap straight to ±1 past a small deadzone (no proportional
//     ramp) so it's effortless to move at full speed — and it stays active in
//     every zone, so up-left / down-right diagonals work like a keyboard.
//   • Vertical (3 zones): inside the band → 0 (pure left/right); above the band
//     → -1 (up); below the band → +1 (down).
// dx/dy are the touch offset from center, normalized to [-1, 1] per axis.

export const DEADZONE_X = 0.15;  // horizontal deadzone before snapping to ±1
export const BAND_HALF = 0.3;    // half-height of the neutral (left/right) band

export function shapeJoystickInput(dx: number, dy: number): { x: number; y: number } {
  const x = Math.abs(dx) <= DEADZONE_X ? 0 : Math.sign(dx);
  const y = dy < -BAND_HALF ? -1 : dy > BAND_HALF ? 1 : 0;
  return { x, y };
}
