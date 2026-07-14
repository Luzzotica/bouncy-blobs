import React from 'react';
import { EditorState } from './EditorState';
import { COLORS, paperBtnSm, actionBtnSm } from '../theme/uiTheme';

/**
 * Touch-only editor affordances, overlaid at the bottom of the canvas when
 * the device uses the pad (`shouldUsePad()` — gated by the parent). Three
 * groups, each surfacing something that is keyboard/modifier-only on desktop:
 *
 *  - Sticky modifier chips (per active tool): stand-ins for holding Shift /
 *    Alt. They set `state.touchShift` / `state.touchModifier`, which the
 *    canvas touch layer passes wherever the mouse handlers read
 *    `e.shiftKey` / `isModifierHeld(e)`; mirroring into `angleSnapHeld` /
 *    `modifierHeld` keeps the canvas preview highlights live too.
 *  - Selection actions: Delete / Rotate ±15° / Duplicate / spring-size cycle —
 *    the Del, R/Shift+R, ⌘D and S key paths.
 *  - Draft controls while authoring a point shape / action / chain:
 *    Done (Enter), Close shape (C), Cancel (Escape).
 */

interface EditorTouchBarProps {
  state: EditorState;
  onUpdate: () => void;
}

const barRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  justifyContent: 'center',
  flexWrap: 'wrap',
  pointerEvents: 'auto',
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    ...paperBtnSm,
    minHeight: 40,
    padding: '6px 12px',
    fontWeight: 700,
    background: active ? COLORS.purple : paperBtnSm.background,
    color: active ? COLORS.onAccent : paperBtnSm.color,
  };
}

const touchBtn: React.CSSProperties = { ...paperBtnSm, minHeight: 40, padding: '6px 12px' };

export default function EditorTouchBar({ state, onUpdate }: EditorTouchBarProps) {
  const tool = state.selectedTool;
  const hasSelection = tool === 'select' && (state.selectedElement !== null || state.multiSelect.length > 0);
  const drafting = state.draftPointShape !== null || state.draftAction !== null || state.draftChain !== null;

  const setShift = (on: boolean) => {
    state.touchShift = on;
    state.angleSnapHeld = on; // keep the angle-snap ghost preview live
    onUpdate();
  };
  const setModifier = (on: boolean) => {
    state.touchModifier = on;
    state.modifierHeld = on; // keep the rotation-target highlight live
    onUpdate();
  };

  const chips: React.ReactNode[] = [];
  if (tool === 'select') {
    chips.push(
      <button key="multi" style={chipStyle(state.touchShift)} onClick={() => setShift(!state.touchShift)}>
        +Select
      </button>,
    );
  }
  if (tool === 'pointShape') {
    chips.push(
      <button key="snap" style={chipStyle(state.touchShift)} onClick={() => setShift(!state.touchShift)}>
        ∠ Snap
      </button>,
      <button key="anchor" style={chipStyle(state.touchModifier)} onClick={() => setModifier(!state.touchModifier)}>
        Anchor
      </button>,
    );
  }
  if (tool === 'action') {
    chips.push(
      <button key="rot" style={chipStyle(state.touchModifier)} onClick={() => setModifier(!state.touchModifier)}>
        Rotate target
      </button>,
    );
  }

  const draftDone = () => {
    if (state.draftPointShape) {
      state.commitDraftPointShape(false);
    } else if (state.draftAction) {
      if (state.draftAction.phase === 'pickPoints') state.advanceDraftActionPhase();
      else state.commitDraftAction();
    }
    onUpdate();
  };
  const draftCancel = () => {
    if (state.draftPointShape) state.cancelDraftPointShape();
    else if (state.draftAction) state.cancelDraftAction();
    else if (state.draftChain) state.cancelDraftChain();
    onUpdate();
  };

  if (chips.length === 0 && !hasSelection && !drafting) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: 8,
        right: 8,
        bottom: 'calc(8px + var(--safe-area-bottom, 0px))',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'center',
        pointerEvents: 'none',
        zIndex: 20,
      }}
    >
      {hasSelection && (
        <div style={barRow}>
          {state.isSelectedRotatable() && (
            <>
              <button style={touchBtn} onClick={() => { state.rotateSelected(-Math.PI / 12); onUpdate(); }}>
                ⟲ 15°
              </button>
              <button style={touchBtn} onClick={() => { state.rotateSelected(Math.PI / 12); onUpdate(); }}>
                ⟳ 15°
              </button>
            </>
          )}
          {state.selectedElement?.type === 'spring' && (
            <button
              style={touchBtn}
              onClick={() => { state.cycleSpringSize(state.selectedElement!.id, 1); onUpdate(); }}
            >
              Spring size
            </button>
          )}
          <button style={touchBtn} onClick={() => { state.duplicateSelected(); onUpdate(); }}>
            Duplicate
          </button>
          <button
            style={{ ...touchBtn, color: COLORS.danger, fontWeight: 700 }}
            onClick={() => { state.deleteSelected(); onUpdate(); }}
          >
            Delete
          </button>
        </div>
      )}
      {drafting && (
        <div style={barRow}>
          {(state.draftPointShape || state.draftAction) && (
            <button style={actionBtnSm(COLORS.purple)} onClick={draftDone}>
              {state.draftAction?.phase === 'pickPoints' ? 'Next' : 'Done'}
            </button>
          )}
          {state.draftPointShape && (
            <button style={touchBtn} onClick={() => { state.commitDraftPointShape(true); onUpdate(); }}>
              Close shape
            </button>
          )}
          <button style={touchBtn} onClick={draftCancel}>
            Cancel
          </button>
        </div>
      )}
      {chips.length > 0 && <div style={barRow}>{chips}</div>}
    </div>
  );
}
