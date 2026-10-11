# Bouncy Blobs — phone controller

The page phones open from the game's QR code (`/controller/<CODE>`) or by
typing the 5-letter room code (`/join`). Plain Vite + React: loads instantly on
a phone, no install. The game (Rust/Bevy) hosts a `bouncy-blobs` room on
[partii](../../partii/platform); this page joins it as a `phone` member through
the partii web engine (wasm) and speaks the controller JSON protocol
(`player_join`, `customization_update`, `player_input_batch`, …) as UTF-8 JSON
messages to the host: one-off messages reliable, the 30 Hz input stream
unreliable. The engine picks the path (WebRTC or the edge relay) and reconnects
by itself through short drops.

```bash
npm install
npm run dev        # http://localhost:5171 (and your LAN IP for real phones)
npm run build      # → dist/ (static; deploy anywhere, SPA rewrite in vercel.json)
```

## Platform settings

Build-time env (`.env.local`, not committed):

| var | meaning | default |
| --- | --- | --- |
| `VITE_PARTII_KEY` | partii publishable key (`pk_…`) | none |
| `VITE_PARTII_API` | partii edge URL | `https://partii-edge-staging.partii-games.workers.dev` |

Query params override them per link, and survive `/join` → `/controller`:
`?k=<publishable key>&e=<edge url>`, e.g.
`/controller/ABCDE?k=pk_demo_…&e=http://192.168.1.20:8787`.

Point the game at a deployment with `BB_CONTROLLER_URL=https://<host>/controller/`.

## The wasm engine

`public/engine/partii_engine.{js,_bg.wasm}` is a vendored copy of
`partii/platform/sdk/engine-web` (built by
`partii/platform/scripts/build-engine-web.sh`), served next to the page and
loaded at run time (`src/lib/partii.ts`). Refresh it after an engine change
with `npm run engine` (expects the partii repo at `../../partii`).

## End-to-end test

Drives the built page in headless Chromium against a local partii platform:
a second page creates a `bouncy-blobs` room as kind `game`, the phone joins by
typing the code, and the test checks the reliable `player_join`, a game→phone
`customization_update` greying out taken colors/faces, the unreliable
`player_input_batch` stream after stick + expand input, and that the host
leaving sends the phone back to `/join`. Prints one JSON result line.

```bash
# a local platform (from partii/platform): ./target/debug/partii dev up --public
npm run build
PARTII_API=http://127.0.0.1:8787 PARTII_KEY=pk_demo_k1_A7ZzxXtfq8H806VOVu-1Jq npm test
```

`PARTII_API` defaults to `http://127.0.0.1:8787` and `PARTII_KEY` to the local
dev key above.
