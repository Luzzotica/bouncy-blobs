# marketing/ — all Bouncy Blobs deliverables + their toolchain in one place

**Nothing here is built into the game** — only `public/` assets ship with the
build. The `steam-assets/` toolchain is tracked in git; the generated **output**
subfolders + pipeline workspaces are git-ignored (local-only, often large).

```
marketing/
  steam-assets/  ← the image/trailer/copy toolchain (TRACKED in git)
  steam/    Steam capsules, icons, store art    ← steam-assets render (pnpm render:steam)
  social/   LinkedIn / X / YouTube banners       ← steam-assets render (dir:"social" assets)
  itch/     itch.io cover + screenshots          ← hand-curated
  video/    trailers / recaps (out/) + workspace ← weekly-music-video skill
  shorts/   TikTok/IG/YT shorts (run-*/) + queue ← match-shorts skill
```

## How each folder is produced

| Folder | Command / skill | Output path is set in |
|---|---|---|
| `steam/`, `social/` | `cd marketing/steam-assets && pnpm render:steam <asset\|all>` | `marketing/steam-assets/render.ts` → `../<dir>`; per-asset `dir` in `marketing/steam-assets/templates/_manifest.ts` |
| `video/` | `weekly-music-video` skill (or `marketing/steam-assets` `pnpm trailer:render`) | `scripts/music-video/paths.ts` |
| `shorts/` | `match-shorts` skill | `scripts/match-shorts/paths.ts` |
| `itch/` | hand-curated (publish via `scripts/publish-itch.sh`) | — |

`scripts/match-shorts/` and `scripts/music-video/` stay at the repo-root
`scripts/` because they're shared across games; only the per-game
`steam-assets/` toolchain lives here.

Source art (AI-generated key art, character ref sheets) intentionally stays in
`public/refs/` because templates and the game load it by `/refs/...` URL.

Other games follow the same `<game>/marketing/{steam,social,itch,video,shorts}/`
convention; the pipeline output paths above are shared across games.
