import { describe, it, expect } from 'vitest';
import { SoftBodyWorld } from './softBodyWorld';
import { SlimeBlob, BLOB_RADIUS } from './slimeBlob';
import { vec2, Vec2 } from './vec2';

const DT = 1 / 60;

interface Snapshot {
  pos: Vec2[];
  vel: Vec2[];
}

function snapshot(world: SoftBodyWorld): Snapshot {
  return {
    pos: world.getPositions().map(p => ({ x: p.x, y: p.y })),
    vel: world.getVelocities(),
  };
}

function expectIdentical(a: Snapshot, b: Snapshot, ctx: string): void {
  expect(a.pos.length, `${ctx}: particle count`).toBe(b.pos.length);
  for (let i = 0; i < a.pos.length; i++) {
    // Bit-exact comparison — physics determinism means same inputs → same bits out.
    if (a.pos[i].x !== b.pos[i].x || a.pos[i].y !== b.pos[i].y) {
      throw new Error(
        `${ctx}: position diverged at particle ${i}: ` +
        `A=(${a.pos[i].x},${a.pos[i].y}) B=(${b.pos[i].x},${b.pos[i].y})`,
      );
    }
    if (a.vel[i].x !== b.vel[i].x || a.vel[i].y !== b.vel[i].y) {
      throw new Error(
        `${ctx}: velocity diverged at particle ${i}: ` +
        `A=(${a.vel[i].x},${a.vel[i].y}) B=(${b.vel[i].x},${b.vel[i].y})`,
      );
    }
  }
}

/**
 * Build a scenario as a setup function so we can reconstruct two independent
 * worlds with identical initial conditions. Returns the world plus its blobs
 * so the test can also inspect higher-level state if needed.
 */
type Scenario = () => { world: SoftBodyWorld; blobs: SlimeBlob[] };

function runAndSnapshotEvery(scenario: Scenario, totalSeconds: number, every = 1): Snapshot[] {
  const { world } = scenario();
  const totalSteps = Math.round(totalSeconds / DT);
  const out: Snapshot[] = [];
  for (let i = 0; i < totalSteps; i++) {
    world.step(DT);
    if ((i + 1) % every === 0) out.push(snapshot(world));
  }
  return out;
}

const scenarios: Record<string, Scenario> = {
  'fast head-on (CCD path)': () => {
    const world = new SoftBodyWorld({ gravity: vec2(0, 0), rngSeed: 42 });
    const a = new SlimeBlob(world, vec2(0, 0), { playerControlled: false });
    const b = new SlimeBlob(world, vec2(BLOB_RADIUS * 4, 0), { playerControlled: false });
    world.applyBlobLinearVelocityDelta(a.blobId, vec2(5000, 0));
    return { world, blobs: [a, b] };
  },

  'three-blob pileup (multi-pair CCD)': () => {
    const world = new SoftBodyWorld({ gravity: vec2(0, 0), rngSeed: 7 });
    const a = new SlimeBlob(world, vec2(0, 0), { playerControlled: false });
    const b = new SlimeBlob(world, vec2(BLOB_RADIUS * 3, 0), { playerControlled: false });
    const c = new SlimeBlob(world, vec2(BLOB_RADIUS * 6, 0), { playerControlled: false });
    world.applyBlobLinearVelocityDelta(a.blobId, vec2(3500, 0));
    world.applyBlobLinearVelocityDelta(c.blobId, vec2(-1500, 0));
    return { world, blobs: [a, b, c] };
  },

  'oblique high-speed (asymmetric CCD)': () => {
    const world = new SoftBodyWorld({ gravity: vec2(0, 0), rngSeed: 999 });
    const a = new SlimeBlob(world, vec2(0, 0), { playerControlled: false });
    const b = new SlimeBlob(world, vec2(BLOB_RADIUS * 4, BLOB_RADIUS * 0.4), { playerControlled: false });
    world.applyBlobLinearVelocityDelta(a.blobId, vec2(4000, 700));
    return { world, blobs: [a, b] };
  },

  'slow contact (CCD inactive, baseline)': () => {
    const world = new SoftBodyWorld({ gravity: vec2(0, 0), rngSeed: 123 });
    const a = new SlimeBlob(world, vec2(0, 0), { playerControlled: false });
    const b = new SlimeBlob(world, vec2(BLOB_RADIUS * 3, 0), { playerControlled: false });
    world.applyBlobLinearVelocityDelta(a.blobId, vec2(400, 0));
    return { world, blobs: [a, b] };
  },
};

describe('softBodyWorld determinism', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name}: two runs produce bit-identical state`, () => {
      const runA = runAndSnapshotEvery(scenario, 0.5, 5);
      const runB = runAndSnapshotEvery(scenario, 0.5, 5);
      expect(runA.length).toBe(runB.length);
      for (let i = 0; i < runA.length; i++) {
        expectIdentical(runA[i], runB[i], `${name} @ snapshot ${i}`);
      }
    });
  }

  it('interleaving two scenarios in different orders gives the same final state for each', () => {
    // Catches accidental shared mutable state (module-level caches, global RNG,
    // etc.) that would couple unrelated world instances.
    const fastA = runAndSnapshotEvery(scenarios['fast head-on (CCD path)'], 0.3);
    const fastB = (() => {
      // Run a different scenario first, then ours, to check the second world is unaffected.
      runAndSnapshotEvery(scenarios['three-blob pileup (multi-pair CCD)'], 0.3);
      return runAndSnapshotEvery(scenarios['fast head-on (CCD path)'], 0.3);
    })();
    expectIdentical(fastA[fastA.length - 1], fastB[fastB.length - 1], 'interleaved');
  });

  it('CCD pass: replay across many steps stays bit-identical (long-horizon)', () => {
    // The CCD pass touches positions and velocities in-place. Long-horizon
    // replays are the most sensitive to any drift introduced by it.
    const runA = runAndSnapshotEvery(scenarios['fast head-on (CCD path)'], 1.5, 1);
    const runB = runAndSnapshotEvery(scenarios['fast head-on (CCD path)'], 1.5, 1);
    expect(runA.length).toBe(runB.length);
    for (let i = 0; i < runA.length; i++) {
      expectIdentical(runA[i], runB[i], `long-horizon @ step ${i}`);
    }
  });
});
