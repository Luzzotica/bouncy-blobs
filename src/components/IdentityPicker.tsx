import React from 'react';
import { getAllFacePresets } from '../renderer/faceRenderer';
import BlobPreview from './BlobPreview';
import FaceSwatch from './FaceSwatch';
import { COLORS } from '../theme/uiTheme';

interface Props {
  color: string;
  faceId: string;
  onColorChange: (hex: string) => void;
  onFaceChange: (faceId: string) => void;
  previewSize?: number;
}

/** Blob customization controls: an animated live preview, a colour picker, and
 * a grid of selectable eyes/faces. Shared by the /play side panel and the
 * first-time picker so both stay in sync. */
export default function IdentityPicker({
  color, faceId, onColorChange, onFaceChange, previewSize = 200,
}: Props) {
  const faces = getAllFacePresets();
  return (
    <div style={wrap}>
      <div style={previewBox}>
        <BlobPreview color={color} faceId={faceId} size={previewSize} />
      </div>

      <label style={colorRow}>
        <span>Colour</span>
        <input
          type="color"
          value={color}
          onChange={(e) => onColorChange(e.target.value)}
          style={colorSwatch}
          aria-label="Blob colour"
        />
      </label>

      <div style={facesLabel}>Eyes</div>
      <div style={facesGrid}>
        {faces.map((f) => {
          const selected = f.id === faceId;
          return (
            <button
              key={f.id}
              type="button"
              onClick={() => onFaceChange(f.id)}
              title={f.label}
              aria-label={f.label}
              aria-pressed={selected}
              style={{
                ...faceBtn,
                borderColor: selected ? COLORS.purple : '#0a0612',
                boxShadow: selected ? `0 0 0 3px ${COLORS.lavender}` : 'none',
                background: selected ? COLORS.paperInput : COLORS.paper,
              }}
            >
              <FaceSwatch faceId={f.id} color={color} size={34} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

const wrap: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'stretch',
};

const previewBox: React.CSSProperties = {
  alignSelf: 'center',
  background: 'rgba(10, 6, 18, 0.35)',
  border: '3px solid #0a0612', borderRadius: 12,
  padding: 6, lineHeight: 0,
};

const colorRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  fontSize: 15, fontWeight: 800, color: COLORS.ink,
};

const colorSwatch: React.CSSProperties = {
  width: 48, height: 30, padding: 0,
  border: '2px solid #0a0612', borderRadius: 4, cursor: 'pointer', background: 'transparent',
};

const facesLabel: React.CSSProperties = {
  fontSize: 15, fontWeight: 800, color: COLORS.ink,
};

const facesGrid: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
};

const faceBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 5, borderRadius: 8, border: '2px solid #0a0612', cursor: 'pointer',
};
