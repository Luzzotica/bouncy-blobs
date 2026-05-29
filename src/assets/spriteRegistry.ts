// Sprite + collision-shape registry. Loaded from /sprites/manifest.json at
// boot. Sprites are PNGs in /public/sprites/. Each sprite ships with its own
// hand-tuned collision shape so non-convex props (pencil, etc.) collide
// correctly — they're not boxes.
//
// Missing-sprite behavior: getSprite() returns null. Callers fall back to
// their existing primitive draw so the game keeps working during migration.

export type CollisionShape =
  | { kind: 'polygon'; points: [number, number][] }
  | {
      kind: 'pointShape';
      points: { x: number; y: number; mass?: number; pinned?: boolean }[];
      edges: { a: number; b: number; stiffness?: number }[];
    }
  | { kind: 'circle'; radius: number };

export type SpriteLayer = 'background' | 'prop' | 'foreground';

export interface SpriteDef {
  id: string;
  image: string;            // url, e.g. "/sprites/spring.png"
  pxPerWorldUnit: number;   // sprite px per world unit; world = image_px / this
  anchor: { x: number; y: number }; // normalized [0..1] within image bounds
  shape: CollisionShape;
  layer?: SpriteLayer;
}

interface SpriteManifest {
  sprites: SpriteDef[];
}

export interface LoadedSprite {
  def: SpriteDef;
  image: HTMLImageElement;
}

const cache = new Map<string, LoadedSprite>();
let readyPromise: Promise<void> | null = null;

export function preloadSprites(manifestUrl = '/sprites/manifest.json'): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    let manifest: SpriteManifest;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) {
        console.warn('[sprites] manifest fetch failed', res.status);
        return;
      }
      manifest = await res.json();
    } catch (err) {
      console.warn('[sprites] manifest load error', err);
      return;
    }

    await Promise.all(
      (manifest.sprites ?? []).map(
        (def) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              cache.set(def.id, { def, image: img });
              resolve();
            };
            img.onerror = () => {
              console.warn(`[sprites] failed to load ${def.id} from ${def.image}`);
              resolve();
            };
            img.src = def.image;
          }),
      ),
    );
  })();
  return readyPromise;
}

export function getSprite(id: string): LoadedSprite | null {
  return cache.get(id) ?? null;
}

export function hasSprite(id: string): boolean {
  return cache.has(id);
}

/** Every sprite the registry has fully loaded, in manifest order. Used by
 * the editor's sprite picker. Returns a fresh array each call (caller may
 * sort/filter freely). */
export function allSprites(): LoadedSprite[] {
  return Array.from(cache.values());
}

/** Sprite footprint in world units (image dimensions divided by ppwu). */
export function getSpriteWorldSize(sprite: LoadedSprite): { width: number; height: number } {
  return {
    width: sprite.image.width / sprite.def.pxPerWorldUnit,
    height: sprite.image.height / sprite.def.pxPerWorldUnit,
  };
}
