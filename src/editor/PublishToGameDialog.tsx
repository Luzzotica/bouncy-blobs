import React, { useState } from 'react';
import { EditorState } from './EditorState';
import { getLevelTypes, type LevelType } from '../levels/types';
import { publishMapToGame, slugifyMapId } from '../lib/devMaps';
import { invalidateBuiltinCache } from '../levels/levelRegistry';
import {
  COLORS,
  HAIRLINE,
  modalBackdrop,
  modalCard,
  modalTape,
  paperBtnSm,
  actionBtnSm,
  inputSm,
  pickerLabel,
} from '../theme/uiTheme';

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
  team_racing: 'Chained Together',
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
        <span style={modalTape} />
        <div style={header}>
          <span style={{ color: COLORS.ink, fontSize: 14, fontWeight: 900, textShadow: '2px 2px 0 #c77dff' }}>Publish to Game (dev)</span>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        <p style={{ color: COLORS.inkDim, fontSize: 11, margin: '0 0 12px' }}>
          Writes <code style={code}>public/levels/{idValid ? id : '<id>'}.json</code> and updates the
          manifest so this map ships with the game. Commit the change to deploy it.
        </p>

        <label style={label}>Display Name</label>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={80} style={input} />

        <label style={label}>Map Id / Filename</label>
        <input
          value={id}
          onChange={e => setId(e.target.value)}
          style={{ ...input, borderColor: idValid ? undefined : COLORS.danger }}
        />
        {!idValid && <div style={{ color: COLORS.danger, fontSize: 11, marginTop: 4 }}>Lowercase letters, numbers and dashes only.</div>}
        {idValid && overwrites && (
          <div style={{ color: COLORS.danger, fontSize: 11, marginTop: 4 }}>⚠ Overwrites the existing "{id}" map.</div>
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
                  ...(on ? actionBtnSm(COLORS.lavender, COLORS.ink) : paperBtnSm),
                  width: 'auto', flex: '0 0 auto',
                }}
              >{TYPE_LABELS[t]}</button>
            );
          })}
        </div>

        <label style={{ ...label, display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', letterSpacing: 0 }}>
          <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} />
          Hidden (dev/test scaffolding — won't show in hosting flows)
        </label>

        {err && <div style={{ color: COLORS.danger, fontSize: 12, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={paperBtnSm}>Cancel</button>
          <button
            onClick={submit}
            disabled={busy || !idValid || types.length === 0}
            style={actionBtnSm(COLORS.lavender, COLORS.ink)}
          >
            {busy ? 'Writing…' : overwrites ? 'Overwrite & Publish' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { ...modalBackdrop };
const panel: React.CSSProperties = {
  ...modalCard, position: 'relative', width: 460,
};
const header: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  marginBottom: 12, paddingBottom: 8, borderBottom: '1px solid ' + HAIRLINE,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: COLORS.ink, fontSize: 22, cursor: 'pointer', lineHeight: 1,
};
const label: React.CSSProperties = {
  ...pickerLabel, display: 'block', marginTop: 10, marginBottom: 4,
};
const input: React.CSSProperties = {
  ...inputSm, width: '100%',
};
const code: React.CSSProperties = { color: COLORS.purple, background: COLORS.paperInput, border: '1px solid ' + HAIRLINE, padding: '1px 4px', borderRadius: 3 };
