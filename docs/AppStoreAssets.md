# App Store assets path (Bouncy Blobs Kids)

**Path known — recipe only.** Do **not** generate a full marketing set unless
Sterling explicitly asks. Companion skill:
`games/.claude/skills/app-store-assets/SKILL.md`. Binary / TestFlight:
`docs/MobileRelease.md` (eng-owned).

## Why this doc exists

GOAL.md DoD: *App Store assets path known (`app-store-assets`) for iPad
screenshots if needed.* When Sterling greenlights store art (typically after
TestFlight feedback), run the recipe below. Until then: **no art production.**

## Skill + generator

| Item | Location |
| --- | --- |
| Skill | `games/.claude/skills/app-store-assets/SKILL.md` |
| Generator | `games/.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs` |
| Output root (created by script) | `bouncy-blobs/marketing/app-store/` |
| Runtime icons (after `tauri icon`) | `bouncy-blobs/src-tauri/icons/` |
| Brand (UI / cream paper) | `bouncy-blobs-ui` + `bouncy-blobs-style` skills; `src/theme/uiTheme.ts` |

### Generate (when Sterling asks)

From `games/bouncy-blobs` (or monorepo games root with `--game`):

```sh
# Plan only (safe anytime):
node ../.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs --dry-run

# Full icons + resized screenshots + tauri icon wiring:
node ../.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs

# Listing art only (no binary icon rewrite):
node ../.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs --skip-tauri-icon

# Override sources:
node ../.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs \
  --icon path/to/square-master.png \
  --screenshots path/to/stills-dir-or-glob
```

Requires ImageMagick `magick` on PATH. Script cover-crops sources into each
device class (no letterboxing).

## Where files land

```
bouncy-blobs/marketing/app-store/
  icon-1024.png              # ASC App Icon (PNG, no alpha)
  icon-512.png               # Play hi-res (optional for now)
  screenshots/
    iphone-6.9/              # 2868×1320 landscape
    iphone-6.7/              # 2796×1290
    iphone-6.5/              # 2778×1284
    ipad-13/                 # 2752×2064  ← primary Kids / iPad path
    ipad-12.9/               # 2732×2048
  play/
    feature-graphic.png      # 1024×500
    phone/                   # 1920×1080
```

Upload map (when listing is ready):

| File / folder | App Store Connect |
| --- | --- |
| `icon-1024.png` | App Information → App Icon |
| `screenshots/ipad-13/*` (+ `ipad-12.9` if needed) | iPad Pro screenshot slots |
| `screenshots/iphone-6.9/*` (etc.) | iPhone slots (at least one class required) |

## iPad sizes that matter for Kids Mode

Kids Mode is **iPad-first** (GOAL.md). Ship at least:

| Class | Landscape px | Folder |
| --- | --- | --- |
| **iPad Pro 13"** | **2752×2064** | `screenshots/ipad-13/` |
| iPad Pro 12.9" | 2732×2048 | `screenshots/ipad-12.9/` |

Also produce iPhone landscape folders via the same skill (Apple wants ≥1 phone
class even if marketing leads with iPad). Match **supported orientations** of
the binary (landscape stills preferred for store; capture portrait only if the
listing will show it).

## Kids Mode shot list (capture recipe)

Prefer **real in-app** stills (device or simulator), cream-paper brand visible,
no pricing / GOTY / platform logos, no fail-state chrome.

| # | Scene | What to show | Route / tip |
| --- | --- | --- | --- |
| 1 | **Home entry** | Big **Kids Mode** sticky (yellow tape hero) on Home | `/` — title + menu column |
| 2 | **Color rail** | Huge floating color chips **above** the playfield on cream sticky + tape | `/kids` — rail selected ring visible |
| 3 | **Playfield + friends** | Soft arena, many colored blobs, kid blob mid-bounce | `/kids` — no dense HUD |
| 4 | **Pick-up delight** | One blob puffed / held (scale squash readable) | Tap/drag friend blob |
| 5 | **ABC beat** (optional) | Letter badge sticky (corner) + open playfield | After a bounce; keep UI readable |

5–8 distinct shots total is enough. Brand: cream `#fffae6` paper, ink border,
colored tape — same as in-game UI (`uiTheme` / style skill). Do **not** invent
a different store chrome.

### Capture sources (priority)

1. **Manual device / Simulator** captures of the shot list above (best for Kids
   Mode — rail + Home hero are new UI).
2. Drop stills into a working folder, e.g.
   `marketing/app-store/source-stills/` (create when capturing; not required
   until Sterling greenlights).
3. Optional: Steam stills under `marketing/steam/` or
   `marketing/steam/screenshots/` if present — good for non-Kids modes; skill
   will cover-crop. Prefer Kids-specific stills for the iPad listing lead.
4. If a Playwright store-shot pipeline exists later (`shots:store` / spectate),
   use it only when it can hit `/` and `/kids` with the rail on-screen.

Run the generator with `--screenshots <dir>` pointing at curated stills.

## Master icon (when regenerating)

Skill source priority:

1. `--icon` / `--from-cover` CLI
2. `marketing/steam/client-icon.png` / `community-icon.png` (if present)
3. Steam cover crop / existing art
4. `src-tauri/icons/icon.png` (last resort)

**Canonical BB master (used 2026-07-19 P0 App Icon):**  
`marketing/steam/v3/client-icon.png` — teal slime blob (matches `bouncy-blobs-style`
blob `#4ac8c8`). Prefer **v3** over **v1** (v1 is legacy apple-green).

```sh
# Icon-only pass (no gameplay stills required):
node ../.claude/skills/app-store-assets/scripts/build-app-store-assets.mjs \
  --icon marketing/steam/v3/client-icon.png \
  --ios-bg "#0a0612"
# → marketing/app-store/icon-1024.png (RGB, no alpha)
# → regenerates src-tauri/icons + syncs gen/apple AppIcon.appiconset
```

**1024 rules:** no transparency, no baked rounded corners, strong center
subject (blob preferred over text-only wordmark). After generate, rebuild the
app so `src-tauri/icons/` and Xcode AppIcon match.

### Brand QA checklist (icon-1024)

| Check | Pass criteria |
| --- | --- |
| Size | Exactly **1024×1024** |
| Alpha | **No** (PNG color type RGB / color_type=2) |
| Corners | Square full-bleed — OS applies mask (no baked round rect) |
| Subject | Teal blob centered, ~10% safe margin |
| Brand | Matches Steam v3 client icon / style skill blob (not v1 green, not wordmark) |

## Explicit non-goals (until Sterling asks)

- Full Steam → ASC campaign batch
- Device-frame mockups, fake reviews, concept art
- Play Store listing push (path is the same skill; iOS/iPad is the Kids lead)
- Replacing eng-owned TestFlight / signing flow

## Checklist when Sterling greenlights

1. Capture Kids shot list on iPad (or high-res sim) → source stills folder.
2. Dry-run generator; then full run (or `--skip-tauri-icon` if binary icons OK).
3. Review `marketing/app-store/screenshots/ipad-13/` + icon-1024 (no alpha).
4. Upload to App Store Connect device classes; keep git copies under
   `marketing/app-store/`.
5. If icons changed: rebuild iOS binary before next TF / release train.
