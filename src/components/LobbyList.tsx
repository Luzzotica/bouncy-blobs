import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RoomService } from "../lib/party";
import type { RoomSummary } from "../lib/party";
import { roomConfig, GAME_ID } from "../lib/partyConfig";
import {
  getStoredDisplayName,
  setStoredDisplayName,
  resolveDefaultDisplayName,
} from "../lib/userProfile";
import { setPendingJoin } from "../lib/pendingJoin";

// Browse + join joinable online lobbies. Self-contained (fetches its own
// list, owns the display-name + password prompt) and fills its parent
// container, so it can drop into the Multiplayer page's right column. On
// join it stashes the pending join and navigates to /online-guest.
export default function LobbyList() {
  const navigate = useNavigate();
  const [lobbies, setLobbies] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Single source of truth for the guest's display name. Pre-filled from
  // localStorage (or Steam persona under Steam); persisted on every change.
  const [displayName, setDisplayName] = useState<string>(getStoredDisplayName());
  const [joinTarget, setJoinTarget] = useState<RoomSummary | null>(null);
  const [joinPassword, setJoinPassword] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (displayName) return;
    void resolveDefaultDisplayName().then((n) => {
      if (!cancelled && n) setDisplayName(n);
    });
    return () => { cancelled = true; };
  }, [displayName]);

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

  function beginJoin(lobby: RoomSummary) {
    if (!displayName.trim()) {
      setError("Enter a display name first");
      return;
    }
    if (lobby.is_password_protected) {
      setJoinTarget(lobby);
      setJoinPassword("");
      return;
    }
    void commitJoin(lobby, "");
  }

  async function commitJoin(lobby: RoomSummary, password: string) {
    const name = displayName.trim();
    if (!name) return;
    setStoredDisplayName(name);
    setBusy(true);
    try {
      setPendingJoin({ room_id: lobby.room_id, display_name: name, password });
      navigate("/online-guest");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function joinByCode() {
    if (!displayName.trim()) {
      setError("Enter a display name first");
      return;
    }
    const raw = window.prompt("Enter the room code to join:")?.trim();
    if (!raw) return;
    setError(null);
    setBusy(true);
    try {
      const room = new RoomService(roomConfig);
      const summary = await room.lookupByCode(raw);
      beginJoin(summary);
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
    <div style={panel}>
      <div style={headerRow}>
        <h2 style={{ fontSize: 22, margin: 0, color: "#fffae6" }}>Lobbies</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            data-testid="refresh-lobbies-button"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={busy || refreshing}
            style={smallBtn}
            title="Refresh lobby list"
          >
            {refreshing ? "⏳" : "🔄"}
          </button>
          <button
            data-testid="enter-room-code-button"
            onClick={joinByCode}
            disabled={busy}
            style={{ ...smallBtn, background: "#5dd6ff", color: "#0a0612", fontWeight: 600 }}
            title="Join a private lobby by typing its join code"
          >
            🔑 Code
          </button>
        </div>
      </div>

      {error && <div style={{ color: "#ff9a9a", fontSize: 13 }}>{error}</div>}

      <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 13, color: "#cbb8e6" }}>Your name</span>
        <input
          data-testid="lobby-display-name"
          type="text"
          value={displayName}
          maxLength={32}
          placeholder="Enter your display name"
          onChange={(e) => {
            const v = e.target.value;
            setDisplayName(v);
            setStoredDisplayName(v);
          }}
          style={inputStyle}
        />
      </label>

      <div data-testid="lobby-list" style={listBox}>
        {lobbies.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#9b8bb5", fontSize: 14 }}>
            No public lobbies yet — host one on the left!
          </div>
        )}
        {lobbies.map((l) => (
          <div key={l.room_id} data-testid={`lobby-row-${l.join_code}`} style={lobbyRow}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#fffae6", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.is_password_protected && <span title="Password protected" style={{ marginRight: 6 }}>🔒</span>}
                {l.display_name || "Untitled lobby"}
              </div>
              <div style={{ color: "#9b8bb5", fontSize: 12 }}>
                {l.peer_count}/{l.max_peers} · code {l.join_code}
              </div>
            </div>
            <button
              onClick={() => beginJoin(l)}
              disabled={busy || l.peer_count >= l.max_peers}
              style={{ ...joinBtn, background: l.peer_count >= l.max_peers ? "#555" : "#c77dff" }}
            >
              {l.peer_count >= l.max_peers ? "Full" : "Join"}
            </button>
          </div>
        ))}
      </div>

      {joinTarget && (
        <div
          data-testid="join-password-backdrop"
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
          }}
          onClick={() => setJoinTarget(null)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const tgt = joinTarget;
              setJoinTarget(null);
              void commitJoin(tgt, joinPassword);
            }}
            style={{
              background: "#1a1525", color: "#fff", padding: 24, borderRadius: 12,
              minWidth: 320, display: "flex", flexDirection: "column", gap: 14,
            }}
          >
            <h3 style={{ margin: 0 }}>Password required</h3>
            <div style={{ color: "#bbb", fontSize: 13 }}>
              {joinTarget.display_name || "Untitled lobby"}
            </div>
            <input
              data-testid="join-password-input"
              type="text"
              autoFocus
              value={joinPassword}
              onChange={(e) => setJoinPassword(e.target.value)}
              placeholder="Enter password"
              style={inputStyle}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setJoinTarget(null)} style={smallBtn}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={!joinPassword}
                style={{
                  ...joinBtn,
                  background: joinPassword ? "#c77dff" : "#555",
                  cursor: joinPassword ? "pointer" : "not-allowed",
                }}
              >
                Join
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

const panel: React.CSSProperties = {
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 20,
  borderRadius: 12,
  background: "rgba(15, 10, 24, 0.82)",
  border: "1px solid rgba(199,125,255,0.25)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  backdropFilter: "blur(4px)",
  minHeight: 0,
};

const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 15,
  borderRadius: 6,
  border: "1px solid #444",
  background: "#0f0a18",
  color: "#fff",
};

const listBox: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.08)",
};

const lobbyRow: React.CSSProperties = {
  padding: 14,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  borderTop: "1px solid rgba(255,255,255,0.06)",
};

const smallBtn: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 14,
};

const joinBtn: React.CSSProperties = {
  padding: "10px 20px",
  background: "#c77dff",
  color: "#0a0612",
  fontWeight: 600,
  flexShrink: 0,
};
