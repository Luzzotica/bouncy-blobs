// Test-only helper to initialise the Rust+wasm physics module under vitest.
//
// vitest runs in node, where the wasm-bindgen glue expects fetch(). We side-
// step that by reading the .wasm bytes off disk and handing them to the init
// function directly. Call `await loadWasmForTests()` in a `beforeAll` before
// constructing `SoftBodyWorldRust`. The init promise is memoised, so multiple
// test files / hooks share a single initialisation.
import initWasm, { SoftBodyWorldHandle } from './wasm/softbody_wasm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let ready: Promise<void> | null = null;

export function loadWasmForTests(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const wasmPath = resolve(here, './wasm/softbody_wasm_bg.wasm');
      const bytes = readFileSync(wasmPath);
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await initWasm({ module_or_path: ab as ArrayBuffer });
      if (typeof SoftBodyWorldHandle !== 'function') {
        throw new Error('wasm did not initialise SoftBodyWorldHandle');
      }
    })();
  }
  return ready;
}
