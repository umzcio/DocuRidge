'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/util';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional sub-line shown below the label in the dropdown. */
  hint?: string;
}

/**
 * Custom-rendered select with a fully stylable open-state popover.
 *
 * The browser-native <select>'s open list is OS-rendered and ignores
 * our CSS, so we render a button + listbox combo instead. The listbox
 * is portalled to <body> and anchored to the trigger's bounding rect,
 * which sidesteps clipping, transforms, or stacking-context surprises
 * inside dialogs and scroll containers.
 *
 * Keyboard: Enter/Space to open; ↑↓ to move highlight; Enter to commit;
 * Esc to close; Home/End jump. Outside-click closes. Focus returns to
 * the trigger on close.
 */
export function Select({
  value, onChange, options, placeholder, className, name, disabled, ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  name?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; flip: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? '— Select —';
  const isPlaceholder = !selected;

  // Position the portalled popover relative to the trigger. Recompute on
  // open and on scroll/resize so the listbox tracks if the page moves.
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const t = triggerRef.current;
      if (!t) return;
      const r = t.getBoundingClientRect();
      const popHeight = Math.min(288, options.length * 36 + 12); // matches max-h-72
      const spaceBelow = window.innerHeight - r.bottom;
      const flip = spaceBelow < popHeight + 12 && r.top > spaceBelow;
      setCoords({
        top: flip ? r.top - popHeight - 4 : r.bottom + 4,
        left: r.left,
        width: r.width,
        flip,
      });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, options.length]);

  // Close on outside click + keyboard shortcuts while open.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = triggerRef.current;
      const l = listRef.current;
      const target = e.target as Node;
      if (t && t.contains(target)) return;
      if (l && l.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((i) => Math.min(options.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) {
          onChange(opt.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHighlight(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHighlight(options.length - 1);
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, options, highlight, onChange]);

  // Scroll the highlighted option into view.
  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLLIElement>(`[data-idx="${highlight}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [open, highlight]);

  return (
    <div className={cn('relative w-full', className)}>
      {/* Hidden native input so the value participates in any wrapping form. */}
      {name && <input type="hidden" name={name} value={value} />}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          setOpen((o) => !o);
          setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
          }
        }}
        className={cn(
          'inline-flex w-full h-9 items-center gap-2 pl-3 pr-9 rounded-md bg-surface border border-hairline relative',
          'text-[13px] text-left text-ink outline-none',
          'focus-visible:border-accent focus-visible:ring-3 focus-visible:ring-accent/12',
          'hover:border-hairline-strong transition-colors',
          isPlaceholder && 'text-ink-tertiary',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <span className="flex-1 truncate">{label}</span>
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-tertiary pointer-events-none">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {open && coords && typeof document !== 'undefined' &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              zIndex: 1000,
            }}
            className="max-h-72 overflow-y-auto rounded-md border border-hairline bg-surface shadow-[0_8px_24px_rgba(15,17,21,0.12)] py-1"
          >
            {options.map((opt, i) => {
              const isActive = opt.value === value;
              const isHl = i === highlight;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isActive}
                  data-idx={i}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    // Use mousedown so we beat the outside-click close handler.
                    e.preventDefault();
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={cn(
                    'cursor-pointer px-3 py-1.5 text-[13px] flex items-start gap-2',
                    isHl ? 'bg-surface-muted' : 'bg-surface',
                    isActive && 'font-medium text-ink',
                  )}
                >
                  <span className="mt-0.5 inline-flex h-3 w-3 items-center justify-center flex-shrink-0">
                    {isActive && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">{opt.label}</span>
                    {opt.hint && <span className="block text-[11px] text-ink-tertiary truncate">{opt.hint}</span>}
                  </span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )
      }
    </div>
  );
}
