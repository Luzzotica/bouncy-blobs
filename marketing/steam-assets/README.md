# Steam Assets

Scaffold for a single game's Steam store + library art and copy.

## Quick start

```bash
pnpm install
pnpm exec playwright install chromium   # only once
pnpm render:steam all       # render every PNG to ../marketing/{steam,social}/
pnpm render:steam header    # render a single asset
pnpm trailer:studio         # preview trailer in Remotion
pnpm trailer:render         # ../marketing/video/trailer.mp4
pnpm copy:build | pbcopy    # assemble Steam BBCode, copy to clipboard
```

## Where things live

- `templates/_shared.tsx` — palette, fonts, title, tagline (single source of truth)
- `templates/*.tsx` — one React component per Steam asset
- `templates/_manifest.ts` — asset name → component + exact dimensions
- `src/main.tsx` + `index.html` — Vite host that mounts `?asset=<name>`
- `render.ts` — Playwright orchestrator
- `remotion/` — trailer composition
- `copy/*.md` — every Steam text field, with character limits in HTML comments
- `../marketing/{steam,social}/` — gitignored render targets (per-asset `dir` in `_manifest.ts`)

## Adding a new asset

1. Add a React component in `templates/`.
2. Register it in `templates/_manifest.ts` with its exact pixel dimensions.
3. `pnpm render:steam <new-name>`.

Asset dimensions and Steam guideline rules: see `.claude/skills/steam-assets/SKILL.md`.
