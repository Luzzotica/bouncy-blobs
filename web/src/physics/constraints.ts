import { Vec2, sub, scale, add, length } from './vec2';

const EPS = 1e-7;

export function solveWeld(
  pos: Vec2[], invMass: number[], i: number, j: number
): void {
  const wi = i < invMass.length ? invMass[i] : 0;
  const wj = j < invMass.length ? invMass[j] : 0;
  const wSum = wi + wj;
  if (wSum < EPS) return;
  const delta = sub(pos[j], pos[i]);
  const corr = scale(delta, 1 / wSum);
  pos[i] = add(pos[i], scale(corr, wj));
  pos[j] = sub(pos[j], scale(corr, wi));
}

export function solveWeightedAnchor(
  pos: Vec2[], invMass: number[],
  indicesA: number[], weightsA: number[],
  indicesB: number[], weightsB: number[],
): void {
  let pa: Vec2 = { x: 0, y: 0 };
  let waSum = 0;
  for (let k = 0; k < indicesA.length; k++) {
    const w = weightsA[k];
    pa = add(pa, scale(pos[indicesA[k]], w));
    waSum += w;
  }
  let pb: Vec2 = { x: 0, y: 0 };
  let wbSum = 0;
  for (let k = 0; k < indicesB.length; k++) {
    const w = weightsB[k];
    pb = add(pb, scale(pos[indicesB[k]], w));
    wbSum += w;
  }
  if (waSum < EPS || wbSum < EPS) return;
  pa = scale(pa, 1 / waSum);
  pb = scale(pb, 1 / wbSum);
  const delta = sub(pb, pa);
  let wTotal = 0;
  for (let k = 0; k < indicesA.length; k++) {
    const w = weightsA[k] / waSum;
    wTotal += invMass[indicesA[k]] * w * w;
  }
  for (let k = 0; k < indicesB.length; k++) {
    const w = weightsB[k] / wbSum;
    wTotal += invMass[indicesB[k]] * w * w;
  }
  if (wTotal < EPS) return;
  const corr = scale(delta, 1 / wTotal);
  for (let k = 0; k < indicesA.length; k++) {
    const idx = indicesA[k];
    const w = weightsA[k] / waSum;
    pos[idx] = add(pos[idx], scale(corr, invMass[idx] * w));
  }
  for (let k = 0; k < indicesB.length; k++) {
    const idx = indicesB[k];
    const w = weightsB[k] / wbSum;
    pos[idx] = sub(pos[idx], scale(corr, invMass[idx] * w));
  }
}

export function solveDistanceMax(
  pos: Vec2[], invMass: number[], i: number, j: number, maxDist: number
): void {
  const d = sub(pos[j], pos[i]);
  const len = length(d);
  if (len <= maxDist || len < EPS) return;
  const n = scale(d, 1 / len);
  const overlap = len - maxDist;
  const wi = i < invMass.length ? invMass[i] : 0;
  const wj = j < invMass.length ? invMass[j] : 0;
  const wSum = wi + wj;
  if (wSum < EPS) return;
  const corr = overlap / wSum;
  pos[i] = add(pos[i], scale(n, corr * wj));
  pos[j] = sub(pos[j], scale(n, corr * wi));
}
