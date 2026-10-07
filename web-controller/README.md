# Bouncy Blobs — phone controller

The page phones open from the game's QR code (`/controller/<room id>`) or by
typing a join code (`/join`). Plain Vite + React: loads instantly on a phone
(~68 KB gzipped), no install. The game (Rust/Bevy) hosts the room on Lobbii
and is the WebRTC offerer; this page joins as a `phone` peer and speaks the
controller JSON protocol (`player_join`, `customization_update`,
`player_input_batch`) over the `data` + `input` channels.

```bash
npm install
npm run dev        # http://localhost:5171 (and your LAN IP for real phones)
npm run build      # → dist/ (static; deploy anywhere, SPA rewrite in vercel.json)
```

Env (`.env.local`, not committed): `VITE_MP_API_KEY` (required),
`VITE_PARTY_API_URL` (default https://www.sterlinglong.me),
`VITE_TURNSTILE_SITE_KEY` (production attestation; falls back to the API key
while the backend doesn't enforce session tokens).

Point the game at a deployment with `BB_CONTROLLER_URL=https://<host>/controller/`.
