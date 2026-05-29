import React from 'react';
import { EditorState, SPRING_SIZE_PRESETS } from './EditorState';
import type { HullPreset } from '../physics/slimeBlob';
import { allSprites } from '../assets/spriteRegistry';

interface EditorPropertiesProps {
  state: EditorState;
  onUpdate: () => void;
}

const HULL_PRESETS: HullPreset[] = ['circle16', 'square', 'triangle', 'star', 'diamond', 'hexagon'];

function radToDeg(r: number): number { return Math.round(r * 180 / Math.PI); }
function degToRad(d: number): number { return d * Math.PI / 180; }

/** Lists every action whose targets rotate this entity, with editable
 *  endRotation per row. Lets you see/tune rotation from the entity's
 *  perspective (selecting the platform / shape itself) without diving
 *  through the action panel. */
function RotationActionsSection({
  state,
  entityKind,
  entityId,
  onUpdate,
}: {
  state: EditorState;
  entityKind: 'platform' | 'rotateShape';
  entityId: string;
  onUpdate: () => void;
}) {
  const matches: { action: import('../levels/types').ActionDef; target: import('../levels/types').ActionTarget; idx: number }[] = [];
  for (const action of state.level.actions ?? []) {
    for (let idx = 0; idx < action.targets.length; idx++) {
      const t = action.targets[idx];
      if (entityKind === 'platform') {
        if (t.kind === 'platform' && t.platformId === entityId && t.endRotation !== undefined) {
          matches.push({ action, target: t, idx });
        }
      } else {
        if (t.kind === 'rotateShape' && t.shapeId === entityId) {
          matches.push({ action, target: t, idx });
        }
      }
    }
  }
  if (matches.length === 0) return null;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #2a3a5a', paddingTop: 8 }}>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Rotation animations</div>
      {matches.map(({ action, target, idx }) => {
        // Display the DELTA from rest pose so the number matches what the
        // action will actually animate (this matches the canvas badge).
        // shapePoint targets are filtered out upstream, so the only kinds
        // here are 'platform' and 'rotateShape'.
        if (target.kind === 'shapePoint') return null;
        let restRot = 0;
        if (target.kind === 'platform') {
          const plat = state.level.platforms.find(p => p.id === target.platformId);
          restRot = plat?.rotation ?? 0;
        }
        const endRot = target.kind === 'platform' ? (target.endRotation ?? restRot) : target.endRotation;
        const deltaDeg = radToDeg(endRot - restRot);
        return (
          <div key={`${action.id}#${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, fontSize: 11 }}>
            <button
              onClick={() => { state.selectedElement = { type: 'action', id: action.id }; onUpdate(); }}
              data-no-sfx="true"
              title="Open this action's panel"
              style={{
                flex: 1, textAlign: 'left',
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                color: '#bbb', fontSize: 11,
              }}
            >
              {action.id} <span style={{ color: '#666' }}>({action.mode})</span>
            </button>
            <input
              type="number"
              step={15}
              value={deltaDeg}
              onChange={e => {
                const newDeltaDeg = parseFloat(e.target.value) || 0;
                state.setActionTargetEndRotation(action.id, idx, restRot + degToRad(newDeltaDeg));
                onUpdate();
              }}
              style={{ background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '2px 4px', fontSize: 11, width: 60 }}
            />
            <span style={{ color: '#666', fontSize: 10 }}>°</span>
          </div>
        );
      })}
    </div>
  );
}

export default function EditorProperties({ state, onUpdate }: EditorPropertiesProps) {
  const sel = state.selectedElement;
  const groupSize = state.getMultiSelected().length;

  if (groupSize >= 2) {
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Group · {groupSize} items</h3>
        <p style={{ color: '#888', fontSize: 11, margin: '0 0 8px' }}>
          Shift-click items to add to the group. Click empty space to clear.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button onClick={() => { state.distribute('x'); onUpdate(); }} style={actionStyle} disabled={groupSize < 3}>
            Distribute Horizontally
          </button>
          <button onClick={() => { state.distribute('y'); onUpdate(); }} style={actionStyle} disabled={groupSize < 3}>
            Distribute Vertically
          </button>
          <button onClick={() => { state.align('y'); onUpdate(); }} style={actionStyle}>
            Align Y (to first)
          </button>
          <button onClick={() => { state.align('x'); onUpdate(); }} style={actionStyle}>
            Align X (to first)
          </button>
          <button onClick={() => { state.clearMultiSelect(); onUpdate(); }} style={{ ...actionStyle, background: '#3a3a3a', marginTop: 8 }}>
            Clear group
          </button>
        </div>
        <p style={{ color: '#666', fontSize: 10, marginTop: 12 }}>
          Distribute requires 3+ items. Align uses the first-selected item as the anchor.
        </p>
      </div>
    );
  }

  if (!sel) {
    // Sprite-tool active without a selection → show the sprite picker so the
    // user can pick which asset to drop on the next canvas click.
    if (state.selectedTool === 'sprite') {
      return (
        <div style={panelStyle}>
          <h3 style={titleStyle}>Place sprite</h3>
          <SpritePicker state={state} onUpdate={onUpdate} />
        </div>
      );
    }
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
            Ctrl/Cmd+D: Duplicate<br />
            B/N/M: Blob size ghosts<br />
            Shift+click: Add to group<br />
            Space+drag / MMB: Pan<br />
            Scroll: Zoom at cursor<br />
            Esc: Deselect<br />
            Ctrl+Z/Y: Undo/Redo
          </p>
        </div>
      </div>
    );
  }

  // Per-instance editor for a placed sprite — id, transform, material.
  if (sel.type === 'sprite') {
    const inst = (state.level.sprites ?? []).find(s => s.id === sel.id);
    if (!inst) return null;
    const sprites = allSprites();
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Sprite Instance</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Asset</label>
          <select
            value={inst.spriteId}
            onChange={e => { state.updateProperty('spriteId', e.target.value); onUpdate(); }}
            style={{ flex: 1, background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '3px 6px', fontSize: 12 }}
          >
            {sprites.length === 0 && <option value={inst.spriteId}>{inst.spriteId}</option>}
            {sprites.map(s => (
              <option key={s.def.id} value={s.def.id}>{s.def.id}</option>
            ))}
          </select>
        </div>
        <NumInput label="X" value={inst.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={inst.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Rotation" value={radToDeg(inst.rotation)} step={15}
          onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <NumInput label="Scale" value={inst.scale ?? 1} step={0.1}
          onChange={v => { state.updateProperty('scale', Math.max(0.1, v)); onUpdate(); }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Material</label>
          <select
            value={inst.material ?? 'default'}
            onChange={e => { state.updateProperty('material', e.target.value); onUpdate(); }}
            style={{ flex: 1, background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '3px 6px', fontSize: 12 }}
          >
            <option value="default">Default</option>
            <option value="ice">Ice</option>
            <option value="sticky">Sticky</option>
            <option value="bouncy">Bouncy</option>
          </select>
        </div>
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
          Material only applies to polygon/circle hulls. Point-shape props (pencil) flex regardless.
        </p>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'softPlatform') {
    const sp = (state.level.softPlatforms ?? []).find(s => s.id === sel.id);
    if (!sp) return null;
    const anchorsValue = Array.isArray(sp.anchors) ? 'custom' : (sp.anchors ?? 'corners');
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Soft Platform</h3>
        <NumInput label="X" value={sp.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={sp.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={sp.width} onChange={v => { state.updateProperty('width', Math.max(40, v)); onUpdate(); }} />
        <NumInput label="Height" value={sp.height} onChange={v => { state.updateProperty('height', Math.max(20, v)); onUpdate(); }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Anchors</label>
          <select
            value={anchorsValue}
            disabled={anchorsValue === 'custom'}
            onChange={e => { state.updateProperty('anchors', e.target.value); onUpdate(); }}
            style={{ flex: 1, background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '3px 6px', fontSize: 12 }}
          >
            <option value="corners">Corners</option>
            <option value="ends">Ends</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
            {anchorsValue === 'custom' && <option value="custom">Custom (JSON)</option>}
          </select>
        </div>
        <NumInput label="Stiffness" value={sp.stiffness ?? 1.0} step={0.1} onChange={v => { state.updateProperty('stiffness', Math.max(0.1, v)); onUpdate(); }} />
        <NumInput label="Segments W" value={sp.segW ?? 8} step={1} onChange={v => { state.updateProperty('segW', Math.max(2, Math.floor(v))); onUpdate(); }} />
        <NumInput label="Segments H" value={sp.segH ?? 1} step={1} onChange={v => { state.updateProperty('segH', Math.max(1, Math.floor(v))); onUpdate(); }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Pinned</label>
          <input type="checkbox" checked={!!sp.pinned}
            onChange={e => { state.updateProperty('pinned', e.target.checked); onUpdate(); }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Frame lock</label>
          <input type="checkbox" checked={!!sp.frameLocked}
            onChange={e => { state.updateProperty('frameLocked', e.target.checked); onUpdate(); }} />
        </div>
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Pinned = each vertex springs to its rest position (jelly). Frame lock = whole body wobbles on a global spring (rigid platform feel). Combinable.</p>
        <button
          onClick={() => { state.convertSoftPlatformToPointShape(sp.id); onUpdate(); }}
          style={{ ...actionStyle, marginTop: 6, background: '#3a4a6a' }}
          title="Bake into an editable point-shape (per-vertex control)."
        >
          Convert to Point Shape
        </button>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
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
        <RotationActionsSection state={state} entityKind="platform" entityId={p.id} onUpdate={onUpdate} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'spring') {
    const s = (state.level.springPads ?? []).find(s => s.id === sel.id);
    if (!s) return null;
    const activeIdx = SPRING_SIZE_PRESETS.findIndex(p => p.width === s.width && p.height === s.height);
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Spring Pad</h3>
        <NumInput label="X" value={s.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={s.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <div style={{ marginBottom: 8 }}>
          <label style={{ ...labelStyle, width: 'auto', display: 'block', marginBottom: 4 }}>Size</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {SPRING_SIZE_PRESETS.map((p, i) => (
              <button
                key={p.label}
                onClick={() => { state.setSpringSize(s.id, i); onUpdate(); }}
                style={{
                  flex: 1, padding: '4px 6px', fontSize: 11,
                  background: i === activeIdx ? '#7b68ee' : '#1a2240',
                  border: `1px solid ${i === activeIdx ? '#9b88ff' : '#2a3a5a'}`,
                  borderRadius: 4,
                  color: i === activeIdx ? '#fff' : '#bbb',
                  cursor: 'pointer',
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Press S to cycle size.</p>
        </div>
        <NumInput label="Rotation" value={radToDeg(s.rotation)} step={15} onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <NumInput label="Fire speed" value={s.fireSpeed ?? 1100} step={100} onChange={v => { state.updateProperty('fireSpeed', Math.max(500, Math.min(2500, v))); onUpdate(); }} />
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>0°=right, -90°=up, 90°=down · fire speed 500–2500</p>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'deathZone') {
    const z = (state.level.deathZones ?? []).find(z => z.id === sel.id);
    if (!z) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Death Zone</h3>
        <p style={{ color: '#ff8080', fontSize: 11, margin: '0 0 8px' }}>Any blob whose center enters this zone dies instantly.</p>
        <NumInput label="X" value={z.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={z.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={z.width} onChange={v => { state.updateProperty('width', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Height" value={z.height} onChange={v => { state.updateProperty('height', Math.max(20, v)); onUpdate(); }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'gravityZone') {
    const z = (state.level.gravityZones ?? []).find(z => z.id === sel.id);
    if (!z) return null;
    const f = z.field;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Gravity Zone</h3>
        <p style={{ color: '#888', fontSize: 11, margin: '0 0 8px' }}>
          Overrides gravity for any blob whose centroid enters this zone.
        </p>
        <NumInput label="X" value={z.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={z.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={z.width} onChange={v => { state.updateProperty('width', Math.max(20, v)); onUpdate(); }} />
        <NumInput label="Height" value={z.height} onChange={v => { state.updateProperty('height', Math.max(20, v)); onUpdate(); }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, marginBottom: 4 }}>
          <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Field</label>
          <select
            value={f.kind}
            onChange={e => { state.setGravityFieldType(z.id, e.target.value as 'uniform' | 'point'); onUpdate(); }}
            style={{ flex: 1, background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '3px 6px', fontSize: 12 }}
          >
            <option value="uniform">Uniform (direction + strength)</option>
            <option value="point">Point (pull toward centre)</option>
          </select>
        </div>
        {f.kind === 'uniform' ? (
          <>
            <NumInput
              label="Force X"
              value={f.vector.x}
              step={50}
              onChange={v => { state.setGravityUniformVector(z.id, v, f.vector.y); onUpdate(); }}
            />
            <NumInput
              label="Force Y"
              value={f.vector.y}
              step={50}
              onChange={v => { state.setGravityUniformVector(z.id, f.vector.x, v); onUpdate(); }}
            />
            <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
              Positive Y = down. (0, 0) = zero-G. Default game gravity is ~+Y.
            </p>
          </>
        ) : (
          <>
            <NumInput
              label="Strength"
              value={f.strength}
              step={100}
              onChange={v => { state.setGravityPointParams(z.id, v, f.falloff); onUpdate(); }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 4 }}>
              <label style={{ color: '#aaa', fontSize: 12, width: 70 }}>Falloff</label>
              <select
                value={f.falloff}
                onChange={e => { state.setGravityPointParams(z.id, f.strength, e.target.value as 'linear' | 'inverseSquare'); onUpdate(); }}
                style={{ flex: 1, background: '#1a2240', color: '#ddd', border: '1px solid #333', padding: '3px 6px', fontSize: 12 }}
              >
                <option value="linear">Linear</option>
                <option value="inverseSquare">Inverse-square (gravity-like)</option>
              </select>
            </div>
            <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
              Center auto-tracks the zone's position. Negative strength = push outward.
            </p>
          </>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
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
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'trigger') {
    const trig = (state.level.triggers ?? []).find(p => p.id === sel.id);
    if (!trig) return null;
    const allActions = state.level.actions ?? [];
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Trigger</h3>
        <p style={{ color: '#888', fontSize: 11, margin: '0 0 6px' }}>
          Area that detects blobs. Tick an action below to make this trigger fire it.
        </p>
        <NumInput label="X" value={trig.x} onChange={v => { state.updateProperty('x', v); onUpdate(); }} />
        <NumInput label="Y" value={trig.y} onChange={v => { state.updateProperty('y', v); onUpdate(); }} />
        <NumInput label="Width" value={trig.width} onChange={v => { state.updateProperty('width', Math.max(40, v)); onUpdate(); }} />
        <NumInput label="Height" value={trig.height} onChange={v => { state.updateProperty('height', Math.max(10, v)); onUpdate(); }} />
        <NumInput label="Rotation" value={radToDeg(trig.rotation)} step={15} onChange={v => { state.updateProperty('rotation', degToRad(v)); onUpdate(); }} suffix="°" />
        <NumInput
          label="Charge"
          value={trig.chargeSeconds ?? 0}
          step={0.1}
          suffix="s"
          onChange={v => { state.updateProperty('chargeSeconds', Math.max(0, v)); onUpdate(); }}
        />
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
          0 = instant. With charge &gt; 0, blob must stay continuously for that long.
        </p>
        <div style={rowStyle}>
          <label style={labelStyle}>Ignore NPCs</label>
          <input
            type="checkbox"
            checked={!!trig.ignoreNpcs}
            onChange={e => { state.updateProperty('ignoreNpcs', e.target.checked); onUpdate(); }}
          />
        </div>
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>
          When on, only player blobs can press this trigger.
        </p>
        <div style={{ marginTop: 10, borderTop: '1px solid #2a3a5a', paddingTop: 8 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Fires actions</div>
          {allActions.length === 0 ? (
            <p style={{ color: '#555', fontSize: 11 }}>No actions in level yet — place one with the Action tool</p>
          ) : (
            allActions.map(a => {
              const linked = a.sourceTriggerIds.includes(trig.id);
              return (
                <label
                  key={a.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11, color: '#bbb', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={linked}
                    onChange={() => { state.toggleActionSourceTrigger(a.id, trig.id); onUpdate(); }}
                  />
                  <span>{a.id}</span>
                  <span style={{ color: '#666' }}>({a.mode}, {a.targets.length} target{a.targets.length === 1 ? '' : 's'})</span>
                </label>
              );
            })
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'pointShape') {
    const shape = (state.level.pointShapes ?? []).find(p => p.id === sel.id);
    if (!shape) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Point Shape</h3>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
          {shape.points.length} points, {shape.edges.length}{shape.closed ? '+1' : ''} edges
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>Pinned</label>
          <input type="checkbox" checked={!!shape.pinned}
            onChange={e => { state.updateProperty('pinned', e.target.checked); onUpdate(); }} />
        </div>
        <div style={rowStyle}>
          <label style={labelStyle}>Frame lock</label>
          <input type="checkbox" checked={!!shape.frameLocked}
            onChange={e => { state.updateProperty('frameLocked', e.target.checked); onUpdate(); }} />
        </div>
        <NumInput label="Stiffness" value={shape.stiffness ?? 1.0} step={0.1}
          onChange={v => { state.updateProperty('stiffness', Math.max(0.1, v)); onUpdate(); }} />
        <p style={{ color: '#666', fontSize: 10, marginTop: 4 }}>Pinned = each vertex springs to rest (jelly). Frame lock = whole body wobbles on a global spring. Higher stiffness = more rigid.</p>
        <RotationActionsSection state={state} entityKind="rotateShape" entityId={shape.id} onUpdate={onUpdate} />
        <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', borderTop: '1px solid #2a3a5a', paddingTop: 6 }}>
          {shape.points.map((pt, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, fontSize: 11 }}>
              <span style={{ color: '#888', width: 22 }}>#{i}</span>
              <span style={{ color: '#aaa', flex: 1 }}>({Math.round(pt.x)},{Math.round(pt.y)})</span>
              <label style={{ color: pt.anchored ? '#ffcc55' : '#666', cursor: 'pointer' }}>
                <input type="checkbox" checked={pt.anchored}
                  onChange={() => { state.togglePointAnchored(shape.id, i); onUpdate(); }}
                  style={{ marginRight: 2 }} />
                anchor
              </label>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.duplicateSelected(); onUpdate(); }} style={duplicateStyle}>Duplicate</button>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete Shape</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'pointShapeVertex') {
    const shape = (state.level.pointShapes ?? []).find(p => p.id === sel.id);
    const pt = shape?.points[sel.pointIndex];
    if (!shape || !pt) return null;
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Vertex #{sel.pointIndex}</h3>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>of shape {shape.id}</div>
        <NumInput label="X" value={pt.x} onChange={v => { pt.x = v; onUpdate(); }} />
        <NumInput label="Y" value={pt.y} onChange={v => { pt.y = v; onUpdate(); }} />
        <NumInput label="Mass" value={pt.mass ?? 1} step={0.1}
          onChange={v => { pt.mass = Math.max(0.01, v); onUpdate(); }} />
        <div style={rowStyle}>
          <label style={labelStyle}>Anchored</label>
          <input type="checkbox" checked={pt.anchored}
            onChange={() => { state.togglePointAnchored(shape.id, sel.pointIndex); onUpdate(); }} />
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete Vertex</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'action') {
    const action = (state.level.actions ?? []).find(a => a.id === sel.id);
    if (!action) return null;
    const easings = ['linear', 'easeInOut', 'easeOut'] as const;
    const modes = ['switch', 'continuous', 'oneShot', 'timer'] as const;
    const allTriggers = state.level.triggers ?? [];
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Action</h3>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>{action.id}</div>

        <div style={rowStyle}>
          <label style={labelStyle}>Mode</label>
          <select value={action.mode}
            onChange={e => { state.updateProperty('mode', e.target.value); onUpdate(); }}
            style={inputStyle}>
            {modes.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <p style={{ color: '#666', fontSize: 10, marginTop: 0, marginBottom: 6 }}>
          {action.mode === 'continuous' && 'Open while pressed, close on release.'}
          {action.mode === 'switch' && 'Press to toggle. Press again to flip back.'}
          {action.mode === 'oneShot' && 'Fire once on first press, then deaf forever.'}
          {action.mode === 'timer' && 'Runs every N seconds — open, close, wait, repeat. Triggers are ignored.'}
        </p>

        <NumInput label="Delay" value={action.delaySeconds ?? 0} step={0.1} suffix="s"
          onChange={v => { state.updateProperty('delaySeconds', Math.max(0, v)); onUpdate(); }} />

        {action.mode === 'timer' && (
          <NumInput
            label="Interval"
            value={action.intervalSeconds ?? 4}
            step={0.5}
            suffix="s"
            onChange={v => { state.updateProperty('intervalSeconds', Math.max(0.5, v)); onUpdate(); }}
          />
        )}

        <NumInput label="Duration" value={action.duration} step={0.1} suffix="s"
          onChange={v => { state.updateProperty('duration', Math.max(0.05, v)); onUpdate(); }} />

        <div style={rowStyle}>
          <label style={labelStyle}>Easing</label>
          <select value={action.easing ?? 'easeInOut'}
            onChange={e => { state.updateProperty('easing', e.target.value); onUpdate(); }}
            style={inputStyle}>
            {easings.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>

        <div style={{ marginTop: 10, borderTop: '1px solid #2a3a5a', paddingTop: 8, opacity: action.mode === 'timer' ? 0.4 : 1 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
            Source triggers
            {action.mode === 'timer' && <span style={{ color: '#666', marginLeft: 6 }}>(ignored in timer mode)</span>}
          </div>
          {allTriggers.length === 0 ? (
            <p style={{ color: '#555', fontSize: 11 }}>No triggers in level yet</p>
          ) : (
            allTriggers.map(t => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11, color: '#bbb', cursor: 'pointer' }}>
                <input type="checkbox" checked={action.sourceTriggerIds.includes(t.id)}
                  onChange={() => { state.toggleActionSourceTrigger(action.id, t.id); onUpdate(); }} />
                {t.id}
              </label>
            ))
          )}
          {action.sourceTriggerIds.length >= 2 && (
            <div style={{ ...rowStyle, marginTop: 6 }}>
              <label style={labelStyle}>Require</label>
              <select value={action.requireMode}
                onChange={e => { state.updateProperty('requireMode', e.target.value); onUpdate(); }}
                style={inputStyle}>
                <option value="any">Any (OR)</option>
                <option value="all">All (AND)</option>
              </select>
            </div>
          )}
        </div>

        <div style={{ marginTop: 10, fontSize: 11, color: '#888' }}>Targets</div>
        <div style={{ color: '#666', fontSize: 10, marginBottom: 4 }}>
          Drag a target's dashed ghost on the canvas, or edit values below. Platforms can rotate too.
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', borderTop: '1px solid #2a3a5a', paddingTop: 6 }}>
          {action.targets.map((t, i) => (
            <div key={i} style={{ marginBottom: 8, fontSize: 11, color: '#bbb' }}>
              <div style={{ color: '#888' }}>
                {t.kind === 'shapePoint' && `${t.shapeId} · #${t.pointIndex}`}
                {t.kind === 'platform' && `${t.platformId} (platform)`}
                {t.kind === 'rotateShape' && `${t.shapeId} (rotate hull)`}
              </div>
              {t.kind !== 'rotateShape' && (
                <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                  <input type="number" value={Math.round(t.endX)} style={{ ...inputStyle, padding: '2px 4px' }}
                    onChange={e => { state.setActionTargetEnd(action.id, i, parseFloat(e.target.value) || 0, t.endY); onUpdate(); }} />
                  <input type="number" value={Math.round(t.endY)} style={{ ...inputStyle, padding: '2px 4px' }}
                    onChange={e => { state.setActionTargetEnd(action.id, i, t.endX, parseFloat(e.target.value) || 0); onUpdate(); }} />
                </div>
              )}
              {(t.kind === 'platform' || t.kind === 'rotateShape') && (() => {
                // End rot is shown + stored as the DELTA from the entity's
                // closed-pose rotation. Matches the canvas badge and the
                // entity-side RotationActionsSection so the same number
                // shows up in every place. (Previously this panel stored
                // absolute, the other stored delta — they disagreed by
                // exactly the platform's closed-pose rotation.)
                const restRot = t.kind === 'platform'
                  ? (state.level.platforms.find(p => p.id === t.platformId)?.rotation ?? 0)
                  : 0;
                const endRot = t.kind === 'platform' ? (t.endRotation ?? restRot) : t.endRotation;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <label style={{ color: '#999', fontSize: 10, width: 60 }}>End rot</label>
                    <input
                      type="number"
                      step={15}
                      value={radToDeg(endRot - restRot)}
                      style={{ ...inputStyle, padding: '2px 4px', flex: 1 }}
                      onChange={e => {
                        const newDeltaDeg = parseFloat(e.target.value) || 0;
                        state.setActionTargetEndRotation(action.id, i, restRot + degToRad(newDeltaDeg));
                        onUpdate();
                      }}
                    />
                    <span style={{ color: '#666', fontSize: 10 }}>°</span>
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete Action</button>
        </div>
      </div>
    );
  }

  if (sel.type === 'chain') {
    const chain = (state.level.chains ?? []).find(c => c.id === sel.id);
    if (!chain) return null;
    const describeAnchor = (ref: typeof chain.endpointA) => {
      if (ref.kind === 'fixed') return `Fixed (${Math.round(ref.x)}, ${Math.round(ref.y)})`;
      return `${ref.entity}: ${ref.id}`;
    };
    return (
      <div style={panelStyle}>
        <h3 style={titleStyle}>Chain</h3>
        <div style={{ fontSize: 11, color: '#bbb', marginBottom: 4 }}>End A: {describeAnchor(chain.endpointA)}</div>
        <div style={{ fontSize: 11, color: '#bbb', marginBottom: 8 }}>End B: {describeAnchor(chain.endpointB)}</div>
        <NumInput label="Total length" value={chain.totalLength} step={10}
          onChange={v => { state.updateProperty('totalLength', Math.max(50, v)); onUpdate(); }} />
        <NumInput label="Max segment len" value={chain.maxSegmentLength ?? 25} step={1}
          onChange={v => { state.updateProperty('maxSegmentLength', Math.max(5, v)); onUpdate(); }} />
        <NumInput label="Segment mass" value={chain.segmentMass ?? 0.5} step={0.1}
          onChange={v => { state.updateProperty('segmentMass', Math.max(0.01, v)); onUpdate(); }} />
        <NumInput label="Segment radius" value={chain.segmentRadius ?? 10} step={1}
          onChange={v => { state.updateProperty('segmentRadius', Math.max(1, v)); onUpdate(); }} />
        <NumInput label="Iterations" value={chain.iterations ?? 12} step={1}
          onChange={v => { state.updateProperty('iterations', Math.max(1, Math.round(v))); onUpdate(); }} />
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button onClick={() => { state.deleteSelected(); onUpdate(); }} style={deleteStyle}>Delete Chain</button>
        </div>
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
  flex: 1,
  marginTop: 0,
  padding: '6px',
  fontSize: 12,
  background: '#8b0000',
  border: 'none',
  borderRadius: 4,
  color: '#fff',
  cursor: 'pointer',
};

const actionStyle: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 12,
  background: '#2a3a5a',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#ddd',
  cursor: 'pointer',
};

const duplicateStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px',
  fontSize: 12,
  background: '#2a4a8a',
  border: 'none',
  borderRadius: 4,
  color: '#fff',
  cursor: 'pointer',
};

/** Thumbnail grid of every sprite the registry has loaded. Click one to make
 * it the active brush; the next canvas click drops it. Empty state nudges
 * the user to run the asset generator. */
function SpritePicker({ state, onUpdate }: { state: EditorState; onUpdate: () => void }) {
  const sprites = allSprites();
  if (sprites.length === 0) {
    return (
      <div style={{ color: '#888', fontSize: 12, lineHeight: 1.4 }}>
        No sprites loaded yet.<br />
        <span style={{ color: '#666' }}>
          Run <code style={{ color: '#aaa' }}>./scripts/generate-all-art.sh</code> to generate them.
        </span>
      </div>
    );
  }
  const activeId = state.placementSpriteId ?? sprites[0].def.id;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
      {sprites.map(s => {
        const selected = s.def.id === activeId;
        return (
          <button
            key={s.def.id}
            onClick={() => { state.setPlacementSpriteId(s.def.id); onUpdate(); }}
            title={s.def.id}
            style={{
              padding: 6,
              background: selected ? '#2a4a8a' : '#1a2240',
              border: selected ? '2px solid #5a8aff' : '1px solid #333',
              borderRadius: 4,
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
            }}
          >
            <img
              src={s.def.image}
              alt={s.def.id}
              style={{ width: '100%', maxHeight: 64, objectFit: 'contain', imageRendering: 'auto' }}
            />
            <span style={{ fontSize: 10, color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
              {s.def.id}
            </span>
          </button>
        );
      })}
    </div>
  );
}
