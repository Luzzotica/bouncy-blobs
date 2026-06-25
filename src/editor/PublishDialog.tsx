import React, { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { EditorState } from './EditorState';
import { getLevelTypes } from '../levels/types';
import { stagingDirForMap, writeLocalMap } from '../lib/localMaps';
import {
  publishToWorkshop,
  updateWorkshopItem,
  type WorkshopVisibility,
} from '../lib/workshopApi';
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
  onClose: () => void;
  onPublished: (workshopId: string) => void;
}

export default function PublishDialog({ state, onClose, onPublished }: Props) {
  const [title, setTitle] = useState(state.level.name || 'Untitled');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<WorkshopVisibility>('public');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pickPreview = async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        filters: [{ name: 'Preview image', extensions: ['png', 'jpg', 'jpeg'] }],
      });
      if (typeof picked === 'string') setPreviewPath(picked);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  };

  // Auto-tag with the level's modes.
  const tags = getLevelTypes(state.level);

  const handleSubmit = async () => {
    setErr(null);
    setBusy(true);
    try {
      // Ensure level is persisted locally first.
      const save = await writeLocalMap({
        id: state.localId ?? undefined,
        workshopId: state.workshopId,
        level: { ...state.level, name: title },
      });
      state.localId = save.id;
      state.level.name = title;

      const contentDir = await stagingDirForMap(save.id);
      const meta = {
        title,
        description,
        tags,
        visibility,
        contentDir,
        previewPath: previewPath ?? undefined,
        changeNote: state.workshopId ? `Updated ${new Date().toLocaleString()}` : 'Initial release',
      };

      const result = state.workshopId
        ? await updateWorkshopItem(state.workshopId, meta)
        : await publishToWorkshop(meta);

      // Persist new workshop id back into the local map file.
      await writeLocalMap({
        id: save.id,
        workshopId: result.workshopId,
        level: state.level,
      });

      if (result.needsLegalAgreement) {
        alert(
          'Steam needs you to accept the Workshop Legal Agreement before your item is visible. ' +
          'Opening the Workshop page in the Steam overlay.',
        );
      }
      onPublished(result.workshopId);
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
          <span style={{ color: COLORS.ink, fontSize: 14, fontWeight: 900, textShadow: '2px 2px 0 #c77dff' }}>
            {state.workshopId ? 'Update Workshop Item' : 'Publish to Steam Workshop'}
          </span>
          <button onClick={onClose} style={closeBtn}>×</button>
        </div>

        <label style={label}>Title</label>
        <input value={title} onChange={e => setTitle(e.target.value)} maxLength={128} style={input} />

        <label style={label}>Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={5}
          maxLength={4000}
          style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }}
        />

        <label style={label}>Visibility</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['public', 'friends', 'private'] as WorkshopVisibility[]).map(v => (
            <button
              key={v}
              onClick={() => setVisibility(v)}
              style={{
                ...(visibility === v ? actionBtnSm(COLORS.lavender, COLORS.ink) : paperBtnSm),
                flex: 1,
                textTransform: 'capitalize',
              }}
            >{v}</button>
          ))}
        </div>

        <label style={label}>Preview Image (PNG/JPG, max 1MB)</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={pickPreview} style={{ ...paperBtnSm, flex: '0 0 auto' }}>
            {previewPath ? 'Change…' : 'Choose Image…'}
          </button>
          <div style={{ color: COLORS.inkFaint, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={previewPath ?? ''}>
            {previewPath ? previewPath.split(/[\\/]/).pop() : '(no preview selected)'}
          </div>
          {previewPath && (
            <button onClick={() => setPreviewPath(null)} style={{ ...paperBtnSm, padding: '4px 10px' }}>Clear</button>
          )}
        </div>

        <div style={{ color: COLORS.inkDim, fontSize: 11, marginTop: 10 }}>
          Tags: {tags.length ? tags.join(', ') : '(none)'}
        </div>

        {err && <div style={{ color: COLORS.danger, fontSize: 12, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={paperBtnSm}>Cancel</button>
          <button onClick={handleSubmit} disabled={busy} style={actionBtnSm(COLORS.lavender, COLORS.ink)}>
            {busy ? 'Uploading…' : state.workshopId ? 'Update' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { ...modalBackdrop };
const panel: React.CSSProperties = {
  ...modalCard, position: 'relative', width: 480,
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
