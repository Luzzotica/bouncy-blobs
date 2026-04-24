import React, { useState } from 'react';
import { EditorState, EditorTool } from './EditorState';
import { useAuth } from '../contexts/AuthContext';
import * as contentApi from '../lib/contentApi';
import type { ContentItem } from '../lib/contentApi';

interface EditorToolbarProps {
  state: EditorState;
  onUpdate: () => void;
  onTestPlay: () => void;
}

const tools: { id: EditorTool; label: string; hotkey: string }[] = [
  { id: 'select', label: 'Select', hotkey: '1' },
  { id: 'platform', label: 'Platform', hotkey: '2' },
  { id: 'spawn', label: 'Spawn', hotkey: '3' },
  { id: 'npc', label: 'NPC', hotkey: '4' },
  { id: 'spring', label: 'Spring', hotkey: '5' },
  { id: 'spike', label: 'Spike', hotkey: '6' },
  { id: 'goalZone', label: 'Goal', hotkey: '7' },
  { id: 'hillZone', label: 'Hill', hotkey: '8' },
  { id: 'powerup', label: 'Powerup', hotkey: '9' },
];

export default function EditorToolbar({ state, onUpdate, onTestPlay }: EditorToolbarProps) {
  const { user, session, signIn, signOut } = useAuth();
  const [saving, setSaving] = useState(false);
  const [loadPanelOpen, setLoadPanelOpen] = useState(false);
  const [loadItems, setLoadItems] = useState<ContentItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const handleExport = () => {
    const json = state.toJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.level.name || 'level'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.loadJSON(reader.result as string);
        state.contentId = null;
        state.isPublished = false;
        onUpdate();
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleSave = async () => {
    if (!session) return;
    setSaving(true);
    try {
      if (state.contentId) {
        // Update existing
        await contentApi.updateLevel(session, state.contentId, {
          name: state.level.name,
          contentJson: state.level,
        });
      } else {
        // Create new — prompt for name if empty
        let name = state.level.name;
        if (!name || name === 'New Level') {
          const input = prompt('Level name:', state.level.name || 'My Level');
          if (!input) { setSaving(false); return; }
          name = input;
          state.level.name = name;
        }
        const result = await contentApi.saveLevel(session, name, '', state.level);
        state.contentId = result.id;
      }
      onUpdate();
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async () => {
    if (!session) return;
    setLoadPanelOpen(true);
    setLoadingList(true);
    try {
      const items = await contentApi.listLevels(session);
      setLoadItems(items);
    } catch (err: any) {
      alert('Failed to load list: ' + err.message);
    } finally {
      setLoadingList(false);
    }
  };

  const handleLoadItem = async (item: ContentItem) => {
    try {
      const levelData = await contentApi.loadLevel(item.id, session ?? undefined);
      state.loadJSON(JSON.stringify(levelData));
      state.contentId = item.id;
      state.isPublished = item.isPublic;
      setLoadPanelOpen(false);
      onUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  };

  const handleDeleteItem = async (item: ContentItem) => {
    if (!session) return;
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
      await contentApi.deleteLevel(session, item.id);
      setLoadItems(prev => prev.filter(i => i.id !== item.id));
      if (state.contentId === item.id) {
        state.contentId = null;
        state.isPublished = false;
        onUpdate();
      }
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    }
  };

  const handlePublishToggle = async () => {
    if (!session || !state.contentId) return;
    try {
      const newPublic = !state.isPublished;
      await contentApi.publishLevel(session, state.contentId, newPublic);
      state.isPublished = newPublic;
      onUpdate();
    } catch (err: any) {
      alert('Publish failed: ' + err.message);
    }
  };

  return (
    <>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 12px',
        background: '#16213e',
        borderBottom: '1px solid #333',
        flexWrap: 'wrap',
      }}>
        {tools.map(t => (
          <button
            key={t.id}
            onClick={() => { state.selectedTool = t.id; onUpdate(); }}
            title={`${t.label} (${t.hotkey})`}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              background: state.selectedTool === t.id ? '#7b68ee' : '#2a3a5a',
              border: state.selectedTool === t.id ? '1px solid #9b88ff' : '1px solid #3a4a6a',
              borderRadius: 4,
              color: state.selectedTool === t.id ? '#fff' : '#bbb',
              cursor: 'pointer',
            }}
          >
            <span>{t.label}</span>
            <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.5 }}>{t.hotkey}</span>
          </button>
        ))}

        <div style={{ width: 1, height: 20, background: '#444', margin: '0 4px' }} />

        <button onClick={() => { state.newLevel(); state.contentId = null; state.isPublished = false; onUpdate(); }}
          style={actionBtnStyle('#8b4513')}>
          New
        </button>
        <button onClick={handleImport} style={actionBtnStyle('#2d6a4f')}>Import</button>
        <button onClick={handleExport} style={actionBtnStyle('#2d6a4f')}>Export</button>

        {session && (
          <>
            <div style={{ width: 1, height: 20, background: '#444', margin: '0 4px' }} />
            <button onClick={handleSave} disabled={saving}
              style={actionBtnStyle(saving ? '#555' : '#1a6aaa')}>
              {saving ? 'Saving...' : state.contentId ? 'Save' : 'Save to Cloud'}
            </button>
            <button onClick={handleLoad} style={actionBtnStyle('#1a6aaa')}>Load</button>
            {state.contentId && (
              <button onClick={handlePublishToggle}
                style={actionBtnStyle(state.isPublished ? '#2d8a4f' : '#6a5a1a')}>
                {state.isPublished ? 'Public' : 'Private'}
              </button>
            )}
          </>
        )}

        <div style={{ flex: 1 }} />

        <button onClick={onTestPlay} style={actionBtnStyle('#c77dff')}>Test Play</button>

        <div style={{ width: 1, height: 20, background: '#444', margin: '0 4px' }} />

        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#aaa' }}>{user.email?.split('@')[0]}</span>
            <button onClick={signOut} style={{ ...actionBtnStyle('#555'), fontSize: 11, padding: '3px 8px' }}>
              Sign Out
            </button>
          </div>
        ) : (
          <button onClick={signIn} style={actionBtnStyle('#4a6a8a')}>Sign In</button>
        )}
      </div>

      {/* Load panel overlay */}
      {loadPanelOpen && (
        <div style={{
          position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
          width: 480, maxHeight: 400, background: '#1a2240', border: '1px solid #444',
          borderRadius: 8, zIndex: 100, display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #333' }}>
            <span style={{ color: '#ccc', fontSize: 14, fontWeight: 'bold' }}>Load Level</span>
            <button onClick={() => setLoadPanelOpen(false)}
              style={{ background: 'none', border: 'none', color: '#888', fontSize: 18, cursor: 'pointer' }}>
              x
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {loadingList ? (
              <p style={{ color: '#888', fontSize: 13, textAlign: 'center', padding: 20 }}>Loading...</p>
            ) : loadItems.length === 0 ? (
              <p style={{ color: '#666', fontSize: 13, textAlign: 'center', padding: 20 }}>No saved levels yet</p>
            ) : (
              loadItems.map(item => (
                <div key={item.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  borderRadius: 4, cursor: 'pointer', marginBottom: 4,
                  background: '#222b4a',
                }} onMouseEnter={e => (e.currentTarget.style.background = '#2a3a5a')}
                   onMouseLeave={e => (e.currentTarget.style.background = '#222b4a')}>
                  <div style={{ flex: 1 }} onClick={() => handleLoadItem(item)}>
                    <div style={{ color: '#ddd', fontSize: 13, fontWeight: 500 }}>{item.name}</div>
                    <div style={{ color: '#888', fontSize: 11 }}>
                      {item.isPublic ? 'Public' : 'Private'}
                      {item.creatorId !== user?.id ? ' (community)' : ''}
                      {' · '}
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  {item.creatorId === user?.id && (
                    <button onClick={(e) => { e.stopPropagation(); handleDeleteItem(item); }}
                      style={{ background: '#6b0000', border: 'none', borderRadius: 3, color: '#faa', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}>
                      Del
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

function actionBtnStyle(bg: string): React.CSSProperties {
  return { padding: '5px 12px', fontSize: 12, background: bg, border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer' };
}
