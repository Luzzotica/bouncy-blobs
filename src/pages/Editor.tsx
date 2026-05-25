import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EditorState } from '../editor/EditorState';
import EditorToolbar from '../editor/EditorToolbar';
import EditorCanvas from '../editor/EditorCanvas';
import EditorProperties from '../editor/EditorProperties';
import MapPreview from '../components/MapPreview';
import { LevelData, LevelType, getLevelTypes } from '../levels/types';
import { getBuiltinLevels, loadBuiltinLevel, LevelManifestEntry } from '../levels/levelRegistry';
import {
  deleteLocalMap,
  listLocalMaps,
  readLocalMap,
  writeLocalMap,
  revealMapInFiles,
  canRevealInFiles,
  downloadMapJson,
  type LocalMap,
} from '../lib/mapsStore';
import {
  isSteamAvailable,
  openWorkshopOverlay,
  openWorkshopBrowseOverlay,
  listSubscribedItems,
  getItemDetails,
  unsubscribeFromItem,
  readSubscribedLevelJson,
  type WorkshopItemDetail,
} from '../lib/workshopApi';

const LEVEL_TYPE_LABELS: Record<LevelType, string> = {
  solo_racing: 'Solo Racing',
  team_racing: 'Chained Together',
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
  team_racing: 'Chained together — everyone reaches the end',
  party: 'UCH-style rounds with item placement',
  koth: 'Control the hill to score points',
};

function NewLevelTypePicker({ onCreateNew, onBack, busy }: { onCreateNew: (types: LevelType[], name: string) => void; onBack: () => void; busy: boolean }) {
  const [selected, setSelected] = useState<Set<LevelType>>(new Set());
  const [name, setName] = useState('');
  const trimmedName = name.trim();
  const canSubmit = selected.size > 0 && trimmedName.length > 0 && !busy;

  const toggle = (lt: LevelType) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(lt)) next.delete(lt); else next.add(lt);
      return next;
    });
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#0f1629', gap: 20 }}>
      <h2 style={{ color: '#c77dff', fontSize: 24, margin: 0 }}>New Level</h2>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <label style={{ color: '#aaa', fontSize: 13 }}>Name</label>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canSubmit) onCreateNew(Array.from(selected), trimmedName); }}
          placeholder="e.g. Lava Tower"
          maxLength={80}
          style={{
            padding: '8px 12px', fontSize: 15, minWidth: 280,
            background: '#1a2240', border: '1px solid #2a3a5a', borderRadius: 6,
            color: '#fff', textAlign: 'center',
          }}
        />
      </div>
      <p style={{ color: '#888', fontSize: 14, margin: 0 }}>Select one or more modes this map supports</p>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        {(['solo_racing', 'team_racing', 'koth'] as LevelType[]).map(lt => {
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
          onClick={() => onCreateNew(Array.from(selected), trimmedName)}
          disabled={!canSubmit}
          style={{
            padding: '8px 24px', fontSize: 14, fontWeight: 'bold',
            background: canSubmit ? '#c77dff' : '#333',
            border: 'none', borderRadius: 6,
            color: canSubmit ? '#fff' : '#666',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Creating…' : 'Create Level'}
        </button>
      </div>
    </div>
  );
}

function SaveStatusBadge({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  const text = status === 'saving' ? 'Saving…'
    : status === 'saved' ? 'Saved ✓'
    : status === 'error' ? 'Save failed'
    : '';
  const color = status === 'error' ? '#ff6666'
    : status === 'saving' ? '#c7a94a'
    : status === 'saved' ? '#4ae04a'
    : '#888';
  if (!text) return null;
  return <span style={{ color, fontSize: 11, marginRight: 8 }}>{text}</span>;
}

export default function Editor() {
  const [, setTick] = useState(0);
  const [phase, setPhase] = useState<EditorPhase>('list');
  const [builtinLevels, setBuiltinLevels] = useState<LevelManifestEntry[]>([]);
  const [localMaps, setLocalMaps] = useState<LocalMap[]>([]);
  const [subscribed, setSubscribed] = useState<WorkshopItemDetail[]>([]);
  /** Cached LevelData for preview thumbnails, keyed by source ("builtin:<id>" or "local:<id>"). */
  const [previewLevels, setPreviewLevels] = useState<Record<string, LevelData>>({});
  const [steamReady, setSteamReady] = useState(false);
  const stateRef = useRef<EditorState | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  if (!stateRef.current) {
    stateRef.current = new EditorState();
  }

  const editorState = stateRef.current;

  type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const autosaveTimer = useRef<number | null>(null);
  const inFlightSave = useRef(false);

  const forceUpdate = useCallback(() => setTick(t => t + 1), []);

  // Probe Steam availability once.
  useEffect(() => {
    isSteamAvailable().then(setSteamReady).catch(() => setSteamReady(false));
  }, []);

  // Debounced local autosave on every change.
  const runAutosave = useCallback(async () => {
    if (inFlightSave.current) return;
    inFlightSave.current = true;
    setSaveStatus('saving');
    try {
      const result = await writeLocalMap({
        id: editorState.localId ?? undefined,
        workshopId: editorState.workshopId,
        level: editorState.level,
      });
      editorState.localId = result.id;
      setSaveStatus('saved');
    } catch (err) {
      console.warn('Autosave failed:', err);
      setSaveStatus('error');
    } finally {
      inFlightSave.current = false;
    }
  }, [editorState]);

  useEffect(() => {
    if (phase !== 'editing') return;
    editorState.onChange = () => {
      try { localStorage.setItem('editor:lastLevel', editorState.toJSON()); } catch {}
      if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = window.setTimeout(runAutosave, 500) as unknown as number;
    };
    return () => { editorState.onChange = undefined; };
  }, [phase, editorState, runAutosave]);

  // Restore editing session after returning from test-play.
  useEffect(() => {
    if (searchParams.get('restore') !== '1') return;
    const raw = sessionStorage.getItem('editorReturnState');
    if (!raw) {
      setSearchParams({}, { replace: true });
      return;
    }
    try {
      const saved = JSON.parse(raw) as { level: LevelData; localId: string | null; workshopId: string | null };
      const fresh = new EditorState(saved.level);
      fresh.localId = saved.localId;
      fresh.workshopId = saved.workshopId;
      stateRef.current = fresh;
      setPhase('editing');
    } catch (e) {
      console.warn('Failed to restore editor state:', e);
    }
    setSearchParams({}, { replace: true });
    forceUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch built-in levels + local maps when in list phase
  useEffect(() => {
    if (phase !== 'list') return;
    getBuiltinLevels().then(setBuiltinLevels).catch(err => {
      console.warn('Failed to load level manifest:', err);
    });
    listLocalMaps().then(setLocalMaps).catch(err => {
      console.warn('Failed to list local maps:', err);
      setLocalMaps([]);
    });
  }, [phase]);

  // Fetch subscribed Workshop maps + their details when Steam is up.
  useEffect(() => {
    if (phase !== 'list' || !steamReady) {
      if (phase !== 'list') setSubscribed([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const items = await listSubscribedItems();
        const ids = items.filter(i => i.installed).map(i => i.workshopId);
        if (ids.length === 0) {
          if (!cancelled) setSubscribed([]);
          return;
        }
        const details = await getItemDetails(ids);
        if (!cancelled) setSubscribed(details);
      } catch (err) {
        console.warn('Failed to load subscribed Workshop items:', err);
        if (!cancelled) setSubscribed([]);
      }
    })();
    return () => { cancelled = true; };
  }, [phase, steamReady]);

  const handleEditWorkshop = useCallback(async (item: WorkshopItemDetail) => {
    try {
      const json = await readSubscribedLevelJson(item.workshopId);
      // Stored shape on disk is either a bare LevelData or { level: LevelData }.
      const parsed = JSON.parse(json);
      const level: LevelData = parsed?.level ?? parsed;
      level.name = (level.name || item.title) + ' (Copy)';
      const fresh = new EditorState(level);
      // Don't carry the workshopId — this is the subscriber's local copy.
      fresh.localId = null;
      fresh.workshopId = null;
      stateRef.current = fresh;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to open Workshop map: ' + (err?.message ?? err));
    }
  }, [forceUpdate]);

  const handleUnsubscribe = useCallback(async (item: WorkshopItemDetail) => {
    if (!confirm(`Unsubscribe from "${item.title}"?`)) return;
    try {
      await unsubscribeFromItem(item.workshopId);
      setSubscribed(prev => prev.filter(s => s.workshopId !== item.workshopId));
    } catch (err: any) {
      alert('Unsubscribe failed: ' + (err?.message ?? err));
    }
  }, []);

  // Load LevelData for every map card so we can render previews.
  useEffect(() => {
    if (phase !== 'list') return;
    let cancelled = false;
    (async () => {
      const next: Record<string, LevelData> = {};
      await Promise.all([
        ...builtinLevels.map(async (e) => {
          const key = `builtin:${e.id}`;
          if (previewLevels[key]) { next[key] = previewLevels[key]; return; }
          try { next[key] = await loadBuiltinLevel(e.id); } catch {}
        }),
        ...localMaps.map(async (m) => {
          const key = `local:${m.id}`;
          // Always re-read local maps in case the user just edited & autosaved one.
          try {
            const mf = await readLocalMap(m.id);
            next[key] = mf.level;
          } catch {
            if (previewLevels[key]) next[key] = previewLevels[key];
          }
        }),
      ]);
      if (!cancelled) setPreviewLevels(next);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, builtinLevels, localMaps]);

  const handleTestPlay = useCallback(() => {
    const json = editorState.toJSON();
    sessionStorage.setItem('testLevel', json);
    sessionStorage.setItem('editorReturnState', JSON.stringify({
      level: editorState.level,
      localId: editorState.localId,
      workshopId: editorState.workshopId,
    }));
    navigate('/sandbox?testLevel=1&from=editor');
  }, [editorState, navigate]);

  const handleEditBuiltin = useCallback(async (entry: LevelManifestEntry) => {
    try {
      const level = await loadBuiltinLevel(entry.id);
      level.name = level.name + ' (Copy)';
      stateRef.current = new EditorState(level);
      stateRef.current.localId = null;
      stateRef.current.workshopId = null;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  }, [forceUpdate]);

  const handleEditLocal = useCallback(async (item: LocalMap) => {
    try {
      const mf = await readLocalMap(item.id);
      stateRef.current = new EditorState(mf.level);
      stateRef.current.localId = item.id;
      stateRef.current.workshopId = mf.workshopId ?? null;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  }, [forceUpdate]);

  const handleDeleteLocal = useCallback(async (item: LocalMap) => {
    if (!confirm(`Delete "${item.name}"? This only removes the local copy. Steam Workshop items are unaffected.`)) return;
    try {
      await deleteLocalMap(item.id);
      setLocalMaps(prev => prev.filter(i => i.id !== item.id));
    } catch (err: any) {
      alert('Delete failed: ' + err.message);
    }
  }, []);

  const [creatingLevel, setCreatingLevel] = useState(false);
  const handleCreateNew = useCallback(async (levelTypes: LevelType[], name: string) => {
    if (creatingLevel) return;
    setCreatingLevel(true);
    try {
      const fresh = new EditorState();
      fresh.newLevel(levelTypes);
      fresh.level.name = name;
      try {
        const result = await writeLocalMap({ level: fresh.level });
        fresh.localId = result.id;
      } catch (err: any) {
        console.warn('Failed to create local file:', err);
      }
      stateRef.current = fresh;
      setPhase('editing');
      forceUpdate();
    } finally {
      setCreatingLevel(false);
    }
  }, [forceUpdate, creatingLevel]);

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
          {steamReady && (
            <button
              onClick={() => { openWorkshopBrowseOverlay().catch(err => alert('Failed to open Workshop: ' + (err?.message ?? err))); }}
              style={{ padding: '8px 16px', fontSize: 13, background: '#2d6a4f', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer' }}
              title="Browse the Steam Workshop in the Steam overlay"
            >
              Browse Workshop
            </button>
          )}
          <button
            onClick={() => setPhase('new_level_type')}
            style={{ padding: '8px 20px', fontSize: 14, background: '#c77dff', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}
          >
            + New Level
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Local maps */}
          <h3 style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1 }}>
            Your Maps {localMaps.length > 0 && <span style={{ color: '#666' }}>({localMaps.length})</span>}
          </h3>
          {localMaps.length === 0 ? (
            <p style={{ color: '#666', fontSize: 13, marginBottom: 32 }}>No saved maps yet. Create one!</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
              {localMaps.map(item => {
                const lvl = previewLevels[`local:${item.id}`];
                return (
                <div key={item.id} style={{
                  background: '#1a2240', borderRadius: 8, padding: 12, border: '1px solid #2a3a5a',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#7b68ee')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a3a5a')}
                  onClick={() => handleEditLocal(item)}
                >
                  <div style={{ background: '#0f1629', borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {lvl
                      ? <MapPreview level={lvl} width={260} height={160} />
                      : <span style={{ color: '#555', fontSize: 11 }}>Loading…</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: '#ddd', fontSize: 15, fontWeight: 600 }}>{item.name}</span>
                    {item.workshopId && (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 3,
                        background: '#2d8a4f22', color: '#4ae04a',
                      }}>Workshop</span>
                    )}
                  </div>
                  <div style={{ color: '#666', fontSize: 11 }}>
                    Updated {new Date(item.updatedAtMs).toLocaleDateString()}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {item.workshopId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openWorkshopOverlay(item.workshopId!); }}
                        style={{ background: '#2d6a4f', border: 'none', borderRadius: 3, color: '#fff', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                      >
                        View on Workshop
                      </button>
                    )}
                    {canRevealInFiles() ? (
                      <button
                        onClick={async (e) => { e.stopPropagation(); try { await revealMapInFiles(item.id); } catch (err: any) { alert('Reveal failed: ' + (err?.message ?? err)); } }}
                        style={{ background: '#2a3a5a', border: '1px solid #3a4a6a', borderRadius: 3, color: '#ddd', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                        title={item.path}
                      >
                        Show in Finder
                      </button>
                    ) : (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const mf = await readLocalMap(item.id); await downloadMapJson(item, mf.level); }}
                        style={{ background: '#2a3a5a', border: '1px solid #3a4a6a', borderRadius: 3, color: '#ddd', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                      >
                        Download
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteLocal(item); }}
                      style={{ background: '#6b0000', border: 'none', borderRadius: 3, color: '#faa', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* Workshop subscriptions */}
          {steamReady && (
            <>
              <h3 style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1 }}>
                Subscribed Workshop Maps {subscribed.length > 0 && <span style={{ color: '#666' }}>({subscribed.length})</span>}
              </h3>
              {subscribed.length === 0 ? (
                <p style={{ color: '#666', fontSize: 13, marginBottom: 32 }}>
                  None yet. Click <em>Browse Workshop</em> above to find some.
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
                  {subscribed.map(item => (
                    <div key={item.workshopId} style={{
                      background: '#1a2240', borderRadius: 8, padding: 12, border: '1px solid #2a3a5a',
                      cursor: 'pointer', transition: 'border-color 0.15s',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = '#7b68ee')}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a3a5a')}
                      onClick={() => handleEditWorkshop(item)}
                    >
                      <div style={{ background: '#0f1629', borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {item.previewUrl
                          ? <img src={item.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ color: '#555', fontSize: 11 }}>No preview</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: '#ddd', fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.title}</span>
                        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, background: '#2d8a4f22', color: '#4ae04a' }}>Workshop</span>
                      </div>
                      <div style={{ color: '#666', fontSize: 11 }}>
                        ▲ {item.numUpvotes} · ▼ {item.numDownvotes}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); openWorkshopOverlay(item.workshopId); }}
                          style={{ background: '#2d6a4f', border: 'none', borderRadius: 3, color: '#fff', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                        >
                          View on Workshop
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnsubscribe(item); }}
                          style={{ background: '#6b0000', border: 'none', borderRadius: 3, color: '#faa', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                        >
                          Unsubscribe
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Built-in levels */}
          <h3 style={{ color: '#aaa', fontSize: 14, margin: '0 0 12px', textTransform: 'uppercase', letterSpacing: 1 }}>Built-in Levels</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
            {builtinLevels.map(entry => {
              const lvl = previewLevels[`builtin:${entry.id}`];
              return (
                <div key={entry.id} style={{
                  background: '#1a2240', borderRadius: 8, padding: 12, border: '1px solid #2a3a5a',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = '#7b68ee')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#2a3a5a')}
                  onClick={() => handleEditBuiltin(entry)}
                >
                  <div style={{ background: '#0f1629', borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {lvl
                      ? <MapPreview level={lvl} width={260} height={160} />
                      : <span style={{ color: '#555', fontSize: 11 }}>Loading…</span>}
                  </div>
                  <span style={{ color: '#ddd', fontSize: 14, fontWeight: 600 }}>{entry.name}</span>
                  <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>Opens as copy</div>
                </div>
              );
            })}
          </div>

        </div>
      </div>
    );
  }

  if (phase === 'new_level_type') {
    return <NewLevelTypePicker onCreateNew={handleCreateNew} onBack={() => setPhase('list')} busy={creatingLevel} />;
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
          <EditorToolbar state={editorState} onUpdate={forceUpdate} onTestPlay={handleTestPlay} steamAvailable={steamReady} />
        </div>
        <SaveStatusBadge status={saveStatus} />
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
