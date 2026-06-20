import type { LevelData, LevelType } from './types';
import { getLevelTypes } from './types';
import { listLocalMaps, readLocalMap } from '../lib/mapsStore';
import { listSubscribedItems } from '../lib/workshopApi';
import { assetUrl } from '../utils/assetUrl';

export type LevelSource = 'builtin' | 'local' | 'workshop';

export interface LevelManifestEntry {
  id: string;
  name: string;
  file: string;
  levelTypes?: LevelType[];
  source?: LevelSource;
  /** If true, this level is dev/test scaffolding and must not appear in
   *  hosting flows. It is still loadable by id (editor, sandbox page). */
  hidden?: boolean;
}

interface Manifest {
  levels: LevelManifestEntry[];
}

let manifestCache: LevelManifestEntry[] | null = null;
const levelCache = new Map<string, LevelData>();

/** Fetch the built-in level manifest (cached after first call). */
export async function getBuiltinLevels(): Promise<LevelManifestEntry[]> {
  if (manifestCache) return manifestCache;
  const res = await fetch(assetUrl('/levels/manifest.json'));
  if (!res.ok) throw new Error('Failed to load level manifest');
  const data: Manifest = await res.json();
  manifestCache = data.levels.map(l => ({ ...l, source: 'builtin' as const }));
  return manifestCache;
}

/** Back-compat alias. */
export const getAvailableLevels = getBuiltinLevels;

/** Drop cached manifest + level data so the next fetch re-reads from disk.
 *  Used by the dev "Publish to Game" flow after writing a new/updated map. */
export function invalidateBuiltinCache(): void {
  manifestCache = null;
  levelCache.clear();
}

/** Load a built-in level by its manifest id (cached after first load). */
export async function loadBuiltinLevel(id: string): Promise<LevelData> {
  const cached = levelCache.get(id);
  if (cached) return JSON.parse(JSON.stringify(cached));

  const manifest = await getBuiltinLevels();
  const entry = manifest.find(e => e.id === id);
  if (!entry) throw new Error(`Unknown built-in level: ${id}`);

  const res = await fetch(assetUrl(`/levels/${entry.file}`));
  if (!res.ok) throw new Error(`Failed to load level: ${entry.file}`);
  const levelData: LevelData = await res.json();
  levelCache.set(id, levelData);
  return JSON.parse(JSON.stringify(levelData));
}

export interface MergedLevel {
  /** Stable identifier prefixed with source: "builtin:x", "local:<uuid>", "workshop:<workshopId>". */
  id: string;
  name: string;
  source: LevelSource;
  levelTypes: LevelType[];
  /** For local maps. */
  localId?: string;
  /** For workshop maps. */
  workshopId?: string;
  /** For workshop maps — file path inside the subscribed install dir. */
  workshopFile?: string;
}

/** Builtins + local-fs maps + subscribed Workshop maps, merged for browser views. */
export async function listAllLevels(): Promise<MergedLevel[]> {
  const out: MergedLevel[] = [];

  // Built-in (skip hidden = dev/test scaffolding).
  try {
    const builtins = await getBuiltinLevels();
    for (const b of builtins) {
      if (b.hidden) continue;
      out.push({
        id: `builtin:${b.id}`,
        name: b.name,
        source: 'builtin',
        levelTypes: b.levelTypes && b.levelTypes.length > 0 ? b.levelTypes : ['solo_racing'],
      });
    }
  } catch (err) {
    console.warn('manifest load failed', err);
  }

  // Local maps
  try {
    const locals = await listLocalMaps();
    for (const m of locals) {
      let levelTypes: LevelType[] = ['solo_racing'];
      try {
        const mf = await readLocalMap(m.id);
        levelTypes = getLevelTypes(mf.level);
      } catch (err) {
        console.warn(`Failed to read local map ${m.id} for mode detection:`, err);
      }
      out.push({
        id: `local:${m.id}`,
        name: m.name || 'Untitled',
        source: 'local',
        levelTypes,
        localId: m.id,
        workshopId: m.workshopId ?? undefined,
      });
    }
  } catch (err) {
    // Non-Tauri / no fs — silently skip.
  }

  // Workshop subscriptions
  try {
    const subs = await listSubscribedItems();
    for (const s of subs) {
      if (!s.installed || !s.installDir) continue;
      out.push({
        id: `workshop:${s.workshopId}`,
        name: `Workshop ${s.workshopId}`,
        source: 'workshop',
        levelTypes: ['solo_racing', 'team_racing', 'party', 'koth'],
        workshopId: s.workshopId,
        workshopFile: `${s.installDir}/level.json`,
      });
    }
  } catch {
    // Steam not available — fine.
  }

  return out;
}

/** Resolve a merged-id back to LevelData (works for any source). */
export async function loadLevelById(id: string): Promise<LevelData> {
  if (id.startsWith('builtin:')) return loadBuiltinLevel(id.slice('builtin:'.length));
  if (id.startsWith('local:')) {
    const mf = await readLocalMap(id.slice('local:'.length));
    return mf.level;
  }
  if (id.startsWith('workshop:')) {
    // The merged listAllLevels carries the file path; for direct callers we
    // re-query subscribed items to find it.
    const list = await listAllLevels();
    const hit = list.find(l => l.id === id);
    if (!hit || !hit.workshopFile) throw new Error(`Workshop item not installed: ${id}`);
    const res = await fetch(`file://${hit.workshopFile}`);
    if (!res.ok) throw new Error(`Failed to read workshop level: ${hit.workshopFile}`);
    return await res.json();
  }
  throw new Error(`Unknown level id: ${id}`);
}
