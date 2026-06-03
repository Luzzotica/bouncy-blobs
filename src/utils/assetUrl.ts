// Resolve a public-folder path against Vite's base URL.
// `/sprites/foo.png` → `/sprites/foo.png` in dev, `./sprites/foo.png` on itch (base='./').
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return base + path.replace(/^\//, '');
}
