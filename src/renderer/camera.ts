import { Vec2, vec2 } from '../physics/vec2';

export class Camera {
  position: Vec2 = vec2(0, 0);
  zoom = 1.0;
  private targetPosition: Vec2 = vec2(0, 0);
  private targetZoom = 1.0;
  private smoothSpeed = 8; // exponential decay speed (higher = snappier)

  // Hard-containment frame: the world-space AABB (already padded) that MUST
  // stay fully inside the viewport, plus the viewport size and zoom clamps
  // that produced it. Set every tick by followTargets()/watchWholeMap(); then
  // enforced after the smooth lerp in update(). The smooth lerp gives the nice
  // floaty feel; the enforcement is the guarantee that a fast mover can never
  // slip off-screen while the lerp is still catching up.
  private frameMinX = 0;
  private frameMaxX = 0;
  private frameMinY = 0;
  private frameMaxY = 0;
  private frameCanvasW = 0;
  private frameCanvasH = 0;
  private frameMaxZoom = Infinity;
  private frameMinZoom = 0;
  private hasFrame = false;

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
    this.hasFrame = false;
  }

  /** Lerp position & zoom toward target, then hard-contain. Call once per tick. */
  update(dt: number): void {
    // --- Adaptive position speed -------------------------------------------
    // The closer the framed targets get to the viewport edge, the harder the
    // camera chases. Gentle drift stays smooth (speed = smoothSpeed); a blob
    // accelerating toward the edge ramps the speed up to ~4× so it's reeled
    // back in before it can leave frame.
    let posSpeed = this.smoothSpeed;
    if (this.hasFrame && this.frameCanvasW > 0 && this.zoom > 0) {
      const halfW = this.frameCanvasW / (2 * this.zoom);
      const halfH = this.frameCanvasH / (2 * this.zoom);
      const dx = Math.abs(this.targetPosition.x - this.position.x) / halfW;
      const dy = Math.abs(this.targetPosition.y - this.position.y) / halfH;
      const lead = Math.min(1, Math.max(dx, dy)); // 0 centred .. 1 at the edge
      posSpeed = this.smoothSpeed * (1 + 3 * lead);
    }
    const aPos = 1 - Math.exp(-posSpeed * dt);
    this.position.x += (this.targetPosition.x - this.position.x) * aPos;
    this.position.y += (this.targetPosition.y - this.position.y) * aPos;

    // --- Asymmetric zoom ----------------------------------------------------
    // Zooming OUT (targets spreading apart) is urgent — snap out fast so nobody
    // leaves frame. Zooming IN (closing back up) is cosmetic — keep it gentle
    // so the view doesn't nervously "breathe" on every small movement.
    const zoomSpeed = this.targetZoom < this.zoom ? this.smoothSpeed * 3 : this.smoothSpeed;
    const aZoom = 1 - Math.exp(-zoomSpeed * dt);
    this.zoom += (this.targetZoom - this.zoom) * aZoom;

    this.enforceFrame();
  }

  /**
   * After the smooth lerp, guarantee the framed AABB is fully visible. The AABB
   * already includes padding, so the lerp has that much slack before this bites;
   * once the real targets reach the padded edge we stop being smooth and clamp
   * zoom/position so they physically cannot exit the screen.
   */
  private enforceFrame(): void {
    if (!this.hasFrame || this.frameCanvasW <= 0) return;

    const spanX = Math.max(1e-3, this.frameMaxX - this.frameMinX);
    const spanY = Math.max(1e-3, this.frameMaxY - this.frameMinY);

    // The most zoomed-in we may be while still fitting the whole AABB.
    let reqZoom = Math.min(this.frameCanvasW / spanX, this.frameCanvasH / spanY);
    reqZoom = Math.min(reqZoom, this.frameMaxZoom);
    reqZoom = Math.max(reqZoom, this.frameMinZoom);
    if (this.zoom > reqZoom) this.zoom = reqZoom;

    // Clamp the camera centre so the AABB stays inside the (possibly larger)
    // viewport. On the binding axis the window equals the AABB and the centre
    // is pinned; on the other axis there's slack and the lerp is left alone.
    const halfW = this.frameCanvasW / (2 * this.zoom);
    const halfH = this.frameCanvasH / (2 * this.zoom);
    const cx = (this.frameMinX + this.frameMaxX) / 2;
    const cy = (this.frameMinY + this.frameMaxY) / 2;

    if (halfW <= spanX / 2) {
      this.position.x = cx;
    } else {
      this.position.x = Math.min(Math.max(this.position.x, this.frameMaxX - halfW), this.frameMinX + halfW);
    }
    if (halfH <= spanY / 2) {
      this.position.y = cy;
    } else {
      this.position.y = Math.min(Math.max(this.position.y, this.frameMaxY - halfH), this.frameMinY + halfH);
    }
  }

  followTargets(
    targets: Vec2[],
    canvasWidth: number,
    canvasHeight: number,
    padding = 200,
    maxZoom = 0.592,
    // Zoom-out floor. This is the real ceiling on map size: when targets spread
    // wider than the canvas can show at this zoom, the camera clamps here and
    // anyone past the edge gets clipped. Lowered from 0.254 to 0.212 (÷1.2) so
    // the camera can zoom out ~20% further → ~20% larger maps stay in frame.
    minZoom = 0.212,
  ): void {
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
    this.targetZoom = Math.min(zoomX, zoomY, maxZoom);
    this.targetZoom = Math.max(this.targetZoom, minZoom);

    this.setFrame(minX - padding, maxX + padding, minY - padding, maxY + padding,
      canvasWidth, canvasHeight, maxZoom, minZoom);
  }

  /**
   * The zoom that would show an entire world-space AABB (with padding) — NOT
   * clamped, so callers can decide whether a map is "small enough" to sit and
   * watch as a whole (e.g. KOTH) by comparing it against a threshold.
   */
  static boundsFitZoom(
    minX: number, minY: number, maxX: number, maxY: number,
    canvasWidth: number, canvasHeight: number,
    padding = 200,
  ): number {
    const spanX = (maxX - minX) + padding * 2;
    const spanY = (maxY - minY) + padding * 2;
    return Math.min(canvasWidth / spanX, canvasHeight / spanY);
  }

  /**
   * Frame an entire world-space AABB statically — the camera sits centred on
   * the arena and fits the whole thing. Ideal for small modes like King of the
   * Hill, and for the establishing shot before a round begins.
   */
  watchBounds(
    minX: number, minY: number, maxX: number, maxY: number,
    canvasWidth: number, canvasHeight: number,
    padding = 200,
    maxZoom = 0.592,
  ): void {
    this.targetPosition = vec2((minX + maxX) / 2, (minY + maxY) / 2);
    this.targetZoom = Math.min(
      Camera.boundsFitZoom(minX, minY, maxX, maxY, canvasWidth, canvasHeight, padding), maxZoom);
    this.setFrame(minX - padding, maxX + padding, minY - padding, maxY + padding,
      canvasWidth, canvasHeight, maxZoom, 0);
  }

  /** Instantly frame a world-space AABB (no lerp) — the round-start wide shot. */
  snapToBounds(
    minX: number, minY: number, maxX: number, maxY: number,
    canvasWidth: number, canvasHeight: number,
    padding = 200,
    maxZoom = 0.592,
  ): void {
    const z = Math.min(
      Camera.boundsFitZoom(minX, minY, maxX, maxY, canvasWidth, canvasHeight, padding), maxZoom);
    this.snapTo(vec2((minX + maxX) / 2, (minY + maxY) / 2), z);
  }

  private setFrame(
    minX: number, maxX: number, minY: number, maxY: number,
    canvasWidth: number, canvasHeight: number, maxZoom: number, minZoom: number,
  ): void {
    this.frameMinX = minX;
    this.frameMaxX = maxX;
    this.frameMinY = minY;
    this.frameMaxY = maxY;
    this.frameCanvasW = canvasWidth;
    this.frameCanvasH = canvasHeight;
    this.frameMaxZoom = maxZoom;
    this.frameMinZoom = minZoom;
    this.hasFrame = true;
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
