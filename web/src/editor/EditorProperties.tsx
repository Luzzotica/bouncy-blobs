import React from 'react';
import { EditorState } from './EditorState';
import type { HullPreset } from '../physics/slimeBlob';

interface EditorPropertiesProps {
  state: EditorState;
  onUpdate: () => void;
}

const HULL_PRESETS: HullPreset[] = ['circle16', 'square', 'triangle', 'star', 'diamond', 'hexagon'];

function radToDeg(r: number): number { return Math.round(r * 180 / Math.PI); }
function degToRad(d: number): number { return d * Math.PI / 180; }

export default function EditorProperties({ state, onUpdate }: EditorPropertiesProps) {
  const sel = state.selectedElement;

  if (!sel) {
    return (
      <div style={panelStyle}>
        <h3 style={{ margin: '0 0 8px', fontSize: 14, color: '#888' }}>Properties</h3>
        <p style={{ color: '#666', fontSize: 13 }}>Select an element to edit</p>
        <div style={{ marginTop: 16, borderTop: '1px solid #333', paddingTop: 12 }}>
          <p style={{ color: '#555', fontSize: 11, lineHeight: 1.5 }}>
            <b style={{ color: '#888' }}>Hotkeys</b><br />
            1-9: Switch tools<br />
            R / Shift+R: Rotate 15&deg;<br />
            Del: Delete selected<br />
            Esc: Deselect<br />
            Ctrl+Z/Y: Undo/Redo
          </p>
        </div>
      </div>
    );
  }

  if (sel.type === 'platform') {
    const p = state.level.platforms.find(p => p.id === sel.id);
    if (!p) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Platform</h3>
        <NumInput label="X" value={p.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={p.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={p.width} onChange={v => { state.updateProperty('width', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Height" value={p.height} onChange={v => { state.updateProperty('height', Math.max(10, v)); onUpdate(); }} />
        <NumInput label="Rotation" value={radToDeg(p.rotation)} step={15} onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'spring') {
    const s = (state.level.springPads ?? []).find(s => s.id === sel.id);
    if (!s) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Spring Pad</h3>
        <NumInput label="X" value={s.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={s.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={s.width} onChange={v => { state.updateProperty('width', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Height" value={s.height} onChange={v => { state.updateProperty('height', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Rotation" value={radToDeg(s.rotation)} step={15} onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <NumInput label="Force" value={s.force} step={50} onChange={v => { state.updateProperty('force', Math.max(100, v)); onUpdate(); }} />
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>0°=right, -90°=up, 90°=down</p>
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'spike') {
    const s = (state.level.spikes ?? []).find(s => s.id === sel.id);
    if (!s) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Spike</h3>
        <NumInput label="X" value={s.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={s.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={s.width} onChange={v => { state.updateProperty('width', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Height" value={s.height} onChange={v => { state.updateProperty('height', Math.max(10, v)); onUpdate(); }} />
        <NumInput label="Rotation" value={radToDeg(s.rotation)} step={15} onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Teeth point "up" at 0°</p>
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'goalZone') {
    const z = (state.level.goalZones ?? []).find(z => z.id === sel.id);
    if (!z) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Goal Zone</h3>
        <NumInput label="X" value={z.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={z.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={z.width} onChange={v => { state.updateProperty('width', Math.max(40, v)); onUpdate(); }} />
        <NumInput label="Height" value={z.height} onChange={v => { state.updateProperty('height', Math.max(40, v)); onUpdate(); }} />
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'hillZone') {
    const z = (state.level.hillZones ?? []).find(z => z.id === sel.id);
    if (!z) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Hill Zone</h3>
        <NumInput label="X" value={z.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={z.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={z.width} onChange={v => { state.updateProperty('width', Math.max(40, v)); onUpdate(); }} />
        <NumInput label="Height" value={z.height} onChange={v => { state.updateProperty('height', Math.max(40, v)); onUpdate(); }} />
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'spawn') {
    const s = state.level.spawnPoints.find(s => s.id === sel.id);
    if (!s) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Spawn Point</h3>
        <NumInput label="X" value={s.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={s.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <div style={rowStyle}>
          <label style={labelStyle}>Type</label>
          <select
            value={s.type}
            onChange={e => { state.updateSpawnType(sel.id, e.target.value as 'player' | 'npc'); onUpdate(); }}
            style={inputStyle}
          >
            <option value="player">Player</option>
            <option value="npc">NPC</option>
          </select>
        </div>
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'npc') {
    const n = state.level.npcBlobs.find(n => n.id === sel.id);
    if (!n) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>NPC Blob</h3>
        <NumInput label="X" value={n.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={n.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <div style={rowStyle}>
          <label style={labelStyle}>Shape</label>
          <select
            value={n.hullPreset}
            onChange={e => { state.updateNpcPreset(sel.id, e.target.value as HullPreset); onUpdate(); }}
            style={inputStyle}
          >
            {HULL_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  if (sel.type === 'powerup') {
    const p = (state.level.powerupSpawns ?? []).find(p => p.id === sel.id);
    if (!p) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Powerup Spawn</h3>
        <NumInput label="X" value={p.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={p.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
      </div>
    );
  }

  return null;
}

function NumInput({ label, value, onChange, step, suffix }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        value={Math.round(value * 100) / 100}
        step={step ?? 1}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={inputStyle}
      />
      {suffix && <span style={{ color: '#666', fontSize: 11 }}>{suffix}</span>}
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  padding: 12,
  background: '#16213e',
  borderLeft: '1px solid #333',
  width: 220,
  overflowY: 'auto',
};

const titleStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: 14, color: '#ccc' };

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 8,
};

const labelStyle: React.CSSProperties = { fontSize: 12, color: '#999', width: 50, flexShrink: 0 };

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '4px 6px',
  fontSize: 12,
  background: '#1a1a2e',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#e0e0e0',
};

const deleteStyle: React.CSSProperties = {
  marginTop: 12,
  width: '100%',
  padding: '6px',
  fontSize: 12,
  background: '#8b0000',
  border: 'none',
  borderRadius: 4,
  color: '#fff',
  cursor: 'pointer',
};
