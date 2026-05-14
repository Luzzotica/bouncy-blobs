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

  useEffect(() => {
    const room = new RoomService(roomConfig);
    let cancelled = false;
    async function load() {
      try {
        const list = await room.listRooms(GAME_ID);
        if (!cancelled) setLobbies(list);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void load();
    const i = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(i); };
  }, []);

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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", maxWidth: 720, margin: "0 auto", padding: 24, gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <h1 style={{ fontSize: 32 }}>Online Lobbies</h1>
        <Link to="/"><button style={{ padding: "8px 16px" }}>← Home</button></Link>
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
