import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { loadPlayCampaign, type CampaignLevelEntry } from '../lib/campaignRegistry';
import { getBuiltinLevels } from '../levels/levelRegistry';
import { getPlayProgress, isUnlocked, type PlayProgress } from '../lib/playProgress';

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

  return (
    <div style={shell}>
      <div style={topBar}>
        <Link to="/"><button style={backBtn}>← Home</button></Link>
        <h1 style={title}>Play</h1>
        <div style={{ width: 90 }} />
      </div>

      {levels == null ? (
        <span style={{ color: '#888' }}>Loading…</span>
      ) : levels.length === 0 ? (
        <span style={{ color: '#888' }}>No levels yet.</span>
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
                {completed && <span style={tape} />}
                <div style={cardNum}>{i + 1}</div>
                <div style={cardName}>{name}</div>
                <div style={cardMeta}>
                  {!unlocked ? (
                    <span>🔒 Locked</span>
                  ) : completed ? (
                    <>
                      <span style={{ color: '#2d6a4f', fontWeight: 800 }}>✓ Cleared</span>
                      <span style={metaDim}>Best {formatTime(p!.bestTimeMs)}</span>
                      <span style={metaDim}>☠ {p!.deaths}</span>
                    </>
                  ) : (
                    <span style={{ color: '#5a189a', fontWeight: 800 }}>▶ Play</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const shell: React.CSSProperties = {
  position: 'fixed', inset: 0, background: '#0a0612',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  padding: '24px 32px 40px', overflowY: 'auto',
};

const topBar: React.CSSProperties = {
  width: '100%', maxWidth: 1000, display: 'flex', alignItems: 'center',
  justifyContent: 'space-between', marginBottom: 28,
};

const title: React.CSSProperties = {
  margin: 0, fontSize: 44, fontWeight: 900, color: '#fffae6',
  textShadow: '4px 4px 0 #c77dff, -2px -2px 0 #0a0612, 2px 2px 0 #0a0612',
  transform: 'rotate(-1.5deg)',
};

const backBtn: React.CSSProperties = {
  padding: '8px 16px', fontSize: 14, background: '#fffae6', color: '#1a0f2e',
  border: '3px solid #0a0612', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
};

const grid: React.CSSProperties = {
  width: '100%', maxWidth: 1000,
  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 22,
};

const card: React.CSSProperties = {
  position: 'relative', textAlign: 'left',
  background: '#fffae6', color: '#1a0f2e',
  border: '4px solid #0a0612', borderRadius: 6, padding: '20px 20px 16px',
  boxShadow: '0 8px 20px rgba(0,0,0,0.35)', fontFamily: 'inherit',
  display: 'flex', flexDirection: 'column', gap: 8, minHeight: 120,
};

const tape: React.CSSProperties = {
  position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%) rotate(-3deg)',
  width: '55%', height: 14, background: '#c77dff',
  border: '1px solid rgba(0,0,0,0.25)', opacity: 0.85, boxShadow: '0 2px 3px rgba(0,0,0,0.2)',
};

const cardNum: React.CSSProperties = {
  fontSize: 13, fontWeight: 800, color: '#5a189a', letterSpacing: 1,
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
