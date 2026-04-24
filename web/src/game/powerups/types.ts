import { Vec2 } from '../../physics/vec2';

export type PowerupType = 'mass_boost' | 'expand_speed' | 'bouncy';

export interface PowerupDef {
  type: PowerupType;
  duration: number;
  multiplier: number;
  color: string;
  label: string;
}

export interface ActivePowerup {
  type: PowerupType;
  remainingTime: number;
  multiplier: number;
}

export interface SpawnedPowerup {
  id: string;
  def: PowerupDef;
  position: Vec2;
  respawnTimer: number;
  collected: boolean;
}

export const POWERUP_DEFS: Record<PowerupType, PowerupDef> = {
  mass_boost: {
    type: 'mass_boost',
    duration: 8,
    multiplier: 2.0,
    color: '#ff8844',
    label: 'M',
  },
  expand_speed: {
    type: 'expand_speed',
    duration: 8,
    multiplier: 3.0,
    color: '#ff44ff',
    label: 'E',
  },
  bouncy: {
    type: 'bouncy',
    duration: 6,
    multiplier: 2.0,
    color: '#44ff44',
    label: 'B',
  },
};

export const POWERUP_TYPES: PowerupType[] = ['mass_boost', 'expand_speed', 'bouncy'];
