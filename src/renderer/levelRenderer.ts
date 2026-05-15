import { Vec2 } from '../physics/vec2';
import { PLATFORM_COLOR, PLATFORM_BORDER } from './colors';

const MATERIAL_COLORS: Record<string, { fill: string; stroke: string }> = {
  default: { fill: PLATFORM_COLOR, stroke: PLATFORM_BORDER },
  ice:     { fill: '#bfe6ff',      stroke: '#7ec0e8' },
  sticky:  { fill: '#d8b4f8',      stroke: '#9a6ed1' },
  bouncy:  { fill: '#ffd166',      stroke: '#cf9a26' },
};

/** Draw the literal collision polygon. Visual matches physics exactly —
 * no rounded-capsule approximation for rectangular platforms. */
export function drawStaticPolygon(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  material: string = 'default',
  lineWidth = 2,
): void {
  if (poly.length < 2) return;
  const colors = MATERIAL_COLORS[material] ?? MATERIAL_COLORS.default;

  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) {
    ctx.lineTo(poly[i].x, poly[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();
  ctx.strokeStyle = colors.stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}
