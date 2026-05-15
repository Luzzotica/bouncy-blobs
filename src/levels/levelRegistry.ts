import type { LevelData, LevelType } from './types';

export interface LevelManifestEntry {
  id: string;
  name: string;
  file: string;
  levelTypes?: LevelType[];
}

interface Manifest {
  levels: LevelManifestEntry[];
}

let manifestCache: LevelManifestEntry[] | null = null;
const levelCache = new Map<string, LevelData>();

/** Fetch the level manifest (cached after first call). */
export async function getAvailableLevels(): Promise<LevelManifestEntry[]> {
  if (manifestCache) return manifestCache;
  const res = await fetch('/levels/manifest.json');
  if (!res.ok) throw new Error('Failed to load level manifest');
  const data: Manifest = await res.json();
  manifestCache = data.levels;
  return manifestCache;
}

/** Load a built-in level by its manifest id (cached after first load). */
export async function loadBuiltinLevel(id: string): Promise<LevelData> {
  const cached = levelCache.get(id);
  if (cached) return JSON.parse(JSON.stringify(cached));

  const manifest = await getAvailableLevels();
  const entry = manifest.find(e => e.id === id);
  if (!entry) throw new Error(`Unknown built-in level: ${id}`);

  const res = await fetch(`/levels/${entry.file}`);
  if (!res.ok) throw new Error(`Failed to load level: ${entry.file}`);
  const levelData: LevelData = await res.json();
  levelCache.set(id, levelData);
  // Return a copy so callers can mutate without affecting cache
  return JSON.parse(JSON.stringify(levelData));
}
