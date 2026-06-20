import React, { useState } from 'react';
import { EditorState } from './EditorState';
import { getLevelTypes, type LevelType } from '../levels/types';
import { publishMapToGame, slugifyMapId } from '../lib/devMaps';
import { invalidateBuiltinCache } from '../levels/levelRegistry';

interface Props {
  state: EditorState;
  /** Ids already present in the manifest — used to warn about overwrites. */
  existingIds: string[];
  onClose: () => void;
  onPublished: (id: string) => void;
}

const ALL_TYPES: LevelType[] = ['solo_racing', 'koth', 'team_racing', 'party'];
const TYPE_LABELS: Record<LevelType, string> = {
  solo_racing: 'Solo Racing',
  koth: 'King of the Hill',
  team_racing: 'Chained Climb',
  party: 'Party',
};

/**
 * Dev-only dialog: writes the current map into the repo's `public/levels/` and
 * registers it in `manifest.json`, so it ships with the game on the next build.
 */
export default function PublishToGameDialog({ state, existingIds, onClose, onPublished }: Props) {
  const [name, setName] = useState(state.level.name || 'Untitled');
  const [id, setId] = useState(state.builtinId ?? slugifyMapId(state.level.name || 'untitled'));
  const [types, setTypes] = useState<LevelType[]>(() => getLevelTypes(state.level));
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(id);
  const overwrites = existingIds.includes(id);

  const toggleType = (t: LevelType) =>
    setTypes(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]));

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await publishMapToGame({
        id,
        name: name.trim() || id,
        levelTypes: types,
        hidden,
        level: { ...state.level, name: name.trim() || state.level.name },
      });
      state.level.name = name.trim() || state.level.name;
      state.builtinId = id;
      invalidateBuiltinCache();
      onPublished(id);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay}>
      <div style={panel}>
        <div style={header}>
          <span style={{ color: '#ddd', fontSize: 14, fontWeight: 600 }}>Publish to Game (dev)</span>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        <p style={{ color: '#8aa', fontSize: 11, margin: '0 0 12px' }}>
          Writes <code style={code}>public/levels/{idValid ? id : '<id>'}.json</code> and updates the
          manifest so this map ships with the game. Commit the change to deploy it.
        </p>

        <label style={label}>Display Name</label>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={80} style={input} />

        <label style={label}>Map Id / Filename</label>
        <input
          value={id}
          onChange={e => setId(e.target.value)}
          style={{ ...input, borderColor: idValid ? '#2a3a5a' : '#ff5555' }}
        />
        {!idValid && <div style={{ color: '#ff6666', fontSize: 11, marginTop: 4 }}>Lowercase letters, numbers and dashes only.</div>}
        {idValid && overwrites && (
          <div style={{ color: '#e0b04a', fontSize: 11, marginTop: 4 }}>⚠ Overwrites the existing "{id}" map.</div>
        )}

        <label style={label}>Modes</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ALL_TYPES.map(t => {
            const on = types.includes(t);
            return (
              <button
                key={t}
                onClick={() => toggleType(t)}
                style={{
                  ...input, width: 'auto', flex: '0 0 auto', cursor: 'pointer',
                  background: on ? '#7b68ee' : '#2a3a5a', color: '#fff',
                }}
              >{TYPE_LABELS[t]}</button>
            );
          })}
        </div>

        <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0 }}>
          <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />
          Hidden (dev/test scaffolding — won't show in hosting flows)
        </label>

        {err && <div style={{ color: '#ff6666', fontSize: 12, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...btn, background: '#444' }}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !idValid || types.length === 0}
            style={{ ...btn, background: busy || !idValid || types.length === 0 ? '#555' : '#c77dff' }}
          >
            {busy ? 'Writing…' : overwrites ? 'Overwrite & Publish' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
};
const panel: React.CSSProperties = {
  width: 460, background: '#1a2240', border: '1px solid #444', borderRadius: 8,
  padding: 16, boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid #333',
};
const closeBtn: React.CSSProperties = {
  background: 'none', border: 'none', color: '#888', fontSize: 22, cursor: 'pointer', lineHeight: 1,
};
const label: React.CSSProperties = {
  display: 'block', color: '#aaa', fontSize: 11, marginTop: 10, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5,
};
const input: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13, background: '#0f1629',
  border: '1px solid #2a3a5a', borderRadius: 4, color: '#ddd', boxSizing: 'border-box',
};
const btn: React.CSSProperties = {
  padding: '8px 18px', fontSize: 13, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
};
const code: React.CSSProperties = { color: '#c7a7ff', background: '#0f1629', padding: '1px 4px', borderRadius: 3 };
