# Bouncy Blobs — phone controller

The page phones open from the game's QR code
(`https://bouncy-blobs.partii.games/c/<CODE>?k=<key>&e=<edge>&g=bouncy-blobs`)
or by typing the 5-letter room code (`/join`). `/p/<CODE>` is the same page and
the old `/controller/<CODE>` links still work. Plain Vite + React: loads
instantly on a phone, no install. The game (Rust/Bevy) hosts a `bouncy-blobs`
room on [partii](../../partii/platform); this page joins it as a `phone`
member through the partii web engine (wasm).

## Protocol (partii `docs/CONTROLLER.md`)

- **Input:** partii's 10-byte `0x50` frame, unreliable, ~30 Hz at rest and at
  once on any change (`src/lib/play.ts`). Left stick = the square pad (+y
  down); EXPAND = PRIMARY (bit 0), held at least 100 ms so a quick tap lands.
- **Bouncy Blobs JSON, reliable:** `player_join` (name, colour, face),
  `customization_update` (picks; the game answers with what others hold).
  Plus partii's standard `hello`.
- **Game → phone, reliable:** `seat` (label, colour), `layout` (button
  names), `rumble` (vibrate on a pop).

`src/lib/play.ts` holds the generic parts in one module, to be replaced by
partii's `@partii/controller-kit`; its Rust twin is `crates/bb-net/src/play.rs`.

```bash
npm install
npm run dev        # http://localhost:5171 (and your LAN IP for real phones)
npm run build      # → dist/
```

## Platform settings

Build-time env (`.env.local`, not committed):

| var | meaning | default |
| --- | --- | --- |
| `VITE_PARTII_API` | partii edge URL | production (`https://partii-edge.partii-games.workers.dev`) |
| `VITE_PARTII_KEY` | partii publishable key (`pk_…`) | Bouncy Blobs' production key (with the default edge) |

Query params override them per link, and survive `/join` → `/c/<CODE>`:
`?k=<publishable key>&e=<edge url>&g=<game>`.

Point the game at another controller site with
`BB_CONTROLLER_URL=http://<host>:5171`.

## Deploy (partii hosting)

```bash
# staging (bouncy-blobs-staging.partii.games), staging edge + key baked in
set -a; . ~/.config/partii/bouncy-blobs-game.env; set +a
VITE_PARTII_API=$PARTII_API VITE_PARTII_KEY=$PARTII_KEY npm run build
partii web deploy bouncy-blobs ./dist --spa --no-activate   # check the preview_url
partii web activate bouncy-blobs <deploy id>
```

Production (`bouncy-blobs.partii.games`) is a plain `npm run build` deployed
with production credentials; that goes through partii-backend. The old
Vercel page (`bouncy-blobs-controller.vercel.app`) stays up for builds that
already shipped.

## The wasm engine

`public/engine/partii_engine.{js,_bg.wasm}` is a vendored copy of
`partii/platform/sdk/engine-web` (built by
`partii/platform/scripts/build-engine-web.sh`), served next to the page and
loaded at run time (`src/lib/partii.ts`). Refresh it after an engine change
with `npm run engine` (expects the partii repo at `../../partii`).

## End-to-end test

`test/frame.test.mjs` checks the input frame against the golden vectors
shared with bb-net. `test/e2e.mjs` drives the built page in headless
Chromium (muted) against a partii platform: a second page creates a
`bouncy-blobs` room as kind `game`, the phone joins by typing the code, and
the test checks `player_join` + `hello`, taken colours/faces, `seat`/`layout`,
the unreliable `0x50` frames (~30 Hz, stick, EXPAND as PRIMARY, a 0 ms tap
landing), and that the host leaving sends the phone back to `/join`. Prints
one JSON result line. `PAGE=https://bouncy-blobs-staging.partii.games` runs
it against a deployed page.

```bash
# a local platform (from partii/platform): ./target/debug/partii dev up --public
npm run build
PARTII_API=http://127.0.0.1:8787 PARTII_KEY=pk_demo_k1_A7ZzxXtfq8H806VOVu-1Jq npm test
```

`PARTII_API` defaults to `http://127.0.0.1:8787` and `PARTII_KEY` to the local
dev key above.
