// Tron Game Map Definitions

import { TronMapDefinition, MapTheme } from '../types';

// Theme definitions
const THEMES: Record<string, MapTheme> = {
  classic: {
    backgroundColor: 0x000000,
    gridLineColor: 0x003366,
    wallColor: 0x0066cc,
    name: 'Classic',
  },
  neon: {
    backgroundColor: 0x0a0a1a,
    gridLineColor: 0x2d2d5a,
    wallColor: 0x6c5ce7,
    name: 'Neon',
  },
  cyber: {
    backgroundColor: 0x0f0f0f,
    gridLineColor: 0x1a3a1a,
    wallColor: 0x00ff88,
    name: 'Cyber',
  },
  sunset: {
    backgroundColor: 0x1a0a0a,
    gridLineColor: 0x3a1a1a,
    wallColor: 0xff6600,
    name: 'Sunset',
  },
};

// Map: Standard Arena
const STANDARD_ARENA: TronMapDefinition = {
  id: 'standard',
  name: 'Standard Arena',
  description: 'Classic rectangular arena',
  gridWidth: 60,
  gridHeight: 40,
  cellSize: 16,
  theme: THEMES.classic,
};

// Map: Small Arena (faster games)
const SMALL_ARENA: TronMapDefinition = {
  id: 'small',
  name: 'Small Arena',
  description: 'Compact arena for quick matches',
  gridWidth: 40,
  gridHeight: 30,
  cellSize: 20,
  theme: THEMES.neon,
};

// Map: Large Arena
const LARGE_ARENA: TronMapDefinition = {
  id: 'large',
  name: 'Large Arena',
  description: 'Expansive battlefield',
  gridWidth: 80,
  gridHeight: 50,
  cellSize: 14,
  theme: THEMES.cyber,
};

// Map: Square Arena
const SQUARE_ARENA: TronMapDefinition = {
  id: 'square',
  name: 'Square Arena',
  description: 'Perfectly square arena',
  gridWidth: 50,
  gridHeight: 50,
  cellSize: 16,
  theme: THEMES.sunset,
};

// All maps collection
const ALL_MAPS: TronMapDefinition[] = [
  STANDARD_ARENA,
  SMALL_ARENA,
  LARGE_ARENA,
  SQUARE_ARENA,
];

/**
 * Get all available maps
 */
export function getAllMaps(): TronMapDefinition[] {
  return ALL_MAPS;
}

/**
 * Get a map by ID
 */
export function getMapById(id: string): TronMapDefinition | undefined {
  return ALL_MAPS.find(map => map.id === id);
}

/**
 * Get a random map
 */
export function getRandomMap(): TronMapDefinition {
  return ALL_MAPS[Math.floor(Math.random() * ALL_MAPS.length)];
}

/**
 * Get the default map
 */
export function getDefaultMap(): TronMapDefinition {
  return STANDARD_ARENA;
}
