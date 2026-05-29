import { Vec2 } from '../physics/vec2';
import { drawCandySurface } from './candySkin';

/** Draw a static collision polygon using the candy skin for its material.
 * Visual silhouette matches physics exactly — the skin only changes the
 * fill, highlight, and outline layers; the polygon path is untouched. */
export function drawStaticPolygon(
  ctx: CanvasRenderingContext2D,
  poly: Vec2[],
  material: string = 'default',
  _lineWidth = 2,
): void {
  if (poly.length < 2) return;
  drawCandySurface(ctx, poly, material);
}
