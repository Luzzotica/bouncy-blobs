// ─────────────────────────────────────────────────────────────────────────────
// Bouncy Blobs in-game UI theme — the canonical "cream-paper-and-tape" component
// system. Every React screen/overlay in src/pages + src/components should pull
// its surfaces, buttons, titles and modals from here so single-player and the
// multiplayer/menu area stay visually identical.
//
// Values mirror the multiplayer area (Multiplayer.tsx, HomeBackground.tsx,
// LobbyList.tsx) which is the visual reference. The broader brand guide
// (palette rationale, marketing, characters) lives in the `bouncy-blobs-style`
// skill — this file is the *code* source of truth for component styling.
//
// Rule: when you change a value here, you're changing the whole game's UI. Do
// not fork these styles inline in a component; extend this module instead.
// ─────────────────────────────────────────────────────────────────────────────

import type React from 'react';
import { isCave } from '../renderer/colors';

type Palette = {
  bg: string; ink: string; paper: string; paperInput: string; titleInk: string;
  lavender: string; purple: string; pink: string; green: string; yellow: string;
  inkDim: string; inkFaint: string; danger: string; blue: string;
  workCanvas: string; onAccent: string;
};

/** Original "cream-paper-and-tape" palette. */
const CLASSIC_COLORS: Palette = {
  bg: '#0a0612',          // dark void behind everything
  ink: '#1a0f2e',         // text on paper / deep purple
  paper: '#fffae6',       // sticky-note / card surface
  paperInput: '#fffefb',  // input field surface
  titleInk: '#fffae6',    // big-title text
  lavender: '#c77dff',    // primary accent + title shadow
  purple: '#5a189a',      // deep purple — primary action buttons
  pink: '#e85d75',
  green: '#2d6a4f',
  yellow: '#fdd835',
  inkDim: '#5a4a72',      // muted label text on paper
  inkFaint: '#6b5e85',    // uppercase picker labels
  danger: '#b3261e',      // destructive actions (delete)
  blue: '#1a6aaa',        // occasional non-brand accent (toggles)
  workCanvas: '#0f1629',  // dark working-canvas / thumbnail backdrop
  onAccent: '#fffae6',    // text on solid accent buttons (light)
};

/** Cave variant — dark blue-stone "paper", cool light ink, cyan/teal accents,
 * red danger. Same token names so every component reskins automatically.
 * Keeps the cream-paper motif structurally, just carved from cavern rock. */
const CAVE_COLORS: Palette = {
  bg: '#05070f',          // deep cavern void
  ink: '#dce8ff',         // cool light text on dark stone
  paper: '#15233c',       // dark blue-stone card surface
  paperInput: '#1d2f4e',  // slightly lighter input field
  titleInk: '#cfe4ff',    // icy big-title text
  lavender: '#54d3e6',    // cave cyan — primary accent + title shadow + tape
  purple: '#1f7d92',      // deep teal — primary action buttons
  pink: '#ff5d7a',
  green: '#2fae8f',
  yellow: '#f2c14e',
  inkDim: '#8aa0c4',      // muted light label text
  inkFaint: '#6f86ab',    // uppercase picker labels
  danger: '#ff3b4e',      // spike-tip red — destructive actions
  blue: '#3f9fe0',
  workCanvas: '#0a1020',  // dark working-canvas / thumbnail backdrop
  onAccent: '#eaf3ff',    // light text on solid accent buttons
};

/** Core palette used by UI surfaces. Cave theme swaps the whole palette so
 * every screen follows the dark cavern look. Mirrors the `bouncy-blobs-style`
 * skill. */
export const COLORS = isCave ? CAVE_COLORS : CLASSIC_COLORS;

/** Faint ink hairline for dividers / internal borders on paper surfaces. */
export const HAIRLINE = 'rgba(10,6,18,0.15)';

export const RADII = { card: 6, control: 4 } as const;
export const PAPER_SHADOW = '0 8px 20px rgba(0,0,0,0.35)';
/** The chunky multi-layer drop used on big page titles. Accent-colored offset
 * (lavender classic / cyan cave) with a dark outline. */
export const TITLE_SHADOW =
  `4px 4px 0 ${COLORS.lavender}, -2px -2px 0 #0a0612, 2px -2px 0 #0a0612, -2px 2px 0 #0a0612, 2px 2px 0 #0a0612`;

// ─── Craggy rock treatment (cave) ──────────────────────────────────────────
// Cave theme carves the prominent buttons out of stone: a lit-top → dark-bottom
// gradient, an irregular clip-path silhouette, an outer drop-shadow and inset
// volume shading. Text stays centered so the jagged edges never clip it.
const STONE_GRAD = 'linear-gradient(160deg, #2a3d59 0%, #182740 55%, #0c1526 100%)';
const CRAG_CLIP =
  'polygon(2% 12%, 9% 3%, 20% 8%, 33% 2%, 47% 7%, 61% 2%, 75% 8%, 88% 3%, 98% 11%, 95% 28%, 100% 46%, 96% 64%, 100% 82%, 92% 94%, 81% 99%, 67% 93%, 53% 99%, 40% 94%, 27% 99%, 15% 94%, 4% 98%, 2% 82%, 6% 62%, 1% 45%, 5% 28%)';
const CRAG_DROP = 'drop-shadow(0 6px 7px rgba(0,0,0,0.5))';
const CRAG_INSET = 'inset 0 3px 0 rgba(150,190,240,0.13), inset 0 -12px 18px rgba(0,0,0,0.42)';

/** Craggy-rock decoration merged onto a button (cave only). */
function rock(bg: string = STONE_GRAD, fg: string = COLORS.ink): React.CSSProperties {
  return {
    background: bg,
    color: fg,
    border: 'none',
    borderRadius: 0,
    clipPath: CRAG_CLIP,
    filter: CRAG_DROP,
    boxShadow: CRAG_INSET,
    textShadow: '0 1px 2px rgba(0,0,0,0.6)',
  };
}

// ─── Page shell ──────────────────────────────────────────────────────────────
// Screens render inside <HomeBackground> (parallax hero + overlay). This is the
// scrolling content layer on top of it.

export const pageContent: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  padding: '24px clamp(16px, 4vw, 48px)',
  gap: 16,
  overflowY: 'auto',
};

export const headerRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-start',
  alignItems: 'center',
  gap: 20,
  flexShrink: 0,
};

// ─── Titles & headings ─────────────────────────────────────────────────────────

export const pageTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 'clamp(32px, 5vw, 52px)',
  fontWeight: 900,
  color: COLORS.titleInk,
  transform: 'rotate(-1.5deg)',
  textShadow: TITLE_SHADOW,
  letterSpacing: 1,
};

/** Heading inside a paper card/panel. No drop shadow — matches lobby cards. */
export const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 22,
  fontWeight: 900,
  color: COLORS.ink,
  letterSpacing: 0.3,
};

/** Small uppercase label above pickers/fields (color/face/etc). */
export const pickerLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: COLORS.inkFaint,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

// ─── Buttons ────────────────────────────────────────────────────────────────
// Add className="paper-btn" (from HomeBackground's global CSS) for the hover
// lift/scale used across menu screens.

/** Big main-menu CTA — cream sticky-note (classic) / carved rock (cave). */
export const paperBtn: React.CSSProperties = isCave
  ? {
      position: 'relative',
      fontSize: 22,
      fontWeight: 800,
      padding: '22px 46px',
      cursor: 'pointer',
      fontFamily: 'inherit',
      letterSpacing: 0.5,
      ...rock(),
    }
  : {
      position: 'relative',
      fontSize: 22,
      fontWeight: 800,
      padding: '20px 40px 18px',
      background: COLORS.paper,
      color: COLORS.ink,
      border: '4px solid #0a0612',
      borderRadius: RADII.control,
      cursor: 'pointer',
      fontFamily: 'inherit',
      letterSpacing: 0.5,
      boxShadow: PAPER_SHADOW,
      textShadow: '1px 1px 0 rgba(199,125,255,0.4)',
    };

/** Small cream "back / home" button — slightly tilted, soft shadow. */
export const backBtn: React.CSSProperties = {
  padding: '10px 18px',
  fontSize: 15,
  fontWeight: 800,
  background: COLORS.paper,
  color: COLORS.ink,
  border: '3px solid #0a0612',
  borderRadius: RADII.control,
  cursor: 'pointer',
  fontFamily: 'inherit',
  letterSpacing: 0.4,
  boxShadow: '0 5px 12px rgba(0,0,0,0.3)',
  transform: 'rotate(-2deg)',
};

/** Solid accent action button (e.g. "Create Game", "Resume"). */
export function actionBtn(bg: string = COLORS.purple, fg: string = COLORS.onAccent): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: isCave ? '15px 24px' : '13px 20px',
    fontSize: 16,
    fontWeight: 800,
    letterSpacing: 0.4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
  return isCave
    ? { ...base, ...rock(bg, fg) }
    : { ...base, background: bg, color: fg, border: '3px solid #0a0612', borderRadius: RADII.control, boxShadow: '0 5px 12px rgba(0,0,0,0.3)' };
}

// ─── Compact controls (dense UI: editor toolbars, property panels, dialogs) ────

/** Small neutral cream button — toolbar / dialog default. */
export const paperBtnSm: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  fontWeight: 700,
  background: COLORS.paper,
  color: COLORS.ink,
  border: '2px solid #0a0612',
  borderRadius: RADII.control,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/** Small solid accent button — compact actions. */
export function actionBtnSm(bg: string = COLORS.purple, fg: string = COLORS.onAccent): React.CSSProperties {
  return { ...paperBtnSm, background: bg, color: fg, fontWeight: 800 };
}

/** Compact text input for dense forms. */
export const inputSm: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 13,
  borderRadius: RADII.control,
  border: '2px solid #0a0612',
  background: COLORS.paperInput,
  color: COLORS.ink,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

/** Cream chrome surface (editor toolbar / property panel). Borders are applied
 * by the caller (e.g. borderBottom on a toolbar, borderLeft on a panel). */
export const paperPanel: React.CSSProperties = {
  background: COLORS.paper,
  color: COLORS.ink,
  fontFamily: 'inherit',
};

// ─── Surfaces ────────────────────────────────────────────────────────────────

/** Cream paper card / panel. */
export const paperCard: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '24px 20px 20px',
  borderRadius: RADII.card,
  background: COLORS.paper,
  border: '4px solid #0a0612',
  boxShadow: PAPER_SHADOW,
};

export const inputStyle: React.CSSProperties = {
  padding: '9px 11px',
  fontSize: 15,
  borderRadius: RADII.control,
  border: '2px solid #0a0612',
  background: COLORS.paperInput,
  color: COLORS.ink,
  fontFamily: 'inherit',
};

// ─── Tape ────────────────────────────────────────────────────────────────────

/** Coloured tape strip stuck across the top of a card/button. Position the
 * parent `relative`. Pass an accent colour from COLORS. */
export function tape(color: string = COLORS.lavender): React.CSSProperties {
  if (isCave) return { display: 'none' }; // no tape on rock — cave drops it
  return {
    position: 'absolute',
    top: -10,
    left: '50%',
    transform: 'translateX(-50%) rotate(-3deg)',
    width: '60%',
    height: 16,
    background: color,
    border: '1px solid rgba(0,0,0,0.25)',
    opacity: 0.85,
    pointerEvents: 'none',
    boxShadow: '0 2px 3px rgba(0,0,0,0.2)',
  };
}

/** Bare tape strip (no colour) — kept for back-compat with existing imports. */
export const tapeStrip: React.CSSProperties = tape('');

// ─── Modals ──────────────────────────────────────────────────────────────────
// For the full slam/rip paper animation, see SettingsModal/PauseMenu (they
// inject the keyframes). These cover the static structure.

export const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(10, 6, 18, 0.7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
};

export const modalCard: React.CSSProperties = {
  position: 'relative',
  background: COLORS.paper,
  color: COLORS.ink,
  border: '4px solid #0a0612',
  borderRadius: RADII.card,
  padding: '32px 40px 26px',
  minWidth: 300,
  maxWidth: '90vw',
  boxShadow: '0 18px 40px rgba(0,0,0,0.5)',
};

/** Tan "masking tape" used on modals (warmer than card tape). Hidden in cave. */
export const modalTape: React.CSSProperties = isCave ? { display: 'none' } : {
  position: 'absolute',
  top: -14,
  left: '50%',
  transform: 'translateX(-50%) rotate(-2deg)',
  width: 160,
  height: 28,
  background: 'rgba(200, 180, 120, 0.78)',
  border: '1px solid rgba(120, 100, 60, 0.4)',
  boxShadow: '0 3px 6px rgba(0,0,0,0.2)',
};
