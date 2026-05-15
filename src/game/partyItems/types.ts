export type PartyItemType =
  // === Static geometry ===
  | 'platform_small'
  | 'platform_medium'
  | 'platform_large'
  | 'wall_small'
  | 'l_shape'
  | 'ramp_left'
  | 'ramp_right'
  | 'funnel'
  | 'bridge'
  // === Spikes / traps ===
  | 'spike'
  | 'spike_pit'
  | 'spike_wall'
  // === Spring pads ===
  | 'spring_pad'
  | 'trampoline'
  // === Dynamic / force-based ===
  | 'cannon'
  | 'catapult'
  | 'bumper'
  | 'wind_zone'
  | 'gravity_flipper'
  | 'conveyor_left'
  | 'conveyor_right'
  | 'sticky_goo'
  | 'wrecking_ball';

export type PartyItemCategory = 'platform' | 'trap' | 'launcher' | 'zone' | 'hazard';

export interface PartyItem {
  type: PartyItemType;
  label: string;
  category: PartyItemCategory;
  width: number;
  height: number;
  rotation: number;
  /** Brief description shown on controller */
  desc?: string;
}

export const PARTY_ITEM_CATALOG: PartyItem[] = [
  // --- Platforms ---
  { type: 'platform_small', label: 'Small Platform', category: 'platform', width: 120, height: 24, rotation: 0 },
  { type: 'platform_medium', label: 'Medium Platform', category: 'platform', width: 240, height: 24, rotation: 0 },
  { type: 'platform_large', label: 'Large Platform', category: 'platform', width: 400, height: 24, rotation: 0 },
  { type: 'wall_small', label: 'Small Wall', category: 'platform', width: 24, height: 120, rotation: 0 },
  { type: 'l_shape', label: 'L-Shape', category: 'platform', width: 160, height: 160, rotation: 0, desc: 'Corner platform' },
  { type: 'ramp_left', label: 'Ramp Left', category: 'platform', width: 200, height: 80, rotation: 0, desc: 'Slope going up-left' },
  { type: 'ramp_right', label: 'Ramp Right', category: 'platform', width: 200, height: 80, rotation: 0, desc: 'Slope going up-right' },
  { type: 'funnel', label: 'Funnel', category: 'platform', width: 250, height: 150, rotation: 0, desc: 'V-shaped catch' },
  { type: 'bridge', label: 'Bridge', category: 'platform', width: 350, height: 16, rotation: 0, desc: 'Long thin platform' },

  // --- Traps ---
  { type: 'spike', label: 'Spikes', category: 'trap', width: 150, height: 35, rotation: 0 },
  { type: 'spike_pit', label: 'Spike Pit', category: 'trap', width: 300, height: 45, rotation: 0, desc: 'Wide deadly pit' },
  { type: 'spike_wall', label: 'Spike Wall', category: 'trap', width: 35, height: 150, rotation: -Math.PI / 2, desc: 'Vertical spikes' },
  { type: 'sticky_goo', label: 'Sticky Goo', category: 'trap', width: 180, height: 60, rotation: 0, desc: 'Slows blobs to a crawl' },
  { type: 'wrecking_ball', label: 'Wrecking Ball', category: 'hazard', width: 100, height: 100, rotation: 0, desc: 'Periodic blast that sends blobs flying' },

  // --- Launchers ---
  { type: 'spring_pad', label: 'Spring Pad', category: 'launcher', width: 100, height: 40, rotation: -Math.PI / 2 },
  { type: 'trampoline', label: 'Trampoline', category: 'launcher', width: 160, height: 30, rotation: -Math.PI / 2, desc: 'Big upward bounce' },
  { type: 'cannon', label: 'Cannon', category: 'launcher', width: 80, height: 80, rotation: -Math.PI / 2, desc: 'Fires blobs periodically!' },
  { type: 'catapult', label: 'Catapult', category: 'launcher', width: 140, height: 50, rotation: 0, desc: 'Launches blobs skyward every few seconds' },
  { type: 'bumper', label: 'Bumper', category: 'launcher', width: 80, height: 80, rotation: 0, desc: 'Bounces blobs on contact' },

  // --- Zones ---
  { type: 'wind_zone', label: 'Wind Zone', category: 'zone', width: 200, height: 250, rotation: -Math.PI / 2, desc: 'Pushes blobs upward' },
  { type: 'gravity_flipper', label: 'Gravity Flip', category: 'zone', width: 200, height: 200, rotation: 0, desc: 'Reverses gravity inside!' },
  { type: 'conveyor_left', label: 'Conveyor Left', category: 'zone', width: 250, height: 40, rotation: 0, desc: 'Pushes blobs left' },
  { type: 'conveyor_right', label: 'Conveyor Right', category: 'zone', width: 250, height: 40, rotation: 0, desc: 'Pushes blobs right' },
];
