# WebRTC + Supabase in Bouncy Blobs (Godot)

This project exchanges **SDP offers/answers** and **ICE candidates** through your Supabase **`signaling`** table (HTTP polling), matching the shape in `reference/supabase/migrations/20251224000000_add_signaling_table.sql` and the TypeScript flow in `reference/src/services/signalingService.ts`.

## Roles and peers

- **Gamemaster (host)** runs Godot as **multiplayer peer `1`**. It creates a `WebRTCMultiplayerPeer` server and one `WebRTCPeerConnection` for **peer `2`** (the remote participant).
- **Controller (client)** joins as **peer `2`** and connects to **peer `1`**.

Rows use `role` ∈ `gamemaster` | `controller` and `player_id` = `"2"` for the negotiated leg (same as the reference site).

## Session id

`signaling.session_id` is a **foreign key** to `game_sessions(session_id)`. Create a row in `game_sessions` first (your website or SQL), then use that numeric id in the main menu **Session id** field.

## Godot configuration

1. Copy `config/supabase_env.example` to `config/supabase.env`.
2. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (anon key is fine for public signaling with your RLS policies).

## Desktop WebRTC extension

Headless runs may log **“No default WebRTC extension configured.”** For **desktop** exports, install the official **webrtc-native** GDExtension for your platform so `WebRTCPeerConnection` is fully functional. **HTML5** builds use the browser’s WebRTC stack.

## NAT / ICE

STUN servers are set in `net/webrtc_supabase_network.gd` (`stun.l.google.com`). For strict NATs, add TURN URLs and credentials in the same `iceServers` list.

## Remote controller (stub)

The host can receive unreliable input from peers via `Lobby.submit_controller_input(move, expand_pressed)` (RPC). `Lobby.controller_input_received` fires on the host with `sender_peer_id`. Wire this to gameplay (e.g. apply the same vector you would from `Input` for a chosen player authority) when you add a dedicated controller client.
