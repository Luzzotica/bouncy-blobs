export interface User {
  id: string;
  name: string;
  created_at: string;
  is_online: boolean;
}

export interface Player {
  player_id: string;
  session_id: string;
  name: string;
  slot: number;
  status: string;
  controller_config: Record<string, any> | null;
  joined_at: string;
  /** Player-chosen color (hex string like #ff44aa). */
  color?: string;
  /** Player-chosen face preset id. */
  faceId?: string;
}
