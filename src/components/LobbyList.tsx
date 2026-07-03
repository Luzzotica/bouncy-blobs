import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RoomService } from "../lib/party";
import type { RoomSummary } from "../lib/party";
import { roomConfig, GAME_ID } from "../lib/partyConfig";
import { setStoredDisplayName } from "../lib/userProfile";
import { setPendingJoin } from "../lib/pendingJoin";
import { COLORS, modalTape as themeModalTape } from "../theme/uiTheme";

// Browse + join joinable online lobbies. Fetches its own list and owns the
// password prompt, but the display name is supplied by the parent (single
// source of truth on the Multiplayer page). Fills its parent container so it
// can drop into the Multiplayer page's right column. On join it stashes the
// pending join and navigates to /online-guest.
export default function LobbyList({ displayName }: { displayName: string }) {
  const navigate = useNavigate();
  const [lobbies, setLobbies] = useState<RoomSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [joinTarget, setJoinTarget] = useState<RoomSummary | null>(null);
  const [joinPassword, setJoinPassword] = useState("");
  const [codeModalOpen, setCodeModalOpen] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  // Drives the drop-in / rip-off paper animation shared by both modals (only
  // one is ever open at a time). `closing` flips the active modal to its
  // rip-off animation; the pending action runs once that animation ends.
  const [closing, setClosing] = useState(false);
  const pendingCloseRef = useRef<null | (() => void)>(null);

  function beginClose(after: () => void) {
    pendingCloseRef.current = after;
    setClosing(true);
  }
  function handleAnimEnd() {
    if (closing && pendingCloseRef.current) {
      const fn = pendingCloseRef.current;
      pendingCloseRef.current = null;
      setClosing(false);
      fn();
    }
  }

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
      setClosing(false);
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

  function openCodeModal() {
    if (!displayName.trim()) {
      setError("Enter a display name first");
      return;
    }
    setError(null);
    setCodeInput("");
    setClosing(false);
    setCodeModalOpen(true);
  }

  async function submitCode() {
    const raw = codeInput.trim();
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
        <h2 style={{ fontSize: 22, fontWeight: 900, margin: 0, color: COLORS.ink }}>Lobbies</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="bb-hover-btn"
            data-testid="refresh-lobbies-button"
            onClick={() => setRefreshTick((t) => t + 1)}
            disabled={busy || refreshing}
            style={smallBtn}
            title="Refresh lobby list"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="bb-hover-btn"
            data-testid="enter-room-code-button"
            onClick={openCodeModal}
            disabled={busy}
            style={{ ...smallBtn, background: "#5dd6ff", color: "#0a0612", fontWeight: 700 }}
            title="Join a private lobby by typing its join code"
          >
            Enter Game Code
          </button>
        </div>
      </div>

      {error && <div style={{ color: COLORS.danger, fontSize: 13, fontWeight: 600 }}>{error}</div>}

      <div data-testid="lobby-list" style={listBox}>
        {lobbies.length === 0 && (
          <div style={{ padding: 24, textAlign: "center", color: "#7a6e8c", fontSize: 14, fontWeight: 600 }}>
            No public lobbies yet — host one on the left!
          </div>
        )}
        {lobbies.map((l) => (
          <div key={l.room_id} data-testid={`lobby-row-${l.join_code}`} style={lobbyRow}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 800, color: COLORS.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {l.is_password_protected && <span title="Password protected" style={{ marginRight: 6 }}>🔒</span>}
                {l.display_name || "Untitled lobby"}
              </div>
              <div style={{ color: COLORS.inkDim, fontSize: 12.5, fontWeight: 600 }}>
                {l.peer_count}/{l.max_peers} · code {l.join_code}
              </div>
            </div>
            <button
              className="bb-hover-btn"
              onClick={() => beginJoin(l)}
              disabled={busy || l.peer_count >= l.max_peers}
              style={{ ...joinBtn, background: l.peer_count >= l.max_peers ? "#d8cfe2" : COLORS.lavender, color: l.peer_count >= l.max_peers ? "#7a6e8c" : COLORS.ink }}
            >
              {l.peer_count >= l.max_peers ? "Full" : "Join"}
            </button>
          </div>
        ))}
      </div>

      {joinTarget && (
        <div
          data-testid="join-password-backdrop"
          style={{ ...modalBackdrop, opacity: closing ? 0 : 1, transition: "opacity 0.25s ease-out" }}
          onClick={() => beginClose(() => setJoinTarget(null))}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onAnimationEnd={handleAnimEnd}
            className={closing ? "modal-paper rip" : "modal-paper slam"}
            onSubmit={(e) => {
              e.preventDefault();
              const tgt = joinTarget;
              beginClose(() => { setJoinTarget(null); void commitJoin(tgt, joinPassword); });
            }}
            style={modalCard}
          >
            <div style={modalTape} />
            <h3 style={modalTitle}>Password required</h3>
            <div style={{ color: COLORS.inkFaint, fontSize: 13, fontWeight: 600 }}>
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
              <button className="bb-hover-btn" type="button" onClick={() => beginClose(() => setJoinTarget(null))} style={smallBtn}>
                Cancel
              </button>
              <button
                className="bb-hover-btn"
                type="submit"
                disabled={!joinPassword}
                style={{
                  ...joinBtn,
                  background: joinPassword ? COLORS.lavender : "#d8cfe2",
                  color: joinPassword ? COLORS.ink : "#7a6e8c",
                  cursor: joinPassword ? "pointer" : "not-allowed",
                }}
              >
                Join
              </button>
            </div>
            <ModalAnimStyle />
          </form>
        </div>
      )}

      {codeModalOpen && (
        <div
          data-testid="code-modal-backdrop"
          style={{ ...modalBackdrop, opacity: closing ? 0 : 1, transition: "opacity 0.25s ease-out" }}
          onClick={() => beginClose(() => setCodeModalOpen(false))}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onAnimationEnd={handleAnimEnd}
            className={closing ? "modal-paper rip" : "modal-paper slam"}
            onSubmit={(e) => { e.preventDefault(); if (codeInput.trim()) beginClose(() => { setCodeModalOpen(false); void submitCode(); }); }}
            style={modalCard}
          >
            <div style={modalTape} />
            <h3 style={modalTitle}>Enter Game Code</h3>
            <div style={{ color: COLORS.inkFaint, fontSize: 13, fontWeight: 600 }}>
              Type the join code shared by the host.
            </div>
            <input
              data-testid="code-input"
              type="text"
              autoFocus
              value={codeInput}
              maxLength={12}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="e.g. ABCD"
              style={{ ...inputStyle, textTransform: "uppercase", letterSpacing: 2, fontWeight: 700 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="bb-hover-btn" type="button" onClick={() => beginClose(() => setCodeModalOpen(false))} style={smallBtn}>
                Cancel
              </button>
              <button
                className="bb-hover-btn"
                type="submit"
                data-testid="code-submit"
                disabled={!codeInput.trim()}
                style={{
                  ...joinBtn,
                  background: codeInput.trim() ? COLORS.lavender : "#d8cfe2",
                  color: codeInput.trim() ? COLORS.ink : "#7a6e8c",
                  cursor: codeInput.trim() ? "pointer" : "not-allowed",
                }}
              >
                Join
              </button>
            </div>
            <ModalAnimStyle />
          </form>
        </div>
      )}
    </div>
  );
}

// Shared drop-in / rip-off paper animation, matching HostSetupModal.
function ModalAnimStyle() {
  return (
    <style>{`
      @keyframes modal-slam-in {
        0%   { transform: translateY(-160vh) rotate(-9deg); opacity: 0; }
        55%  { transform: translateY(24px) rotate(3deg);    opacity: 1; }
        72%  { transform: translateY(-10px) rotate(-1.8deg); }
        86%  { transform: translateY(5px) rotate(0.6deg);    }
        100% { transform: translateY(0) rotate(0deg);        }
      }
      @keyframes modal-rip-off {
        0%   { transform: translateY(0) rotate(0deg) skewX(0deg);     opacity: 1; }
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
  );
}

const modalBackdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(10,6,18,0.6)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalCard: React.CSSProperties = {
  position: "relative",
  background: COLORS.paper,
  color: COLORS.ink,
  padding: "30px 24px 24px",
  borderRadius: 6,
  border: "4px solid #0a0612",
  boxShadow: "0 18px 40px rgba(0,0,0,0.5)",
  minWidth: 320,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const modalTape: React.CSSProperties = themeModalTape;

const modalTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 900,
  color: COLORS.ink,
};

const panel: React.CSSProperties = {
  position: "relative",
  height: "100%",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "24px 20px 20px",
  borderRadius: 6,
  background: COLORS.paper,
  border: "4px solid #0a0612",
  boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
  minHeight: 0,
};

const headerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
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

const listBox: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  borderRadius: 4,
  border: "2px solid rgba(10,6,18,0.25)",
  // Recessed well behind the row cards — dark tint reads correctly on both
  // cream (classic) and blue-stone (cave) paper, unlike the old translucent
  // WHITE wash which went milky on the dark theme.
  background: "rgba(10,6,18,0.18)",
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

// Each lobby is its own raised card so the name + player-count subtext sit
// on a solid surface instead of the translucent well.
const lobbyRow: React.CSSProperties = {
  padding: "12px 14px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 10,
  background: COLORS.paperInput,
  border: "2px solid rgba(10,6,18,0.35)",
  borderRadius: 4,
  boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
  flexShrink: 0,
};

const smallBtn: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 700,
  background: COLORS.paperInput,
  color: COLORS.ink,
  border: "2px solid #0a0612",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
};

const joinBtn: React.CSSProperties = {
  padding: "10px 20px",
  background: COLORS.lavender,
  color: COLORS.ink,
  fontWeight: 800,
  border: "2px solid #0a0612",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "inherit",
  flexShrink: 0,
};
