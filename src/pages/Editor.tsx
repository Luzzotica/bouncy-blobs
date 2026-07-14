import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { EditorState } from '../editor/EditorState';
import EditorToolbar from '../editor/EditorToolbar';
import EditorCanvas from '../editor/EditorCanvas';
import EditorProperties from '../editor/EditorProperties';
import EditorTouchBar from '../editor/EditorTouchBar';
import { shouldUsePad } from '../game/touchInput';
import { useIsNarrow } from '../lib/useIsNarrow';
import MapPreview from '../components/MapPreview';
import PublishToGameDialog from '../editor/PublishToGameDialog';
import CampaignEditor from '../editor/CampaignEditor';
import { DEV_MAPS, deleteGameMap, setMapHidden } from '../lib/devMaps';
import { LevelData, LevelType, getLevelTypes, validateLevelType } from '../levels/types';
import { features } from '../config/featureFlags';
import { getBuiltinLevels, loadBuiltinLevel, invalidateBuiltinCache, LevelManifestEntry } from '../levels/levelRegistry';
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
import {
  COLORS,
  HAIRLINE,
  pickerLabel,
  paperBtnSm,
  actionBtn,
  actionBtnSm,
} from '../theme/uiTheme';

const LEVEL_TYPE_LABELS: Record<LevelType, string> = {
  solo_racing: 'Solo Racing',
  team_racing: 'Chained Together',
  koth: 'King of the Hill',
};

// Modes the editor lets you author. Party stays out until its mode is fixed;
// Chained Together is gated on the `chainedClimb` feature flag (hidden in demo builds).
const EDITOR_LEVEL_TYPES: LevelType[] = [
  'solo_racing',
  ...(features.chainedClimb ? (['team_racing'] as LevelType[]) : []),
  'koth',
];

const LEVEL_TYPE_COLORS: Record<LevelType, string> = {
  solo_racing: '#4a9eff',
  team_racing: '#4ae04a',
  koth: '#ffa500',
};

/** Small coloured chips showing which game modes a map supports. */
function ModeBadges({ types }: { types: LevelType[] }) {
  if (types.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
      {types.map(lt => (
        <span
          key={lt}
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: 3,
            background: LEVEL_TYPE_COLORS[lt] + '22',
            color: LEVEL_TYPE_COLORS[lt],
            border: `1px solid ${LEVEL_TYPE_COLORS[lt]}44`,
            whiteSpace: 'nowrap',
          }}
        >
          {LEVEL_TYPE_LABELS[lt]}
        </span>
      ))}
    </div>
  );
}

type EditorPhase = 'list' | 'new_level_type' | 'editing';

const LEVEL_TYPE_DESCRIPTIONS: Record<LevelType, string> = {
  solo_racing: 'First to the finish wins',
  team_racing: 'Chained together — everyone climbs to the summit',
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
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: COLORS.paper, gap: 20 }}>
      <h2 style={{ color: COLORS.ink, fontWeight: 900, fontSize: 24, margin: 0 }}>New Level</h2>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <label style={{ color: COLORS.inkFaint, fontSize: 13 }}>Name</label>
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
            background: COLORS.paperInput, border: '2px solid #0a0612', borderRadius: 4,
            color: COLORS.ink, textAlign: 'center',
          }}
        />
      </div>
      <p style={{ color: COLORS.inkFaint, fontSize: 14, margin: 0 }}>Select one or more modes this map supports</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 16, marginTop: 8, maxWidth: '100%', padding: '0 12px' }}>
        {EDITOR_LEVEL_TYPES.map(lt => {
          const active = selected.has(lt);
          return (
            <button
              key={lt}
              onClick={() => toggle(lt)}
              style={{
                padding: '24px 32px',
                fontSize: 16,
                fontWeight: 'bold',
                background: active ? LEVEL_TYPE_COLORS[lt] + '22' : COLORS.paperInput,
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
              <div style={{ fontSize: 11, color: COLORS.inkFaint, marginTop: 6, fontWeight: 'normal' }}>
                {LEVEL_TYPE_DESCRIPTIONS[lt]}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <button
          onClick={onBack}
          style={{ ...paperBtnSm, padding: '8px 20px' }}
        >
          Back
        </button>
        <button
          onClick={() => onCreateNew(Array.from(selected), trimmedName)}
          disabled={!canSubmit}
          style={{
            ...actionBtn(COLORS.lavender, COLORS.ink),
            padding: '8px 24px', fontSize: 14,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            opacity: canSubmit ? 1 : 0.5,
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
  const color = status === 'error' ? COLORS.danger
    : status === 'saving' ? COLORS.inkDim
    : status === 'saved' ? COLORS.green
    : COLORS.inkFaint;
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
  const [showPublishGame, setShowPublishGame] = useState(false);
  const [showCampaign, setShowCampaign] = useState(false);
  /** Touch device: overlay the EditorTouchBar (modifier chips + selection/draft actions). */
  const [usePadDevice] = useState(() => shouldUsePad());
  /** Phone-width: properties panel becomes a slide-over drawer instead of a fixed sidebar. */
  const isNarrow = useIsNarrow();
  const [propsOpen, setPropsOpen] = useState(false);
  const stateRef = useRef<EditorState | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  if (!stateRef.current) {
    stateRef.current = new EditorState();
  }

  const editorState = stateRef.current;
  // Dev/e2e handle (mirrors GameMaster's __bbGame): lets tests assert on the
  // live editor state (zoom, level contents) without UI scraping.
  if (import.meta.env.DEV) (window as unknown as { __bbEditor?: EditorState }).__bbEditor = editorState;

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

  // Dev-only: edit a shipped map *in place* — no "(Copy)" rename, and stamp the
  // builtinId so "Publish to Game" defaults to overwriting the same file.
  const handleEditBuiltinInPlace = useCallback(async (entry: LevelManifestEntry) => {
    try {
      const level = await loadBuiltinLevel(entry.id);
      const fresh = new EditorState(level);
      fresh.localId = null;
      fresh.workshopId = null;
      fresh.builtinId = entry.id;
      stateRef.current = fresh;
      setPhase('editing');
      forceUpdate();
    } catch (err: any) {
      alert('Failed to load level: ' + err.message);
    }
  }, [forceUpdate]);

  // Dev-only: remove a shipped map from the repo (deletes public/levels/<id>.json
  // and its manifest entry). Commit the change to deploy the removal.
  const handleUnpublishBuiltin = useCallback(async (entry: LevelManifestEntry) => {
    if (!confirm(`Unpublish "${entry.name}"?\n\nThis deletes public/levels/${entry.file} and removes it from the manifest. Commit to deploy the removal.`)) return;
    try {
      await deleteGameMap(entry.id);
      invalidateBuiltinCache();
      setBuiltinLevels(prev => prev.filter(e => e.id !== entry.id));
    } catch (err: any) {
      alert('Unpublish failed: ' + (err?.message ?? err));
    }
  }, []);

  // Dev-only: flip a shipped map's hidden flag. Hidden maps stay loadable in the
  // editor/sandbox but won't show in hosting flows.
  const handleToggleHidden = useCallback(async (entry: LevelManifestEntry) => {
    const next = !entry.hidden;
    try {
      await setMapHidden(entry.id, next);
      invalidateBuiltinCache();
      setBuiltinLevels(prev => prev.map(e => (e.id === entry.id ? { ...e, hidden: next } : e)));
    } catch (err: any) {
      alert('Failed to update: ' + (err?.message ?? err));
    }
  }, []);

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
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: COLORS.paper }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 20px', background: COLORS.paper, borderBottom: '3px solid #0a0612' }}>
          <Link to="/">
            <button className="bb-hover-btn" style={paperBtnSm}>Home</button>
          </Link>
          <h2 style={{ color: COLORS.ink, fontWeight: 900, fontSize: 20, margin: 0, flex: 1, textShadow: '1px 1px 0 rgba(199,125,255,0.4)' }}>Level Editor</h2>
          {steamReady && (
            <button
              onClick={() => { openWorkshopBrowseOverlay().catch(err => alert('Failed to open Workshop: ' + (err?.message ?? err))); }}
              style={actionBtnSm(COLORS.green)}
              title="Browse the Steam Workshop in the Steam overlay"
            >
              Browse Workshop
            </button>
          )}
          {DEV_MAPS && (
            <button
              onClick={() => setShowCampaign(true)}
              style={actionBtnSm(COLORS.purple)}
              title="Define the order of levels in the single-player Play campaign"
            >
              Campaign
            </button>
          )}
          <button
            onClick={() => setPhase('new_level_type')}
            style={actionBtn(COLORS.lavender, COLORS.ink)}
          >
            + New Level
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
          {/* Local maps */}
          <h3 style={{ ...pickerLabel, fontSize: 14, margin: '0 0 12px', letterSpacing: 1 }}>
            Your Maps {localMaps.length > 0 && <span style={{ color: COLORS.inkDim }}>({localMaps.length})</span>}
          </h3>
          {localMaps.length === 0 ? (
            <p style={{ color: COLORS.inkFaint, fontSize: 13, marginBottom: 32 }}>No saved maps yet. Create one!</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
              {localMaps.map(item => {
                const lvl = previewLevels[`local:${item.id}`];
                return (
                <div key={item.id} style={{
                  background: COLORS.paper, borderRadius: 6, padding: 12, border: '4px solid #0a0612',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = COLORS.purple)}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#0a0612')}
                  onClick={() => handleEditLocal(item)}
                >
                  <div style={{ background: COLORS.workCanvas, borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {lvl
                      ? <MapPreview level={lvl} width={260} height={160} />
                      : <span style={{ color: '#555', fontSize: 11 }}>Loading…</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: COLORS.ink, fontSize: 15, fontWeight: 600 }}>{item.name}</span>
                    {item.workshopId && (
                      <span style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: '#2d8a4f22', color: COLORS.green,
                      }}>Workshop</span>
                    )}
                  </div>
                  <div style={{ color: COLORS.inkFaint, fontSize: 11 }}>
                    Updated {new Date(item.updatedAtMs).toLocaleDateString()}
                  </div>
                  {lvl && <ModeBadges types={getLevelTypes(lvl)} />}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {item.workshopId && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openWorkshopOverlay(item.workshopId!); }}
                        style={actionBtnSm(COLORS.green)}
                      >
                        View on Workshop
                      </button>
                    )}
                    {canRevealInFiles() ? (
                      <button
                        onClick={async (e) => { e.stopPropagation(); try { await revealMapInFiles(item.id); } catch (err: any) { alert('Reveal failed: ' + (err?.message ?? err)); } }}
                        style={paperBtnSm}
                        title={item.path}
                      >
                        Show in Finder
                      </button>
                    ) : (
                      <button
                        onClick={async (e) => { e.stopPropagation(); const mf = await readLocalMap(item.id); await downloadMapJson(item, mf.level); }}
                        style={paperBtnSm}
                      >
                        Download
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteLocal(item); }}
                      style={actionBtnSm(COLORS.danger)}
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
              <h3 style={{ ...pickerLabel, fontSize: 14, margin: '0 0 12px', letterSpacing: 1 }}>
                Subscribed Workshop Maps {subscribed.length > 0 && <span style={{ color: COLORS.inkDim }}>({subscribed.length})</span>}
              </h3>
              {subscribed.length === 0 ? (
                <p style={{ color: COLORS.inkFaint, fontSize: 13, marginBottom: 32 }}>
                  None yet. Click <em>Browse Workshop</em> above to find some.
                </p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
                  {subscribed.map(item => (
                    <div key={item.workshopId} style={{
                      background: COLORS.paper, borderRadius: 6, padding: 12, border: '4px solid #0a0612',
                      boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                      cursor: 'pointer', transition: 'border-color 0.15s',
                    }}
                      onMouseEnter={e => (e.currentTarget.style.borderColor = COLORS.purple)}
                      onMouseLeave={e => (e.currentTarget.style.borderColor = '#0a0612')}
                      onClick={() => handleEditWorkshop(item)}
                    >
                      <div style={{ background: COLORS.workCanvas, borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {item.previewUrl
                          ? <img src={item.previewUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ color: '#555', fontSize: 11 }}>No preview</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: COLORS.ink, fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{item.title}</span>
                        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#2d8a4f22', color: COLORS.green }}>Workshop</span>
                      </div>
                      <div style={{ color: COLORS.inkFaint, fontSize: 11 }}>
                        ▲ {item.numUpvotes} · ▼ {item.numDownvotes}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); openWorkshopOverlay(item.workshopId); }}
                          style={actionBtnSm(COLORS.green)}
                        >
                          View on Workshop
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnsubscribe(item); }}
                          style={actionBtnSm(COLORS.danger)}
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
          <h3 style={{ ...pickerLabel, fontSize: 14, margin: '0 0 12px', letterSpacing: 1 }}>Built-in Levels</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, marginBottom: 32 }}>
            {builtinLevels.map(entry => {
              const lvl = previewLevels[`builtin:${entry.id}`];
              return (
                <div key={entry.id} style={{
                  background: COLORS.paper, borderRadius: 6, padding: 12, border: '4px solid #0a0612',
                  boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                  cursor: 'pointer', transition: 'border-color 0.15s',
                }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = COLORS.purple)}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = '#0a0612')}
                  onClick={() => (DEV_MAPS ? handleEditBuiltinInPlace(entry) : handleEditBuiltin(entry))}
                >
                  <div style={{ background: COLORS.workCanvas, borderRadius: 4, overflow: 'hidden', marginBottom: 8, aspectRatio: '16 / 10', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {lvl
                      ? <MapPreview level={lvl} width={260} height={160} />
                      : <span style={{ color: '#555', fontSize: 11 }}>Loading…</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: COLORS.ink, fontSize: 14, fontWeight: 600, flex: 1 }}>{entry.name}</span>
                    {entry.hidden && <span style={{ fontSize: 10, color: COLORS.inkFaint, border: '1px solid ' + HAIRLINE, borderRadius: 4, padding: '1px 5px' }}>hidden</span>}
                  </div>
                  <ModeBadges types={lvl ? getLevelTypes(lvl) : (entry.levelTypes ?? [])} />
                  {DEV_MAPS ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditBuiltinInPlace(entry); }}
                        style={actionBtnSm(COLORS.lavender, COLORS.ink)}
                        title={`Edit ${entry.file} in place — publish overwrites the shipped map`}
                      >
                        Edit in place
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleEditBuiltin(entry); }}
                        style={paperBtnSm}
                      >
                        Open as copy
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggleHidden(entry); }}
                        style={{ ...(entry.hidden ? actionBtnSm(COLORS.green) : actionBtnSm(COLORS.yellow, COLORS.ink)), marginLeft: 'auto' }}
                        title={entry.hidden ? 'Show in hosting flows' : 'Hide from hosting flows (stays editable here)'}
                      >
                        {entry.hidden ? 'Unhide' : 'Hide'}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnpublishBuiltin(entry); }}
                        style={actionBtnSm(COLORS.danger)}
                        title={`Delete ${entry.file} from the repo`}
                      >
                        Unpublish
                      </button>
                    </div>
                  ) : (
                    <div style={{ color: COLORS.inkFaint, fontSize: 11, marginTop: 2 }}>Opens as copy</div>
                  )}
                </div>
              );
            })}
          </div>

        </div>
        {showCampaign && <CampaignEditor onClose={() => setShowCampaign(false)} />}
      </div>
    );
  }

  if (phase === 'new_level_type') {
    return <NewLevelTypePicker onCreateNew={handleCreateNew} onBack={() => setPhase('list')} busy={creatingLevel} />;
  }

  // --- Editing phase ---
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', background: COLORS.paper, borderBottom: '3px solid #0a0612' }}>
        <button onClick={handleBackToList} style={paperBtnSm}>
          Back
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' }}>
          {EDITOR_LEVEL_TYPES.map(lt => {
            const enabled = getLevelTypes(editorState.level).includes(lt);
            const missing = validateLevelType(editorState.level, lt);
            const disabled = !enabled && missing !== null;
            const currentTypes = getLevelTypes(editorState.level);
            const wouldRemoveLast = enabled && currentTypes.length === 1;
            const title = enabled
              ? (missing ? `WARNING: ${LEVEL_TYPE_LABELS[lt]} ${missing}. Add it or disable this mode.` : `${LEVEL_TYPE_LABELS[lt]} is enabled`)
              : (missing ? `${LEVEL_TYPE_LABELS[lt]} ${missing} — add one to enable this mode` : `Click to enable ${LEVEL_TYPE_LABELS[lt]}`);
            const onClick = () => {
              if (disabled || wouldRemoveLast) return;
              const next = enabled
                ? currentTypes.filter(t => t !== lt)
                : [...currentTypes, lt];
              editorState.setLevelTypes(next);
              forceUpdate();
            };
            const showWarn = enabled && missing !== null;
            return (
              <button
                key={lt}
                onClick={onClick}
                disabled={disabled || wouldRemoveLast}
                title={title + (wouldRemoveLast ? ' (cannot disable the last mode)' : '')}
                data-no-sfx="true"
                style={{
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 3,
                  background: enabled ? LEVEL_TYPE_COLORS[lt] + '44' : 'transparent',
                  color: enabled ? LEVEL_TYPE_COLORS[lt] : (disabled ? COLORS.inkFaint : COLORS.inkDim),
                  fontWeight: 600,
                  border: enabled
                    ? (showWarn ? '1px solid ' + COLORS.danger : `1px solid ${LEVEL_TYPE_COLORS[lt]}`)
                    : (disabled ? '1px dashed ' + HAIRLINE : '1px dashed ' + COLORS.inkDim),
                  cursor: (disabled || wouldRemoveLast) ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                  textAlign: 'left',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.2,
                }}
              >
                {showWarn && '⚠ '}{LEVEL_TYPE_LABELS[lt]}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }}>
          <EditorToolbar state={editorState} onUpdate={forceUpdate} onTestPlay={handleTestPlay} steamAvailable={steamReady} />
        </div>
        {DEV_MAPS && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginRight: 8 }}>
            <button
              onClick={() => setShowPublishGame(true)}
              style={actionBtnSm(COLORS.lavender, COLORS.ink)}
              title="Write this map into public/levels so it ships with the game"
            >
              {editorState.builtinId ? `Publish ▸ ${editorState.builtinId}` : 'Publish to Game'}
            </button>
            <button
              onClick={() => setShowCampaign(true)}
              style={actionBtnSm(COLORS.purple)}
              title="Define the order of levels in the single-player Play campaign"
            >
              Campaign
            </button>
          </div>
        )}
        <SaveStatusBadge status={saveStatus} />
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <EditorCanvas state={editorState} onUpdate={forceUpdate} />
          {usePadDevice && <EditorTouchBar state={editorState} onUpdate={forceUpdate} />}
          {isNarrow && (
            <button
              onClick={() => setPropsOpen(true)}
              style={{ ...paperBtnSm, position: 'absolute', top: 8, right: 8, zIndex: 25, minHeight: 40 }}
            >
              Properties
            </button>
          )}
        </div>
        {!isNarrow && <EditorProperties state={editorState} onUpdate={forceUpdate} />}
      </div>
      {isNarrow && propsOpen && (
        <div
          onClick={() => setPropsOpen(false)}
          style={{ position: 'absolute', inset: 0, background: 'rgba(10,6,18,0.35)', zIndex: 40 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 0,
              width: 'min(320px, 85vw)',
              display: 'flex',
              paddingBottom: 'var(--safe-area-bottom, 0px)',
              ['--editor-props-width' as string]: '100%',
            } as React.CSSProperties}
          >
            <EditorProperties state={editorState} onUpdate={forceUpdate} />
          </div>
        </div>
      )}
      {showCampaign && <CampaignEditor onClose={() => setShowCampaign(false)} />}
      {showPublishGame && (
        <PublishToGameDialog
          state={editorState}
          existingIds={builtinLevels.map(l => l.id)}
          onClose={() => setShowPublishGame(false)}
          onPublished={(id) => {
            setShowPublishGame(false);
            forceUpdate();
            getBuiltinLevels().then(setBuiltinLevels).catch(() => {});
            setSaveStatus('saved');
            // eslint-disable-next-line no-alert
            alert(`Published "${id}" to the game.\nWrote public/levels/${id}.json + manifest. Commit to deploy.`);
          }}
        />
      )}
    </div>
  );
}
