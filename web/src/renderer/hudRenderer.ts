import { GameModeState } from '../game/gameModes/types';
import { ManagedPlayer } from '../game/playerManager';
import { Camera } from './camera';
import { Vec2 } from '../physics/vec2';

/** Draw player name labels above blobs (world-space, call inside camera transform). */
export function drawPlayerLabels(
  ctx: CanvasRenderingContext2D,
  players: ManagedPlayer[],
): void {
  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';

  for (const p of players) {
    const centroid = p.blob.getCentroid();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(p.name, centroid.x, centroid.y - 60);
  }

  ctx.restore();
}

/** Draw scores as horizontal bars in top-right corner. */
export function drawScoreBoard(
  ctx: CanvasRenderingContext2D,
  width: number,
  players: ManagedPlayer[],
  scores: Map<string, number>,
  targetScore?: number,
): void {
  if (scores.size === 0) return;

  const maxScore = targetScore ?? Math.max(...scores.values(), 1);
  const barWidth = 140;
  const barHeight = 16;
  const padding = 8;
  const startX = width - barWidth - padding - 60;
  const startY = 12;

  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  let y = startY;
  for (const p of players) {
    const score = scores.get(p.playerId) ?? 0;
    const fillWidth = Math.min(score / maxScore, 1) * barWidth;

    // Name
    ctx.fillStyle = '#ccc';
    ctx.fillText(p.name, startX - 8, y + barHeight / 2);

    // Bar background
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(startX, y, barWidth, barHeight);

    // Bar fill
    ctx.fillStyle = p.color;
    ctx.fillRect(startX, y, fillWidth, barHeight);

    // Score text
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(String(Math.floor(score)), startX + barWidth + 6, y + barHeight / 2);
    ctx.textAlign = 'right';

    y += barHeight + 4;
  }

  ctx.restore();
}

/** Draw time remaining in top-center. */
export function drawTimer(
  ctx: CanvasRenderingContext2D,
  width: number,
  timeRemaining: number,
): void {
  const minutes = Math.floor(timeRemaining / 60);
  const seconds = Math.ceil(timeRemaining % 60);
  const text = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  ctx.save();
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = timeRemaining <= 10 ? '#ff4444' : '#fff';
  ctx.fillText(text, width / 2, 12);
  ctx.restore();
}
