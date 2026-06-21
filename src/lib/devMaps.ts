import type { LevelData, LevelType } from '../levels/types';
import type { LevelManifestEntry } from '../levels/levelRegistry';

/**
 * Client side of the dev-only maps pipeline. These talk to the Vite middleware
 * in `vite/devMapsPlugin.ts`, which reads/writes the repo's `public/levels/`.
 * `DEV_MAPS` is true only under `vite dev` — in production builds the endpoints
 * don't exist and all of this UI stays hidden.
 */
export const DEV_MAPS: boolean = import.meta.env.DEV;

export interface PublishToGameArgs {
  /** Slug used for both the manifest id and the `<id>.json` filename. */
  id: string;
  name: string;
  levelTypes: LevelType[];
  hidden?: boolean;
  level: LevelData;
}

/** Slugify a display name into a safe manifest id / filename. */
export function slugifyMapId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled';
}

/** Write a map into the repo so it ships with the game. Dev-only. */
export async function publishMapToGame(args: PublishToGameArgs): Promise<{ id: string; file: string }> {
  const res = await fetch('/__dev/levels/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(msg || `Publish failed (${res.status})`);
  }
  return res.json();
}

/** Toggle a shipped map's `hidden` flag in the manifest (no file rewrite). Dev-only.
 *  Hidden maps stay loadable by id but don't appear in hosting/level-picker flows. */
export async function setMapHidden(id: string, hidden: boolean): Promise<void> {
  const res = await fetch('/__dev/levels/sethidden', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, hidden }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => res.statusText)) || `Update failed (${res.status})`);
}

/** Remove a shipped map (file + manifest entry). Dev-only. */
export async function deleteGameMap(id: string): Promise<void> {
  const res = await fetch('/__dev/levels/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => res.statusText)) || `Delete failed (${res.status})`);
}

/** Shape of a single-player campaign written to public/campaigns/<id>.json. */
export interface CampaignSaveArgs {
  id: string;
  name: string;
  levels: { id: string; name?: string }[];
}

/** Read the Play campaign straight off disk via the dev server. Dev-only. */
export async function fetchDevCampaign(id = 'play'): Promise<CampaignSaveArgs> {
  const res = await fetch(`/__dev/campaigns/${id}`);
  if (!res.ok) throw new Error(`Failed to read campaign (${res.status})`);
  return res.json();
}

/** Persist the campaign (level list + order) into the repo. Dev-only. */
export async function saveDevCampaign(args: CampaignSaveArgs): Promise<void> {
  const res = await fetch('/__dev/campaigns/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => res.statusText)) || `Save failed (${res.status})`);
}

/** Read the live manifest straight off disk via the dev server. Dev-only. */
export async function fetchDevManifest(): Promise<LevelManifestEntry[]> {
  const res = await fetch('/__dev/levels/manifest');
  if (!res.ok) throw new Error(`Failed to read manifest (${res.status})`);
  const data = await res.json();
  return data.levels ?? [];
}
