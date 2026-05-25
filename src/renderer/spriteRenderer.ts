// Draws a registered sprite at a world position with rotation/scale. The
// anchor (normalized inside the image) becomes the rotation pivot AND the
// world origin of the sprite — collision-shape coordinates in the manifest
// are expressed in this same anchor-local frame.

import { LoadedSprite } from '../assets/spriteRegistry';

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: LoadedSprite,
  x: number,
  y: number,
  rotation = 0,
  scale = 1,
  alpha = 1,
): void {
  const { def, image } = sprite;
  const wWorld = image.width / def.pxPerWorldUnit;
  const hWorld = image.height / def.pxPerWorldUnit;
  const ax = def.anchor.x * wWorld;
  const ay = def.anchor.y * hWorld;

  ctx.save();
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  if (rotation) ctx.rotate(rotation);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.drawImage(image, -ax, -ay, wWorld, hWorld);
  ctx.restore();
}
