import { Vec2, vec2 } from '../physics/vec2';

export class Camera {
  position: Vec2 = vec2(0, 0);
  zoom = 1.0;
  private targetPosition: Vec2 = vec2(0, 0);
  private targetZoom = 1.0;
  private smoothSpeed = 8; // exponential decay speed (higher = snappier)

  setTarget(pos: Vec2, zoom?: number): void {
    this.targetPosition = pos;
    if (zoom !== undefined) this.targetZoom = zoom;
  }

  snapTo(pos: Vec2, zoom?: number): void {
    this.position = { ...pos };
    this.targetPosition = { ...pos };
    if (zoom !== undefined) {
      this.zoom = zoom;
      this.targetZoom = zoom;
    }
  }

  /** Lerp position & zoom toward target. Call exactly once per frame. */
  update(dt: number): void {
    const alpha = 1 - Math.exp(-this.smoothSpeed * dt);
    this.position.x += (this.targetPosition.x - this.position.x) * alpha;
    this.position.y += (this.targetPosition.y - this.position.y) * alpha;
    this.zoom += (this.targetZoom - this.zoom) * alpha;
  }

  followTargets(targets: Vec2[], canvasWidth: number, canvasHeight: number, padding = 200): void {
    if (targets.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const t of targets) {
      if (t.x < minX) minX = t.x;
      if (t.x > maxX) maxX = t.x;
      if (t.y < minY) minY = t.y;
      if (t.y > maxY) maxY = t.y;
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.targetPosition = vec2(cx, cy);

    const spanX = (maxX - minX) + padding * 2;
    const spanY = (maxY - minY) + padding * 2;
    const zoomX = canvasWidth / spanX;
    const zoomY = canvasHeight / spanY;
    this.targetZoom = Math.min(zoomX, zoomY, 0.592);
    this.targetZoom = Math.max(this.targetZoom, 0.254);
  }

  worldToScreen(world: Vec2, canvasWidth: number, canvasHeight: number): Vec2 {
    const dx = world.x - this.position.x;
    const dy = world.y - this.position.y;
    return vec2(
      dx * this.zoom + canvasWidth / 2,
      dy * this.zoom + canvasHeight / 2,
    );
  }

  screenToWorld(screen: Vec2, canvasWidth: number, canvasHeight: number): Vec2 {
    const dx = (screen.x - canvasWidth / 2) / this.zoom;
    const dy = (screen.y - canvasHeight / 2) / this.zoom;
    return vec2(this.position.x + dx, this.position.y + dy);
  }
}
