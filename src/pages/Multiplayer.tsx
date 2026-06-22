import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import HomeBackground from "../components/HomeBackground";
import LobbyList from "../components/LobbyList";
import type { HostSetupResult } from "../components/HostSetupModal";
import {
  getStoredDisplayName,
  setStoredDisplayName,
  getStoredRoomPrefs,
  setStoredRoomPrefs,
  resolveDefaultDisplayName,
} from "../lib/userProfile";

// Combined Host + Browse screen. Left column hosts a new game; right column
// browses + joins existing lobbies. Shares the home hero background.
export default function Multiplayer() {
  return (
    <HomeBackground>
      <div style={content}>
        <div style={headerRow}>
          <h1 style={pageTitle}>Multiplayer</h1>
          <Link to="/"><button style={homeBtn}>← Home</button></Link>
        </div>
        <div style={columns}>
          <div style={leftCol}><HostPanel /></div>
          <div style={rightCol}><LobbyList /></div>
        </div>
      </div>
    </HomeBackground>
  );
}

// ─── Host (left column) ───────────────────────────────────────────────────────
// Collects the same fields as HostSetupModal, stashes the result, and routes
// to /game (GameMaster consumes `pendingHostSetup` and skips its own modal).
function HostPanel() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState<string>(getStoredDisplayName());
  const [roomName, setRoomName] = useState("Bouncy Lobby");
  const [isPublic, setIsPublic] = useState(false);
  const [password, setPassword] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(8);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const name = await resolveDefaultDisplayName();
      const prefs = getStoredRoomPrefs();
      if (cancelled) return;
      if (name && !getStoredDisplayName()) setDisplayName(name);
      if (prefs.roomName) setRoomName(prefs.roomName);
      setIsPublic(prefs.isPublic);
      setMaxPlayers(prefs.maxPlayers);
    })();
    return () => { cancelled = true; };
  }, []);

  const canCreate = displayName.trim().length > 0 && roomName.trim().length > 0;

  function createGame(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    const room = roomName.trim();
    if (!name || !room) return;
    setStoredDisplayName(name);
    setStoredRoomPrefs({ roomName: room, isPublic, maxPlayers });
    const config: HostSetupResult = {
      displayName: name,
      roomName: room,
      isPublic,
      password: isPublic ? password : "",
      maxPlayers,
    };
    sessionStorage.setItem("pendingHostSetup", JSON.stringify(config));
    navigate("/game");
  }

  return (
    <form style={panel} onSubmit={createGame}>
      <h2 style={{ fontSize: 22, margin: 0, color: "#fffae6" }}>Host a Game</h2>

      <label style={field}>
        <span style={fieldLabel}>Your name</span>
        <input
          data-testid="host-display-name"
          type="text"
          value={displayName}
          maxLength={32}
          placeholder="Enter your display name"
          onChange={(e) => setDisplayName(e.target.value)}
          style={inputStyle}
        />
      </label>

      <label style={field}>
        <span style={fieldLabel}>Room name</span>
        <input
          data-testid="host-room-name"
          type="text"
          value={roomName}
          maxLength={40}
          placeholder="Bouncy Lobby"
          onChange={(e) => setRoomName(e.target.value)}
          style={inputStyle}
        />
      </label>

      <label style={field}>
        <span style={fieldLabel}>Max players: {maxPlayers}</span>
        <input
          type="range"
          min={2}
          max={8}
          value={maxPlayers}
          onChange={(e) => setMaxPlayers(Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>

      <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
        />
        <span style={{ ...fieldLabel, marginBottom: 0 }}>
          List publicly (others can find it without a code)
        </span>
      </label>

      {isPublic && (
        <label style={field}>
          <span style={fieldLabel}>Password (optional)</span>
          <input
            type="text"
            value={password}
            maxLength={40}
            placeholder="Leave blank for open lobby"
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>
      )}

      <button
        type="submit"
        data-testid="create-game-button"
        disabled={!canCreate}
        style={{
          ...createBtn,
          background: canCreate ? "#c77dff" : "#555",
          cursor: canCreate ? "pointer" : "not-allowed",
        }}
      >
        Create Game →
      </button>
    </form>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const content: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  padding: "24px clamp(16px, 4vw, 48px)",
  gap: 16,
  overflowY: "auto",
};

const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexShrink: 0,
};

const pageTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(32px, 5vw, 52px)",
  fontWeight: 900,
  color: "#fffae6",
  transform: "rotate(-1.5deg)",
  textShadow: "4px 4px 0 #c77dff, -2px -2px 0 #0a0612, 2px -2px 0 #0a0612, -2px 2px 0 #0a0612, 2px 2px 0 #0a0612",
  letterSpacing: 1,
};

const homeBtn: React.CSSProperties = {
  padding: "10px 18px",
  fontSize: 15,
};

const columns: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  gap: 20,
  alignItems: "stretch",
};

// Left: narrow (~1/4), only as tall as its content, pinned in place while the
// lobby list scrolls.
const leftCol: React.CSSProperties = {
  flex: "0 0 clamp(240px, 24%, 340px)",
  alignSelf: "flex-start",
  position: "sticky",
  top: 0,
  display: "flex",
};

// Right: the remaining ~3/4, stretched to full height for the scrollable list.
const rightCol: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  display: "flex",
};

const panel: React.CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 20,
  borderRadius: 12,
  background: "rgba(15, 10, 24, 0.82)",
  border: "1px solid rgba(199,125,255,0.25)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  backdropFilter: "blur(4px)",
};

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const fieldLabel: React.CSSProperties = {
  fontSize: 13,
  color: "#cbb8e6",
  marginBottom: 0,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  fontSize: 15,
  borderRadius: 6,
  border: "1px solid #444",
  background: "#0f0a18",
  color: "#fff",
};

const createBtn: React.CSSProperties = {
  marginTop: 4,
  padding: "14px 20px",
  fontSize: 18,
  fontWeight: 700,
  color: "#0a0612",
  border: "none",
  borderRadius: 8,
};
