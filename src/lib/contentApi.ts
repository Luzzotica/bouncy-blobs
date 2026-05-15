import type { Session } from '@supabase/supabase-js';
import type { LevelData } from '../levels/types';

const BASE = import.meta.env.VITE_CONTENT_API_URL ?? 'http://localhost:3000';
const GAME_ID = 'bouncy-blobs';

export interface ContentItem {
  id: string;
  gameId: string;
  contentType: string;
  creatorId: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

function authHeaders(session: Session): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export async function listLevels(session: Session): Promise<ContentItem[]> {
  const res = await fetch(`${BASE}/api/content?game_id=${GAME_ID}`, {
    headers: authHeaders(session),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to list levels');
  const data = await res.json();
  return data.items;
}

export async function listPublicLevels(): Promise<ContentItem[]> {
  const res = await fetch(`${BASE}/api/content?game_id=${GAME_ID}&public=true`);
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to list public levels');
  const data = await res.json();
  return data.items;
}

export async function saveLevel(
  session: Session,
  name: string,
  description: string,
  levelJson: LevelData,
): Promise<{ id: string }> {
  const res = await fetch(`${BASE}/api/content`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({
      game_id: GAME_ID,
      content_type: 'level',
      name,
      description: description || undefined,
      contentJson: levelJson,
    }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to save level');
  return res.json();
}

export async function updateLevel(
  session: Session,
  id: string,
  updates: { name?: string; description?: string; contentJson?: LevelData },
): Promise<void> {
  const res = await fetch(`${BASE}/api/content/${id}`, {
    method: 'PATCH',
    headers: authHeaders(session),
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update level');
}

export async function loadLevel(id: string, session?: Session): Promise<LevelData> {
  const headers: Record<string, string> = {};
  if (session) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`${BASE}/api/content/${id}`, { headers });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to load level');
  return res.json();
}

export async function deleteLevel(session: Session, id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/content/${id}`, {
    method: 'DELETE',
    headers: authHeaders(session),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to delete level');
}

export async function publishLevel(
  session: Session,
  id: string,
  isPublic: boolean,
): Promise<void> {
  const res = await fetch(`${BASE}/api/content/${id}/publish`, {
    method: 'POST',
    headers: authHeaders(session),
    body: JSON.stringify({ is_public: isPublic }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update publish status');
}
