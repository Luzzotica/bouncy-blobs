import { describe, it, expect } from 'vitest';
import { encodeStateSync, decodeStateSync, encodeHashBeacon, decodeHashBeacon, MAGIC_STATE_SYNC, MAGIC_HASH_BEACON } from './stateSyncCodec';

describe('stateSyncCodec', () => {
  it('hash beacon round-trips tick + hash (13 bytes)', () => {
    const ab = encodeHashBeacon(12345, '0x60af009115b6d362');
    expect(ab.byteLength).toBe(13);
    expect(new Uint8Array(ab)[0]).toBe(MAGIC_HASH_BEACON);
    const d = decodeHashBeacon(ab);
    expect(d).toEqual({ tick: 12345, hash: '0x60af009115b6d362' });
  });

  it('full state round-trips LOSSLESSLY (engine bytes bit-identical)', () => {
    // Pseudo engine snapshot — fixed-point-ish integers (the real shape).
    const engine = new Uint8Array(6000);
    for (let i = 0; i < engine.length; i++) engine[i] = (i * 2654435761) & 0xff;
    const gameState = { blobs: [{ id: 1, s: { expandShapeScale: 1.25, stickX: 3 } }], platformMover: { o: 42 } };
    const ab = encodeStateSync({ tick: 999, hash: '0x0d38bb38a31362da', engineState: engine, gameState });
    expect(new Uint8Array(ab)[0]).toBe(MAGIC_STATE_SYNC);

    const d = decodeStateSync(ab)!;
    expect(d.tick).toBe(999);
    expect(d.hash).toBe('0x0d38bb38a31362da');
    expect(d.engineState.byteLength).toBe(engine.byteLength);
    expect(Array.from(d.engineState)).toEqual(Array.from(engine)); // bit-exact
    expect(d.gameState).toEqual(gameState);
  });

  it('compresses real-shaped (low-entropy) snapshots well', () => {
    // Mostly-zero with sparse nonzero — typical of a settled physics snapshot.
    const engine = new Uint8Array(8000);
    for (let i = 0; i < engine.length; i += 16) engine[i] = (i / 16) & 0xff;
    const ab = encodeStateSync({ tick: 1, hash: '0x1', engineState: engine, gameState: {} });
    expect(ab.byteLength).toBeLessThan(engine.byteLength); // smaller than raw
  });

  it('rejects truncated / wrong-magic buffers', () => {
    expect(decodeStateSync(new Uint8Array([0x04, 1, 2]))).toBeNull();
    expect(decodeHashBeacon(new Uint8Array([0x99, 1, 2, 3, 4]))).toBeNull();
    expect(decodeStateSync(encodeHashBeacon(1, '0x1'))).toBeNull(); // beacon ≠ state
  });
});
