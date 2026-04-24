// TypeScript types for Supabase database tables

export interface User {
  id: string; // UUID from auth.users
  name: string;
  created_at: string;
  is_online: boolean;
}

export interface GameSession {
  session_id: number; // BIGSERIAL
  game_id: string;
  name: string;
  master_user_id: string | null; // UUID, can be null for anonymous
  master_anonymous_id: string | null; // For anonymous session creators
  default_controller_config: Record<string, any>; // JSONB
  is_active: boolean;
  created_at: string;
}

export interface Player {
  player_id: number; // BIGSERIAL
  user_id: string | null; // UUID, null for anonymous
  anonymous_id: string | null; // Generated UUID for anonymous players
  session_id: number;
  name: string;
  controller_config: Record<string, any> | null; // JSONB
  is_display: boolean;
  joined_at: string;
}

// Note: PlayerInput table removed - using Realtime Broadcast instead

// Metrics tracking
export interface GameMetrics {
  id: number;
  metric_name: string;
  metric_value: number;
  last_updated: string;
}

export interface GameDailyStats {
  id: number;
  stat_date: string;
  game_id: string;
  sessions_created: number;
  sessions_completed: number;
  total_players: number;
  total_playtime_minutes: number;
}

// Database helper types
export type Database = {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Omit<User, 'created_at' | 'is_online'>;
        Update: Partial<Omit<User, 'id'>>;
      };
      game_sessions: {
        Row: GameSession;
        Insert: Omit<GameSession, 'session_id' | 'created_at'>;
        Update: Partial<Omit<GameSession, 'session_id'>>;
      };
      players: {
        Row: Player;
        Insert: Omit<Player, 'player_id' | 'joined_at'>;
        Update: Partial<Omit<Player, 'player_id'>>;
      };
      game_metrics: {
        Row: GameMetrics;
        Insert: Omit<GameMetrics, 'id' | 'last_updated'>;
        Update: Partial<Omit<GameMetrics, 'id'>>;
      };
      game_daily_stats: {
        Row: GameDailyStats;
        Insert: Omit<GameDailyStats, 'id'>;
        Update: Partial<Omit<GameDailyStats, 'id'>>;
      };
    };
  };
};

