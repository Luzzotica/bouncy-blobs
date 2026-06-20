import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { COLOR_PALETTE } from '../constants/customization';
import { getAllFacePresets } from '../renderer/faceRenderer';
import { PERSONALITY_LABELS, type PersonalityName } from '../game/aiPersonalities';
import type { LevelData, LevelType } from '../levels/types';
import { features } from '../config/featureFlags';
import MapPickerModal from './MapPickerModal';
import FaceSwatch from './FaceSwatch';

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
  source: 'builtin' | 'local' | 'workshop';
  /** Modes this map is designed for. Local/Workshop maps default to all modes
   * since we can't introspect a stored level without loading it. */
  levelTypes: LevelType[];
}

export const MODE_OPTIONS: { id: LevelType; label: string }[] = [
  { id: 'solo_racing', label: 'Racing' },
  // Chained Climb is gated on the `chainedClimb` feature flag (hidden in demo
  // builds). Party remains hidden until its mode is fixed up.
  ...(features.chainedClimb ? [{ id: 'team_racing' as LevelType, label: 'Chained Climb' }] : []),
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
  width: 300,
  height: '100%',
  background: '#181a24',
  borderRight: '1px solid #2a2d3a',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  fontSize: 13,
  color: '#ddd',
};

const sectionStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderBottom: '1px solid #232634',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const selectStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  background: '#222536',
  color: '#fff',
  border: '1px solid #353a4c',
  borderRadius: 4,
};

const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  background: '#2a2d3a',
  color: '#fff',
  border: '1px solid #353a4c',
  borderRadius: 4,
  cursor: 'pointer',
};

const startButtonStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 16,
  fontWeight: 700,
  background: '#2d6a4f',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  width: '100%',
};

// ── Face swatch (canvas preview) ───────────────────────────────────────────
// ── Component ──────────────────────────────────────────────────────────────
export default function LobbyPanel(props: LobbyPanelProps) {
  const {
    joinCode,
    players, maxPlayers, onChangeMaxPlayers,
    mapOptions, selectedMapId, onChangeMap,
    selectedModeId, onChangeMode, loadLevel,
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
        <Link to="/" style={{ color: '#888', fontSize: 12, textDecoration: 'none' }}>← Home</Link>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Bouncy Lobby</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={labelStyle}>Join</span>
          <code data-testid="join-code" style={{
            background: '#222',
            padding: '3px 8px',
            borderRadius: 4,
            fontSize: 14,
            letterSpacing: 2,
            color: '#fff',
          }}>{joinCode || '…'}</code>
        </div>
      </div>

      {/* Players */}
      <div style={sectionStyle}>
        <div style={labelStyle}>Players ({players.length} / {maxPlayers})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {players.length === 0 && (
            <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
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
                background: '#1f2230',
                borderRadius: 4,
              }}
            >
              <FaceSwatch faceId={p.faceId} color={p.color} size={24} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ fontSize: 10, color: '#666' }}>{p.kind}</span>
              {p.kind === 'bot' && (
                <button
                  onClick={() => onRemoveBot(p.playerId)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#888',
                    cursor: 'pointer',
                    fontSize: 14,
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
            data-testid="add-bot"
            onClick={() => onAddBot()}
            disabled={!canAddBot}
            style={{
              ...buttonStyle,
              background: canAddBot ? '#5a189a' : '#333',
              opacity: canAddBot ? 1 : 0.5,
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
              <div style={{ fontSize: 12, color: '#888', fontStyle: 'italic' }}>
                No maps available for this mode.
              </div>
            );
          }
          return (
            <button
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
                    background: '#5a189a',
                    color: '#fff',
                    borderRadius: 8,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}>Custom</span>
                )}
                <span style={{ color: '#888' }}>▾</span>
              </span>
            </button>
          );
        })()}
      </div>

      {/* Local player */}
      <div style={sectionStyle}>
        <label style={labelStyle}>Play from this laptop</label>
        <button
          data-testid="local-player-toggle"
          onClick={localPlayerJoined ? onLeaveLocal : onJoinLocal}
          style={{
            ...buttonStyle,
            background: localPlayerJoined ? '#2d6a4f' : '#5dd6ff',
            color: localPlayerJoined ? '#fff' : '#000',
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
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      background: '#1f2230',
                      border: selected ? '2px solid #fff' : '1px solid #333',
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
          data-testid="toggle-public"
          onClick={onTogglePublic}
          disabled={visibilityBusy}
          style={{
            ...buttonStyle,
            background: isPublic ? '#2d6a4f' : '#444',
          }}
        >
          {isPublic ? '🌐 Public — anyone can find' : '🔒 Private — code only'}
        </button>
      </div>

      {/* Start */}
      <div style={{ ...sectionStyle, marginTop: 'auto', borderBottom: 'none' }}>
        <button
          data-testid="start-game"
          onClick={onStart}
          disabled={!canStart}
          style={{
            ...startButtonStyle,
            background: canStart ? '#2d6a4f' : '#333',
            cursor: canStart ? 'pointer' : 'not-allowed',
            opacity: canStart ? 1 : 0.5,
          }}
        >
          ▶ START GAME
        </button>
        {!canStart && (
          <div style={{ fontSize: 11, color: '#888', textAlign: 'center' }}>
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
      />
    </div>
  );
}

// Re-export so callers don't need a second import line.
export { PERSONALITY_LABELS };
