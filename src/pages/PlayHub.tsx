import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loadPlayCampaign, type CampaignLevelEntry } from '../lib/campaignRegistry';
import { getBuiltinLevels } from '../levels/levelRegistry';
import { getPlayProgress, isUnlocked, type PlayProgress } from '../lib/playProgress';
import {
  getPlayerColor, setPlayerColorSetting,
  getPlayerFaceId, setPlayerFaceIdSetting,
} from '../utils/audioSettings';
import { hasChosenIdentity, markIdentityChosen } from '../utils/identityChosen';
import HomeBackground from '../components/HomeBackground';
import IdentityPicker from '../components/IdentityPicker';
import {
  COLORS, pageContent, headerRow, pageTitle, backBtn, cardTitle, paperCard,
  tape, modalBackdrop, modalCard, modalTape, actionBtn,
} from '../theme/uiTheme';
import { useIsNarrow } from '../lib/useIsNarrow';

function formatTime(ms: number | null): string {
  if (ms == null) return '—';
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${m}:${s.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

export default function PlayHub() {
  const navigate = useNavigate();
  const [levels, setLevels] = useState<CampaignLevelEntry[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<PlayProgress>({});
  const [blobColor, setBlobColor] = useState(() => getPlayerColor());
  const [blobFace, setBlobFace] = useState(() => getPlayerFaceId());
  // First-time players get a one-off "make your blob" prompt before the levels.
  const [firstTime, setFirstTime] = useState(() => !hasChosenIdentity());

  const chooseColor = (hex: string) => { setBlobColor(hex); setPlayerColorSetting(hex); };
  const chooseFace = (id: string) => { setBlobFace(id); setPlayerFaceIdSetting(id); };
  const finishFirstTime = () => { markIdentityChosen(); setFirstTime(false); };

  useEffect(() => {
    setProgress(getPlayProgress());
    loadPlayCampaign()
      .then((c) => setLevels(c.levels))
      .catch((err) => { console.error('Failed to load campaign', err); setLevels([]); });
    // Display-name fallback from the level manifest.
    getBuiltinLevels()
      .then((m) => setNames(Object.fromEntries(m.map((e) => [e.id, e.name]))))
      .catch(() => { /* names fall back to id */ });
  }, []);

  const ids = useMemo(() => (levels ?? []).map((l) => l.id), [levels]);
  // Phone: the blob-customization sidebar stacks above the level grid.
  const isNarrow = useIsNarrow();

  return (
    <HomeBackground>
      <div style={pageContent}>
        <div style={headerRow}>
          <Link to="/"><button className="paper-btn bb-hover-btn" style={backBtn}>← Home</button></Link>
          <h1 style={pageTitle}>Play</h1>
        </div>

        <div style={{ ...mainRow, ...(isNarrow ? { flexDirection: 'column' as const, alignItems: 'stretch' as const } : {}) }}>
          {/* Left: live blob customization */}
          <aside style={{ ...sidePanel, ...(isNarrow ? { flex: 'none', position: 'static' as const, alignSelf: 'stretch' as const } : {}) }}>
            <h2 style={panelHeading}>Your Blob</h2>
            <IdentityPicker
              color={blobColor}
              faceId={blobFace}
              onColorChange={chooseColor}
              onFaceChange={chooseFace}
            />
          </aside>

          {/* Right: level select */}
          <div style={levelsCol}>
            {levels == null ? (
              <span style={dim}>Loading…</span>
            ) : levels.length === 0 ? (
              <span style={dim}>No levels yet.</span>
            ) : (
              <div style={grid}>
                {levels.map((lvl, i) => {
                  const unlocked = isUnlocked(ids, i);
                  const p = progress[lvl.id];
                  const completed = !!p?.completed;
                  const name = lvl.name || names[lvl.id] || lvl.id;
                  return (
                    <button
                      key={lvl.id}
                      className={unlocked ? 'paper-btn' : undefined}
                      data-testid={`play-level-${lvl.id}`}
                      disabled={!unlocked}
                      onClick={() => unlocked && navigate(`/play/level?level=${encodeURIComponent(lvl.id)}`)}
                      style={{
                        ...card,
                        cursor: unlocked ? 'pointer' : 'not-allowed',
                        opacity: unlocked ? 1 : 0.5,
                        filter: unlocked ? 'none' : 'grayscale(0.7)',
                      }}
                    >
                      {completed && <span style={tape(COLORS.lavender)} />}
                      <div style={cardNum}>{i + 1}</div>
                      <div style={cardName}>{name}</div>
                      <div style={cardMeta}>
                        {!unlocked ? (
                          <span>🔒 Locked</span>
                        ) : completed ? (
                          <>
                            <span style={{ color: COLORS.green, fontWeight: 800 }}>✓ Cleared</span>
                            <span style={metaDim}>Best {formatTime(p!.bestTimeMs)}</span>
                            <span style={metaDim}><span style={{ fontSize: 40, lineHeight: 1 }}>☠</span> {p!.deaths}</span>
                          </>
                        ) : (
                          <span style={{ color: COLORS.purple, fontWeight: 800 }}>▶ Play</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {firstTime && (
        <div style={modalBackdrop}>
          <div style={firstTimeCard}>
            <span style={modalTape} />
            <h2 style={modalHeading}>Make your blob!</h2>
            <p style={modalSub}>Pick a colour and some eyes. You can change these any time on this screen.</p>
            <IdentityPicker
              color={blobColor}
              faceId={blobFace}
              onColorChange={chooseColor}
              onFaceChange={chooseFace}
              previewSize={180}
            />
            <button className="paper-btn" style={modalGo} onClick={finishFirstTime}>Let's bounce →</button>
          </div>
        </div>
      )}
    </HomeBackground>
  );
}

// ─── styles (layout-specific; surfaces/buttons come from uiTheme) ───────────────

const mainRow: React.CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', gap: 20, alignItems: 'flex-start',
};

// Narrow, pinned customization panel — mirrors the multiplayer lobby's left column.
const sidePanel: React.CSSProperties = {
  ...paperCard,
  flex: '0 0 clamp(240px, 26%, 320px)',
  alignSelf: 'flex-start',
  position: 'sticky',
  top: 0,
};

const panelHeading: React.CSSProperties = { ...cardTitle, textAlign: 'center' };

const levelsCol: React.CSSProperties = { flex: '1 1 0', minWidth: 0 };

const grid: React.CSSProperties = {
  width: '100%',
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 22,
};

const card: React.CSSProperties = {
  position: 'relative', textAlign: 'left',
  background: COLORS.paper, color: COLORS.ink,
  border: '4px solid #0a0612', borderRadius: 6, padding: '20px 20px 16px',
  boxShadow: '0 8px 20px rgba(0,0,0,0.35)', fontFamily: 'inherit',
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120,
};

const cardNum: React.CSSProperties = {
  fontSize: 13, fontWeight: 800, color: COLORS.purple, letterSpacing: 1,
};

const cardName: React.CSSProperties = {
  fontSize: 22, fontWeight: 900, lineHeight: 1.1,
};

const cardMeta: React.CSSProperties = {
  marginTop: 'auto', display: 'flex', flexWrap: 'wrap', gap: 10,
  fontSize: 13, fontWeight: 700, alignItems: 'center',
};

const metaDim: React.CSSProperties = {
  color: '#555', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const dim: React.CSSProperties = { color: '#cbb8e0', fontWeight: 700 };

// First-time picker modal — theme modal card + a scroll cap for the tall picker.
const firstTimeCard: React.CSSProperties = {
  ...modalCard, width: 'min(360px, 92vw)', maxHeight: '90vh', overflowY: 'auto',
  display: 'flex', flexDirection: 'column',
};

const modalHeading: React.CSSProperties = {
  margin: '0 0 6px', fontSize: 26, fontWeight: 900, textAlign: 'center',
  textShadow: '2px 2px 0 #c77dff',
};

const modalSub: React.CSSProperties = {
  margin: '0 0 18px', fontSize: 13, color: '#555', textAlign: 'center', fontWeight: 600,
};

const modalGo: React.CSSProperties = { ...actionBtn(COLORS.purple), width: '100%', marginTop: 20 };
