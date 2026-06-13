import { Vec2 } from '../physics/vec2';
import type { SoftBodyEngine } from "../physics/SoftBodyEngine";
import { SoftBodyWorld } from '../physics/softBodyWorld';

export function drawSprings(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
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

/** Draw, for every blob with a shape-match constraint, the rest-pose hull
 *  rotated/translated/scaled into world space — i.e. exactly where the
 *  shape-match force is trying to pull each hull vertex this frame. Also
 *  draws (a) the frame centroid the engine computed from the current hull
 *  positions, and (b) the center particle position (which may differ from
 *  the centroid if the center isn't pinned). Useful for debugging "blob
 *  goes oblong" / "blob flies on expand" / "expand isn't symmetric" cases. */
export function drawShapeMatchTargets(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  color = 'rgba(0, 255, 200, 0.85)',
): void {
  const positions = world.getPositions();
  for (let bi = 0; bi < world.getBlobCount(); bi++) {
    const r = world.blobRanges[bi];
    if (r.inactive) continue;
    const targets = world.getBlobShapeMatchTargetHull(bi);
    if (targets.length >= 2) {
      ctx.save();
      // Target hull — dashed cyan outline + tiny markers at each target vert.
      ctx.beginPath();
      ctx.moveTo(targets[0].x, targets[0].y);
      for (let i = 1; i < targets.length; i++) {
        ctx.lineTo(targets[i].x, targets[i].y);
      }
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      for (const t of targets) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Frame centroid (mean of current hull positions) — magenta cross.
    if (r.hull.length > 0) {
      let cx = 0, cy = 0;
      for (const idx of r.hull) {
        cx += positions[idx].x;
        cy += positions[idx].y;
      }
      cx /= r.hull.length;
      cy /= r.hull.length;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 80, 220, 0.95)';
      ctx.lineWidth = 2;
      const s = 6;
      ctx.beginPath();
      ctx.moveTo(cx - s, cy); ctx.lineTo(cx + s, cy);
      ctx.moveTo(cx, cy - s); ctx.lineTo(cx, cy + s);
      ctx.stroke();
      ctx.restore();
    }

    // Center particle — yellow filled dot. Lets you see at a glance
    // whether the center has drifted off the hull centroid (cross).
    const shape = world.shapes[r.shapeIdx];
    if (shape) {
      const ci = shape.centerIdx;
      const p = positions[ci];
      if (p) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 230, 80, 0.95)';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

export function drawVelocities(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
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
  world: SoftBodyEngine,
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

/** Draw each blob's hull as a closed perimeter polygon (in hull-ring order)
 *  plus a dot at every hull particle. The first hull point is drawn in a
 *  distinct colour so the ring's winding direction is visible — handy for
 *  inspecting the treadmill contour. */
export function drawBlobHulls(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  lineColor = 'rgba(80, 255, 160, 0.95)',
  pointColor = 'rgba(80, 255, 160, 0.95)',
  firstPointColor = 'rgba(255, 220, 60, 0.95)',
  pointRadius = 4,
  lineWidth = 2,
): void {
  const pos = world.getPositions();
  for (let bi = 0; bi < world.getBlobCount(); bi++) {
    const r = world.blobRanges[bi];
    if (r.inactive) continue;
    const hull = r.hull;
    if (hull.length < 2) continue;

    ctx.save();
    // Perimeter outline, connecting hull particles in ring order.
    ctx.beginPath();
    const first = pos[hull[0]];
    if (first) ctx.moveTo(first.x, first.y);
    for (let k = 1; k < hull.length; k++) {
      const p = pos[hull[k]];
      if (p) ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();

    // Dot at each hull point (hull[0] highlighted to show winding).
    for (let k = 0; k < hull.length; k++) {
      const p = pos[hull[k]];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pointRadius, 0, Math.PI * 2);
      ctx.fillStyle = k === 0 ? firstPointColor : pointColor;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Render every particle of every blob, with hull and center distinguished. */
export function drawBlobPoints(
  ctx: CanvasRenderingContext2D,
  world: SoftBodyEngine,
  hullColor = 'rgba(255, 80, 80, 0.95)',
  centerColor = 'rgba(255, 230, 80, 0.95)',
  hullRadius = 3.5,
  centerRadius = 5,
): void {
  const pos = world.getPositions();
  for (let bi = 0; bi < world.getBlobCount(); bi++) {
    const r = world.blobRanges[bi];
    if (r.inactive) continue;
    const centerIdx = world.shapes[r.shapeIdx]?.centerIdx ?? -1;
    for (let i = r.start; i < r.end; i++) {
      const p = pos[i];
      if (!p) continue;
      const isCenter = i === centerIdx;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCenter ? centerRadius : hullRadius, 0, Math.PI * 2);
      ctx.fillStyle = isCenter ? centerColor : hullColor;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
