import { Vec2 } from './vec2';

const TAU = Math.PI * 2;

export function square(half: number): Vec2[] {
  return [
    { x: -half, y: -half },
    { x: half, y: -half },
    { x: half, y: half },
    { x: -half, y: half },
  ];
}

export function circle(n: number, r: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (TAU * i) / n - Math.PI / 2;
    points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return points;
}

export function triangle(r: number): Vec2[] {
  return circle(3, r);
}

export function star(arms: number, rOuter: number, rInner: number): Vec2[] {
  const n = arms * 2;
  const points: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (TAU * i) / n;
    const r = i % 2 === 0 ? rOuter : rInner;
    points.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return points;
}

export function diamond(w: number): Vec2[] {
  const h = w * 1.2;
  return [
    { x: 0, y: -h },
    { x: w, y: 0 },
    { x: 0, y: h },
    { x: -w, y: 0 },
  ];
}

export function hexagon(r: number): Vec2[] {
  return circle(6, r);
}

/** Rectangle hull subdivided along both axes. Returns points CCW starting at
 * top-left. `segW` and `segH` are the number of segments along each axis
 * (so an edge with N segments has N+1 points). Corners are shared between
 * adjacent edges; total point count = 2*segW + 2*segH. */
export function rect(width: number, height: number, segW: number, segH: number): Vec2[] {
  const sw = Math.max(1, Math.floor(segW));
  const sh = Math.max(1, Math.floor(segH));
  const hw = width / 2;
  const hh = height / 2;
  const points: Vec2[] = [];
  // Top edge: TL → TR (segW segments, segW+1 points; emit segW, last is shared with right)
  for (let i = 0; i < sw; i++) {
    const t = i / sw;
    points.push({ x: -hw + width * t, y: -hh });
  }
  // Right edge: TR → BR
  for (let i = 0; i < sh; i++) {
    const t = i / sh;
    points.push({ x: hw, y: -hh + height * t });
  }
  // Bottom edge: BR → BL
  for (let i = 0; i < sw; i++) {
    const t = i / sw;
    points.push({ x: hw - width * t, y: hh });
  }
  // Left edge: BL → TL
  for (let i = 0; i < sh; i++) {
    const t = i / sh;
    points.push({ x: -hw, y: hh - height * t });
  }
  return points;
}

/** Resolve anchor indices for a CCW rectangle hull produced by rect().
 * Layout (segW=N, segH=M):
 *   index 0       = TL
 *   indices 1..N-1 = top mids
 *   index N       = TR
 *   indices N+1..N+M-1 = right mids
 *   index N+M     = BR
 *   indices N+M+1..2N+M-1 = bottom mids
 *   index 2N+M    = BL
 *   indices 2N+M+1..2N+2M-1 = left mids
 */
export function rectAnchorIndices(
  segW: number,
  segH: number,
  pattern: 'corners' | 'ends' | 'left' | 'right' | 'top' | 'bottom',
): number[] {
  const N = Math.max(1, Math.floor(segW));
  const M = Math.max(1, Math.floor(segH));
  const TL = 0, TR = N, BR = N + M, BL = 2 * N + M;
  switch (pattern) {
    case 'corners': return [TL, TR, BR, BL];
    case 'ends': {
      // entire left + right edges (TL, left mids, BL ... TR, right mids, BR)
      const out: number[] = [TL];
      for (let i = 1; i < M; i++) out.push(BL + i); // left mids (after BL going up)
      out.push(BL);
      out.push(TR);
      for (let i = 1; i < M; i++) out.push(N + i); // right mids
      out.push(BR);
      return out;
    }
    case 'top': {
      const out: number[] = [];
      for (let i = TL; i <= TR; i++) out.push(i);
      return out;
    }
    case 'bottom': {
      const out: number[] = [];
      for (let i = BR; i <= BL; i++) out.push(i);
      return out;
    }
    case 'left': {
      const out: number[] = [TL];
      for (let i = 1; i < M; i++) out.push(BL + i);
      out.push(BL);
      return out;
    }
    case 'right': {
      const out: number[] = [TR];
      for (let i = 1; i < M; i++) out.push(N + i);
      out.push(BR);
      return out;
    }
  }
}
