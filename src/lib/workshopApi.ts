import { invoke } from '@tauri-apps/api/core';

export type WorkshopVisibility = 'public' | 'friends' | 'private';

export interface PublishMeta {
  title: string;
  description: string;
  tags: string[];
  visibility: WorkshopVisibility;
  /** Absolute path to a directory whose contents become the Workshop item payload. */
  contentDir: string;
  /** Absolute path to a PNG/JPG used as the preview/thumbnail. */
  previewPath?: string | null;
  changeNote?: string | null;
}

export interface PublishResult {
  workshopId: string;
  needsLegalAgreement: boolean;
}

interface RawPublishResult {
  workshop_id: number;
  needs_legal_agreement: boolean;
}

interface RawSubscribedItem {
  workshop_id: number;
  install_dir: string | null;
  size_bytes: number;
  installed: boolean;
}

export interface SubscribedItem {
  workshopId: string;
  installDir: string | null;
  sizeBytes: number;
  installed: boolean;
}

function toRustMeta(meta: PublishMeta) {
  return {
    title: meta.title,
    description: meta.description,
    tags: meta.tags,
    visibility: meta.visibility,
    content_dir: meta.contentDir,
    preview_path: meta.previewPath ?? null,
    change_note: meta.changeNote ?? null,
  };
}

export async function isSteamAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('steam_available');
  } catch {
    return false;
  }
}

export async function publishToWorkshop(meta: PublishMeta): Promise<PublishResult> {
  const raw = await invoke<RawPublishResult>('workshop_publish', { meta: toRustMeta(meta) });
  return { workshopId: String(raw.workshop_id), needsLegalAgreement: raw.needs_legal_agreement };
}

export async function updateWorkshopItem(
  workshopId: string,
  meta: PublishMeta,
): Promise<PublishResult> {
  const raw = await invoke<RawPublishResult>('workshop_update', {
    workshopId: Number(workshopId),
    meta: toRustMeta(meta),
  });
  return { workshopId: String(raw.workshop_id), needsLegalAgreement: raw.needs_legal_agreement };
}

export async function listSubscribedItems(): Promise<SubscribedItem[]> {
  const raw = await invoke<RawSubscribedItem[]>('workshop_list_subscribed');
  return raw.map((r) => ({
    workshopId: String(r.workshop_id),
    installDir: r.install_dir,
    sizeBytes: r.size_bytes,
    installed: r.installed,
  }));
}

export async function openWorkshopOverlay(workshopId: string): Promise<void> {
  await invoke('workshop_open_in_overlay', { workshopId: Number(workshopId) });
}

export async function openWorkshopBrowseOverlay(): Promise<void> {
  await invoke('workshop_browse_overlay');
}

/** Read the level.json out of a subscribed Workshop item's install dir.
 * Returns the raw JSON string — caller parses to LevelData. */
export async function readSubscribedLevelJson(workshopId: string): Promise<string> {
  return await invoke<string>('workshop_read_level', { workshopId: Number(workshopId) });
}

export async function subscribeToItem(workshopId: string): Promise<void> {
  await invoke('workshop_subscribe', { workshopId: Number(workshopId) });
}

export async function unsubscribeFromItem(workshopId: string): Promise<void> {
  await invoke('workshop_unsubscribe', { workshopId: Number(workshopId) });
}

interface RawItemDetail {
  workshop_id: number;
  title: string;
  description: string;
  owner_steam_id: number;
  preview_url: string | null;
  tags: string[];
  time_updated: number;
  num_upvotes: number;
  num_downvotes: number;
  file_size: number;
  installed: boolean;
  install_dir: string | null;
}

export interface WorkshopItemDetail {
  workshopId: string;
  title: string;
  description: string;
  ownerSteamId: string;
  previewUrl: string | null;
  tags: string[];
  /** Unix epoch seconds. */
  timeUpdated: number;
  numUpvotes: number;
  numDownvotes: number;
  fileSize: number;
  installed: boolean;
  installDir: string | null;
}

export async function getItemDetails(workshopIds: string[]): Promise<WorkshopItemDetail[]> {
  if (workshopIds.length === 0) return [];
  const raw = await invoke<RawItemDetail[]>('workshop_item_details', {
    workshopIds: workshopIds.map((id) => Number(id)),
  });
  return raw.map((r) => ({
    workshopId: String(r.workshop_id),
    title: r.title,
    description: r.description,
    ownerSteamId: String(r.owner_steam_id),
    previewUrl: r.preview_url,
    tags: r.tags,
    timeUpdated: r.time_updated,
    numUpvotes: r.num_upvotes,
    numDownvotes: r.num_downvotes,
    fileSize: r.file_size,
    installed: r.installed,
    installDir: r.install_dir,
  }));
}
