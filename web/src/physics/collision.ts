import { Vec2, vec2, sub, dot, length, lengthSq, normalize, scale, add, distanceToSq, perp, negate, ZERO, RIGHT } from './vec2';
import { AABB } from './types';

const EPS = 1e-6;

export function polygonAABB(poly: Vec2[]): AABB {
  if (poly.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = poly[0].x, maxX = poly[0].x, minY = poly[0].y, maxY = poly[0].y;
  for (let i = 1; i < poly.length; i++) {
    if (poly[i].x < minX) minX = poly[i].x;
    if (poly[i].x > maxX) maxX = poly[i].x;
    if (poly[i].y < minY) minY = poly[i].y;
    if (poly[i].y > maxY) maxY = poly[i].y;
  }
  return { minX, minY, maxX, maxY };
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function isPointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  const n = polygon.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    if ((pi.y > point.y) !== (pj.y > point.y) &&
        point.x < (pj.x - pi.x) * (point.y - pi.y) / (pj.y - pi.y) + pi.x) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const abLenSq = lengthSq(ab);
  if (abLenSq < EPS * EPS) return a;
  let t = dot(sub(p, a), ab) / abLenSq;
  t = Math.max(0, Math.min(1, t));
  return add(a, scale(ab, t));
}

export interface ClosestPointResult {
  closest: Vec2;
  edgeI: number;
  normal: Vec2;
  a: Vec2;
  b: Vec2;
  edgeDir: Vec2;
  edgeLen: number;
}

export function closestPointOnPolygonBoundary(point: Vec2, polygon: Vec2[]): ClosestPointResult {
  let bestDist = Infinity;
  let bestClosest = ZERO;
  let bestI = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const c = closestPointOnSegment(point, a, b);
    const d = distanceToSq(point, c);
    if (d < bestDist) {
      bestDist = d;
      bestClosest = c;
      bestI = i;
    }
  }
  const a = polygon[bestI];
  const b = polygon[(bestI + 1) % n];
  const edge = sub(b, a);
  const lenE = length(edge);
  const edgeDir = lenE > EPS ? scale(edge, 1 / lenE) : RIGHT;
  // Normal perpendicular to edge: (tangent.y, -tangent.x)
  let normal = normalize({ x: edgeDir.y, y: -edgeDir.x });
  // Flip normal if it points away from query point
  const fromClosestToPoint = sub(point, bestClosest);
  if (dot(fromClosestToPoint, normal) < 0) {
    normal = negate(normal);
  }
  return { closest: bestClosest, edgeI: bestI, normal, a, b, edgeDir, edgeLen: lenE };
}

export function edgeVertexWeights(point: Vec2, a: Vec2, b: Vec2): { wb: number; wc: number } {
  const ab = sub(b, a);
  const labSq = lengthSq(ab);
  if (labSq < EPS * EPS) return { wb: 0.5, wc: 0.5 };
  let t = dot(sub(point, a), ab) / labSq;
  t = Math.max(0, Math.min(1, t));
  return { wb: 1 - t, wc: t };
}

export function signedAreaPolygon(poly: Vec2[]): number {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
  }
  return a * 0.5;
}

export function resolveThreeBodyVelocity(
  va: Vec2, ma: number,
  vb: Vec2, mb: number,
  vc: Vec2, mc: number,
  normal: Vec2,
  wb: number, wc: number,
  restitution: number,
  mu: number = 0,
  tangent: Vec2 = ZERO,
  frictionImpulseScale: number = 1.0,
): [Vec2, Vec2, Vec2] {
  const n = normalize(normal);
  const vRel = dot(n, va) - (wb * dot(n, vb) + wc * dot(n, vc));
  if (vRel >= 0) return [va, vb, vc];

  let invSum = 0;
  if (ma > EPS) invSum += 1 / ma;
  if (mb > EPS) invSum += (wb * wb) / mb;
  if (mc > EPS) invSum += (wc * wc) / mc;
  if (invSum < EPS) return [va, vb, vc];

  const j = -(1 + restitution) * vRel / invSum;
  let vaNew = add(va, scale(n, ma > EPS ? j / ma : 0));
  let vbNew = sub(vb, scale(n, mb > EPS ? (j * wb) / mb : 0));
  let vcNew = sub(vc, scale(n, mc > EPS ? (j * wc) / mc : 0));

  if (mu <= EPS || lengthSq(tangent) < EPS * EPS) return [vaNew, vbNew, vcNew];

  let t = normalize(tangent);
  if (Math.abs(dot(t, n)) > 0.05) {
    t = normalize({ x: -n.y, y: n.x });
  }

  const vRelT = dot(t, vaNew) - (wb * dot(t, vbNew) + wc * dot(t, vcNew));
  if (Math.abs(vRelT) < 0.42) return [vaNew, vbNew, vcNew];

  const jtUncap = -vRelT / invSum;
  const jnAbs = Math.abs(j);
  const maxT = mu * Math.max(jnAbs, EPS * EPS);
  const jt = Math.max(-maxT, Math.min(maxT, jtUncap)) * Math.max(0, Math.min(1, frictionImpulseScale));

  vaNew = add(vaNew, scale(t, ma > EPS ? jt / ma : 0));
  vbNew = sub(vbNew, scale(t, mb > EPS ? (jt * wb) / mb : 0));
  vcNew = sub(vcNew, scale(t, mc > EPS ? (jt * wc) / mc : 0));

  return [vaNew, vbNew, vcNew];
}
