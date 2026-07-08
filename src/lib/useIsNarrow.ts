import { useEffect, useState } from 'react';

/**
 * Reactive "is this a narrow (phone-width) viewport?" hook. Used to switch
 * desktop side-by-side column layouts to a stacked single column so they don't
 * overflow horizontally on a phone. Default breakpoint 820px matches
 * `shouldUsePad()` in game/touchInput.ts.
 */
export function useIsNarrow(maxWidth = 820): boolean {
  const query = `(max-width: ${maxWidth}px)`;
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}
