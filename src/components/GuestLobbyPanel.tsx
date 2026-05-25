import React from 'react';
import { Link } from 'react-router-dom';
import FaceSwatch from './FaceSwatch';
import { COLOR_PALETTE } from '../constants/customization';
import { getAllFacePresets } from '../renderer/faceRenderer';
import { MODE_OPTIONS } from './LobbyPanel';
import type { LobbyStateEvent } from '../lib/multiplayerSnapshot';

interface GuestLobbyPanelProps {
  /** Latest lobby_state message from the host. May be null before the first
   * one arrives. */
  lobbyState: LobbyStateEvent | null;
  /** Steam lobby id or WebRTC room code — purely informational. */
  joinCode: string;
  /** Connection status pill text. */
  phase: 'connecting' | 'connected' | 'host_disconnected' | 'error';

  /** Auto-join handled in OnlineGuest, but we still surface its state to
   * gate when color/face controls render. */
  localPlayerJoined: boolean;
  /** Full exit — leave the room, tear down the manager, and navigate back
   * to the lobby browser. */
  onLeaveGame: () => void;
  localColor: string;
  onChangeLocalColor: (c: string) => void;
  localFaceId: string;
  onChangeLocalFaceId: (id: string) => void;
}

/** Read-only mirror of LobbyPanel rendered on the guest. Everything except
 * the local player's color/face/join controls is display-only — the host
 * picks the map, mode, max players, etc. */
export default function GuestLobbyPanel(props: GuestLobbyPanelProps) {
  const {
    lobbyState, joinCode, phase,
    localPlayerJoined, onLeaveGame,
    localColor, onChangeLocalColor,
    localFaceId, onChangeLocalFaceId,
  } = props;

  const players = lobbyState?.players ?? [];
  const maxPlayers = lobbyState?.maxPlayers ?? 4;
  const takenColors = new Set(players.map((p) => p.color));
  const takenFaces = new Set(players.map((p) => p.faceId));

  const selectedMode = lobbyState?.selectedModeId
    ? MODE_OPTIONS.find((m) => m.id === lobbyState.selectedModeId)?.label ?? lobbyState.selectedModeId
    : '—';
  const selectedMap = lobbyState?.selectedMapId
    ? (lobbyState.mapOptions.find((m) => m.id === lobbyState.selectedMapId)?.name ?? lobbyState.selectedMapId)
    : '—';

  return (
    <div style={panelStyle} data-testid="guest-lobby-panel">
      {/* Header */}
      <div style={sectionStyle}>
        <Link to="/" style={{ color: '#888', fontSize: 12, textDecoration: 'none' }}>← Home</Link>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Joined Lobby</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
            background: phase === 'connected' ? '#7f7' : phase === 'connecting' ? '#fc7' : '#f77',
          }} />
          <span style={{ fontSize: 12, color: '#aaa' }}>{phase}</span>
        </div>
        {joinCode && (
          <code style={{
            background: '#222536', padding: '4px 8px', borderRadius: 4,
            fontSize: 12, color: '#bbb',
          }}>{joinCode}</code>
        )}
      </div>

      {/* Players (read-only) */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Players ({players.length} / {maxPlayers})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {players.length === 0 && (
            <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
              Waiting for roster…
            </div>
          )}
          {players.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '4px 6px', background: '#1f2230', borderRadius: 4,
              }}
            >
              <FaceSwatch faceId={p.faceId} color={p.color} size={24} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ fontSize: 10, color: '#666' }}>{p.kind}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Mode + Map (read-only — host picks these) */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Mode</div>
        <div style={readOnlyValue}>{selectedMode}</div>
      </div>
      <div style={sectionStyle}>
        <div style={labelStyle}>Map</div>
        <div style={readOnlyValue}>{selectedMap}</div>
      </div>

      {/* Visibility (read-only) */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Visibility</div>
        <div style={readOnlyValue}>
          {lobbyState?.isPublic ? '🌐 Public' : '🔒 Private'}
        </div>
      </div>

      {/* Local player — the ONLY interactive section on the guest. */}
      <div style={sectionStyle}>
        <div style={labelStyle}>You</div>
        <button
          data-testid="leave-game"
          onClick={onLeaveGame}
          style={{ ...buttonStyle, background: '#5a189a' }}
          title="Leave the match and return to the lobby browser"
        >
          🚪 Leave Match
        </button>
        {localPlayerJoined && (
          <>
            <div style={labelStyle}>Color</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {COLOR_PALETTE.map((c) => {
                const taken = takenColors.has(c) && c !== localColor;
                const selected = c === localColor;
                return (
                  <button
                    key={c}
                    onClick={() => !taken && onChangeLocalColor(c)}
                    disabled={taken}
                    title={taken ? 'Taken' : c}
                    style={{
                      width: 22, height: 22, borderRadius: '50%',
                      background: c,
                      border: selected ? '2px solid #fff' : '1px solid #333',
                      opacity: taken ? 0.3 : 1,
                      cursor: taken ? 'not-allowed' : 'pointer',
                      padding: 0,
                    }}
                  />
                );
              })}
            </div>
            <div style={labelStyle}>Face</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {getAllFacePresets().map((f) => {
                const taken = takenFaces.has(f.id) && f.id !== localFaceId;
                const selected = f.id === localFaceId;
                return (
                  <button
                    key={f.id}
                    onClick={() => !taken && onChangeLocalFaceId(f.id)}
                    disabled={taken}
                    title={taken ? 'Taken' : f.label}
                    style={{
                      width: 30, height: 30, borderRadius: '50%',
                      background: '#1f2230',
                      border: selected ? '2px solid #fff' : '1px solid #333',
                      opacity: taken ? 0.25 : 1,
                      cursor: taken ? 'not-allowed' : 'pointer',
                      padding: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <FaceSwatch faceId={f.id} color={localColor} size={26} />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div style={{ ...sectionStyle, marginTop: 'auto', borderBottom: 'none' }} />
      {/* Bottom Leave Lobby removed — the top "Leave Match" button now does
          the full exit, so a second Leave control was redundant. */}
    </div>
  );
}

// ── Styles (mirror LobbyPanel for visual consistency) ────────────────────────
const panelStyle: React.CSSProperties = {
  width: 300, height: '100%', background: '#181a24',
  borderRight: '1px solid #2a2d3a', display: 'flex', flexDirection: 'column',
  overflowY: 'auto', fontSize: 13, color: '#ddd',
};
const sectionStyle: React.CSSProperties = {
  padding: '12px 14px', borderBottom: '1px solid #232634',
  display: 'flex', flexDirection: 'column', gap: 8,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5,
};
const readOnlyValue: React.CSSProperties = {
  padding: '6px 8px', fontSize: 13, background: '#1a1d28',
  color: '#aaa', border: '1px solid #2a2d3a', borderRadius: 4,
};
const buttonStyle: React.CSSProperties = {
  padding: '8px 12px', fontSize: 13, color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600,
};
