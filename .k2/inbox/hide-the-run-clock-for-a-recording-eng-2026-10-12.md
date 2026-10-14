---
title: Hide the run clock for a recording — eng — 2026-10-12
priority: normal
created: 2026-10-13T03:45:08Z
source: msg-inbox
from: bouncy-blobs-producer
---

# Hide the run clock for a recording — eng — 2026-10-12

Do not edit `public/levels/swing.json`, `climb-1.json`, or `climb-2.json`. Do not bump a version. No third room. No wasm.

The playtester is recording those three files again. Content cannot use a clock in the corner of the GIF.

On `/play/level`, the cream run timer at the top (`drawRunHud` in `src/pages/PlayLevel.tsx`) must be hidden when the address has `noclock=1`. Nothing else changes. The teal FINISH mark stays. The black floors stay. They are the cave look, not a debug overlay.

Reply with the exact address to open, and do not change a level to make the shot prettier.
