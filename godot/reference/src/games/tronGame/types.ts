// Tron Game Types

// Game phases
export type GamePhase = 'countdown' | 'playing' | 'round_end' | 'game_over';

// Direction enum for grid-based movement
export type Direction = 'up' | 'down' | 'left' | 'right';

// Position interface
export interface Position {
  x: number;
  y: number;
}

// Grid map definition
export interface TronMapDefinition {
  id: string;
  name: string;
  description: string;
  gridWidth: number;  // Number of cells wide
  gridHeight: number; // Number of cells tall
  cellSize: number;   // Pixel size of each cell
  theme: MapTheme;
}

// Map theme
export interface MapTheme {
  backgroundColor: number;
  gridLineColor: number;
  wallColor: number;
  name: string;
}

// Trail segment - represents one cell the player has passed through
export interface TrailSegment {
  x: number; // Grid x
  y: number; // Grid y
}

// Player state in Phaser
export interface TronPlayerState {
  playerId: string;
  name: string;
  color: number;
  gridX: number;      // Current grid X position
  gridY: number;      // Current grid Y position
  direction: Direction;
  trail: TrailSegment[];
  isAlive: boolean;
  isGhost: boolean;      // Ghost mode active (can pass through trails)
  ghostEndTime: number;  // When ghost mode ends
  ghostCooldownEnd: number; // When ghost ability can be used again
  placement: number;     // Finishing position (0 = winner, higher = eliminated earlier)
}

// Game state for Tron
export interface TronGameState {
  phase: GamePhase;
  currentMap: TronMapDefinition | null;
  players: Map<string, TronPlayerState>;
  winnerId: string | null;
  countdownTimer: number;
  roundNumber: number;
}

// Events emitted from Phaser to React
export interface TronGameEvents {
  onPlayerEliminated: (playerId: string, placement: number) => void;
  onPhaseChange: (phase: GamePhase) => void;
  onGameOver: (winnerId: string | null) => void;
}

// Input state from controller
export interface PlayerInputState {
  movement: Position;     // Left joystick (x, y normalized)
  ghostButton: boolean;   // Right button pressed
}

// Game configuration constants
export const MAX_PLAYERS = 16;

// Player constants
export const PLAYER_SIZE = 0.8;           // Percentage of cell size
export const PLAYER_SPEED = 8;           // Cells per second (movement tick rate)
export const INITIAL_SPEED = 6;          // Starting speed (ramps up)
export const MAX_SPEED = 12;             // Maximum speed

// Ghost mode constants
export const GHOST_DURATION = 500;       // 0.5 seconds
export const GHOST_COOLDOWN = 2000;      // 2 seconds

// Timing constants
export const COUNTDOWN_DURATION = 3000;  // 3 seconds countdown
export const ROUND_END_DELAY = 3000;     // 3 seconds after game ends
export const MOVEMENT_TICK = 1000 / PLAYER_SPEED; // Milliseconds per movement tick

// Grid constants
export const DEFAULT_CELL_SIZE = 20;
export const GRID_PADDING = 40; // Pixels of padding around the grid
