import { ZoneDef } from '../levels/types';

/** Draw a goal zone (green glow with FINISH label). */
export function drawGoalZone(
  ctx: CanvasRenderingContext2D,
  zone: ZoneDef,
  time: number,
): void {
  const hw = zone.width / 2;
  const hh = zone.height / 2;
  const x = zone.x - hw;
  const y = zone.y - hh;

  // Pulsing alpha
  const pulse = 0.15 + 0.1 * Math.sin(time * 3);

  ctx.save();

  // Filled zone
  ctx.fillStyle = `rgba(0, 255, 100, ${pulse})`;
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(0, 255, 100, ${pulse + 0.2})`;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(x, y, zone.width, zone.height);
  ctx.setLineDash([]);

  // Label
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(0, 255, 100, ${pulse + 0.4})`;
  ctx.fillText('FINISH', zone.x, zone.y);

  ctx.restore();
}

/** Draw a hill zone (golden highlight). */
export function drawHillZone(
  ctx: CanvasRenderingContext2D,
  zone: ZoneDef,
  time: number,
  ownerColor: string | null,
): void {
  const hw = zone.width / 2;
  const hh = zone.height / 2;
  const x = zone.x - hw;
  const y = zone.y - hh;

  const pulse = 0.12 + 0.08 * Math.sin(time * 2.5);
  const color = ownerColor ?? 'rgba(255, 215, 0';

  ctx.save();

  // Filled zone
  if (ownerColor) {
    ctx.fillStyle = ownerColor.replace(')', `, ${pulse})`).replace('rgb(', 'rgba(');
  } else {
    ctx.fillStyle = `rgba(255, 215, 0, ${pulse})`;
  }
  ctx.fillRect(x, y, zone.width, zone.height);

  // Border
  ctx.strokeStyle = `rgba(255, 215, 0, ${pulse + 0.3})`;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, zone.width, zone.height);

  // Crown icon
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = `rgba(255, 215, 0, ${pulse + 0.4})`;
  ctx.fillText('HILL', zone.x, zone.y);

  ctx.restore();
}
