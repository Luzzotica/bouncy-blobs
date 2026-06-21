import React, { useEffect, useState } from 'react';
import { fetchDevCampaign, saveDevCampaign, type CampaignSaveArgs } from '../lib/devMaps';
import { getBuiltinLevels, invalidateBuiltinCache, type LevelManifestEntry } from '../levels/levelRegistry';
import { invalidateCampaignCache } from '../lib/campaignRegistry';

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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Play campaign</h2>
          <button style={iconBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <p style={hint}>Order of levels in the single-player Play menu. Level 1 is always unlocked; each clear unlocks the next.</p>

        <div style={list}>
          {rows.length === 0 && <div style={{ color: '#888', padding: '8px 0' }}>No levels.</div>}
          {rows.map((r, i) => (
            <div key={r.id} style={listRow}>
              <span style={{ color: '#7c89a8', width: 22 }}>{i + 1}.</span>
              <span style={{ flex: 1 }}>{nameFor(r.id)} <span style={{ color: '#5b6680' }}>({r.id})</span></span>
              <button style={miniBtn} disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
              <button style={miniBtn} disabled={i === rows.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
              <button style={{ ...miniBtn, color: '#e85d75' }} onClick={() => remove(i)} title="Remove">×</button>
            </div>
          ))}
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
          <span style={{ fontSize: 12, color: '#9aa7c2' }}>{status}</span>
          <button style={{ ...btn, background: '#c77dff', color: '#fff', fontWeight: 700 }} onClick={save}>Save campaign</button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(5,8,16,0.7)', zIndex: 300,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
const modal: React.CSSProperties = {
  width: 460, maxWidth: '90vw', background: '#16213e', color: '#e0e6f2',
  border: '1px solid #2c3a5e', borderRadius: 8, padding: 20,
  boxShadow: '0 16px 60px rgba(0,0,0,0.6)', fontSize: 14,
};
const hint: React.CSSProperties = { margin: '0 0 14px', fontSize: 12, color: '#9aa7c2', lineHeight: 1.4 };
const list: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6,
  maxHeight: 320, overflowY: 'auto',
  border: '1px solid #2c3a5e', borderRadius: 6, padding: 8, background: '#101a30',
};
const listRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const select: React.CSSProperties = {
  flex: 1, padding: '6px 8px', background: '#101a30', color: '#e0e6f2',
  border: '1px solid #2c3a5e', borderRadius: 6,
};
const btn: React.CSSProperties = {
  padding: '6px 12px', background: '#243352', color: '#e0e6f2',
  border: '1px solid #3a4a72', borderRadius: 6, cursor: 'pointer', fontSize: 13,
};
const miniBtn: React.CSSProperties = {
  width: 26, height: 26, background: '#243352', color: '#e0e6f2',
  border: '1px solid #3a4a72', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#9aa7c2', fontSize: 24, cursor: 'pointer', lineHeight: 1,
};
