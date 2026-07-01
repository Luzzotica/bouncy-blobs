/** Deterministic FNV-1a hash of a string → u32. Used to derive a stable
 *  numeric id for the engine from a level-data string id (triggers, actions,
 *  spikes, players). The same string always hashes to the same number on every
 *  client, so the Rust engine and TS shell agree without a shared counter.
 *  Mirrors `hashStringId` in springPadManager.ts. */
export function hashStringId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
