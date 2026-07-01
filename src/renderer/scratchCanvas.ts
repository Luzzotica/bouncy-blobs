// A 2D scratch canvas that works on the main thread (DOM <canvas>) AND inside a
// Web Worker (OffscreenCanvas) — so the full renderer can run in a worker drawing
// to a transferred OffscreenCanvas. The returned `image` is a valid
// CanvasImageSource (createPattern / drawImage source) in both environments.

export interface ScratchCanvas {
  image: CanvasImageSource;
  ctx: CanvasRenderingContext2D;
  resize(w: number, h: number): void;
}

export function makeScratchCanvas(w: number, h: number): ScratchCanvas | null {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    return { image: c, ctx, resize: (nw, nh) => { if (c.width !== nw || c.height !== nh) { c.width = nw; c.height = nh; } } };
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    return { image: c as unknown as CanvasImageSource, ctx, resize: (nw, nh) => { if (c.width !== nw || c.height !== nh) { c.width = nw; c.height = nh; } } };
  }
  return null;
}
