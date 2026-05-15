import { Vec2, add, sub, scale, lengthSq, ZERO } from './vec2';
import { Transform2D } from './types';

const EPS = 1e-7;
const TAU = Math.PI * 2;

export function centroidFromIndices(pos: Vec2[], indices: number[]): Vec2 {
  if (indices.length === 0) return ZERO;
  let c: Vec2 = { x: 0, y: 0 };
  for (let i = 0; i < indices.length; i++) {
    c = add(c, pos[indices[i]]);
  }
  return scale(c, 1 / indices.length);
}

export function averageAngle(
  restLocal: Vec2[], pos: Vec2[], indices: number[], center: Vec2
): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const li = restLocal[i];
    if (lengthSq(li) < EPS * EPS) continue;
    const pi = sub(pos[indices[i]], center);
    if (lengthSq(pi) < EPS * EPS) continue;
    const aRest = Math.atan2(li.y, li.x);
    const aCur = Math.atan2(pi.y, pi.x);
    let diff = aCur - aRest;
    diff = ((diff + Math.PI) % TAU + TAU) % TAU - Math.PI; // wrap to [-PI, PI]
    sum += diff;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export function frameTransform(center: Vec2, angle: number): Transform2D {
  return {
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    tx: center.x,
    ty: center.y,
  };
}

export function applyTransform(t: Transform2D, v: Vec2): Vec2 {
  return {
    x: t.cos * v.x - t.sin * v.y + t.tx,
    y: t.sin * v.x + t.cos * v.y + t.ty,
  };
}
