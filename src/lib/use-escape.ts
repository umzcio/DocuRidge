'use client';

import { useEffect } from 'react';

/**
 * Run `cb` when the user presses Escape. Use in modals so the recipient
 * can close them with the keyboard. Stops propagation so a dialog inside
 * a dialog only closes the innermost one.
 */
export function useEscape(cb: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cb();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cb, enabled]);
}
