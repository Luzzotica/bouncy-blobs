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
