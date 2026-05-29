import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { RoomService } from "../lib/party";
import type { RoomSummary } from "../lib/party";
import { roomConfig, GAME_ID } from "../lib/partyConfig";

const PENDING_JOIN_KEY = "pendingLobbyJoin";

export interface PendingJoin {
  room_id: string;
  display_name: string;
  password: string;
}

export function getPendingJoin(): PendingJoin | null {
  try {
    const raw = sessionStorage.getItem(PENDING_JOIN_KEY);
    return raw ? (JSON.parse(raw) as PendingJoin) : null;
  } catch {
    return null;
  }
}

export function clearPendingJoin(): void {
  sessionStorage.removeItem(PENDING_JOIN_KEY);
}

export default function LobbyBrowser() {
  const navigate = useNavigate();
  const [lobbies, setLobbies] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const room = new RoomService(roomConfig);
    let cancelled = false;
    async function load() {
      try {
        setRefreshing(true);
        const list = await room.listRooms(GAME_ID);
        if (!cancelled) setLobbies(list);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    }
    void load();
    const i = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(i); };
  }, [refreshTick]);

  async function join(lobby: RoomSummary) {
    let password = "";
    if (lobby.is_password_protected) {
      password = window.prompt("This lobby is password-protected. Enter password:") ?? "";
      if (!password) return;
    }
    const displayName = window.prompt("Display name for your screen:") ?? "Screen";
    setBusy(true);
    try {
      sessionStorage.setItem(
        PENDING_JOIN_KEY,
        JSON.stringify({ room_id: lobby.room_id, display_name: displayName, password } satisfies PendingJoin),
      );
      navigate("/online-guest");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Join a private (unlisted) lobby by typing its join code. The room
   * service has a public `lookupByCode` endpoint that returns a
   * RoomSummary even for private rooms — we then funnel through the
   * same `join()` flow as picking from the listing so password +
   * display-name prompts behave identically.
   */
  async function joinByCode() {
    const raw = window.prompt("Enter the room code to join:")?.trim();
    if (!raw) return;
    setError(null);
    setBusy(true);
    try {
      const room = new RoomService(roomConfig);
      const summary = await room.lookupByCode(raw);
      await join(summary);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      setError(
        msg.includes("404") || msg.toLowerCase().includes("no active")
          ? `No active game found with code "${raw}"`
          : `Couldn't look up code "${raw}": ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", maxWidth: 720, margin: "0 auto", padding: 24, gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <h1 style={{ fontSize: 32 }}>Online Lobbies</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            data-testid="refresh-lobbies-button"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={busy || refreshing}
            style={{ padding: "8px 16px" }}
            title="Refresh lobby list"
          >
            {refreshing ? "⏳ Refreshing…" : "🔄 Refresh"}
          </button>
          <button
            data-testid="enter-room-code-button"
            onClick={joinByCode}
            disabled={busy}
            style={{ padding: "8px 16px", background: "#5dd6ff", color: "#0a0612", fontWeight: 600 }}
            title="Join a private lobby by typing its join code"
          >
            🔑 Enter Code
          </button>
          <Link to="/"><button style={{ padding: "8px 16px" }}>← Home</button></Link>
        </div>
      </div>
      {error && <div style={{ color: "#f66", flexShrink: 0 }}>{error}</div>}
      <div data-testid="lobby-list" style={{ flex: 1, minHeight: 0, overflowY: "auto", borderRadius: 8, border: "1px solid #333" }}>
        {lobbies.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#888" }}>
            No public lobbies yet. <Link to="/game" style={{ color: "#c77dff" }}>Host one</Link>!
          </div>
        )}
        {lobbies.map((l) => (
          <div key={l.room_id} data-testid={`lobby-row-${l.join_code}`} style={{
            padding: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderTop: "1px solid #222",
          }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {l.is_password_protected && <span title="Password protected" style={{ marginRight: 6 }}>🔒</span>}
                {l.display_name || "Untitled lobby"}
              </div>
              <div style={{ color: "#888", fontSize: 13 }}>
                {l.peer_count}/{l.max_peers} peers · code {l.join_code}
              </div>
            </div>
            <button
              onClick={() => join(l)}
              disabled={busy || l.peer_count >= l.max_peers}
              style={{ padding: "10px 20px", background: "#c77dff" }}
            >
              {l.peer_count >= l.max_peers ? "Full" : "Join"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
