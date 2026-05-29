import { SpringPadDef } from '../levels/types';

export const PLATE_THICKNESS = 72;
export const PLATE_WIDTH_SCALE = 8;

export type SpringRenderState = 'idle' | 'loaded' | 'firing' | 'reloading';

/**
 * Draws a spring pad in its given visual state. Used by both the in-game renderer
 * (with live offset/state) and the editor (with offset=0, state='idle') so the two
 * stay visually identical.
 */
export function drawSpring(
  ctx: CanvasRenderingContext2D,
  def: SpringPadDef,
  offset: number = 0,
  maxCompress: number = 0,
  state: SpringRenderState = 'idle',
): void {
  const compress = maxCompress > 0 ? offset / maxCompress : 0;

  ctx.save();
  ctx.translate(def.x, def.y);
  ctx.rotate(def.rotation);

  const hw = def.width / 2;
  const hh = (def.height * PLATE_WIDTH_SCALE) / 2;
  const frontX = hw - offset;
  const backX = frontX - PLATE_THICKNESS;
  const wallX = -hw;

  const coilStart = backX;
  const coilEnd = wallX;
  const coilLen = Math.max(coilStart - coilEnd, 1);
  const coilAmp = hh * 0.7;
  const numZigs = 5;
  const zigStep = coilLen / numZigs;

  ctx.strokeStyle = '#cccccc';
  ctx.lineWidth = 3.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(coilStart, 0);
  for (let i = 0; i < numZigs; i++) {
    const x = coilStart - (i + 0.5) * zigStep;
    const yDir = i % 2 === 0 ? -1 : 1;
    ctx.lineTo(x, yDir * coilAmp);
  }
  ctx.lineTo(coilEnd, 0);
  ctx.stroke();

  ctx.fillStyle = state === 'loaded' || state === 'idle' ? '#ffe066' : '#e8e8e8';
  // 'idle' (editor) shows the cocked/ready look so users see the launch-ready visual at rest.
  if (state === 'idle') ctx.fillStyle = '#ffe066';
  ctx.strokeStyle = '#aaaaaa';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(backX, -hh, PLATE_THICKNESS, hh * 2, 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#888888';
  ctx.strokeStyle = '#666666';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(wallX - 6, -hh * 1.2, 6, hh * 2.4, 1);
  ctx.fill();
  ctx.stroke();

  const arrowAlpha = state === 'idle' ? 0.9 : 0.4 + 0.5 * compress;
  ctx.fillStyle = `rgba(255, 200, 50, ${arrowAlpha})`;
  ctx.beginPath();
  const arrowX = frontX + 8;
  ctx.moveTo(arrowX + 12, 0);
  ctx.lineTo(arrowX, -5);
  ctx.lineTo(arrowX, 5);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
