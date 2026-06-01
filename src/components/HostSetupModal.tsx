import { useEffect, useRef, useState } from "react";
import {
  getStoredRoomPrefs,
  setStoredRoomPrefs,
  resolveDefaultDisplayName,
  setStoredDisplayName,
} from "../lib/userProfile";

export interface HostSetupResult {
  /** Host's own display name — becomes their blob's label and gets
   *  echoed to guests via lobby_state.players[].name. */
  displayName: string;
  /** Human-readable room name shown in the lobby list. */
  roomName: string;
  /** Public rooms appear in the global lobby list; private ones are
   *  join-code only. Passwords are only meaningful when public, since
   *  private rooms already require knowing the code. */
  isPublic: boolean;
  /** Optional password. When non-empty, joiners must supply it. */
  password: string;
  maxPlayers: number;
}

interface Props {
  onSubmit: (result: HostSetupResult) => void;
  onCancel: () => void;
}

export default function HostSetupModal({ onSubmit, onCancel }: Props): JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [roomName, setRoomName] = useState("Bouncy Lobby");
  const [isPublic, setIsPublic] = useState(false);
  const [password, setPassword] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [ready, setReady] = useState(false);
  const [closing, setClosing] = useState(false);
  const pendingCloseRef = useRef<null | (() => void)>(null);

  // Seed defaults from localStorage + Steam persona on mount. Async
  // because the Steam persona invoke is async; rendering with empty
  // fields first and patching once resolved keeps the modal snappy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const name = await resolveDefaultDisplayName();
      const prefs = getStoredRoomPrefs();
      if (cancelled) return;
      if (name) setDisplayName(name);
      if (prefs.roomName) setRoomName(prefs.roomName);
      setIsPublic(prefs.isPublic);
      setMaxPlayers(prefs.maxPlayers);
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  function beginClose(after: () => void) {
    pendingCloseRef.current = after;
    setClosing(true);
  }

  function handleAnimEnd() {
    if (closing && pendingCloseRef.current) {
      const fn = pendingCloseRef.current;
      pendingCloseRef.current = null;
      fn();
    }
  }

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const name = displayName.trim();
    const room = roomName.trim();
    if (!name || !room) return;
    setStoredDisplayName(name);
    setStoredRoomPrefs({ roomName: room, isPublic, maxPlayers });
    beginClose(() => onSubmit({
      displayName: name,
      roomName: room,
      isPublic,
      password: isPublic ? password : "",
      maxPlayers,
    }));
  }

  function cancel() {
    beginClose(onCancel);
  }

  const canSubmit = ready && displayName.trim().length > 0 && roomName.trim().length > 0;

  return (
    <div
      data-testid="host-setup-backdrop"
      style={{ ...backdrop, opacity: closing ? 0 : 1, transition: "opacity 0.25s ease-out" }}
      onClick={cancel}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        onAnimationEnd={handleAnimEnd}
        data-testid="host-setup-modal"
        className={closing ? "modal-paper rip" : "modal-paper slam"}
        style={modal}
      >
        <div style={tape} />
        <button type="button" style={closeBtn} onClick={cancel} aria-label="Cancel hosting">
          ×
        </button>
        <h2 style={heading}>Host a game</h2>

        <label style={fieldLabel}>
          <span style={fieldLabelText}>Your name</span>
          <input
            data-testid="host-setup-display-name"
            type="text"
            value={displayName}
            maxLength={32}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Enter your display name"
            style={inputStyle}
            autoFocus
          />
        </label>

        <label style={fieldLabel}>
          <span style={fieldLabelText}>Room name</span>
          <input
            data-testid="host-setup-room-name"
            type="text"
            value={roomName}
            maxLength={48}
            onChange={(e) => setRoomName(e.target.value)}
            style={inputStyle}
          />
        </label>

        <div style={fieldGroup}>
          <span style={fieldLabelText}>Visibility</span>
          <div style={radioRow}>
            <label style={radioOption}>
              <input
                type="radio"
                name="visibility"
                checked={!isPublic}
                onChange={() => setIsPublic(false)}
                data-testid="host-setup-private"
                style={radioInput}
              />
              Private (join code only)
            </label>
            <label style={radioOption}>
              <input
                type="radio"
                name="visibility"
                checked={isPublic}
                onChange={() => setIsPublic(true)}
                data-testid="host-setup-public"
                style={radioInput}
              />
              Public (in lobby list)
            </label>
          </div>
          {isPublic && (
            <label style={{ ...fieldLabel, marginTop: 10 }}>
              <span style={fieldLabelText}>Password (optional)</span>
              <input
                data-testid="host-setup-password"
                type="text"
                value={password}
                maxLength={32}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no password"
                style={inputStyle}
              />
            </label>
          )}
        </div>

        <label style={fieldLabel}>
          <span style={fieldLabelText}>Max players: {maxPlayers}</span>
          <input
            data-testid="host-setup-max-players"
            type="range"
            min={2}
            max={16}
            value={maxPlayers}
            onChange={(e) => setMaxPlayers(parseInt(e.target.value, 10))}
            style={slider}
          />
        </label>

        <button
          type="submit"
          data-testid="host-setup-submit"
          disabled={!canSubmit}
          style={{
            ...submitBtn,
            opacity: canSubmit ? 1 : 0.55,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          Start hosting
        </button>

        <style>{`
          @keyframes modal-slam-in {
            0%   { transform: translateY(-160vh) rotate(-9deg); opacity: 0; }
            55%  { transform: translateY(24px) rotate(3deg);    opacity: 1; }
            72%  { transform: translateY(-10px) rotate(-1.8deg); }
            86%  { transform: translateY(5px) rotate(0.6deg);    }
            100% { transform: translateY(0) rotate(0deg);        }
          }
          @keyframes modal-rip-off {
            0%   { transform: translateY(0) rotate(0deg) skewX(0deg);    opacity: 1; }
            20%  { transform: translateY(-24px) rotate(5deg) skewX(-2deg); opacity: 1; }
            100% { transform: translateY(-160vh) rotate(14deg) skewX(-4deg); opacity: 0; }
          }
          .modal-paper { transform-origin: 50% 0%; }
          .modal-paper.slam { animation: modal-slam-in 0.55s cubic-bezier(0.34, 1.56, 0.5, 1) both; }
          .modal-paper.rip  { animation: modal-rip-off 0.35s cubic-bezier(0.5, 0, 0.75, 0) both; }
          @media (prefers-reduced-motion: reduce) {
            .modal-paper.slam { animation: none; }
            .modal-paper.rip  { animation: none; opacity: 0; }
          }
        `}</style>
      </form>
    </div>
  );
}

// Backdrop tint matches SettingsModal so the two feel like siblings.
const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(10, 6, 18, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
};

const modal: React.CSSProperties = {
  position: "relative",
  background: "#fffae6",
  color: "#1a0f2e",
  border: "4px solid #0a0612",
  borderRadius: 6,
  padding: "32px 40px 28px",
  minWidth: 380,
  maxWidth: "92vw",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxShadow: "0 12px 50px rgba(0,0,0,0.5)",
  fontFamily: "inherit",
};

const tape: React.CSSProperties = {
  position: "absolute",
  top: -14,
  left: "50%",
  transform: "translateX(-50%) rotate(-2deg)",
  width: 160,
  height: 28,
  background: "rgba(200, 180, 120, 0.78)",
  border: "1px solid rgba(120, 100, 60, 0.4)",
  boxShadow: "0 3px 6px rgba(0,0,0,0.2)",
};

const closeBtn: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 12,
  background: "transparent",
  border: "none",
  color: "#1a0f2e",
  fontSize: 28,
  fontWeight: 900,
  cursor: "pointer",
  lineHeight: 1,
};

const heading: React.CSSProperties = {
  margin: "0 0 12px",
  fontSize: 26,
  fontWeight: 900,
  textAlign: "center",
  textShadow: "2px 2px 0 #c77dff",
};

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const fieldLabelText: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: 0.4,
  color: "#1a0f2e",
  textTransform: "uppercase",
};

const fieldGroup: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px 14px",
  border: "2px dashed rgba(26, 15, 46, 0.35)",
  borderRadius: 4,
};

const radioRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const radioOption: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  color: "#1a0f2e",
};

const radioInput: React.CSSProperties = {
  accentColor: "#5a189a",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: 15,
  fontWeight: 700,
  borderRadius: 4,
  border: "3px solid #0a0612",
  background: "#fffdf3",
  color: "#1a0f2e",
  fontFamily: "inherit",
  letterSpacing: 0.3,
  outline: "none",
};

const slider: React.CSSProperties = {
  width: "100%",
  accentColor: "#c77dff",
  cursor: "pointer",
};

const submitBtn: React.CSSProperties = {
  marginTop: 8,
  padding: "14px 24px",
  background: "#5a189a",
  color: "#fffae6",
  border: "3px solid #0a0612",
  borderRadius: 4,
  fontSize: 17,
  fontWeight: 800,
  letterSpacing: 0.5,
  boxShadow: "0 4px 0 #0a0612, 0 6px 14px rgba(0,0,0,0.3)",
  fontFamily: "inherit",
};
