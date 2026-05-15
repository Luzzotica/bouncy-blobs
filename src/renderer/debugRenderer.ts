import { Vec2 } from '../physics/vec2';
import { SoftBodyWorld } from '../physics/softBodyWorld';

export function drawSprings(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyWorld,
  color = 'rgba(100, 200, 255, 0.3)',
  lineWidth = 1,
): void {
  const pos = world.getPositions();
  const pairs = world.getSpringIndexPairs();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (const [ia, ib] of pairs) {
    if (ia >= pos.length || ib >= pos.length) continue;
    ctx.beginPath();
    ctx.moveTo(pos[ia].x, pos[ia].y);
    ctx.lineTo(pos[ib].x, pos[ib].y);
    ctx.stroke();
  }
}

export function drawShapeMatchTargets(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyWorld,
  color = 'rgba(0, 255, 200, 0.4)',
): void {
  for (let bi = 0; bi < world.getBlobCount(); bi++) {
    const targets = world.getBlobShapeMatchTargetHull(bi);
    if (targets.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(targets[0].x, targets[0].y);
    for (let i = 1; i < targets.length; i++) {
      ctx.lineTo(targets[i].x, targets[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function drawVelocities(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyWorld,
  velocityScale = 0.05,
  color = 'rgba(255, 200, 0, 0.5)',
): void {
  const pos = world.getPositions();
  const vel = world.getVelocities();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    const v = vel[i];
    const ex = p.x + v.x * velocityScale;
    const ey = p.y + v.y * velocityScale;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

export function drawMassPoints(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyWorld,
  color = 'rgba(255, 255, 255, 0.5)',
  radius = 2,
): void {
  const pos = world.getPositions();
  ctx.fillStyle = color;
  for (let i = 0; i < pos.length; i++) {
    ctx.beginPath();
    ctx.arc(pos[i].x, pos[i].y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}
