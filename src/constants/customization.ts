/**
 * Shared palette for color picker UIs. Used by the Controller phone picker and
 * the host's lobby panel for the local-player picker + AI color avoidance.
 *
 * Keep this list in sync with what `playerColor()` cycles through if you ever
 * unify them — for now we keep this picker palette separate from the indexed
 * default palette in `renderer/colors.ts` because the picker needs ordered,
 * visually distinct swatches.
 */
export const COLOR_PALETTE: readonly string[] = [
  '#e06070', '#e88a5a', '#e8c54a', '#6ecf6e',
  '#4ac8c8', '#5a8ae0', '#8a6ae0', '#d06eb0',
  '#f0f0f0', '#ff4444', '#44aaff', '#aa44ff',
];
