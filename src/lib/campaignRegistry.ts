import { assetUrl } from '../utils/assetUrl';

/**
 * The single-player "Play" campaign: an ordered list of builtin level ids.
 * Adding a level later is a one-line edit to `public/campaigns/play.json`
 * (or via the dev-mode Campaign editor in the level designer). Each `id`
 * resolves to a shipped level through `loadBuiltinLevel(id)`.
 */
export interface CampaignLevelEntry {
  id: string;
  /** Optional display label; the hub falls back to the manifest name. */
  name?: string;
}

export interface Campaign {
  id: string;
  name: string;
  levels: CampaignLevelEntry[];
}

let cache: Campaign | null = null;

/** Fetch the Play campaign definition (cached after first call). */
export async function loadPlayCampaign(): Promise<Campaign> {
  if (cache) return cache;
  const res = await fetch(assetUrl('/campaigns/play.json'));
  if (!res.ok) throw new Error('Failed to load Play campaign');
  cache = (await res.json()) as Campaign;
  return cache;
}

/** Drop the cached campaign so the next load re-reads from disk. Used by the
 *  dev "save campaign" flow after rewriting `public/campaigns/play.json`. */
export function invalidateCampaignCache(): void {
  cache = null;
}
