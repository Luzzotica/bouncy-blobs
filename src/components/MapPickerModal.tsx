import React, { useEffect, useRef, useState } from 'react';
import type { LevelData } from '../levels/types';
import MapPreview from './MapPreview';
import type { MapOption } from './LobbyPanel';
import { playSfx } from '../utils/audio';
import { COLORS } from '../theme/uiTheme';

interface MapPickerModalProps {
  open: boolean;
  options: MapOption[];                    // already filtered by mode
  currentMapId: string;
  onCancel: () => void;
  onConfirm: (mapId: string) => void;
  /** Returns LevelData for a map id; the modal calls this lazily as it opens. */
  loadLevel: (mapId: string) => Promise<LevelData>;
  /** Load a shared community level by its share code (adds + selects it). */
  onLoadCloudCode?: (code: string) => Promise<void>;
}

/**
 * Map picker. Opens over the lobby panel/canvas, shows a grid of map cards
 * with rendered previews. Click a card to mark it as the pending selection;
 * Confirm commits and closes. Built-ins show no badge; cloud levels show a
 * "Custom" badge so the host knows they're user-uploaded.
 */
export default function MapPickerModal({
  open, options, currentMapId, onCancel, onConfirm, loadLevel, onLoadCloudCode,
}: MapPickerModalProps) {
  const [pendingId, setPendingId] = useState(currentMapId);
  const [code, setCode] = useState('');
  const [loadingCode, setLoadingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const submitCode = async () => {
    if (!onLoadCloudCode || !code.trim()) return;
    setLoadingCode(true);
    setCodeError(null);
    try {
      await onLoadCloudCode(code.trim());
      setCode('');
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : 'Could not load that code');
    } finally {
      setLoadingCode(false);
    }
  };
  const [levels, setLevels] = useState<Map<string, LevelData>>(new Map());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  // Reset pending selection whenever the modal is reopened.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setPendingId(currentMapId);
      playSfx('ui-modal-open', { volume: 0.6 });
    } else if (!open && wasOpenRef.current) {
      playSfx('ui-modal-close', { volume: 0.5 });
    }
    wasOpenRef.current = open;
  }, [open, currentMapId]);

  // Lazy-load level data for each visible card. Cache across openings via the
  // levels Map state — once loaded, the data sticks for the lifetime of the
  // component, so closing and reopening the modal is instant.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    for (const m of options) {
      if (levels.has(m.id) || errors.has(m.id)) continue;
      void loadLevel(m.id)
        .then((data) => {
          if (cancelled) return;
          setLevels((prev) => {
            const next = new Map(prev);
            next.set(m.id, data);
            return next;
          });
        })
        .catch((err: Error) => {
          if (cancelled) return;
          setErrors((prev) => {
            const next = new Map(prev);
            next.set(m.id, err.message ?? 'Failed to load');
            return next;
          });
        });
    }
    return () => { cancelled = true; };
  }, [open, options, loadLevel, levels, errors]);

  if (!open) return null;

  return (
    <div
      data-testid="map-picker-modal"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(820px, 90vw)',
          maxHeight: '85vh',
          background: '#181a24',
          border: '1px solid #2a2d3a',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          color: '#ddd',
          boxShadow: '0 10px 40px rgba(0,0,0,0.6)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid #232634',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Pick a Map</div>
          <button
            onClick={onCancel}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#888',
              fontSize: 20,
              cursor: 'pointer',
              padding: '0 4px',
            }}
            title="Close"
          >×</button>
        </div>

        {/* Grid */}
        <div style={{
          padding: 16,
          overflowY: 'auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 12,
        }}>
          {options.length === 0 && (
            <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: '#888', padding: 32 }}>
              No maps available for this mode.
            </div>
          )}
          {options.map((m) => {
            const isPending = m.id === pendingId;
            const level = levels.get(m.id);
            const err = errors.get(m.id);
            return (
              <button
                key={m.id}
                data-testid={`map-card-${m.id}`}
                onClick={() => setPendingId(m.id)}
                style={{
                  background: '#1f2230',
                  border: isPending ? '2px solid #5dd6ff' : '2px solid #2a2d3a',
                  borderRadius: 6,
                  padding: 8,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  textAlign: 'left',
                  color: '#ddd',
                }}
              >
                <div style={{ height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {level
                    ? <MapPreview level={level} width={200} height={130} />
                    : err
                      ? <div style={{ color: '#f66', fontSize: 11, padding: 8, textAlign: 'center' }}>Preview failed<br/>{err}</div>
                      : <div style={{ color: '#666', fontSize: 12 }}>Loading…</div>
                  }
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ flex: 1, fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                  </span>
                  {(m.source === 'local' || m.source === 'workshop' || m.source === 'cloud') && (
                    <span
                      data-testid="custom-badge"
                      style={{
                        fontSize: 10,
                        padding: '2px 6px',
                        background: COLORS.purple,
                        color: COLORS.onAccent,
                        borderRadius: 10,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5,
                      }}
                    >Custom</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px',
          borderTop: '1px solid #232634',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'flex-end',
        }}>
          {onLoadCloudCode && (
            <div style={{ display: 'flex', gap: 6, marginRight: 'auto', alignItems: 'center' }}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitCode(); }}
                placeholder="SHARE CODE"
                maxLength={8}
                style={{
                  padding: '8px 10px', fontSize: 13, width: 130, letterSpacing: '0.12em',
                  background: '#1a1d28', color: '#ddd', border: '1px solid #353a4c', borderRadius: 4,
                }}
              />
              <button
                onClick={() => void submitCode()}
                disabled={loadingCode || !code.trim()}
                style={{
                  padding: '8px 14px', fontSize: 13, background: '#2d4a6a', color: '#fff',
                  border: 'none', borderRadius: 4, cursor: 'pointer', opacity: loadingCode ? 0.6 : 1,
                }}
              >{loadingCode ? '…' : '☁ Load'}</button>
              {codeError && <span style={{ fontSize: 11, color: '#e06a6a' }}>{codeError}</span>}
            </div>
          )}
          <button
            onClick={onCancel}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              background: '#2a2d3a',
              color: '#ddd',
              border: '1px solid #353a4c',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            data-testid="map-picker-confirm"
            onClick={() => onConfirm(pendingId)}
            disabled={!options.some((m) => m.id === pendingId)}
            style={{
              padding: '8px 20px',
              fontSize: 13,
              fontWeight: 700,
              background: '#2d6a4f',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >Confirm</button>
        </div>
      </div>
    </div>
  );
}
