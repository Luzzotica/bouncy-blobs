import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EditorState } from '../editor/EditorState';
import EditorToolbar from '../editor/EditorToolbar';
import EditorCanvas from '../editor/EditorCanvas';
import EditorProperties from '../editor/EditorProperties';
import { useAuth } from '../contexts/AuthContext';
import * as contentApi from '../lib/contentApi';
import type { ContentItem } from '../lib/contentApi';
import { LevelData, LevelType, getLevelTypes } from '../levels/types';
import { getAvailableLevels, loadBuiltinLevel, LevelManifestEntry } from '../levels/levelRegistry';

const LEVEL_TYPE_LABELS: Record<LevelType, string> = {
  solo_racing: 'Solo Racing',
  team_racing: 'Team Racing',
  party: 'Party',
  koth: 'King of the Hill',
};

const LEVEL_TYPE_COLORS: Record<LevelType, string> = {
  solo_racing: '#4a9eff',
  team_racing: '#4ae04a',
  party: '#ff6a9e',
  koth: '#ffa500',
};

type EditorPhase = 'list' | 'new_level_type' | 'editing';

const LEVEL_TYPE_DESCRIPTIONS: Record<LevelType, string> = {
  solo_racing: 'First to the finish wins',
  team_racing: 'Everyone reaches the end',
  party: 'UCH-style rounds with item placement',
  koth: 'Control the hill to score points',
};

function NewLevelTypePicker({ onCreateNew, onBack }: { onCreateNew: (types: LevelType[]) => void; onBack: () => void }) {
  const [selected, setSelected] = useState<Set<LevelType>>(new Set());

  const toggle = (lt: LevelType) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(lt)) next.delete(lt); else next.add(lt);
      return next;
    });
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f1629', gap: 24 }}>
      <h2 style={{ color: '#c77dff', fontSize: 24, margin: 0 }}>Choose Game Modes</h2>
      <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Select one or more modes this map supports</p>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {(['solo_racing', 'team_racing', 'party', 'koth'] as LevelType[]).map(lt => {
          const active = selected.has(lt);
          return (
            <button
              key={lt}
              onClick={() => toggle(lt)}
              style={{
                padding: '24px 32px',
                fontSize: 16,
                fontWeight: 'bold',
                background: active ? LEVEL_TYPE_COLORS[lt] + '22' : '#1a2240',
                border: `2px solid ${active ? LEVEL_TYPE_COLORS[lt] : LEVEL_TYPE_COLORS[lt] + '44'}`,
                borderRadius: 12,
                color: LEVEL_TYPE_COLORS[lt],
                cursor: 'pointer',
                transition: 'all 0.15s',
                minWidth: 160,
                textAlign: 'center',
              }}
            >
              <div>{LEVEL_TYPE_LABELS[lt]}</div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 6, fontWeight: 'normal' }}>
                {LEVEL_TYPE_DESCRIPTIONS[lt]}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button
          onClick={onBack}
          style={{ padding: '8px 20px', fontSize: 13, background: '#2a3a5a', border: 'none', borderRadius: 6, color: '#aaa', cursor: 'pointer' }}
        >
          Back
        </button>
        <button
          onClick={() => onCreateNew(Array.from(selected))}
          disabled={selected.size === 0}
          style={{
            padding: '8px 24px', fontSize: 14, fontWeight: 'bold',
            background: selected.size > 0 ? '#c77dff' : '#333',
            border: 'none', borderRadius: 6,
            color: selected.size > 0 ? '#fff' : '#666',
            cursor: selected.size > 0 ? 'pointer' : 'not-allowed',
          }}
        >
          Create Level
        </button>
      </div>
    </div>
  );
}

export default function Editor() {
  const [, setTick] = useState(0);
  const [phase, setPhase] = useState<EditorPhase>('list');
  const [builtinLevels, setBuiltinLevels] = useState<LevelManifestEntry[]>([]);
  const [cloudLevels, setCloudLevels] = useState<ContentItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const stateRef = useRef<EditorState | null>(null);
  const navigate = useNavigate();
  const { user, session } = useAuth();

  if (!stateRef.current) {
    stateRef.current = new EditorState();
  }

  const editorState = stateRef.current;

  const forceUpdate = useCallback(() => {
    setTick(t => t + 1);
  }, []);

  // Fetch built-in levels manifest + cloud levels when in list phase
  useEffect(() => {
    if (phase !== 'list') return;
    getAvailableLevels().then(setBuiltinLevels).catch(err => {
      console.warn('Failed to load level manifest:', err);
    });
    if (!session) {
      setCloudLevels([]);
      return;
    }
    setLoadingList(true);
    contentApi.listLevels(session).then(items => {
      setCloudLevels(items);
    }).catch(err => {
      console.warn('Failed to load levels:', err);
    }).finally(() => {
      setLoadingList(false);
    });
  }, [phase, session]);

  const handleTestPlay = useCallback(() => {
    const json = editorState.toJSON();
    sessionStorage.setItem('testLevel', json);
    navigate('/sandbox?testLevel=1');
  }, [editorState, navigate]);

  const handleEditBuiltin = useCallback(async (entry: LevelManifestEntry) => {
    try {
      const level = await loadBuiltinLevel(entry.id);
      level.name = level.name + ' (Copy)';
      stateRef.current = new EditorState(level);
      stateRef.current.contentId = null;
      stateRef.current.isPublished = false;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  }, [forceUpdate]);

  const handleEditCloud = useCallback(async (item: ContentItem) => {
    try {
      const levelData = await contentApi.loadLevel(item.id, session ?? undefined);
      stateRef.current = new EditorState(levelData);
      stateRef.current.contentId = item.id;
      stateRef.current.isPublished = item.isPublic;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  }, [session, forceUpdate]);

  const handleDeleteCloud = useCallback(async (item: ContentItem) => {
    if (!session) return;
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
      await contentApi.deleteLevel(session, item.id);
      setCloudLevels(prev => prev.filter(i => i.id !== item.id));
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    }
  }, [session]);

  const handleCreateNew = useCallback((levelTypes: LevelType[]) => {
    stateRef.current = new EditorState();
    stateRef.current.newLevel(levelTypes);
    stateRef.current.contentId = null;
    stateRef.current.isPublished = false;
    setPhase('editing');
    forceUpdate();
  }, [forceUpdate]);

  const handleBackToList = useCallback(() => {
    setPhase('list');
  }, []);

  // --- Level list screen ---
  if (phase === 'list') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0f1629' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: '#16213e', borderBottom: '1px solid #333' }}>
          <Link to="/">
            <button style={{ padding: '6px 12px', fontSize: 13 }}>Home</button>
          </Link>
          <h2 style={{ color: '#c77dff', fontSize: 20, margin: 0, flex: 1 }}>Level Editor</h2>
          <button
            onClick={() => setPhase('new_level_type')}
            style={{ padding: '8px 20px', fontSize: 14, background: '#c77dff', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}
          >
            + New Level
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Built-in levels */}
          <h3 style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Built-in Levels</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
            {builtinLevels.map(entry => (
              <div key={entry.id} style={{
                background: '#1a2240', borderRadius: 8, padding: 16, border: '1px solid #2a3a5a',
                cursor: 'pointer', transition: 'border-color 0.15s',
              }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = '#7b68ee')}
                onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a3a5a')}
                onClick={() => handleEditBuiltin(entry)}
              >
                <span style={{ color: '#ddd', fontSize: 15, fontWeight: 600 }}>{entry.name}</span>
                <div style={{ color: '#888', fontSize: 11, marginTop: 4 }}>Opens as copy</div>
              </div>
            ))}
          </div>

          {/* Cloud levels */}
          <h3 style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Your Levels</h3>
          {!session ? (
            <p style={{ color: '#666', fontSize: 13 }}>Sign in to see your saved levels</p>
          ) : loadingList ? (
            <p style={{ color: '#888', fontSize: 13 }}>Loading...</p>
          ) : cloudLevels.length === 0 ? (
            <p style={{ color: '#666', fontSize: 13 }}>No saved levels yet. Create one!</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
              {cloudLevels.map(item => (
                <div key={item.id} style={{
                  background: '#1a2240', borderRadius: 8, padding: 16, border: '1px solid #2a3a5a',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#7b68ee')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a3a5a')}
                  onClick={() => handleEditCloud(item)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: '#ddd', fontSize: 15, fontWeight: 600 }}>{item.name}</span>
                    <span style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 3,
                      background: item.isPublic ? '#2d8a4f22' : '#6a5a1a22',
                      color: item.isPublic ? '#4ae04a' : '#c7a94a',
                    }}>
                      {item.isPublic ? 'Public' : 'Private'}
                    </span>
                  </div>
                  <div style={{ color: '#666', fontSize: 11 }}>
                    Updated {new Date(item.updatedAt).toLocaleDateString()}
                  </div>
                  {item.creatorId === user?.id && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteCloud(item); }}
                      style={{ marginTop: 8, background: '#6b0000', border: 'none', borderRadius: 3, color: '#faa', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Level type picker for new level (multi-select) ---
  if (phase === 'new_level_type') {
    return <NewLevelTypePicker onCreateNew={handleCreateNew} onBack={() => setPhase('list')} />;
  }

  // --- Editing phase ---
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', background: '#16213e', borderBottom: '1px solid #333' }}>
        <button onClick={handleBackToList} style={{ padding: '6px 12px', fontSize: 13 }}>
          Back
        </button>
        {getLevelTypes(editorState.level).map(lt => (
          <span key={lt} style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 4,
            background: LEVEL_TYPE_COLORS[lt] + '22',
            color: LEVEL_TYPE_COLORS[lt],
            fontWeight: 600,
          }}>
            {LEVEL_TYPE_LABELS[lt]}
          </span>
        ))}
        <div style={{ flex: 1 }}>
          <EditorToolbar state={editorState} onUpdate={forceUpdate} onTestPlay={handleTestPlay} />
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <EditorCanvas state={editorState} onUpdate={forceUpdate} />
        </div>
        <EditorProperties state={editorState} onUpdate={forceUpdate} />
      </div>
    </div>
  );
}
