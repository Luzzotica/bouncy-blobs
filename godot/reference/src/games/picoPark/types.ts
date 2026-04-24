// Pico Park Cooperative Platformer - Type Definitions

// Game phases
export type GamePhase = 'level_select' | 'countdown' | 'playing' | 'level_complete' | 'results';

// Difficulty levels
export type Difficulty = 'easy' | 'medium' | 'hard';

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

// Tile types for level grid
export const TILE_EMPTY = 0;
export const TILE_SOLID = 1;
export const TILE_PLATFORM = 2;  // One-way platform (can jump through from below)
export const TILE_HAZARD = 3;    // Resets level on touch
export const TILE_BOUNCY = 4;    // Bouncy surface
export const TILE_ICE = 5;       // Slippery surface

// Level theme
export interface LevelTheme {
  name: string;
  backgroundColor: number;
  groundColor: number;
  platformColor: number;
  hazardColor: number;
  accentColor: number;
}

// Moving platform definition
export interface MovingPlatformDef {
  id: string;
  startPos: Position;
  endPos: Position;
  width: number;
  speed: number;           // Pixels per second
  pauseTime?: number;      // Time to pause at endpoints (ms)
  triggeredBy?: string;    // Pressure plate ID that controls this
}

// Pressure plate definition
export interface PressurePlateDef {
  id: string;
  position: Position;
  width: number;
  requiredWeight: number;  // Number of players needed
  controls: string[];      // IDs of doors/platforms this controls
}

// Door definition
export interface DoorDef {
  id: string;
  position: Position;
  width: number;
  height: number;
  isOpen: boolean;         // Initial state
}

// Goal area definition
export interface GoalAreaDef {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Level definition
export interface PicoParkLevel {
  id: string;
  name: string;
  difficulty: Difficulty;
  requiredPlayers: number;   // Minimum players needed
  grid: number[][];          // Tile map
  cellSize: number;          // Pixel size of each cell
  coinPositions: Position[]; // Grid coordinates
  spawnPoints: Position[];   // Grid coordinates
  goalArea: GoalAreaDef;     // Grid coordinates
  movingPlatforms?: MovingPlatformDef[];
  pressurePlates?: PressurePlateDef[];
  doors?: DoorDef[];
  theme: LevelTheme;
}

// Player state in Phaser
export interface PicoParkPlayerState {
  playerId: string;
  name: string;
  color: number;
  position: Position;
  velocity: Velocity;
  isGrounded: boolean;
  isAtGoal: boolean;
  coinsCollected: number;
  stackedOnPlayer: string | null;  // ID of player this one is standing on
  playersOnTop: string[];          // IDs of players standing on this one
}

// Coin state
export interface CoinState {
  id: string;
  position: Position;
  isCollected: boolean;
  respawnTimer: number;      // Time until respawn (ms), -1 if doesn't respawn
  collectedBy: string | null; // Player ID who collected it
}

// Game state for Pico Park
export interface PicoParkGameState {
  phase: GamePhase;
  currentLevel: PicoParkLevel | null;
  selectedLevelId: string | null;
  levelStartTime: number;
  levelTime: number;           // Current elapsed time (ms)
  players: Map<string, PicoParkPlayerState>;
  coins: CoinState[];
  playersAtGoal: Set<string>;
  levelAttempts: number;       // Number of resets
  scores: Map<string, number>; // Player ID -> total coins
}

// Events emitted from Phaser to React
export interface PicoParkGameEvents {
  onCoinCollected: (playerId: string, coinId: string) => void;
  onPlayerReachedGoal: (playerId: string) => void;
  onPlayerLeftGoal: (playerId: string) => void;
  onLevelComplete: (time: number, scores: Map<string, number>) => void;
  onLevelReset: (reason: string) => void;
  onPhaseChange: (phase: GamePhase) => void;
  onLevelSelected: (levelId: string) => void;
}

// Input state from controller
export interface PlayerInputState {
  movement: Position;     // Left joystick (x, y normalized), only x is used
  jump: boolean;          // Right button or joystick up
  jumpPressed: boolean;   // True only on the frame jump was pressed
}

// Game configuration constants
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

// Player constants
export const PLAYER_WIDTH = 24;
export const PLAYER_HEIGHT = 32;
export const PLAYER_SPEED = 4;             // Pixels per second (doubled from 2)
export const PLAYER_JUMP_FORCE = 0.048;    // Jump impulse (quadrupled from 0.012)
export const PLAYER_MASS = 1;
export const PLAYER_FRICTION = 0.1;
export const PLAYER_AIR_FRICTION = 0.02;

// Coin constants
export const COIN_RADIUS = 12;
export const COIN_RESPAWN_TIME = 3000;     // 3 seconds

// Physics constants
export const GRAVITY = 1;                   // Matter.js gravity
export const GROUND_SENSOR_HEIGHT = 4;      // Height of ground detection sensor

// Timing constants
export const COUNTDOWN_DURATION = 3000;     // 3 seconds countdown
export const LEVEL_COMPLETE_DELAY = 2000;   // 2 seconds before results

// Grid constants
export const DEFAULT_CELL_SIZE = 32;

// Player colors
export const PLAYER_COLORS = [
  0x3b82f6, // blue
  0xef4444, // red
  0x10b981, // green
  0xf59e0b, // amber
];

