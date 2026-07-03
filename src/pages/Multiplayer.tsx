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
import { COLORS, TITLE_SHADOW } from "../theme/uiTheme";

// Combined Host + Browse screen. Left column: one name card + host-a-game.
// Right column browses + joins existing lobbies. Shares the home hero
// background and the paper-and-tape sticky-note styling of the rest of the
// game. The display name lives here (single source) and feeds both columns.
export default function Multiplayer() {
  const [displayName, setDisplayName] = useState<string>(getStoredDisplayName());

  // Resolve a sensible default (Steam persona / stored) once on mount.
  useEffect(() => {
    let cancelled = false;
    if (getStoredDisplayName()) return;
    void resolveDefaultDisplayName().then((n) => {
      if (!cancelled && n) {
        setDisplayName(n);
        setStoredDisplayName(n);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const changeName = (v: string) => {
    setDisplayName(v);
    setStoredDisplayName(v);
  };

  return (
    <HomeBackground>
      <div style={content}>
        <div style={headerRow}>
          <Link to="/"><button className="bb-hover-btn" style={homeBtn}>← Home</button></Link>
          <h1 style={pageTitle}>Multiplayer</h1>
        </div>
        <div style={columns}>
          <div style={leftCol}>
            <NameCard name={displayName} onChange={changeName} />
            <HostPanel displayName={displayName} />
          </div>
          <div style={rightCol}><LobbyList displayName={displayName} /></div>
        </div>
      </div>
    </HomeBackground>
  );
}

// ─── Name (left column, top) ──────────────────────────────────────────────────
function NameCard({ name, onChange }: { name: string; onChange: (v: string) => void }) {
  return (
    <div style={{ ...paperCard, transform: "rotate(-0.6deg)" }}>
      <h2 style={cardTitle}>Your Name</h2>
      <input
        data-testid="display-name"
        type="text"
        value={name}
        maxLength={32}
        placeholder="Enter your display name"
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
      />
    </div>
  );
}

// ─── Host (left column) ───────────────────────────────────────────────────────
// Collects the same fields as HostSetupModal, stashes the result, and routes
// to /game (GameMaster consumes `pendingHostSetup` and skips its own modal).
function HostPanel({ displayName }: { displayName: string }) {
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState("Bouncy Lobby");
  const [isPublic, setIsPublic] = useState(false);
  const [password, setPassword] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(8);

  useEffect(() => {
    const prefs = getStoredRoomPrefs();
    if (prefs.roomName) setRoomName(prefs.roomName);
    setIsPublic(prefs.isPublic);
    setMaxPlayers(prefs.maxPlayers);
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
    <form style={{ ...paperCard, transform: "rotate(0.5deg)" }} onSubmit={createGame}>
      <h2 style={cardTitle}>Host a Game</h2>

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
        <RangeSlider min={2} max={8} value={maxPlayers} onChange={setMaxPlayers} />
      </label>

      <label style={{ ...field, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={isPublic}
          onChange={(e) => setIsPublic(e.target.checked)}
          style={{ accentColor: COLORS.lavender, width: 16, height: 16 }}
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
        className="bb-hover-btn"
        data-testid="create-game-button"
        disabled={!canCreate}
        style={{
          ...createBtn,
          background: canCreate ? COLORS.lavender : "#d8cfe2",
          color: canCreate ? COLORS.ink : "#7a6e8c",
          cursor: canCreate ? "pointer" : "not-allowed",
        }}
      >
        Create Game →
      </button>
    </form>
  );
}

// ─── Themed range slider ──────────────────────────────────────────────────────
// Native <input type=range> never lets its fill reach the very edges (the thumb
// is inset by half its width). This draws an explicit fill track from 0→100% so
// the bar visually spans the full width at min/max, with the real input layered
// transparently on top for interaction + keyboard support.
function RangeSlider({ min, max, value, onChange }: {
  min: number; max: number; value: number; onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div style={sliderWrap}>
      <div style={sliderTrack}>
        <div style={{ ...sliderFill, width: `${pct}%` }} />
      </div>
      <div style={{ ...sliderThumb, left: `${pct}%` }} />
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={sliderInput}
      />
    </div>
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
  justifyContent: "flex-start",
  alignItems: "center",
  gap: 20,
  flexShrink: 0,
};

const pageTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "clamp(32px, 5vw, 52px)",
  fontWeight: 900,
  color: COLORS.titleInk,
  transform: "rotate(-1.5deg)",
  textShadow: TITLE_SHADOW,
  letterSpacing: 1,
};

const homeBtn: React.CSSProperties = {
  padding: "10px 18px",
  fontSize: 15,
  fontWeight: 800,
  background: COLORS.paper,
  color: COLORS.ink,
  border: "3px solid #0a0612",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
  letterSpacing: 0.4,
  boxShadow: "0 5px 12px rgba(0,0,0,0.3)",
  transform: "rotate(-2deg)",
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
  flexDirection: "column",
  gap: 18,
};

// Right: the remaining ~3/4, stretched to full height for the scrollable list.
const rightCol: React.CSSProperties = {
  flex: "1 1 0",
  minWidth: 0,
  display: "flex",
};

// Cream paper sticky-note card — matches the Home menu buttons.
const paperCard: React.CSSProperties = {
  position: "relative",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "24px 20px 20px",
  borderRadius: 6,
  background: COLORS.paper,
  border: "4px solid #0a0612",
  boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
};

const cardTitle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 900,
  margin: 0,
  color: COLORS.ink,
  letterSpacing: 0.3,
};

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const fieldLabel: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: COLORS.inkDim,
  marginBottom: 0,
};

const inputStyle: React.CSSProperties = {
  padding: "9px 11px",
  fontSize: 15,
  borderRadius: 4,
  border: "2px solid #0a0612",
  background: COLORS.paperInput,
  color: COLORS.ink,
  fontFamily: "inherit",
};

const createBtn: React.CSSProperties = {
  position: "relative",
  marginTop: 4,
  padding: "14px 20px",
  fontSize: 18,
  fontWeight: 800,
  border: "3px solid #0a0612",
  borderRadius: 4,
  fontFamily: "inherit",
  letterSpacing: 0.4,
  boxShadow: "0 5px 12px rgba(0,0,0,0.3)",
};

// Themed slider pieces.
const sliderWrap: React.CSSProperties = {
  position: "relative",
  height: 22,
  display: "flex",
  alignItems: "center",
};

const sliderTrack: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  height: 10,
  borderRadius: 999,
  background: "#e7ddc4",
  border: "2px solid #0a0612",
  overflow: "hidden",
};

const sliderFill: React.CSSProperties = {
  height: "100%",
  background: COLORS.lavender,
};

const sliderThumb: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: COLORS.paper,
  border: "3px solid #0a0612",
  transform: "translate(-50%, -50%)",
  boxShadow: "0 2px 4px rgba(0,0,0,0.3)",
  pointerEvents: "none",
};

const sliderInput: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  width: "100%",
  margin: 0,
  height: 22,
  opacity: 0,
  cursor: "pointer",
};
