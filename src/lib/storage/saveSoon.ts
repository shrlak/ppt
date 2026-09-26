// Saving lyrics the moment they are edited.
//
// Every lyric editor on every page writes what was typed back to its library
// (찬양 라이브러리, 찬양집회 영어 가사, the 수련회 draft) without a button. The
// write itself is a local one — localStorage now, the shared server through
// a durable queue — so it can run almost at once: the short wait below only
// folds one burst of typing into one save instead of one per keystroke.
//
// And a pending save is never lost to a closed tab: when the page is hidden
// (the tab closes, the window is switched away, the phone locks) whatever is
// still waiting is written straight away.
import { useEffect, useRef, type DependencyList } from 'react';

/** Idle time after the last keystroke before an edited lyric is written. */
export const LYRICS_AUTO_SAVE_MS = 300;

/**
 * Run `save` once `delay` ms pass with `deps` unchanged — or at once, if the
 * page is hidden or closed first. `save` is the latest render's, so it always
 * sees the current state.
 */
export function useSaveSoon(save: () => void, deps: DependencyList, delay = LYRICS_AUTO_SAVE_MS): void {
  const pending = useRef<(() => void) | null>(null);

  useEffect(() => {
    const flush = () => {
      const run = pending.current;
      pending.current = null;
      run?.();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      // Leaving the page (or the editor) still writes what was typed.
      flush();
    };
  }, []);

  useEffect(() => {
    const run = () => {
      if (pending.current !== run) return;
      pending.current = null;
      save();
    };
    pending.current = run;
    const timer = window.setTimeout(run, delay);
    return () => {
      window.clearTimeout(timer);
      // The next render's save replaces this one; nothing is dropped.
      if (pending.current === run) pending.current = null;
    };
    // `deps` decides when there is something new to save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
