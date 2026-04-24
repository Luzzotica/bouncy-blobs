# Soft Body Simulation — JavaScript/TypeScript Rebuild Spec

Translate the GDScript soft-body engine from this project into a self-contained
TypeScript module (no Godot dependency). The spec describes every system in the
order a clean implementation should be built.

---

## 1. Coordinate system & conventions

- 2-D, Y-axis pointing **down** (same as Godot 2D / browser canvas).
- Positions and velocities are plain `{ x: number; y: number }` objects (or a
  `Vec2` class — your choice as long as the interface is consistent).
- All angles are in **radians**.
- Area is **signed** (shoelace formula). CCW polygons produce a positive value
  under a Y-down convention (which is what the GDScript uses).

---

## 2. Default tuning constants (`GameplayTuning`)

```
SPRING_K        = 55.0
SPRING_DAMP     = 3.5
RADIAL_K        = 75.0
RADIAL_DAMP     = 4.2
PRESSURE_K      = 0.12
SHAPE_MATCH_K   = 88.0
SHAPE_MATCH_DAMP= 3.85
CENTER_MASS     = 0.2
HULL_MASS       = 0.12
```

These are the base values fed to `addBlobFromHull`. The playground multiplies
them by per-blob scalars (see §9).

---

## 3. Hull presets (`HullPresets`)

Static functions that return `Vec2[]` of CCW vertices centred at the origin.

### 3.1 `square(half: number): Vec2[]`

Four corners in CCW order (Y-down):

```
(-half, -half), (+half, -half), (+half, +half), (-half, +half)
```

### 3.2 `circle(n: number, r: number): Vec2[]`

`n` evenly-spaced points on a circle of radius `r`, starting at the top
(angle offset `-π/2`):

```ts
for i in 0..n-1:
  angle = (TAU * i / n) - PI/2
  points[i] = { x: cos(angle)*r, y: sin(angle)*r }
```

### 3.3 `triangle(r: number): Vec2[]`

Three points, same formula as `circle` but `n = 3`.

### 3.4 `star(arms: number, rOuter: number, rInner: number): Vec2[]`

`arms*2` points alternating outer/inner radius, starting at angle `-π/2`:

```ts
n = arms * 2
for i in 0..n-1:
  angle = -PI/2 + TAU * i / n
  r     = (i % 2 == 0) ? rOuter : rInner
  points[i] = { x: cos(angle)*r, y: sin(angle)*r }
```

### 3.5 `diamond(w: number): Vec2[]`

Four points, height = `w * 1.2`:

```
(0, -h), (+w, 0), (0, +h), (-w, 0)
```

### Named presets used in the game

| Name        | Function call                  |
|-------------|-------------------------------|
| Square      | `square(48)`                  |
| Circle (16) | `circle(16, 48)`              |
| Triangle    | `triangle(52)`                |
| Hexagon     | `circle(6, 48)`               |
| Star        | `star(5, 56, 22)`             |
| Diamond     | `diamond(48)`                 |

---

## 4. Math utilities (`Vec2` / `MathUtils`)

Provide at minimum:

```ts
add(a, b)           // a + b
sub(a, b)           // a - b
scale(v, s)         // v * s
dot(a, b)           // scalar dot product
length(v)
lengthSq(v)
normalize(v)        // returns zero-length vector if length < eps
perp(v)             // { x: -v.y, y: v.x }  (90° CCW)
lerp(a, b, t)
distanceTo(a, b)
distanceToSq(a, b)
atan2(v)            // atan2(v.y, v.x)
```

---

## 5. Collision utilities (`CollisionSoft`)

### 5.1 `polygonAABB(poly: Vec2[]): Rect`

Axis-aligned bounding box. Returns `{ x, y, w, h }` (or `{ minX, minY, maxX, maxY }`).

### 5.2 `aabbOverlap(a: Rect, b: Rect): boolean`

Standard overlap test (strict inequalities).

### 5.3 `isPointInPolygon(point: Vec2, poly: Vec2[]): boolean`

Ray-casting even-odd rule:

```ts
inside = false
j = n - 1
for i in 0..n-1:
  if (poly[i].y > point.y) != (poly[j].y > point.y) AND
     point.x < (poly[j].x - poly[i].x) * (point.y - poly[i].y) /
               (poly[j].y - poly[i].y) + poly[i].x:
    inside = !inside
  j = i
return inside
```

### 5.4 `closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2`

Project `p` onto segment `ab`, clamped to `[0, 1]`.

### 5.5 `closestPointOnPolygonBoundary(point: Vec2, poly: Vec2[])`

Returns:

```ts
{
  closest:  Vec2,   // nearest point on boundary
  edgeI:    number, // index of edge start vertex
  normal:   Vec2,   // outward normal at contact (points toward `point`)
  a:        Vec2,   // edge start
  b:        Vec2,   // edge end
  edgeDir:  Vec2,   // (b - a) / |b - a|, or RIGHT if degenerate
  edgeLen:  number,
}
```

Iterate all edges, pick the closest; flip normal if it points away from `point`.

### 5.6 `edgeVertexWeights(point: Vec2, a: Vec2, b: Vec2): { wb: number, wc: number }`

Barycentric weight of `point` projected onto edge `a–b`:

```ts
t  = dot(point - a, b - a) / |b - a|²   (clamped 0..1)
wc = t
wb = 1 - t
```

### 5.7 `signedAreaPolygon(poly: Vec2[]): number`

Shoelace formula:

```ts
a = 0
for i in 0..n-1:
  j = (i + 1) % n
  a += poly[i].x * poly[j].y - poly[j].x * poly[i].y
return a * 0.5
```

### 5.8 `resolveThreeBodyVelocity(...): [Vec2, Vec2, Vec2]`

Full signature:

```ts
resolveThreeBodyVelocity(
  va: Vec2, ma: number,
  vb: Vec2, mb: number,
  vc: Vec2, mc: number,
  normal: Vec2,         // unit normal from edge toward point A
  wb: number,           // barycentric weight on B
  wc: number,           // barycentric weight on C
  restitution: number,
  mu: number,           // Coulomb friction coefficient (0 = none)
  tangent: Vec2,        // unit edge direction
  frictionImpulseScale: number  // [0, 1] — soften friction chatter
): [Vec2, Vec2, Vec2]
```

Algorithm:

```
n  = normalize(normal)
vRel = dot(n, va) - (wb * dot(n, vb) + wc * dot(n, vc))
if vRel >= 0: return unchanged  // separating

invSum = (1/ma) + (wb²/mb) + (wc²/mc)
j = -(1 + restitution) * vRel / invSum

va' = va + n * (j / ma)
vb' = vb - n * (j * wb / mb)
vc' = vc - n * (j * wc / mc)

// Friction
t = normalize(tangent)
if |dot(t, n)| > 0.05: t = perp(-n)   // re-orthogonalize
vRelT = dot(t, va') - (wb*dot(t,vb') + wc*dot(t,vc'))
if |vRelT| < 0.42: return [va', vb', vc']   // micro-slip threshold
jt_uncap = -vRelT / invSum
jt = clamp(jt_uncap, -mu*|j|, mu*|j|) * frictionImpulseScale

va' += t * (jt / ma)
vb' -= t * (jt * wb / mb)
vc' -= t * (jt * wc / mc)
```

---

## 6. Constraints (`ConstraintsSoft`)

These are **position correction** functions called in an iteration loop.

### 6.1 `solveWeld(pos, invMass, i, j)`

Move particles `i` and `j` so they share the same position, weighted by inverse
mass:

```
delta = pos[j] - pos[i]
wSum  = invMass[i] + invMass[j]
if wSum < eps: return
corr  = delta / wSum
pos[i] += corr * invMass[j]  // note: NOT invMass[i]
pos[j] -= corr * invMass[i]
```

### 6.2 `solveWeightedAnchor(pos, invMass, indicesA, weightsA, indicesB, weightsB)`

Compute weighted centroid of group A and B, then pull them together:

```
pa = Σ(pos[indicesA[k]] * weightsA[k]) / Σ(weightsA)
pb = Σ(pos[indicesB[k]] * weightsB[k]) / Σ(weightsB)
delta = pb - pa

wTotal = Σ(invMass[indicesA[k]] * (wA_norm[k])²)
       + Σ(invMass[indicesB[k]] * (wB_norm[k])²)
corr = delta / wTotal

pos[indicesA[k]] += corr * invMass[indicesA[k]] * wA_norm[k]
pos[indicesB[k]] -= corr * invMass[indicesB[k]] * wB_norm[k]
```

where `wA_norm[k] = weightsA[k] / Σ(weightsA)`.

### 6.3 `solveDistanceMax(pos, invMass, i, j, maxDist)`

Only activates when the particles are **further** than `maxDist` apart:

```
d   = pos[j] - pos[i]
len = |d|
if len <= maxDist or len < eps: return
n       = d / len
overlap = len - maxDist
wSum    = invMass[i] + invMass[j]
corr    = overlap / wSum
pos[i] += n * corr * invMass[j]   // pull toward j
pos[j] -= n * corr * invMass[i]   // pull toward i
```

---

## 7. Shape matching (`ShapeMatching`)

### 7.1 `centroidFromIndices(pos: Vec2[], indices: number[]): Vec2`

Average of `pos[indices[k]]` for all k.

### 7.2 `averageAngle(restLocal: Vec2[], pos: Vec2[], indices: number[], center: Vec2): number`

Estimates the body's current rotation relative to the rest pose:

```
sum = 0, count = 0
for each index k:
  li = restLocal[k]
  pi = pos[indices[k]] - center
  if |li|² < eps² or |pi|² < eps²: skip
  aRest = atan2(li.y, li.x)
  aCur  = atan2(pi.y, pi.x)
  diff  = aCur - aRest
  diff  = ((diff + π) mod 2π) - π   // wrap to [-π, π]
  sum  += diff
  count++
return (count > 0) ? sum / count : 0
```

### 7.3 `frameTransform(center: Vec2, angle: number): Transform2D`

A 2-D rotation + translation. In JS you can represent this as:

```ts
interface Transform2D {
  cos: number; sin: number;   // rotation
  tx: number;  ty: number;    // origin
}

function applyTransform(t: Transform2D, v: Vec2): Vec2 {
  return {
    x: t.cos * v.x - t.sin * v.y + t.tx,
    y: t.sin * v.x + t.cos * v.y + t.ty,
  };
}
```

---

## 8. Core simulation (`SoftBodyWorld`)

This is the main class. All arrays are flat, indexed by particle index.

### 8.1 Particle storage

```ts
pos:           Vec2[]          // world-space positions
vel:           Vec2[]          // world-space velocities
mass:          number[]
invMass:       number[]        // 1/mass; 0 for infinite-mass particles
particleRadius: number[]       // >0 enables circle collision
```

### 8.2 Springs

```ts
type Spring = [i: number, j: number, rest: number, kBase: number, dampBase: number]
springs: Spring[]
```

### 8.3 Blob descriptor

```ts
interface BlobRange {
  id:                  number
  start:               number  // inclusive index into pos/vel
  end:                 number  // exclusive
  hull:                number[] // indices of hull particles (excludes center)
  shapeIdx:            number   // index into shapes[]
  springBegin:         number   // first spring index for this blob
  springEnd:           number   // exclusive
  springStiffnessScale: number  // runtime multiplier (default 1.0)
  springDampScale:     number   // runtime multiplier (default 1.0)
}
```

### 8.4 Shape descriptor

```ts
interface Shape {
  indices:             number[]  // hull particle indices
  staticPoly:          Vec2[]    // non-empty for static/trigger shapes
  isTrigger:           boolean
  isStatic:            boolean
  targetRestArea:      number    // signed area at rest (for pressure)
  pressureK:           number
  shapeMatchK:         number
  shapeMatchDamp:      number
  restLocal:           Vec2[]    // rest positions relative to blob centroid
  shapeMatchRestScale: number    // runtime scale (default 1.0; clamped [0.35, 3.5])
  useFrameOverride:    boolean
  frameOverride:       Transform2D
  triggerGravity:      Vec2      // overrides world gravity inside trigger zone
  centerIdx:           number    // index of center particle
}
```

### 8.5 World-level configuration

```ts
interface WorldConfig {
  gravity:                      Vec2    // default { x: 0, y: 980 * gravityScale }
  gravityScale:                 number  // default 4.0
  fixedDt:                      number  // default 1/60
  substeps:                     number  // default 2 (playground uses 4)
  collisionMargin:              number  // 1.5
  collisionRestitution:         number  // 0.25
  constraintIters:              number  // 8
  staticRestitution:            number  // 0.0
  staticContactSlop:            number  // 14.0
  blobBlobFrictionMu:           number  // 1.44
  blobBlobFrictionImpulseScale: number  // 1.0
  staticEdgeFrictionMu:         number  // 1.64
  staticFrictionMinTangSpeed:   number  // 0.06
  staticFrictionNormalLoadScale:number  // 2.0
  hullVertexDampingPerSec:      number  // 0.012
  centerHullDampingPerSec:      number  // 0.004
  hullDampSkipAboveSpeed:       number  // 220.0
}
```

---

### 8.6 Public API

#### `addBlobFromHull(params): BlobResult`

The primary factory. Creates a blob from an arbitrary closed CCW polygon.

```ts
params: {
  hullRestLocal:  Vec2[]    // CCW hull vertices, centred at origin
  centerLocal:    Vec2      // center offset from world origin (usually zero)
  centerMass:     number
  hullMass:       number
  springK:        number    // hull edge & shear spring stiffness
  springDamp:     number
  radialK:        number    // center→hull spring stiffness
  radialDamp:     number
  pressureK:      number
  shapeMatchK:    number
  shapeMatchDamp: number
  worldOrigin:    Vec2      // world-space spawn position
}

returns: {
  blobId:      number
  centerIdx:   number    // index of center particle
  hullIndices: number[]  // indices of hull particles
  shapeIdx:    number
}
```

**Internal steps:**

1. Push center particle at `centerLocal + worldOrigin`.
2. Push N hull particles at `hullRestLocal[i] + worldOrigin`.
3. Create **hull edge springs** between consecutive hull points (`k = springK`).
4. If N ≥ 4, create **shear springs** between hull[i] and hull[(i+2)%N] (`k = springK * 0.85`).
5. Create **radial springs** from center → each hull point (`k = radialK`, rest = distance from center to each hull point; minimum 0.001).
6. Compute `targetRestArea = |signedAreaPolygon(hullVerticesAtSpawn)|`.
7. Push `BlobRange` and `Shape` descriptors.

#### `addBlob(params): BlobResult`

Convenience variant for a regular N-gon blob (uniform circle-based hull):

```ts
params: {
  centerLocal: Vec2, numHull: number, blobRadius: number,
  centerMass, hullMass, springK, springDamp,
  radialK, radialDamp, pressureK, shapeMatchK, shapeMatchDamp,
  worldOrigin: Vec2
}
```

Same logic as `addBlobFromHull` but hull vertices are generated from `circle(numHull, blobRadius)`.  
Shear springs use `rest_r = blobRadius` instead of measured distance.

#### `registerStaticPolygon(poly: Vec2[]): void`

Add a world-space closed polygon that blobs collide against.

#### `registerTriggerPolygon(poly: Vec2[], gravityOverride?: Vec2): number`

Add an invisible region. Returns `shapeIdx`. Emits enter/exit events.

#### `clearSimulation(): void`

Remove all dynamic particles, springs, and blob ranges. Keep static polygons and trigger shapes.

---

#### Spring/shape control

```ts
setBlobSpringStiffnessScale(blobId: number, stiffnessScale: number, dampScale?: number): void
// stiffnessScale clamped [0.2, 4.0]
// dampScale defaults to sqrt(stiffnessScale) if negative / omitted

setBlobShapeMatchRestScale(blobId: number, scale: number): void
// scale clamped [0.35, 3.5]
```

#### Force application

```ts
applyExternalForcePoint(i: number, f: Vec2): void
// vel[i] += f * invMass[i]

applyBlobMoveForce(blobId: number, move: Vec2, force: number): void
// for each particle in blob: vel[i] += move * force * invMass[i]

applyBlobLinearVelocityDelta(blobId: number, deltaV: Vec2): void
// for each particle in blob: vel[i] += deltaV

applyBlobExpand(blobId: number, expandForce: number): void
// See §8.7 for the pump algorithm
```

#### Queries

```ts
getPositions(): Vec2[]           // reference to internal array (read-only)
getVelocities(): Vec2[]          // copy
getPointCount(): number
getHullPolygon(blobId: number): Vec2[]
getBlobCount(): number
getBlobMassPointIndexRange(blobId: number): { start: number; end: number }
getBlobCenterPointIndex(blobId: number): number
getBlobIdForPointIndex(pointIdx: number): number   // -1 if not found
getSpringIndexPairs(): [number, number][]
getBlobShapeMatchTargetHull(blobId: number): Vec2[]
getBlobPumpEdgeImpulses(blobId: number, expandForce: number): PumpEdge[]

addParticle(pos: Vec2, vel: Vec2, mass: number, radius: number): number
addWeld(i: number, j: number): void
addDistanceMax(i: number, j: number, maxDist: number): void
addWeightedAnchor(indicesA, weightsA, indicesB, weightsB): void
setHullPositions(blobId: number, hullPositions: Vec2[]): void

rayCast(origin: Vec2, dir: Vec2, maxDist: number): RayHit
```

#### Events / callbacks

```ts
onTriggerEntered: (triggerShapeIdx: number, blobId: number) => void
onTriggerExited:  (triggerShapeIdx: number, blobId: number) => void
```

---

### 8.7 Simulation step

Called once per frame with `delta` (seconds). Uses a fixed-timestep accumulator:

```ts
step(delta: number): void {
  timeAccum += delta
  while (timeAccum >= fixedDt) {
    timeAccum -= fixedDt
    for (let s = 0; s < substeps; s++) {
      substep()
    }
  }
}
```

#### `substep()`

```
dt = fixedDt / substeps

1. Build per-particle gravity array (default = world.gravity)
   For each blob: compute hull centroid; if inside a trigger with
   triggerGravity set, override gravity for all particles in that blob.

2. vel[i] += gravity[i] * dt   (for all i)

3. applySpings(dt)
4. applyPressure(dt)
5. applyShapeMatching(dt)

6. pos[i] += vel[i] * dt       (semi-implicit Euler)

7. for CONSTRAINT_ITERS iterations:
     solve all welds
     solve all weighted anchors
     solve all distance-max constraints

8. solveCollisions(dt)
9. solveParticleCollisions(dt)
10. processTriggerEvents()
11. applyHullVelocityDamping(dt)
```

---

### 8.8 Spring force (`applySpings`)

For each blob, iterate only its own springs `[springBegin, springEnd)` and
apply the blob's `springStiffnessScale` / `springDampScale`:

```
diff    = pos[ib] - pos[ia]
dist    = |diff|
if dist < 0.0001: skip
dir     = diff / dist
stretch = dist - rest
relVel  = dot(vel[ib] - vel[ia], dir)
force   = (k * kMult * stretch + damp * dMult * relVel) * dir

if invMass[ia] > 0: vel[ia] += force * invMass[ia] * dt
if invMass[ib] > 0: vel[ib] -= force * invMass[ib] * dt
```

---

### 8.9 Pressure (`applyPressure`)

For each dynamic, non-trigger shape:

```
poly   = buildPolygonFromIndices(shape.indices)
area   = signedAreaPolygon(poly)
target = shapePressureTargetArea(shapeIdx)
err    = target - area
n      = shape.indices.length

for each vertex i:
  ia    = indices[i]
  iprev = indices[(i + n - 1) % n]
  inext = indices[(i + 1)     % n]
  grad  = { x: (pos[inext].y - pos[iprev].y) * 0.5,
            y: (pos[iprev].x - pos[inext].x) * 0.5 }
  f     = grad * pressureK * err
  if invMass[ia] > 0: vel[ia] += f * invMass[ia] * dt
```

#### `shapePressureTargetArea(shapeIdx)`

```
base = shape.targetRestArea
sc   = max(shape.shapeMatchRestScale, 0.05)
return max(base * sc * sc, 1e-6)
```

---

### 8.10 Shape matching (`applyShapeMatching`)

For each dynamic shape with `shapeMatchK > 0`:

```
// Compute rest frame
if useFrameOverride:
  center = frameOverride.origin
  angle  = frameOverride.rotation
else:
  center = centroidFromIndices(pos, indices)
  angle  = averageAngle(restLocal, pos, indices, center)
frame = frameTransform(center, angle)
smScale = max(shapeMatchRestScale, 0.05)

// Centre-of-mass velocity of hull particles
vCom = Σ(vel[idx[k]] * mass[idx[k]]) / Σ(mass[idx[k]])

// Push each hull particle toward its rest-frame target
for each k:
  pi     = indices[k]
  target = applyTransform(frame, restLocal[k] * smScale)
  diff   = target - pos[pi]
  vRel   = vel[pi] - vCom
  f      = diff * shapeMatchK - vRel * shapeMatchDamp
  if invMass[pi] > 0: vel[pi] += f * invMass[pi] * dt
```

---

### 8.11 Collision solving (`solveCollisions`)

Order matters: blob-blob first, then blob-vs-static.

```
for a in 0..blobCount-1:
  for b in a+1..blobCount-1:
    collideBlobBlob(a, b)

for each staticPolygon:
  for each blob:
    collideBlobWithPoly(blob, staticPoly, isStatic=true, dt)
```

#### `collideBlobBlob(a, b)`

Build world-space hull polygons for both blobs. Early-out on AABB miss.

- Check each hull point of A against polygon B → `resolvePointInShape(pi, polyB, indicesB)`
- Check each hull point of B against polygon A → `resolvePointInShape(pi, polyA, indicesA)`

#### `resolvePointInShape(pi, poly, polyIndices)`

```
p = pos[pi]
if not isPointInPolygon(p, poly): return
info = closestPointOnPolygonBoundary(p, poly)
n    = -info.normal   // flip: interior → push outward
closest = info.closest
{ wb, wc } = edgeVertexWeights(p, info.a, info.b)
ib0 = polyIndices[info.edgeI]
ib1 = polyIndices[(info.edgeI + 1) % polyIndices.length]

pen = dot(p - closest, n)
if pen <= 0: pen = COLLISION_MARGIN

// Effective mass correction
wSum = invMass[pi] + invMass[ib0]*wb² + invMass[ib1]*wc²
if wSum < 1e-8: return
corr = pen / wSum

pos[pi]  += n * corr * invMass[pi]
pos[ib0] -= n * corr * invMass[ib0] * wb
pos[ib1] -= n * corr * invMass[ib1] * wc

// Velocity resolution
[va', vb', vc'] = resolveThreeBodyVelocity(
  vel[pi], mass[pi],
  vel[ib0], mass[ib0],
  vel[ib1], mass[ib1],
  n, wb, wc,
  COLLISION_RESTITUTION,
  blobBlobFrictionMu,
  info.edgeDir,
  blobBlobFrictionImpulseScale
)
vel[pi] = va'; vel[ib0] = vb'; vel[ib1] = vc'
```

#### `collideBlobWithPoly(blobId, polyWorld, isStatic, dt)`

For each hull point `pi`:

```
p = pos[pi]
early-out: expand point to 2×2 AABB and check against poly AABB

info   = closestPointOnPolygonBoundary(p, polyWorld)
inside = isPointInPolygon(p, polyWorld)

if inside:
  n         = -info.normal
  pen       = dot(p - info.closest, n)
  if pen <= 0: pen = COLLISION_MARGIN
  pushDist  = pen + COLLISION_MARGIN
  useStatic = isStatic
elif isStatic AND distToBoundary <= staticContactSlop:
  toPoint = p - info.closest
  if dot(toPoint, info.normal) < -0.05: skip
  n        = info.normal
  gap      = dot(toPoint, n)
  if gap < 0: skip
  pushDist = max(gap, COLLISION_MARGIN) + COLLISION_MARGIN * 0.25
  useStatic = true
else:
  skip

if isStatic AND useStatic:
  // Remove inward velocity component
  vnInWall = dot(vel[pi], n)
  if vnInWall < 0: vel[pi] -= n * vnInWall
  pos[pi] = info.closest + n * pushDist

  vnBeforeRest = dot(vel[pi], n)
  if vnBeforeRest < 0:
    vel[pi] -= n * vnBeforeRest * (1 + staticRestitution)
  vnAfterRest = dot(vel[pi], n)

  // Static friction
  if staticEdgeFrictionMu > 1e-6:
    t  = normalize(info.edgeDir)
    if |t|² < 1e-12: t = perp(-n)
    vt = dot(vel[pi], t)
    if |vt| >= staticFrictionMinTangSpeed:
      jnCollision = mass[pi] * |vnAfterRest - vnBeforeRest|
      gLen        = |gravity|
      upDir       = -normalize(gravity)
      support     = clamp(dot(upDir, n), 0, 1)
      jnRest      = mass[pi] * gLen * support * dt * staticFrictionNormalLoadScale
      jn          = max(jnCollision, jnRest)
      jtUncap     = -mass[pi] * vt
      jt          = clamp(jtUncap, -mu*jn, mu*jn)
      vel[pi]    += t * (jt / mass[pi])
```

---

### 8.12 Particle collisions (`solveParticleCollisions`)

Iterate all particles with `particleRadius > 0`.

For each such particle, test against:
- All static polygons
- All static shape polygons
- All dynamic shape polygons (build from indices)

```
resolveParticleVsPoly(i, rad, polyWorld):
  p    = pos[i]
  info = closestPointOnPolygonBoundary(p, polyWorld)
  inside = isPointInPolygon(p, polyWorld)
  distAlong = dot(p - info.closest, info.normal)

  if not inside:
    if distAlong >= rad - COLLISION_MARGIN * 0.25: return  // not close enough
    pos[i] = p + info.normal * (rad - distAlong)
  else:
    pos[i] = info.closest + info.normal * (rad + COLLISION_MARGIN)

  vn = dot(vel[i], info.normal)
  if vn < 0: vel[i] -= info.normal * vn * (1 + COLLISION_RESTITUTION)
```

---

### 8.13 Velocity damping (`applyHullVelocityDamping`)

Exponential drag per substep:

```
hFac = exp(-hullVertexDampingPerSec * dt)
cFac = exp(-centerHullDampingPerSec * dt)
skipSpeedSq = hullDampSkipAboveSpeed²

for each blob:
  ci = blob.start   // center particle index
  for j in blob.start..blob.end-1:
    if j == ci:
      vel[j] *= cFac
    else:
      if |vel[j]|² > skipSpeedSq: skip
      vel[j] *= hFac
```

---

### 8.14 Pump / expand (`applyBlobExpand`, `getBlobPumpEdgeImpulses`)

The pump inflates a blob by pushing each hull edge outward, scaled by how
deflated it currently is (pressure multiplier).

```ts
interface PumpEdge {
  i0: number; i1: number
  mid: Vec2
  normal: Vec2   // outward unit normal
  impulse: number
}

getBlobPumpEdgeImpulses(blobId, expandForce): PumpEdge[] {
  ci = blob.start
  c  = pos[ci]
  hull = blob.hull
  nh   = hull.length

  // Total perimeter
  perim = Σ distance(pos[hull[k]], pos[hull[(k+1)%nh]])
  if perim < 1e-6: return []

  pmul = blobPumpPressureMultiplier(blobId)
  // 0.5 * nh is the "budget factor" (each edge gets a fair share)
  base = expandForce * pmul * (nh * 0.5)

  for each edge k:
    i0 = hull[k];  i1 = hull[(k+1)%nh]
    a  = pos[i0];  b  = pos[i1]
    ed = b - a;    el = |ed|
    if el < 1e-6: skip
    mid   = (a + b) * 0.5
    nOut  = perp(ed)               // { x: -ed.y, y: ed.x }
    if dot(nOut, c - mid) > 0: nOut = -nOut   // ensure outward
    nOut  = normalize(nOut)
    impEdge = base * (el / perim)
    edges.push({ i0, i1, mid, normal: nOut, impulse: impEdge })
}

applyBlobExpand(blobId, expandForce):
  for each edge in getBlobPumpEdgeImpulses(blobId, expandForce):
    vel[edge.i0] += edge.normal * edge.impulse * invMass[edge.i0]
    vel[edge.i1] += edge.normal * edge.impulse * invMass[edge.i1]
```

#### Pressure multiplier

```
blobPumpPressureMultiplier(blobId):
  sh     = shapes[blob.shapeIdx]
  pk     = sh.pressureK
  area   = signedAreaPolygon(buildPolygon(sh.indices))
  target = shapePressureTargetArea(shapeIdx)
  err    = |target - area|
  return 1 + pk * err / max(|target|, 1)
```

---

### 8.15 Trigger processing (`processTriggerEvents`)

After each substep, for each trigger shape × each blob:

```
cx = centroidFromIndices(pos, blob.hull)
isInside = isPointInPolygon(cx, triggerShape.staticPoly)
key = (shapeIdx, blobId)
wasInside = triggerPrev.get(key, false)

if isInside AND NOT wasInside: emit("triggerEntered", shapeIdx, blobId)
if NOT isInside AND wasInside: emit("triggerExited",  shapeIdx, blobId)
triggerPrev.set(key, isInside)
```

---

### 8.16 Ray cast

```ts
rayCast(origin, dir, maxDist): { hit, distance, position, normal }

for each static polygon:
  for each edge (a, b):
    find intersection of ray segment [origin, origin+dir*maxDist] with edge
    if intersection found and t < bestT: update bestT, bestNormal
    // flip normal to face the ray
```

---

## 9. Blob wrapper / controller (`SlimeBlob`)

This layer sits above `SoftBodyWorld` and is responsible for input and visual sync.

### Constants

```
BLOB_RADIUS                    = 48.0
HULL_LINE_WIDTH                = 2.25
MOVE_FORCE                     = 5.0
PLAYER_SPRING_K_MULT           = 0.92
PLAYER_SPRING_DAMP_MULT        = 1.0
PLAYER_RADIAL_K_MULT           = 0.92
PLAYER_RADIAL_DAMP_MULT        = 1.0
PLAYER_SHAPE_MATCH_K_MULT      = 0.92
PLAYER_SHAPE_MATCH_DAMP_MULT   = 1.0
PLAYER_MASS_MULT               = 0.5    // lighter = snappier expand
EXPAND_SPRING_STIFFNESS_MULT   = 1.45   // held while expand is pressed
```

### Expand shape-scale animation

```ts
expandShapeScaleMax:   number = 3.0    // target scale while held
expandShapeScaleSpeed: number = 6.75   // units/sec when releasing
expandShapeScaleSpeedPress: number = 36.0  // units/sec when pressing

// Each physics tick:
targetScale = expandPressed ? expandShapeScaleMax : 1.0
rampRate    = (targetScale > currentScale) ? expandShapeScaleSpeedPress
                                           : expandShapeScaleSpeed
currentScale = moveToward(currentScale, targetScale, rampRate * dt)
world.setBlobShapeMatchRestScale(blobId, currentScale)
```

`moveToward(current, target, maxDelta)`: advance current toward target by at
most maxDelta, never overshoot.

### Physics tick (player-controlled only)

1. `world.setBlobSpringStiffnessScale(blobId, expandPressed ? EXPAND_SPRING_STIFFNESS_MULT : 1.0)`
2. `world.applyBlobMoveForce(blobId, { x: inputX, y: 0 }, MOVE_FORCE)`
3. Update expand shape scale (above).
4. Optionally sync hull positions over network via `setHullPositions`.

### Visual centroid

The on-screen position of the blob node tracks the centroid of its hull
particles each frame:

```ts
centroid = average of pos[hullIndices[k]]  for all k
```

### Draw

Draw the convex hull outline as a closed polyline using `getHullPolygon(blobId)`.

Optional debug: draw each spring with a squiggly line (sine-wave offset along
the spring's normal, ~3.5 waves, amplitude clamped `[2, 10]`).

---

## 10. Playground / demo controller

A thin controller that ties everything together for interactive demo purposes.
Not part of the core physics — skip if you just need the engine.

### Tools

```
PULL  – drag a hull point; release to throw
PUMP  – hold expand key while hovering to inflate
FRAME – click a blob to scale its shape-match rest frame to 2.0×
```

### Pull tool

- On mouse-down inside a blob: record the grab point index (nearest hull
  particle to cursor).
- Each physics tick while dragging:
  `world.applyExternalForcePoint(dragIdx, gesture * pullK * PULL_FORCE_SCALE)`
  where `gesture = mouseCurrent - mouseAtGrab`.
- Smooth mouse velocity each tick: `smoothVel = lerp(smoothVel, instantVel, 0.45)`.
- On mouse-up: apply throw impulse to blob's linear velocity:
  ```
  throwV = instantVel * 1.65
  if |throwV|² < 2.25: throwV = smoothVel * 1.65
  world.applyBlobLinearVelocityDelta(blobId, throwV)
  ```

### Constants used by playground

```
PULL_FORCE_SCALE              = 0.005
PULL_RELEASE_THROW_SCALE      = 1.65
PULL_DRAG_VEL_SMOOTH          = 0.45  // lerp factor each tick
PUMP_FORCE_SCALE              = 0.1
FRAME_REST_SCALE              = 2.0
MOVE_FORCE (keyboard ctrl)    = 47.5
EXPAND_FORCE (keyboard ctrl)  = 500.0
```

Gravity slider range: `[0.2, 8.0]` × base gravity.  
Pump slider: `[100, 3200]`, default 1100. Actual force = `sliderValue * PUMP_FORCE_SCALE`.  
Pull slider: `[80, 2800]`, default 720.

---

## 11. Implementation checklist

Build in this order to keep each step testable:

1. `Vec2` helpers and math utilities.
2. `CollisionSoft`: point-in-polygon, closest-point-on-boundary, signed area, AABB.
3. `HullPresets`: square, circle, triangle, star, diamond.
4. `ConstraintsSoft`: weld, weighted anchor, distance max.
5. `ShapeMatching`: centroid, average angle, frame transform.
6. `SoftBodyWorld` skeleton: particle arrays, blob factory (`addBlobFromHull`).
7. Spring force, pressure, shape matching per-substep.
8. Position integration and constraint solver loop.
9. Blob-blob and blob-static collision resolution.
10. Velocity damping, trigger events.
11. Force / impulse helpers (`applyBlobExpand`, `applyBlobMoveForce`, etc.).
12. `SlimeBlob` wrapper with input and expand animation.
13. (Optional) Playground controller for interactive testing.

---

## 12. Rendering hints

The GDScript rendering pipeline is simple and maps easily to canvas 2D or WebGL:

- **Normal mode**: draw the hull polygon as a closed polyline (connect `hullPolygon[i]` → `hullPolygon[(i+1)%n]`).
- **Debug springs**: squiggly lines between spring endpoint pairs.
- **Debug shape-match target**: draw `getBlobShapeMatchTargetHull(blobId)` as a dim polyline.
- **Debug velocity arrow**: arrow from blob center, length = `|vel[centerIdx]| * 0.085`.
- **Pump visualisation**: draw an arc at the hull centroid while expand is held.
- **Pull visualisation**: line from grab origin to current mouse position.

---

## 13. Not implemented / out of scope

- Multiplayer RPC sync (`sync_points.rpc`) — the GDScript has this but it is
  Godot-specific. In JS expose `setHullPositions` for external callers to invoke.
- `soft_collision_shape_util.gd` and `soft_level_collision_sync.gd` — these
  are Godot editor helpers and are not needed for the core simulation.
- Mobile joystick (`MobileInput`) — implement as a separate input abstraction.
