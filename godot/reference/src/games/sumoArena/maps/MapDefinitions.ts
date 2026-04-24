// Map Definitions - All arena configurations

import { MapDefinition, MapCategory } from '../types';

// Theme presets
const THEMES = {
  classic: {
    floorColor: 0x4a5568,
    edgeColor: 0x2d3748,
    backgroundColor: 0x1a1a2e,
    particleColor: 0x718096,
    name: 'Classic',
  },
  lava: {
    floorColor: 0x7c2d12,
    edgeColor: 0xdc2626,
    backgroundColor: 0x1c1917,
    particleColor: 0xfb923c,
    name: 'Lava',
  },
  ice: {
    floorColor: 0x67e8f9,
    edgeColor: 0x0ea5e9,
    backgroundColor: 0x0c4a6e,
    particleColor: 0xbae6fd,
    name: 'Ice',
  },
  neon: {
    floorColor: 0x7c3aed,
    edgeColor: 0xa855f7,
    backgroundColor: 0x1e1b4b,
    particleColor: 0xc084fc,
    name: 'Neon',
  },
  toxic: {
    floorColor: 0x166534,
    edgeColor: 0x22c55e,
    backgroundColor: 0x052e16,
    particleColor: 0x4ade80,
    name: 'Toxic',
  },
  void: {
    floorColor: 0x1f2937,
    edgeColor: 0x6366f1,
    backgroundColor: 0x030712,
    particleColor: 0x818cf8,
    name: 'Void',
  },
};

// ============================================
// CATEGORY 1: SHRINKING ARENAS
// ============================================

const classicCircle: MapDefinition = {
  id: 'classic_circle',
  name: 'Classic Circle',
  description: 'Standard circular arena with no hazards. Pure skill!',
  category: 'shrinking',
  difficulty: 1,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 80,
    shrinkInterval: 10000,
    shrinkAmount: 30,
    friction: 0.8,
  },
  theme: THEMES.classic,
};

const rapidCollapse: MapDefinition = {
  id: 'rapid_collapse',
  name: 'Rapid Collapse',
  description: 'Fast-paced arena that shrinks quickly. Stay on your toes!',
  category: 'shrinking',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 250,
    minRadius: 60,
    shrinkInterval: 6000,
    shrinkAmount: 35,
    friction: 0.8,
  },
  theme: THEMES.lava,
};

const breathingArena: MapDefinition = {
  id: 'breathing_arena',
  name: 'Breathing Arena',
  description: 'The arena pulses in and out. Timing is everything!',
  category: 'shrinking',
  difficulty: 3,
  arena: {
    shape: 'circle',
    initialRadius: 280,
    minRadius: 100,
    shrinkInterval: 5000,
    shrinkAmount: 25, // Will expand/contract
    friction: 0.8,
  },
  theme: THEMES.neon,
};

const theDonut: MapDefinition = {
  id: 'the_donut',
  name: 'The Donut',
  description: 'Ring-shaped arena with a deadly center hole that grows!',
  category: 'shrinking',
  difficulty: 3,
  arena: {
    shape: 'donut',
    initialRadius: 320,
    minRadius: 120,
    shrinkInterval: 8000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  zones: [
    {
      id: 'center_pit',
      type: 'gravity',
      shape: 'circle',
      position: { x: 0, y: 0 }, // Relative to center
      radius: 50,
      strength: -0.5, // Negative = repels (deadly zone)
    },
  ],
  theme: THEMES.void,
};

// ============================================
// CATEGORY 2: HAZARD ARENAS
// ============================================

const spikePit: MapDefinition = {
  id: 'spike_pit',
  name: 'Spike Pit',
  description: 'Retractable spikes pop up in patterns. Watch the glow!',
  category: 'hazard',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 12000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  hazards: [
    { id: 'spike_1', type: 'spike', position: { x: 100, y: 0 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
    { id: 'spike_2', type: 'spike', position: { x: -100, y: 0 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
    { id: 'spike_3', type: 'spike', position: { x: 0, y: 100 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
    { id: 'spike_4', type: 'spike', position: { x: 0, y: -100 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
    { id: 'spike_5', type: 'spike', position: { x: 150, y: 150 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
    { id: 'spike_6', type: 'spike', position: { x: -150, y: -150 }, behavior: 'timed', warningTime: 2000, damage: 'knockback' },
  ],
  theme: THEMES.toxic,
};

const sawBlades: MapDefinition = {
  id: 'saw_blades',
  name: 'Saw Blades',
  description: 'Rotating saw blades patrol the arena edges. Predictable but deadly!',
  category: 'hazard',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  hazards: [
    {
      id: 'saw_1',
      type: 'saw',
      position: { x: 200, y: 0 },
      behavior: 'rotating',
      warningTime: 0,
      damage: 'knockback',
      path: [{ x: 200, y: 0 }, { x: 0, y: 200 }, { x: -200, y: 0 }, { x: 0, y: -200 }],
      speed: 2,
    },
    {
      id: 'saw_2',
      type: 'saw',
      position: { x: -200, y: 0 },
      behavior: 'rotating',
      warningTime: 0,
      damage: 'knockback',
      path: [{ x: -200, y: 0 }, { x: 0, y: -200 }, { x: 200, y: 0 }, { x: 0, y: 200 }],
      speed: 2,
    },
  ],
  theme: THEMES.lava,
};

const laserGrid: MapDefinition = {
  id: 'laser_grid',
  name: 'Laser Grid',
  description: 'Crossing laser beams sweep across the arena. Time your moves!',
  category: 'hazard',
  difficulty: 3,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  hazards: [
    { id: 'laser_h', type: 'laser', position: { x: 0, y: 0 }, behavior: 'rotating', warningTime: 1000, damage: 'knockback', speed: 1 },
    { id: 'laser_v', type: 'laser', position: { x: 0, y: 0 }, behavior: 'rotating', warningTime: 1000, damage: 'knockback', speed: -1 },
  ],
  theme: THEMES.neon,
};

const theGauntlet: MapDefinition = {
  id: 'the_gauntlet',
  name: 'The Gauntlet',
  description: 'Spike walls close in from all sides, then retract. Survive the squeeze!',
  category: 'hazard',
  difficulty: 3,
  arena: {
    shape: 'square',
    initialRadius: 280,
    minRadius: 100,
    shrinkInterval: 15000,
    shrinkAmount: 20,
    friction: 0.8,
  },
  hazards: [
    { id: 'wall_top', type: 'spike', position: { x: 0, y: -250 }, behavior: 'patrolling', warningTime: 1500, damage: 'knockback', path: [{ x: 0, y: -250 }, { x: 0, y: -100 }], speed: 3 },
    { id: 'wall_bottom', type: 'spike', position: { x: 0, y: 250 }, behavior: 'patrolling', warningTime: 1500, damage: 'knockback', path: [{ x: 0, y: 250 }, { x: 0, y: 100 }], speed: 3 },
    { id: 'wall_left', type: 'spike', position: { x: -250, y: 0 }, behavior: 'patrolling', warningTime: 1500, damage: 'knockback', path: [{ x: -250, y: 0 }, { x: -100, y: 0 }], speed: 3 },
    { id: 'wall_right', type: 'spike', position: { x: 250, y: 0 }, behavior: 'patrolling', warningTime: 1500, damage: 'knockback', path: [{ x: 250, y: 0 }, { x: 100, y: 0 }], speed: 3 },
  ],
  theme: THEMES.toxic,
};

const meteorShower: MapDefinition = {
  id: 'meteor_shower',
  name: 'Meteor Shower',
  description: 'Random meteor impacts target players. Watch for shadows!',
  category: 'hazard',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 320,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 30,
    friction: 0.8,
  },
  hazards: [
    { id: 'meteor_spawner', type: 'meteor', position: 'random', behavior: 'timed', warningTime: 1500, damage: 'knockback' },
  ],
  theme: THEMES.lava,
};

// ============================================
// CATEGORY 3: ICE/SLIPPERY MAPS
// ============================================

const frozenLake: MapDefinition = {
  id: 'frozen_lake',
  name: 'Frozen Lake',
  description: 'The entire arena is slippery ice. Slide into victory!',
  category: 'ice',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 80,
    shrinkInterval: 10000,
    shrinkAmount: 30,
    friction: 0.1, // Very slippery!
  },
  theme: THEMES.ice,
};

const thawingIce: MapDefinition = {
  id: 'thawing_ice',
  name: 'Thawing Ice',
  description: 'Ice melts as the arena shrinks. Friction increases over time!',
  category: 'ice',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 8000,
    shrinkAmount: 25,
    friction: 0.1, // Starts slippery, game logic increases it
  },
  theme: THEMES.ice,
};

const oilSpill: MapDefinition = {
  id: 'oil_spill',
  name: 'Oil Spill',
  description: 'Slippery oil patches drift around the arena. Avoid or exploit!',
  category: 'ice',
  difficulty: 3,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.7,
  },
  zones: [
    { id: 'oil_1', type: 'ice', shape: 'circle', position: { x: 100, y: 50 }, radius: 60, strength: 0.1 },
    { id: 'oil_2', type: 'ice', shape: 'circle', position: { x: -80, y: -100 }, radius: 50, strength: 0.1 },
    { id: 'oil_3', type: 'ice', shape: 'circle', position: { x: -50, y: 120 }, radius: 70, strength: 0.1 },
  ],
  theme: THEMES.toxic,
};

const icyEdges: MapDefinition = {
  id: 'icy_edges',
  name: 'Icy Edges',
  description: 'Center is safe, but the edges are treacherous ice!',
  category: 'ice',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  zones: [
    { id: 'ice_ring', type: 'ice', shape: 'circle', position: { x: 0, y: 0 }, radius: 300, strength: 0.15 },
    // Note: Logic should make outer ring icy while center has normal friction
  ],
  theme: THEMES.ice,
};

// ============================================
// CATEGORY 4: SPECIAL MECHANICS
// ============================================

const bumperArena: MapDefinition = {
  id: 'bumper_arena',
  name: 'Bumper Arena',
  description: 'Bouncy walls reflect players with extra force. Pinball chaos!',
  category: 'special',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 280,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  zones: [
    { id: 'bumper_edge', type: 'bounce', shape: 'circle', position: { x: 0, y: 0 }, radius: 280, strength: 2.0 },
    { id: 'bumper_1', type: 'bounce', shape: 'circle', position: { x: 100, y: 0 }, radius: 30, strength: 2.5 },
    { id: 'bumper_2', type: 'bounce', shape: 'circle', position: { x: -100, y: 0 }, radius: 30, strength: 2.5 },
    { id: 'bumper_3', type: 'bounce', shape: 'circle', position: { x: 0, y: 100 }, radius: 30, strength: 2.5 },
    { id: 'bumper_4', type: 'bounce', shape: 'circle', position: { x: 0, y: -100 }, radius: 30, strength: 2.5 },
  ],
  theme: THEMES.neon,
};

const crumblingFloor: MapDefinition = {
  id: 'crumbling_floor',
  name: 'Crumbling Floor',
  description: 'Random floor sections fall away. Warning cracks appear first!',
  category: 'special',
  difficulty: 3,
  arena: {
    shape: 'hexagon',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 15000,
    shrinkAmount: 20,
    friction: 0.8,
  },
  hazards: [
    { id: 'crumble_zone', type: 'pit', position: 'random', behavior: 'timed', warningTime: 2500, damage: 'instant_kill' },
  ],
  theme: THEMES.classic,
};

const conveyorBelt: MapDefinition = {
  id: 'conveyor_belt',
  name: 'Conveyor Belt',
  description: 'Rotating floor sections push you toward the edge!',
  category: 'special',
  difficulty: 3,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.6,
  },
  zones: [
    { id: 'conveyor_outer', type: 'conveyor', shape: 'circle', position: { x: 0, y: 0 }, radius: 280, strength: 0.5, direction: Math.PI / 2 },
    { id: 'conveyor_inner', type: 'conveyor', shape: 'circle', position: { x: 0, y: 0 }, radius: 150, strength: 0.3, direction: -Math.PI / 2 },
  ],
  theme: THEMES.classic,
};

const gravityWell: MapDefinition = {
  id: 'gravity_well',
  name: 'Gravity Well',
  description: 'Center pulls you in! Fight to stay at the edges.',
  category: 'special',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 320,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 30,
    friction: 0.8,
  },
  zones: [
    { id: 'gravity_center', type: 'gravity', shape: 'circle', position: { x: 0, y: 0 }, radius: 200, strength: 0.3 },
  ],
  theme: THEMES.void,
};

const portals: MapDefinition = {
  id: 'portals',
  name: 'Portals',
  description: 'Two portal zones teleport players between them. Use wisely!',
  category: 'special',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 320,
    minRadius: 100,
    shrinkInterval: 10000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  zones: [
    { id: 'portal_a', type: 'portal', shape: 'circle', position: { x: -150, y: 0 }, radius: 40, linkedPortalId: 'portal_b' },
    { id: 'portal_b', type: 'portal', shape: 'circle', position: { x: 150, y: 0 }, radius: 40, linkedPortalId: 'portal_a' },
  ],
  theme: THEMES.neon,
};

const kingOfTheHill: MapDefinition = {
  id: 'king_of_the_hill',
  name: 'King of the Hill',
  description: 'Center zone gives points. Defend your position!',
  category: 'special',
  difficulty: 2,
  arena: {
    shape: 'circle',
    initialRadius: 300,
    minRadius: 100,
    shrinkInterval: 12000,
    shrinkAmount: 25,
    friction: 0.8,
  },
  zones: [
    { id: 'hill_zone', type: 'gravity', shape: 'circle', position: { x: 0, y: 0 }, radius: 60, strength: 0 }, // Marking zone, no force
  ],
  theme: THEMES.classic,
};

// ============================================
// EXPORTS
// ============================================

export const ALL_MAPS: MapDefinition[] = [
  // Shrinking
  classicCircle,
  rapidCollapse,
  breathingArena,
  theDonut,
  // Hazard
  spikePit,
  sawBlades,
  laserGrid,
  theGauntlet,
  meteorShower,
  // Ice
  frozenLake,
  thawingIce,
  oilSpill,
  icyEdges,
  // Special
  bumperArena,
  crumblingFloor,
  conveyorBelt,
  gravityWell,
  portals,
  kingOfTheHill,
];

export function getAllMaps(): MapDefinition[] {
  return ALL_MAPS;
}

export function getMapById(id: string): MapDefinition | undefined {
  return ALL_MAPS.find(map => map.id === id);
}

export function getMapsByCategory(category: MapCategory): MapDefinition[] {
  return ALL_MAPS.filter(map => map.category === category);
}

export function getRandomMaps(count: number): MapDefinition[] {
  const shuffled = [...ALL_MAPS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

