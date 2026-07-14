import React, { useState } from 'react';
import { EditorState, EditorTool } from './EditorState';
import PublishDialog from './PublishDialog';
import { writeLocalMap } from '../lib/mapsStore';
import { exportLocalMap, importLocalMap, readLocalMap } from '../lib/localMaps';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { isTauri } from '../lib/runtime';
import { COLORS, paperPanel, paperBtnSm, actionBtnSm } from '../theme/uiTheme';
import { useIsNarrow } from '../lib/useIsNarrow';
import { publishLevelToCloud } from '../levels/levelRegistry';
import { LoginRequiredError } from '../lib/party';
import { SignInModal } from '../components/SignInModal';
import { editorCloud } from '../levels/levelRegistry';

interface EditorToolbarProps {
  state: EditorState;
  onUpdate: () => void;
  onTestPlay: () => void;
  steamAvailable: boolean;
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
  { id: 'pointShape', label: 'Shape', hotkey: 'Q' },
  { id: 'trigger', label: 'Trigger', hotkey: 'W' },
  { id: 'action', label: 'Action', hotkey: 'E' },
  { id: 'softPlatform', label: 'Soft Platform', hotkey: 'R' },
  { id: 'deathZone', label: 'Death', hotkey: 'D' },
  { id: 'sprite', label: 'Sprite', hotkey: 'T' },
  { id: 'chain', label: 'Chain', hotkey: 'C' },
  { id: 'gravityZone', label: 'Gravity', hotkey: 'G' },
];

export default function EditorToolbar({ state, onUpdate, onTestPlay, steamAvailable }: EditorToolbarProps) {
  const [publishOpen, setPublishOpen] = useState(false);
  const [cloudSharing, setCloudSharing] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  // Phone: a wrapped 27-button toolbar would eat half the screen — scroll
  // one row horizontally instead, with bigger (finger-sized) buttons.
  const narrow = useIsNarrow();
  const btnExtra: React.CSSProperties = narrow
    ? { minHeight: 40, whiteSpace: 'nowrap', flexShrink: 0 }
    : {};
  const abtn = (bg?: string, fg?: string): React.CSSProperties => ({ ...actionBtnStyle(bg, fg), ...btnExtra });

  const shareToCloud = async () => {
    if (state.level.spawnPoints.length === 0) { alert('Add at least one spawn point first.'); return; }
    setCloudSharing(true);
    try {
      const { shareCode } = await publishLevelToCloud(state.level, 'public');
      await navigator.clipboard.writeText(shareCode).catch(() => {});
      alert(`Shared to the community! Code: ${shareCode}\n(copied — anyone can load it, on any platform)`);
    } catch (err: any) {
      if (err instanceof LoginRequiredError) { setShowSignIn(true); }
      else alert('Share failed: ' + (err?.message ?? err));
    } finally {
      setCloudSharing(false);
    }
  };

  const handleExport = async () => {
    if (!state.localId) {
      alert('Save the map first (it autosaves once you make a change).');
      return;
    }
    try {
      const dest = await saveDialog({
        defaultPath: `${state.level.name || 'level'}.json`,
        filters: [{ name: 'Level JSON', extensions: ['json'] }],
      });
      if (!dest) return;
      await exportLocalMap(state.localId, dest);
    } catch (err: any) {
      alert('Export failed: ' + (err?.message ?? err));
    }
  };

  const handleImport = async () => {
    try {
      const src = await openDialog({
        multiple: false,
        filters: [{ name: 'Level JSON', extensions: ['json'] }],
      });
      if (!src || typeof src !== 'string') return;
      const result = await importLocalMap(src);
      // Read the just-written map back through Tauri (the same path the
      // rest of the app uses). `fetch('file://')` is blocked by default
      // in Tauri 2.x and was silently returning null — when that
      // happened, `loadJSON` never fired and the editor state stayed at
      // whatever was in memory before import (e.g. no triggers),
      // even though the file on disk had the triggers fine.
      const mf = await readLocalMap(result.id);
      state.loadJSON(JSON.stringify(mf.level));
      state.localId = result.id;
      state.workshopId = mf.workshopId ?? null;
      onUpdate();
    } catch (err: any) {
      alert('Import failed: ' + (err?.message ?? err));
    }
  };

  const handleSaveNow = async () => {
    // Manual save trigger — bypasses debounce.
    try {
      const result = await writeLocalMap({
        id: state.localId ?? undefined,
        workshopId: state.workshopId,
        level: state.level,
      });
      state.localId = result.id;
      onUpdate();
    } catch (err: any) {
      alert('Save failed: ' + (err?.message ?? err));
    }
  };

  return (
    <>
      <div style={{
        ...paperPanel,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 12px',
        borderBottom: '3px solid #0a0612',
        ...(narrow
          ? { flexWrap: 'nowrap' as const, overflowX: 'auto' as const, WebkitOverflowScrolling: 'touch' as const }
          : { flexWrap: 'wrap' as const }),
      }}>
        {tools.map(t => (
          <button
            key={t.id}
            onClick={() => {
              if (state.draftPointShape && t.id !== 'pointShape') state.cancelDraftPointShape();
              if (state.draftAction && t.id !== 'action') state.cancelDraftAction();
              if (state.draftChain && t.id !== 'chain') state.cancelDraftChain();
              state.selectedTool = t.id;
              if (t.id === 'pointShape' && !state.draftPointShape) state.beginDraftPointShape();
              if (t.id === 'action' && !state.draftAction) state.beginDraftAction();
              if (t.id === 'chain' && !state.draftChain) state.beginDraftChain();
              onUpdate();
            }}
            title={`${t.label} (${t.hotkey})`}
            style={{
              ...(state.selectedTool === t.id ? actionBtnSm(COLORS.purple) : paperBtnSm),
              padding: '5px 10px',
              fontSize: 12,
              borderRadius: 4,
              ...btnExtra,
            }}
          >
            <span>{t.label}</span>
            <span style={{ fontSize: 9, marginLeft: 3, opacity: 0.5 }}>{t.hotkey}</span>
          </button>
        ))}

        <div style={{ width: 2, height: 20, background: '#0a0612', margin: '0 4px' }} />

        <button
          onClick={() => { state.undo(); onUpdate(); }}
          disabled={state.undoStack.length === 0}
          title="Undo (⌘/Ctrl+Z)"
          style={disableable(abtn(), state.undoStack.length === 0)}
        >
          ↶ Undo
        </button>
        <button
          onClick={() => { state.redo(); onUpdate(); }}
          disabled={state.redoStack.length === 0}
          title="Redo (⌘/Ctrl+Shift+Z)"
          style={disableable(abtn(), state.redoStack.length === 0)}
        >
          ↷ Redo
        </button>

        <div style={{ width: 2, height: 20, background: '#0a0612', margin: '0 4px' }} />

        <button onClick={() => { state.newLevel(); state.localId = null; state.workshopId = null; onUpdate(); }}
          style={abtn()}>
          New
        </button>
        <button onClick={handleSaveNow} style={abtn(COLORS.blue)}>Save</button>
        {isTauri() && <button onClick={handleImport} style={abtn(COLORS.green)}>Import</button>}
        {isTauri() && <button onClick={handleExport} style={abtn(COLORS.green)}>Export</button>}

        <div style={{ width: 2, height: 20, background: '#0a0612', margin: '0 4px' }} />

        <button
          onClick={() => setPublishOpen(true)}
          disabled={!steamAvailable}
          title={steamAvailable ? 'Publish to Steam Workshop' : 'Steam is not running'}
          style={steamAvailable
            ? (state.workshopId ? abtn(COLORS.green) : abtn(COLORS.lavender, COLORS.ink))
            : { ...abtn(), opacity: 0.5, cursor: 'not-allowed' }}
        >
          {state.workshopId ? 'Update Workshop' : 'Publish to Workshop'}
        </button>

        <button
          onClick={shareToCloud}
          disabled={cloudSharing}
          title="Share to the cross-platform community cloud (works everywhere, no Steam needed)"
          style={abtn(COLORS.blue, COLORS.ink)}
        >
          {cloudSharing ? 'Sharing…' : '☁ Share to Cloud'}
        </button>

        <div style={{ flex: 1 }} />

        <button
          onClick={() => { state.showIds = !state.showIds; onUpdate(); }}
          title="Toggle id labels on every entity (I)"
          style={state.showIds ? abtn(COLORS.blue) : abtn()}
        >
          {state.showIds ? 'Labels ON' : 'Labels OFF'}
        </button>
        <button onClick={onTestPlay} style={abtn(COLORS.green)}>Test Play</button>
      </div>

      {publishOpen && (
        <PublishDialog
          state={state}
          onClose={() => setPublishOpen(false)}
          onPublished={(id) => { state.workshopId = id; onUpdate(); setPublishOpen(false); }}
        />
      )}
      {showSignIn && (
        <SignInModal
          cloud={editorCloud}
          onClose={() => setShowSignIn(false)}
          onSignedIn={() => { setShowSignIn(false); void shareToCloud(); }}
        />
      )}
    </>
  );
}

function actionBtnStyle(bg?: string, fg: string = COLORS.paper): React.CSSProperties {
  const base = bg ? actionBtnSm(bg, fg) : paperBtnSm;
  return { ...base, padding: '5px 12px', fontSize: 12, borderRadius: 4 };
}

function disableable(base: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...base, opacity: 0.4, cursor: 'not-allowed' } : base;
}
