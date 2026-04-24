export interface Vec2 {
  x: number;
  y: number;
}

export function vec2(x: number, y: number): Vec2 { return { x, y }; }
export const ZERO: Vec2 = { x: 0, y: 0 };
export const RIGHT: Vec2 = { x: 1, y: 0 };
export const DOWN: Vec2 = { x: 0, y: 1 };

export function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y }; }
export function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
export function scale(v: Vec2, s: number): Vec2 { return { x: v.x * s, y: v.y * s }; }
export function dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y; }
export function lengthSq(v: Vec2): number { return v.x * v.x + v.y * v.y; }
export function length(v: Vec2): number { return Math.sqrt(lengthSq(v)); }
export function normalize(v: Vec2): Vec2 {
  const l = length(v);
  return l < 1e-10 ? ZERO : { x: v.x / l, y: v.y / l };
}
export function perp(v: Vec2): Vec2 { return { x: -v.y, y: v.x }; }  // 90 CCW
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
export function distanceTo(a: Vec2, b: Vec2): number { return length(sub(b, a)); }
export function distanceToSq(a: Vec2, b: Vec2): number { return lengthSq(sub(b, a)); }
export function angle(v: Vec2): number { return Math.atan2(v.y, v.x); }
export function negate(v: Vec2): Vec2 { return { x: -v.x, y: -v.y }; }
