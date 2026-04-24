import { SoftBodyWorld } from '../physics/softBodyWorld';
import { SlimeBlob } from '../physics/slimeBlob';
import { Vec2, vec2 } from '../physics/vec2';
import { LevelData, PlatformDef, ZoneDef } from './types';

export interface LoadedLevel {
  playerSpawnPoints: Vec2[];
  npcBlobs: SlimeBlob[];
  /** Map from zone id to trigger shape index in the physics world. */
  triggerIndices: Map<string, number>;
}

function platformToPolygon(p: PlatformDef): Vec2[] {
  const hw = p.width / 2;
  const hh = p.height / 2;
  const corners: Vec2[] = [
    vec2(-hw, -hh),
    vec2(hw, -hh),
    vec2(hw, hh),
    vec2(-hw, hh),
  ];

  if (Math.abs(p.rotation) > 0.001) {
    const c = Math.cos(p.rotation);
    const s = Math.sin(p.rotation);
    return corners.map(v => vec2(
      v.x * c - v.y * s + p.x,
      v.x * s + v.y * c + p.y,
    ));
  }
  return corners.map(v => vec2(v.x + p.x, v.y + p.y));
}

export function loadLevel(world: SoftBodyWorld, level: LevelData): LoadedLevel {
  // Register platforms
  for (const platform of level.platforms) {
    world.registerStaticPolygon(platformToPolygon(platform));
  }

  // Register walls
  for (const wall of level.walls) {
    world.registerStaticPolygon(wall.points.map(p => vec2(p.x, p.y)));
  }

  // Spawn NPC blobs
  const npcBlobs: SlimeBlob[] = [];
  for (const npc of level.npcBlobs) {
    const blob = new SlimeBlob(world, vec2(npc.x, npc.y), {
      playerControlled: false,
      hullPreset: npc.hullPreset,
    });
    npcBlobs.push(blob);
  }

  // Register goal/hill zones as trigger polygons
  const triggerIndices = new Map<string, number>();
  const allZones: ZoneDef[] = [
    ...(level.goalZones ?? []),
    ...(level.hillZones ?? []),
  ];
  for (const zone of allZones) {
    const hw = zone.width / 2;
    const hh = zone.height / 2;
    const poly: Vec2[] = [
      vec2(zone.x - hw, zone.y - hh),
      vec2(zone.x + hw, zone.y - hh),
      vec2(zone.x + hw, zone.y + hh),
      vec2(zone.x - hw, zone.y + hh),
    ];
    const shapeIdx = world.registerTriggerPolygon(poly);
    triggerIndices.set(zone.id, shapeIdx);
  }

  // Collect player spawn points
  const playerSpawnPoints = level.spawnPoints
    .filter(sp => sp.type === 'player')
    .map(sp => vec2(sp.x, sp.y));

  return { playerSpawnPoints, npcBlobs, triggerIndices };
}
