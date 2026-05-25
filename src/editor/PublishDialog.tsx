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
        <div style={header}>
          <span style={{ color: '#ddd', fontSize: 14, fontWeight: 600 }}>
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
                ...input,
                background: visibility === v ? '#7b68ee' : '#2a3a5a',
                color: '#fff',
                cursor: 'pointer',
                flex: 1,
                textTransform: 'capitalize',
              }}
            >{v}</button>
          ))}
        </div>

        <label style={label}>Preview Image (PNG/JPG, max 1MB)</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={pickPreview} style={{ ...btn, background: '#2a3a5a', flex: '0 0 auto' }}>
            {previewPath ? 'Change…' : 'Choose Image…'}
          </button>
          <div style={{ color: '#aaa', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={previewPath ?? ''}>
            {previewPath ? previewPath.split(/[\\/]/).pop() : '(no preview selected)'}
          </div>
          {previewPath && (
            <button onClick={() => setPreviewPath(null)} style={{ ...btn, background: '#444', padding: '4px 10px' }}>Clear</button>
          )}
        </div>

        <div style={{ color: '#888', fontSize: 11, marginTop: 10 }}>
          Tags: {tags.length ? tags.join(', ') : '(none)'}
        </div>

        {err && <div style={{ color: '#ff6666', fontSize: 12, marginTop: 8 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ ...btn, background: '#444' }}>Cancel</button>
          <button onClick={handleSubmit} disabled={busy} style={{ ...btn, background: busy ? '#555' : '#c77dff' }}>
            {busy ? 'Uploading…' : state.workshopId ? 'Update' : 'Publish'}
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
  width: 480, background: '#1a2240', border: '1px solid #444', borderRadius: 8,
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
