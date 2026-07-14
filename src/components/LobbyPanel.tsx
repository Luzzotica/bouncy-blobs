import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { COLOR_PALETTE } from '../constants/customization';
import { getAllFacePresets } from '../renderer/faceRenderer';
import { PERSONALITY_LABELS, type PersonalityName } from '../game/aiPersonalities';
import type { LevelData, LevelType } from '../levels/types';
import { features } from '../config/featureFlags';
import MapPickerModal from './MapPickerModal';
import FaceSwatch from './FaceSwatch';
import { COLORS } from '../theme/uiTheme';

export interface PlayerSummary {
  playerId: string;
  name: string;
  color: string;
  faceId: string;
  /** 'bot' shows an × to remove; others are read-only. */
  kind: 'phone' | 'local' | 'bot' | 'guest';
}

export interface MapOption {
  id: string;          // 'builtin:default' | 'local:<uuid>' | 'workshop:<id>'
  name: string;
  source: 'builtin' | 'local' | 'workshop' | 'cloud';
  /** Modes this map is designed for. Local/Workshop maps default to all modes
   * since we can't introspect a stored level without loading it. */
  levelTypes: LevelType[];
}

export const MODE_OPTIONS: { id: LevelType; label: string }[] = [
  { id: 'solo_racing', label: 'Racing' },
  // Chained Together is gated on the `chainedClimb` feature flag (hidden in
  // demo builds). Party remains hidden until its mode is fixed up.
  ...(features.chainedClimb ? [{ id: 'team_racing' as LevelType, label: 'Chained Together' }] : []),
  { id: 'koth',        label: 'King of the Hill' },
];

export interface LobbyPanelProps {
  // Identity / join
  joinCode: string;

  // Players
  players: PlayerSummary[];
  maxPlayers: number;
  onChangeMaxPlayers: (n: number) => void;

  // Map + mode
  mapOptions: MapOption[];
  selectedMapId: string;
  onChangeMap: (id: string) => void;
  selectedModeId: LevelType;
  onChangeMode: (id: LevelType) => void;
  /** Lazily fetch a level's data for the map-picker preview. */
  loadLevel: (mapId: string) => Promise<LevelData>;
  /** Load a shared community level by its share code. */
  onLoadCloudCode?: (code: string) => Promise<void>;

  // AI bots
  onAddBot: (personality?: PersonalityName) => void;
  onRemoveBot: (playerId: string) => void;
  canAddBot: boolean;

  // Local player
  localPlayerJoined: boolean;
  onJoinLocal: () => void;
  onLeaveLocal: () => void;
  localColor: string;
  onChangeLocalColor: (c: string) => void;
  localFaceId: string;
  onChangeLocalFaceId: (id: string) => void;

  // Visibility
  isPublic: boolean;
  visibilityBusy: boolean;
  onTogglePublic: () => void;

  // Start
  canStart: boolean;
  onStart: () => void;
}

// ── Styles ──────────────────────────────────────────────────────────────────
const panelStyle: React.CSSProperties = {
  // Fixed sidebar on desktop; the phone layout stacks the lobby above the
  // canvas and overrides these via CSS vars (see GameMaster.tsx).
  width: 'var(--lobby-panel-width, 300px)',
  height: 'var(--lobby-panel-height, 100%)',
  background: COLORS.paper,
  borderRight: '4px solid #0a0612',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  fontSize: 13,
  color: COLORS.ink,
};

const sectionStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderBottom: '1px solid rgba(10,6,18,0.14)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: COLORS.inkFaint,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const selectStyle: React.CSSProperties = {
  padding: '7px 9px',
  fontSize: 13,
  background: COLORS.paperInput,
  color: COLORS.ink,
  border: '2px solid #0a0612',
  borderRadius: 4,
  fontFamily: 'inherit',
};

const buttonStyle: React.CSSProperties = {
  padding: '7px 12px',
  fontSize: 13,
  fontWeight: 700,
  background: COLORS.paperInput,
  color: COLORS.ink,
  border: '2px solid #0a0612',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const startButtonStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 16,
  fontWeight: 800,
  background: '#5ec27e',
  color: '#0a2417',
  border: '3px solid #0a0612',
  borderRadius: 6,
  cursor: 'pointer',
  width: '100%',
  fontFamily: 'inherit',
  letterSpacing: 0.5,
  boxShadow: '0 5px 12px rgba(0,0,0,0.25)',
};

// ── Face swatch (canvas preview) ───────────────────────────────────────────
// ── Component ──────────────────────────────────────────────────────────────
export default function LobbyPanel(props: LobbyPanelProps) {
  const {
    joinCode,
    players, maxPlayers, onChangeMaxPlayers,
    mapOptions, selectedMapId, onChangeMap,
    selectedModeId, onChangeMode, loadLevel, onLoadCloudCode,
    onAddBot, onRemoveBot, canAddBot,
    localPlayerJoined, onJoinLocal, onLeaveLocal,
    localColor, onChangeLocalColor,
    localFaceId, onChangeLocalFaceId,
    isPublic, visibilityBusy, onTogglePublic,
    canStart, onStart,
  } = props;

  const [mapPickerOpen, setMapPickerOpen] = useState(false);

  const takenColors = new Set(
    players.filter((p) => p.playerId !== 'local-keyboard').map((p) => p.color),
  );
  const takenFaces = new Set(
    players.filter((p) => p.playerId !== 'local-keyboard').map((p) => p.faceId),
  );

  return (
    <div style={panelStyle} data-testid="lobby-panel">
      {/* Header */}
      <div style={sectionStyle}>
        <Link to="/" style={{ color: COLORS.inkFaint, fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>← Home</Link>
        <div style={{ fontSize: 18, fontWeight: 900, color: COLORS.ink }}>Bouncy Lobby</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={labelStyle}>Join</span>
          <code data-testid="join-code" style={{
            background: COLORS.paperInput,
            padding: '3px 8px',
            borderRadius: 4,
            border: '2px solid #0a0612',
            fontSize: 14,
            letterSpacing: 2,
            fontWeight: 800,
            color: COLORS.ink,
          }}>{joinCode || '…'}</code>
        </div>
      </div>

      {/* Players */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Players ({players.length} / {maxPlayers})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {players.length === 0 && (
            <div style={{ color: '#7a6e8c', fontStyle: 'italic', fontSize: 12 }}>
              No players yet — scan the QR code or add an AI bot.
            </div>
          )}
          {players.map((p) => (
            <div
              key={p.playerId}
              data-testid={`player-row-${p.playerId}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 6px',
                background: 'rgba(255,255,255,0.55)',
                border: '1px solid rgba(10,6,18,0.15)',
                borderRadius: 4,
              }}
            >
              <FaceSwatch faceId={p.faceId} color={p.color} size={24} />
              <span style={{ flex: 1, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ fontSize: 10, color: '#8a7da6', textTransform: 'uppercase', letterSpacing: 0.4 }}>{p.kind}</span>
              {p.kind === 'bot' && (
                <button
                  onClick={() => onRemoveBot(p.playerId)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: COLORS.inkFaint,
                    cursor: 'pointer',
                    fontSize: 16,
                    fontWeight: 800,
                    padding: '0 4px',
                  }}
                  title="Remove bot"
                >×</button>
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={labelStyle}>Max</span>
          <input
            data-testid="max-players"
            type="number"
            min={1}
            max={8}
            value={maxPlayers}
            onChange={(e) => onChangeMaxPlayers(Number(e.target.value))}
            style={{ ...selectStyle, width: 56 }}
          />
          <button
            className="bb-hover-btn"
            data-testid="add-bot"
            onClick={() => onAddBot()}
            disabled={!canAddBot}
            style={{
              ...buttonStyle,
              background: canAddBot ? COLORS.lavender : '#d8cfe2',
              color: canAddBot ? COLORS.ink : '#7a6e8c',
              opacity: canAddBot ? 1 : 0.7,
              cursor: canAddBot ? 'pointer' : 'not-allowed',
            }}
            title="Spawn a scripted AI bot"
          >+ AI</button>
        </div>
      </div>

      {/* Mode — picked FIRST so the Map list below can filter to compatible levels */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Mode</label>
        <select
          data-testid="mode-select"
          value={selectedModeId}
          onChange={(e) => onChangeMode(e.target.value as LevelType)}
          style={selectStyle}
        >
          {MODE_OPTIONS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Map — opens a modal with previews. Filtered to maps that support the
          selected mode. */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Map</label>
        {(() => {
          const filtered = mapOptions.filter((m) => m.levelTypes.includes(selectedModeId));
          const currentEntry = filtered.find((m) => m.id === selectedMapId) ?? filtered[0];
          if (filtered.length === 0) {
            return (
              <div style={{ fontSize: 12, color: '#7a6e8c', fontStyle: 'italic' }}>
                No maps available for this mode.
              </div>
            );
          }
          return (
            <button
              className="bb-hover-btn"
              data-testid="map-button"
              onClick={() => setMapPickerOpen(true)}
              style={{
                ...selectStyle,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                justifyContent: 'space-between',
                textAlign: 'left',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentEntry?.name ?? 'Pick a map…'}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {(currentEntry?.source === 'local' || currentEntry?.source === 'workshop') && (
                  <span style={{
                    fontSize: 9,
                    padding: '1px 5px',
                    background: COLORS.lavender,
                    color: COLORS.ink,
                    fontWeight: 800,
                    borderRadius: 8,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}>Custom</span>
                )}
                <span style={{ color: COLORS.inkFaint }}>▾</span>
              </span>
            </button>
          );
        })()}
      </div>

      {/* Local player */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Play from this laptop</label>
        <button
          className="bb-hover-btn"
          data-testid="local-player-toggle"
          onClick={localPlayerJoined ? onLeaveLocal : onJoinLocal}
          style={{
            ...buttonStyle,
            background: localPlayerJoined ? '#5ec27e' : '#5dd6ff',
            color: '#0a0612',
          }}
        >
          {localPlayerJoined ? '🎮 Leave' : '🎮 Join (WASD + Space)'}
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
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      background: c,
                      border: selected ? '3px solid #0a0612' : '1px solid rgba(10,6,18,0.35)',
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
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      background: COLORS.paperInput,
                      border: selected ? '3px solid #0a0612' : '1px solid rgba(10,6,18,0.3)',
                      opacity: taken ? 0.25 : 1,
                      cursor: taken ? 'not-allowed' : 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
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

      {/* Visibility */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Visibility</label>
        <button
          className="bb-hover-btn"
          data-testid="toggle-public"
          onClick={onTogglePublic}
          disabled={visibilityBusy}
          style={{
            ...buttonStyle,
            background: isPublic ? '#5ec27e' : COLORS.paperInput,
            color: isPublic ? '#0a0612' : COLORS.ink,
          }}
        >
          {isPublic ? '🌐 Public — anyone can find' : '🔒 Private — code only'}
        </button>
      </div>

      {/* Start */}
      <div style={{ ...sectionStyle, marginTop: 'auto', borderBottom: 'none' }}>
        <button
          className="bb-hover-btn"
          data-testid="start-game"
          onClick={onStart}
          disabled={!canStart}
          style={{
            ...startButtonStyle,
            background: canStart ? '#5ec27e' : '#d8cfe2',
            color: canStart ? '#0a2417' : '#7a6e8c',
            cursor: canStart ? 'pointer' : 'not-allowed',
            opacity: canStart ? 1 : 0.8,
          }}
        >
          ▶ START GAME
        </button>
        {!canStart && (
          <div style={{ fontSize: 11, color: '#7a6e8c', textAlign: 'center' }}>
            Add at least one player to start.
          </div>
        )}
      </div>

      <MapPickerModal
        open={mapPickerOpen}
        options={mapOptions.filter((m) => m.levelTypes.includes(selectedModeId))}
        currentMapId={selectedMapId}
        onCancel={() => setMapPickerOpen(false)}
        onConfirm={(id) => {
          onChangeMap(id);
          setMapPickerOpen(false);
        }}
        loadLevel={loadLevel}
        onLoadCloudCode={onLoadCloudCode}
      />
    </div>
  );
}

// Re-export so callers don't need a second import line.
export { PERSONALITY_LABELS };
