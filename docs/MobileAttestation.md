# Mobile Attestation

How the iOS/Android app proves itself to the arcadii backend and keeps
multiplayer working when `ENFORCE_SESSION_TOKENS` turns on. Implemented
2026-07-14 (this doc is the process record + the hardening roadmap).

## The model: BYO attestation via player JWT (`platform: "player"`)

Mobile can't use the other platforms' proofs — Turnstile needs a real web
origin, Steam tickets need steamworks (feature-gated off on mobile). Instead
the app attests with an **arcadii player JWT**, which the backend already
treats as first-class attestation:

```
app                      arcadii backend
───                      ───────────────
CloudContent.getPlayerToken()
  └─ POST /api/players/login {provider:"anon", device_id}   (silent, cached 24h)
       ←  player_token (HS256 JWT: t:player, pid, proj, exp)

RoomService.ensureToken()  (lazy, ~10 min session TTL)
  └─ POST /api/auth/token {platform:"player", attestation: player_token, device_id}
       backend: verifyPlayerToken() → claims.proj must match the API key's project
       ←  session_token (Bearer, 10 min, sub = "player:<id>")

all rooms/signalling/TURN calls send the Bearer session token
```

If the device previously signed in (arcade SSO `window.__ARCADE_TOKEN__`,
email), the anon device identity is linked to that account, so the attested
`player:<id>` is the same player — sign-in upgrades attestation identity for
free. If the backend is unreachable, `getPlayerToken()` returns null and the
exchange falls back to the raw API key (only works while enforcement is off).

## What was changed (2026-07-14)

| Layer | Change |
|---|---|
| `packages/party-kit/src/cloudContent.ts` | New public `getPlayerToken()`: returns the cached player JWT, silently re-logging-in when it's missing/expired/within 5 min of expiry (`jwtNearExpiry`). Mirrored to all games via `scripts/sync-party-kit.mjs`. |
| `bouncy-blobs/src/lib/partyConfig.ts` | Mobile platform is now `"player"` (was `"web"` + null attestation). `attest()` returns `cloudForAttest().getPlayerToken()` — a lazy CloudContent that shares the localStorage token cache with the SSO/level-registry instances. |
| `hexii/lib/api/origin.ts` | `isTauriOrigin()`: `tauri://localhost` (iOS/macOS) and `http(s)://tauri.localhost` (Android/Windows) are native-client markers browsers can never forge — they now defer to attestation like a missing Origin instead of failing the web allowlist. Tests in `tests/auth/session-token.test.ts`. |

Backend verification (`hexii/app/api/auth/token/route.ts` `platform === "player"`
branch + `verifyPlayerToken`) already existed — no changes needed there.

Verified end-to-end against production (www.sterlinglong.me): anon login →
player token → session token with `player_id: player:<uuid>`; garbage
attestation → 403; the minted Bearer authorizes `/api/rooms` with **no API
key**, i.e. the path survives enforcement.

## Enforcement runbook

1. Deploy the hexii change (`isTauriOrigin`) to Vercel.
2. Ship mobile + web builds that mint session tokens (this branch; web needs
   `VITE_TURNSTILE_SITE_KEY` + backend `TURNSTILE_SECRET` configured).
3. Canary: set `require_session_tokens = true` on ONE project row (per-project
   override in the `projects` table) and play a full mobile session.
4. Global: set `ENFORCE_SESSION_TOKENS=true` in Vercel env. Rollback = unset.
   Watch for 401 "Session token required" spikes in logs — that's a client
   still on the API-key fallback.

## Threat model & the phase-2 upgrade (device integrity)

What player-JWT attestation gives you today:
- Every session is bound to a rate-limitable, bannable `player:<id>`.
- The web allowlist still locks browser keys to your origins; Steam still
  proves game ownership.

What it does NOT give you: proof the caller is your genuine app binary —
`/api/players/login` (anon) is open to anyone holding the public API key.
That's acceptable at current scale (same exposure as the API-key fallback,
but now attributable). When abuse appears, harden the **login** call itself
with platform device integrity — the attestation dispatch already stubs
`platform: "mobile"` for this (`hexii/lib/api/attest/index.ts`):

- **iOS — App Attest** (`DCAppAttestService`): Tauri plugin exposing
  `generateKey`/`attestKey`/`generateAssertion` as invoke commands registered
  in the mobile handler (`src-tauri/src/lib.rs`, the `#[cfg(not(feature =
  "steam"))]` block — parallel to `steam_auth_ticket` on desktop). Backend:
  verify the attestation object's cert chain to Apple's App Attest root CA,
  keyed by Team ID + bundle id (`me.sterlinglong.bouncyblobs`); the
  `apple_bundle_id` project column already exists.
- **Android — Play Integrity**: Tauri plugin calling
  `IntegrityManager.requestIntegrityToken`; backend decrypts/verifies via the
  Play Integrity API (needs a Google Cloud service account + the app on a
  Play track — internal testing is enough). `jose` is already a backend dep
  for JWKS verification.
- Slot both in as `case "mobile"` verifiers in `lib/api/attest/index.ts`
  (mirror `turnstile.ts`/`steam.ts`: BYO project credential first,
  env-var fallback, fail closed in prod), then have `players/login` demand
  the integrity proof for new mobile devices.

Prerequisites that block phase 2 (why it isn't built yet): Apple Developer
team + provisioning, Play Console app + service account, and real devices —
none of which exist for this app yet (see docs/MobileRelease.md).

## Testing

```sh
# Full path against prod (replace $KEY with VITE_MP_API_KEY):
PT=$(curl -s -X POST https://www.sterlinglong.me/api/players/login \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"provider":"anon","device_id":"attest-smoke"}' | jq -r .player_token)
curl -s -X POST https://www.sterlinglong.me/api/auth/token \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d "{\"platform\":\"player\",\"attestation\":\"$PT\"}" | jq .
# expect: session_token + player_id "player:<uuid>"
```

- Backend units: `npm run test` in hexii (origin + token suites).
- In-app: run `npm run ios:dev` / `android:dev`, host a lobby, and check the
  token exchange in the network log — POST `/api/auth/token` body should say
  `"platform":"player"` with a JWT attestation, and the response should carry
  `player_id`.
