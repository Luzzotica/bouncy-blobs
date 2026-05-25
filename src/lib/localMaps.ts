import { invoke } from '@tauri-apps/api/core';
import type { LevelData } from '../levels/types';

export interface LocalMap {
  id: string;
  path: string;
  name: string;
  workshopId?: string | null;
  updatedAtMs: number;
}

interface RawLocalMap {
  id: string;
  path: string;
  name: string;
  workshop_id: string | null;
  updated_at_ms: number;
}

interface RawMapFile {
  workshop_id: string | null;
  updated_at_ms: number;
  level: LevelData;
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

function fromRaw(m: RawLocalMap): LocalMap {
  return {
    id: m.id,
    path: m.path,
    name: m.name,
    workshopId: m.workshop_id,
    updatedAtMs: m.updated_at_ms,
  };
}

export async function listLocalMaps(): Promise<LocalMap[]> {
  const raw = await invoke<RawLocalMap[]>('maps_list');
  return raw.map(fromRaw);
}

export async function readLocalMap(id: string): Promise<MapFile> {
  const raw = await invoke<RawMapFile>('maps_read', { id });
  return {
    workshopId: raw.workshop_id,
    updatedAtMs: raw.updated_at_ms,
    level: raw.level,
  };
}

export async function writeLocalMap(args: {
  id?: string;
  workshopId?: string | null;
  level: LevelData;
}): Promise<WriteResult> {
  const raw = await invoke<{ id: string; path: string; updated_at_ms: number }>('maps_write', {
    args: {
      id: args.id ?? null,
      workshop_id: args.workshopId ?? null,
      level: args.level,
    },
  });
  return { id: raw.id, path: raw.path, updatedAtMs: raw.updated_at_ms };
}

export async function deleteLocalMap(id: string): Promise<void> {
  await invoke('maps_delete', { id });
}

export async function exportLocalMap(id: string, dest: string): Promise<void> {
  await invoke('maps_export', { id, dest });
}

export async function importLocalMap(src: string): Promise<WriteResult> {
  const raw = await invoke<{ id: string; path: string; updated_at_ms: number }>('maps_import', {
    src,
  });
  return { id: raw.id, path: raw.path, updatedAtMs: raw.updated_at_ms };
}

/** Stages the map's content into a per-map directory and returns its path,
 * suitable for the Steam UGC content_path. */
export async function stagingDirForMap(id: string): Promise<string> {
  return await invoke<string>('maps_staging_dir', { id });
}
