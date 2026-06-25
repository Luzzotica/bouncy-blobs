import React, { useEffect, useState } from 'react';
import { fetchDevCampaign, saveDevCampaign, type CampaignSaveArgs } from '../lib/devMaps';
import { getBuiltinLevels, invalidateBuiltinCache, type LevelManifestEntry } from '../levels/levelRegistry';
import { invalidateCampaignCache } from '../lib/campaignRegistry';
import {
  COLORS,
  HAIRLINE,
  modalBackdrop,
  modalCard,
  modalTape,
  paperBtnSm,
  actionBtnSm,
  inputSm,
} from '../theme/uiTheme';

interface Props {
  onClose: () => void;
}

interface Row { id: string; name?: string }

/**
 * Dev-only editor for the single-player "Play" campaign. Reads/writes
 * public/campaigns/play.json through the same serve-only Vite middleware the
 * map "Publish to Game" flow uses, so a freshly-published level can be dropped
 * into the campaign immediately.
 */
export default function CampaignEditor({ onClose }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [pool, setPool] = useState<LevelManifestEntry[]>([]);
  const [addId, setAddId] = useState('');
  const [status, setStatus] = useState<string>('Loading…');
  // Drag-to-reorder gesture state.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const refresh = () => {
    invalidateBuiltinCache();
    getBuiltinLevels().then(setPool).catch(() => setPool([]));
  };

  useEffect(() => {
    getBuiltinLevels().then(setPool).catch(() => setPool([]));
    fetchDevCampaign('play')
      .then((c) => { setRows(c.levels); setStatus(''); })
      .catch(() => { setRows([]); setStatus('No campaign yet — add levels and save.'); });
  }, []);

  const nameFor = (id: string) => pool.find((p) => p.id === id)?.name ?? id;
  const inCampaign = new Set(rows.map((r) => r.id));
  const addable = pool.filter((p) => !inCampaign.has(p.id));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = rows.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setRows(next);
  };
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = rows.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setRows(next);
  };
  const endDrag = () => { setDragIndex(null); setOverIndex(null); };
  const remove = (i: number) => setRows(rows.filter((_, k) => k !== i));
  const add = () => {
    if (!addId || inCampaign.has(addId)) return;
    setRows([...rows, { id: addId }]);
    setAddId('');
  };

  const save = async () => {
    setStatus('Saving…');
    try {
      const args: CampaignSaveArgs = { id: 'play', name: 'Play', levels: rows.map((r) => ({ id: r.id })) };
      await saveDevCampaign(args);
      invalidateCampaignCache();
      setStatus('Saved! Commit public/campaigns/play.json to deploy.');
    } catch (err: any) {
      setStatus(`Save failed: ${err?.message ?? err}`);
    }
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <span style={modalTape} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 900, color: COLORS.ink, textShadow: '2px 2px 0 #c77dff' }}>Play campaign</h2>
          <button style={iconBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <p style={hint}>Order of levels in the single-player Play menu. Level 1 is always unlocked; each clear unlocks the next.</p>

        <div style={list}>
          {rows.length === 0 && <div style={{ color: COLORS.inkFaint, padding: '8px 0' }}>No levels.</div>}
          {rows.map((r, i) => {
            const isDragging = i === dragIndex;
            const isDropTarget = i === overIndex && dragIndex !== null && overIndex !== dragIndex;
            return (
              <div
                key={r.id}
                style={{
                  ...listRow,
                  opacity: isDragging ? 0.4 : 1,
                  boxShadow: isDropTarget ? `inset 0 2px 0 ${COLORS.lavender}` : 'none',
                }}
                draggable
                onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', ''); }}
                onDragOver={(e) => { e.preventDefault(); if (overIndex !== i) setOverIndex(i); }}
                onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) reorder(dragIndex, i); endDrag(); }}
                onDragEnd={endDrag}
              >
                <span style={grip} title="Drag to reorder">⠿</span>
                <span style={{ color: COLORS.inkFaint, width: 22 }}>{i + 1}.</span>
                <span style={{ flex: 1 }}>{nameFor(r.id)} <span style={{ color: COLORS.inkDim }}>({r.id})</span></span>
                <button style={miniBtn} disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                <button style={miniBtn} disabled={i === rows.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                <button style={{ ...miniBtn, color: COLORS.danger }} onClick={() => remove(i)} title="Remove">×</button>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <select value={addId} onChange={(e) => setAddId(e.target.value)} style={select}>
            <option value="">Add a level…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.id}){p.hidden ? ' — hidden' : ''}</option>
            ))}
          </select>
          <button style={btn} onClick={add} disabled={!addId}>Add</button>
          <button style={btn} onClick={refresh} title="Re-read the level manifest (after publishing a new map)">↻</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
          <span style={{ fontSize: 12, color: COLORS.inkDim }}>{status}</span>
          <button style={actionBtnSm(COLORS.green)} onClick={save}>Save campaign</button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = { ...modalBackdrop, zIndex: 300 };
const modal: React.CSSProperties = {
  ...modalCard, position: 'relative', width: 680, maxWidth: '92vw',
  padding: 28, fontSize: 15,
};
const hint: React.CSSProperties = { margin: '0 0 14px', fontSize: 12, color: COLORS.inkDim, lineHeight: 1.4 };
const list: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  maxHeight: '55vh', overflowY: 'auto',
  border: '1px solid ' + HAIRLINE, borderRadius: 4, padding: 10, background: COLORS.paperInput,
};
const listRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  background: COLORS.paper, border: '1px solid ' + HAIRLINE, borderRadius: 4, padding: '8px 10px',
};
const grip: React.CSSProperties = {
  cursor: 'grab', color: COLORS.inkFaint, fontSize: 14, lineHeight: 1, userSelect: 'none',
};
const select: React.CSSProperties = {
  ...inputSm, flex: 1,
};
const btn: React.CSSProperties = {
  ...paperBtnSm,
};
const miniBtn: React.CSSProperties = {
  ...paperBtnSm, width: 26, height: 26, padding: 0, fontSize: 13,
};
const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: COLORS.ink, fontSize: 24, cursor: 'pointer', lineHeight: 1,
};
