// Grid Shooter Game Types

// Game modes
export type GameMode = 'free_for_all' | 'team_deathmatch' | 'capture_the_flag';

// Game phases
export type GamePhase = 'mode_select' | 'map_vote' | 'countdown' | 'playing' | 'round_end' | 'game_over';

// Team types
export type Team = 'red' | 'blue' | 'none';

// Grid cell types
export const CELL_EMPTY = 0;
export const CELL_WALL = 1;
// 2+ are portal types (each number is a different portal destination)

// Position interface
export interface Position {
  x: number;
  y: number;
}

// Velocity interface
export interface Velocity {
  x: number;
  y: number;
}

// Portal definition
export interface PortalDefinition {
  id: number;          // Portal type (2, 3, 4, etc.)
  color: number;       // Visual color
  name: string;        // Display name
  linkedPortalId?: number; // If set, teleports to this portal type
}

// Grid map definition
export interface GridMapDefinition {
  id: string;
  name: string;
  description: string;
  grid: number[][];    // 2D array: 0=empty, 1=wall, 2+=portal types
  cellSize: number;    // Pixel size of each cell
  spawnPoints: {
    ffa: Position[];           // Free for all spawn points (grid coords)
    red: Position[];           // Red team spawn points
    blue: Position[];          // Blue team spawn points
  };
  flagPositions?: {
    red: Position;             // Red team flag position (grid coords)
    blue: Position;            // Blue team flag position (grid coords)
  };
  portals?: PortalDefinition[];
  theme: MapTheme;
}

// Map theme
export interface MapTheme {
  floorColor: number;
  wallColor: number;
  backgroundColor: number;
  gridLineColor: number;
  name: string;
}

// Player state in Phaser
export interface GridShooterPlayerState {
  playerId: string;
  name: string;
  color: number;
  team: Team;
  position: Position;
  velocity: Velocity;
  kills: number;
  deaths: number;
  isAlive: boolean;
  respawnTimer: number;        // Time until respawn (ms)
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
  aimAngle: number;            // Current aiming angle (radians)
  lastFireTime: number;        // Last time bullet was fired
  flagCarrying: Team | null;   // For CTF: which flag the player is carrying
}

// Bullet state
export interface BulletState {
  id: string;
  ownerId: string;
  ownerTeam: Team;
  position: Position;
  velocity: Velocity;
  damage: number;
  createdAt: number;
  lifetime: number;            // Max lifetime in ms
}

// Flag state (for CTF)
export interface FlagState {
  team: Team;
  position: Position;          // Current position
  spawnPosition: Position;     // Original spawn position
  carrierId: string | null;    // Player carrying the flag
  isAtBase: boolean;
  returnTimer: number;         // Time until auto-return (when dropped)
}

// Game state for Grid Shooter
export interface GridShooterGameState {
  phase: GamePhase;
  gameMode: GameMode | null;
  currentMap: GridMapDefinition | null;
  selectedMapId: string | null;
  modeVotes: Map<string, GameMode>;     // playerId -> mode
  mapVotes: Map<string, string>;        // playerId -> mapId
  roundNumber: number;
  players: Map<string, GridShooterPlayerState>;
  bullets: BulletState[];
  flags: Map<Team, FlagState>;          // For CTF
  scores: {
    ffa: Map<string, number>;           // playerId -> kills
    red: number;
    blue: number;
  };
  countdownTimer: number;
  winnerId: string | null;              // For FFA
  winningTeam: Team | null;             // For TDM/CTF
}

// Events emitted from Phaser to React
export interface GridShooterGameEvents {
  onPlayerKilled: (killerId: string, victimId: string) => void;
  onPlayerRespawn: (playerId: string) => void;
  onFlagPickup: (playerId: string, flagTeam: Team) => void;
  onFlagCapture: (playerId: string, flagTeam: Team) => void;
  onFlagReturn: (flagTeam: Team) => void;
  onScoreUpdate: (scores: { ffa: Map<string, number>; red: number; blue: number }) => void;
  onPhaseChange: (phase: GamePhase) => void;
  onGameModeSelected: (mode: GameMode) => void;
  onGameOver: (winnerId: string | null, winningTeam: Team | null) => void;
}

// Input state from controller
export interface PlayerInputState {
  movement: Position;          // Left joystick (x, y normalized)
  aim: Position;               // Right joystick (x, y normalized)
}

// Game configuration constants
export const MAX_PLAYERS = 16;
export const FFA_WIN_SCORE = 25;
export const TDM_WIN_SCORE = 25;
export const CTF_WIN_SCORE = 3;

// Player constants
export const PLAYER_RADIUS = 12;           // Reduced by 20% from 15
export const PLAYER_SPEED = 1.125;         // Reduced by 25%
export const PLAYER_MASS = 1;

// Bullet constants
export const BULLET_RADIUS = 4;
export const BULLET_SPEED = 400;           // Pixels per second
export const BULLET_DAMAGE = 1;
export const BULLET_LIFETIME = 2000;       // ms
export const FIRE_RATE = 100;              // ms between shots (10 shots/second)

// Respawn constants
export const RESPAWN_DELAY = 3000;         // 3 seconds
export const INVULNERABILITY_TIME = 2000;  // 2 seconds after respawn

// Flag constants (CTF)
export const FLAG_RETURN_TIME = 10000;     // 10 seconds to auto-return
export const FLAG_PICKUP_RADIUS = 25;
export const FLAG_CAPTURE_RADIUS = 30;

// Timing constants
export const COUNTDOWN_DURATION = 3000;    // 3 seconds countdown
export const MODE_VOTE_DURATION = 15000;   // 15 seconds for mode voting
export const MAP_VOTE_DURATION = 10000;    // 10 seconds for map voting
export const ROUND_END_DELAY = 5000;       // 5 seconds after game ends

// Grid constants
export const DEFAULT_CELL_SIZE = 32;

