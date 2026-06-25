// Goopy lava sea drawn at the fall-off-the-map kill plane. Purely a visual cue
// for "you die if you fall this far" — the actual kill is the SpikeManager kill
// plane (mapBounds.maxY + FALL_KILL_MARGIN). Shared by the game renderer
// (canvasRenderer) and the level editor (EditorCanvas) so both show the hazard
// at the same height with the same look.
//
// All coordinates are WORLD-space; callers invoke this after their camera/pan
// transform is applied. `timeSec` is monotonic seconds for the wobble + bubbles.

const WAVE_AMP = 16;        // world units — surface wobble height
const WAVE_LEN = 240;       // world units — primary wavelength
const SURFACE_STEP = 22;    // world units between sampled surface points

/** Height of the wavy surface above the resting line at world-x `x`. */
function surfaceOffset(x: number, t: number): number {
  // Two travelling sines at different speeds/lengths give a lazy, goopy roll.
  return (
    Math.sin(x / WAVE_LEN + t * 0.9) * WAVE_AMP +
    Math.sin(x / (WAVE_LEN * 0.41) - t * 1.7) * WAVE_AMP * 0.35
  );
}

/**
 * Draw an animated lava sea filling [leftX, rightX] from a wavy surface near
 * `topY` down to `bottomY`.
 */
export function drawLava(
  ctx: CanvasRenderingContext2D,
  topY: number,
  leftX: number,
  rightX: number,
  bottomY: number,
  timeSec: number,
): void {
  const width = rightX - leftX;
  if (width <= 0 || bottomY <= topY) return;

  // Sampled wavy surface across the visible width (clamped so an extreme
  // zoom-out can't blow up the loop).
  const samples = Math.max(2, Math.min(600, Math.ceil(width / SURFACE_STEP)));
  const surfaceY: number[] = new Array(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const x = leftX + (width * i) / samples;
    surfaceY[i] = topY + surfaceOffset(x, timeSec);
  }

  ctx.save();

  // Body fill: warm vertical gradient, slightly translucent so a blob sinking
  // in still reads through the surface for a beat.
  const grad = ctx.createLinearGradient(0, topY - WAVE_AMP, 0, bottomY);
  grad.addColorStop(0, 'rgba(255, 156, 64, 0.92)');
  grad.addColorStop(0.45, 'rgba(241, 86, 31, 0.94)');
  grad.addColorStop(1, 'rgba(150, 28, 16, 0.96)');

  ctx.beginPath();
  ctx.moveTo(leftX, bottomY);
  ctx.lineTo(leftX, surfaceY[0]);
  for (let i = 0; i <= samples; i++) {
    ctx.lineTo(leftX + (width * i) / samples, surfaceY[i]);
  }
  ctx.lineTo(rightX, bottomY);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Molten rim along the surface — a brighter, slightly glowing crest line.
  ctx.beginPath();
  ctx.moveTo(leftX, surfaceY[0]);
  for (let i = 1; i <= samples; i++) {
    ctx.lineTo(leftX + (width * i) / samples, surfaceY[i]);
  }
  ctx.lineWidth = 6;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255, 224, 130, 0.9)';
  ctx.shadowColor = 'rgba(255, 120, 40, 0.9)';
  ctx.shadowBlur = 18;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Rising bubbles for goopy life. Deterministic from index + time so it's
  // stable frame-to-frame and identical in game + editor.
  const bubbleCount = Math.max(0, Math.min(40, Math.floor(width / 320)));
  ctx.fillStyle = 'rgba(255, 205, 110, 0.5)';
  for (let i = 0; i < bubbleCount; i++) {
    // Pseudo-random but fixed per bubble.
    const seed = i * 127.1;
    const fx = (Math.sin(seed) * 0.5 + 0.5);
    const bx = leftX + fx * width;
    const speed = 0.25 + (Math.sin(seed * 1.7) * 0.5 + 0.5) * 0.4;
    const span = Math.min(220, (bottomY - topY) * 0.6);
    // Rise from `span` below the surface up to it, then loop.
    const phase = (timeSec * speed + fx) % 1;
    const by = topY + surfaceOffset(bx, timeSec) + span * (1 - phase);
    const r = 3 + (Math.sin(seed * 2.3) * 0.5 + 0.5) * 6;
    const alpha = 0.5 * Math.sin(phase * Math.PI); // fade in/out over the rise
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
