// Regression tests for the "guest sees no blobs" bug.
//
// Two ways the guest could lose blobs:
//   1. The local addPlayer call gets silently skipped because of a UI
//      timing race (gameContextRef not yet populated when joinAsLocalPlayer
//      fires) — fixed in OnlineGuest via the `canvasReady` gate.
//   2. Cross-client spawn divergence — the host's player at position X but
//      the guest's "same" player at position Y → the keyframe sync that
//      reconciles them would either flicker or silently fail.
//
// These tests lock in:
//   (a) PlayerManager.addPlayer actually grows the engine's blob count
//       (so a successful call DOES produce a visible blob)
//   (b) Two PlayerManagers seeded with the same spawn points produce the
//       SAME blob position for the same playerId — the netcode-determinism
//       property that lets host+guest end up at the same coordinates
//       without snapshot syncing first.

import { describe, expect, it } from 'vitest';
import { SoftBodyWorld } from '../physics/softBodyWorld';
import { vec2 } from '../physics/vec2';
import { PlayerManager } from './playerManager';

const SPAWN_POINTS = [
  vec2(-200, 380),
  vec2(0, 380),
  vec2(200, 380),
];

describe('PlayerManager — guest-spawn regression', () => {
  it('addPlayer creates a blob in the engine (so the guest can SEE it)', () => {
    const world = new SoftBodyWorld({ rngSeed: 1 });
    const pm = new PlayerManager(SPAWN_POINTS);
    expect(world.getBlobCount()).toBe(0);
    const mp = pm.addPlayer('p1', 'Player One', world);
    expect(world.getBlobCount()).toBe(1);
    expect(mp.blob.blobId).toBe(0);
    // Spawn position should be inside the configured spawn-point grid
    // (one of the three spawns, ± per-id jitter).
    const c = mp.blob.getCentroid();
    expect(c.x).toBeGreaterThan(-500);
    expect(c.x).toBeLessThan(500);
    expect(c.y).toBeGreaterThan(300);
    expect(c.y).toBeLessThan(500);
  });

  it('the same playerId spawns at the SAME position on two independent worlds', () => {
    // This is the cross-client deterministic-spawn property. Host and guest
    // both call addPlayer('host-123') against their own local PlayerManager
    // + world. Without snapshot sync, both must land at the same coordinates
    // for the keyframe path to be a no-op rather than a visible teleport.
    function build() {
      const world = new SoftBodyWorld({ rngSeed: 42 });
      const pm = new PlayerManager(SPAWN_POINTS);
      return { world, pm };
    }
    const a = build();
    const b = build();
    a.pm.addPlayer('host-123', 'Host', a.world);
    b.pm.addPlayer('host-123', 'Host (mirrored)', b.world);
    const ca = a.pm.getPlayer('host-123')!.blob.getCentroid();
    const cb = b.pm.getPlayer('host-123')!.blob.getCentroid();
    expect(cb.x).toBeCloseTo(ca.x, 6);
    expect(cb.y).toBeCloseTo(ca.y, 6);
  });

  it('different playerIds spawn at different positions (no collision spawn)', () => {
    const world = new SoftBodyWorld({ rngSeed: 1 });
    const pm = new PlayerManager(SPAWN_POINTS);
    const a = pm.addPlayer('alpha', 'A', world);
    const b = pm.addPlayer('beta', 'B', world);
    const ca = a.blob.getCentroid();
    const cb = b.blob.getCentroid();
    // Different playerIds should hash to different spawn slots / jitters.
    const dist = Math.hypot(ca.x - cb.x, ca.y - cb.y);
    expect(dist).toBeGreaterThan(1);
  });

  it('spawn-order independence: host adds {a,b}, guest adds {b,a} — same blob positions', () => {
    // The host inserts players in connection order. The guest may receive
    // player_join events in a different order. The deterministic spawn
    // derivation must be order-independent — driven purely by playerId.
    const host = { w: new SoftBodyWorld({ rngSeed: 9 }), pm: new PlayerManager(SPAWN_POINTS) };
    const guest = { w: new SoftBodyWorld({ rngSeed: 9 }), pm: new PlayerManager(SPAWN_POINTS) };
    host.pm.addPlayer('a', 'A', host.w);
    host.pm.addPlayer('b', 'B', host.w);
    guest.pm.addPlayer('b', 'B', guest.w);
    guest.pm.addPlayer('a', 'A', guest.w);
    const ha = host.pm.getPlayer('a')!.blob.getCentroid();
    const ga = guest.pm.getPlayer('a')!.blob.getCentroid();
    const hb = host.pm.getPlayer('b')!.blob.getCentroid();
    const gb = guest.pm.getPlayer('b')!.blob.getCentroid();
    expect(ga.x).toBeCloseTo(ha.x, 6);
    expect(ga.y).toBeCloseTo(ha.y, 6);
    expect(gb.x).toBeCloseTo(hb.x, 6);
    expect(gb.y).toBeCloseTo(hb.y, 6);
  });

  it('addPlayer is idempotent — calling twice with the same id reuses the blob', () => {
    // Guards against the bug where joinAsLocalPlayer ran twice (e.g., effect
    // dependency churn) and would otherwise create duplicate blobs at
    // different positions.
    const world = new SoftBodyWorld({ rngSeed: 1 });
    const pm = new PlayerManager(SPAWN_POINTS);
    const first = pm.addPlayer('p1', 'P1', world);
    const second = pm.addPlayer('p1', 'P1', world);
    expect(world.getBlobCount()).toBe(1);
    expect(first).toBe(second);
  });
});
