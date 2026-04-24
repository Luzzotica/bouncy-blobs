// Sumo Arena Game Types

export type GamePhase = 'map_vote' | 'countdown' | 'playing' | 'round_end' | 'game_over';

export type MapCategory = 'shrinking' | 'hazard' | 'ice' | 'special';

export type ArenaShape = 'circle' | 'hexagon' | 'square' | 'donut';

export type HazardType = 'spike' | 'saw' | 'laser' | 'meteor' | 'pit';

export type HazardBehavior = 'static' | 'rotating' | 'patrolling' | 'timed';

export type HazardDamage = 'instant_kill' | 'knockback' | 'slow';

export type ZoneType = 'ice' | 'bounce' | 'conveyor' | 'portal' | 'gravity';

export type PowerupType = 'speed' | 'mass' | 'dash_refresh' | 'shield' | 'slippery';

export type EnemyType = 'chaser' | 'bumper' | 'slime';

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  x: number;
  y: number;
}

// Arena configuration
export interface ArenaConfig {
  shape: ArenaShape;
  initialRadius: number;
  minRadius: number;
  shrinkInterval: number;  // ms between shrinks
  shrinkAmount: number;    // pixels per shrink
  friction: number;        // 0.0 - 1.0
}

// Hazard definition
export interface HazardDefinition {
  id: string;
  type: HazardType;
  position: Position | 'random' | 'pattern';
  behavior: HazardBehavior;
  warningTime: number;  // ms before hazard activates
  damage: HazardDamage;
  // For patrolling/rotating hazards
  path?: Position[];
  speed?: number;
}

// Zone definition
export interface ZoneDefinition {
  id: string;
  type: ZoneType;
  shape: 'circle' | 'rectangle';
  position: Position;
  radius?: number;
  width?: number;
  height?: number;
  strength?: number;  // effect intensity
  direction?: number; // for conveyor (angle in radians)
  linkedPortalId?: string; // for portal zones
}

// Visual theme
export interface MapTheme {
  floorColor: number;
  edgeColor: number;
  backgroundColor: number;
  particleColor: number;
  name: string;
}

// Complete map definition
export interface MapDefinition {
  id: string;
  name: string;
  description: string;
  category: MapCategory;
  difficulty: 1 | 2 | 3;
  arena: ArenaConfig;
  hazards?: HazardDefinition[];
  zones?: ZoneDefinition[];
  theme: MapTheme;
}

// Powerup configuration
export interface PowerupConfig {
  type: PowerupType;
  duration: number;  // ms, 0 for instant
  effectValue: number;
}

// Player state in Phaser
export interface SumoPlayerState {
  playerId: string;
  lives: number;
  position: Position;
  velocity: Velocity;
  mass: number;
  friction: number;
  speed: number;
  isDashing: boolean;
  dashCooldown: number;
  isInvulnerable: boolean;
  invulnerabilityTimer: number;
  activePowerups: Map<PowerupType, number>; // type -> expiration time
  hasShield: boolean;
  isEliminated: boolean;
  color: number;
  name: string;
}

// Enemy state
export interface EnemyState {
  id: string;
  type: EnemyType;
  position: Position;
  velocity: Velocity;
  mass: number;
  speed: number;
  targetPlayerId?: string;
  lastDashTime: number;
  health?: number;
}

// Game state for Sumo Arena
export interface SumoGameState {
  phase: GamePhase;
  currentMap: MapDefinition | null;
  selectedMapId: string | null;
  mapVotes: Map<string, string>; // playerId -> mapId
  roundNumber: number;
  arenaRadius: number;
  lastShrinkTime: number;
  shrinkWarning: boolean;
  players: Map<string, SumoPlayerState>;
  enemies: EnemyState[];
  powerups: PowerupInstance[];
  countdownTimer: number;
  winnerId: string | null;
}

// Runtime powerup instance
export interface PowerupInstance {
  id: string;
  type: PowerupType;
  position: Position;
  spawnTime: number;
}

// Events emitted from Phaser to React
export interface SumoGameEvents {
  onPlayerEliminated: (playerId: string, remainingLives: number) => void;
  onRoundEnd: (winnerId: string | null) => void;
  onGameOver: (winnerId: string) => void;
  onPhaseChange: (phase: GamePhase) => void;
  onArenaShink: (newRadius: number) => void;
  onPowerupCollected: (playerId: string, type: PowerupType) => void;
}

// Input state from controller
export interface PlayerInputState {
  joystick: Position;
  dashPressed: boolean;
}

// Constants
export const PLAYER_BASE_MASS = 1;
export const PLAYER_BASE_SPEED = 5;
export const PLAYER_BASE_FRICTION = 0.8;
export const DASH_FORCE = 15;
export const DASH_COOLDOWN = 1500; // ms
export const INVULNERABILITY_TIME = 2000; // ms after respawn
export const STARTING_LIVES = 3;
export const POWERUP_SPAWN_INTERVAL = 15000; // ms
export const COUNTDOWN_DURATION = 3000; // ms
export const MAP_VOTE_DURATION = 10000; // ms
export const ROUND_END_DELAY = 3000; // ms

