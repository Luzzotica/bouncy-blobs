import { invoke } from '@tauri-apps/api/core';
import type { LevelData } from '../levels/types';
import { isTauri } from './runtime';
import * as tauriMaps from './localMaps';

export interface LocalMap {
  id: string;
  /** Filesystem path (Tauri only). Empty string in web mode. */
  path: string;
  name: string;
  workshopId?: string | null;
  updatedAtMs: number;
}

export interface MapFile {
  workshopId: string | null;
  updatedAtMs: number;
  level: LevelData;
}

export interface WriteResult {
  id: string;
  path: string;
  updatedAtMs: number;
}

// ---------- Web (localStorage) backend ----------

const INDEX_KEY = 'bb:maps:index';
const MAP_KEY = (id: string) => `bb:map:${id}`;

interface WebIndexEntry {
  id: string;
  name: string;
  workshopId: string | null;
  updatedAtMs: number;
}

function readIndex(): WebIndexEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch { return []; }
}

function writeIndex(entries: WebIndexEntry[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
}

function genWebId(): string {
  // Short random id — collision risk is negligible for hand-authored levels.
  return 'm_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

const webBackend = {
  async list(): Promise<LocalMap[]> {
    return readIndex()
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map(e => ({ id: e.id, path: '', name: e.name, workshopId: e.workshopId, updatedAtMs: e.updatedAtMs }));
  },
  async read(id: string): Promise<MapFile> {
    const raw = localStorage.getItem(MAP_KEY(id));
    if (!raw) throw new Error(`Map not found: ${id}`);
    const mf = JSON.parse(raw) as MapFile;
    return mf;
  },
  async write(args: { id?: string; workshopId?: string | null; level: LevelData }): Promise<WriteResult> {
    const id = args.id ?? genWebId();
    const now = Date.now();
    const mf: MapFile = {
      workshopId: args.workshopId ?? null,
      updatedAtMs: now,
      level: args.level,
    };
    localStorage.setItem(MAP_KEY(id), JSON.stringify(mf));
    const idx = readIndex().filter(e => e.id !== id);
    idx.push({ id, name: args.level.name ?? 'Untitled', workshopId: mf.workshopId, updatedAtMs: now });
    writeIndex(idx);
    return { id, path: '', updatedAtMs: now };
  },
  async delete(id: string): Promise<void> {
    localStorage.removeItem(MAP_KEY(id));
    writeIndex(readIndex().filter(e => e.id !== id));
  },
};

// ---------- Tauri backend ----------

const tauriBackend = {
  list: tauriMaps.listLocalMaps,
  read: tauriMaps.readLocalMap,
  write: tauriMaps.writeLocalMap,
  delete: tauriMaps.deleteLocalMap,
};

const backend = isTauri() ? tauriBackend : webBackend;

export async function listLocalMaps(): Promise<LocalMap[]> { return backend.list(); }
export async function readLocalMap(id: string): Promise<MapFile> { return backend.read(id); }
export async function writeLocalMap(args: { id?: string; workshopId?: string | null; level: LevelData }): Promise<WriteResult> {
  return backend.write(args);
}
export async function deleteLocalMap(id: string): Promise<void> { return backend.delete(id); }

/** Tauri-only: open the OS file manager pointing at this map's file. No-op in web. */
export async function revealMapInFiles(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('maps_reveal', { id });
}

export function canRevealInFiles(): boolean { return isTauri(); }

/** Tauri-only download/export prompt. Web mode triggers a browser download. */
export async function downloadMapJson(map: LocalMap, level: LevelData): Promise<void> {
  if (isTauri()) {
    // Tauri callers handle this via the existing maps_export flow with a save dialog.
    return;
  }
  const blob = new Blob([JSON.stringify(level, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${map.name || 'level'}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
