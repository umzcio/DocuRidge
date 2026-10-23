'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/util';

export interface SelectOption {
  value: string;
  label: string;
  /** Optional sub-line shown below the label in the dropdown. */
  hint?: string;
}

/**
 * Select built on Radix Select. The browser-native <select>'s open list is
 * OS-rendered and ignores our CSS, so we render a button + listbox combo
 * instead. Radix owns anchoring (popper), keyboard navigation, type-ahead,
 * and outside-click — the listbox is portalled to <body>, which sidesteps
 * clipping, transforms, or stacking-context surprises inside dialogs and
 * scroll containers. role=listbox/option markup is native.
 *
 * Radix reserves the empty string for "nothing selected, show the
 * placeholder", so an option whose value is '' (e.g. "All statuses") can't be
 * selected back. When such an option exists it travels through Radix under a
 * sentinel; otherwise '' keeps meaning "show the placeholder". Form
 * participation uses our own hidden input so '' still submits as ''.
 */
const EMPTY_ITEM_VALUE = '__docuridge_empty__';
const fromItemValue = (v: string) => (v === EMPTY_ITEM_VALUE ? '' : v);

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
  const hasEmptyOption = options.some((opt) => opt.value === '');
  const toItemValue = (v: string) => (hasEmptyOption && v === '' ? EMPTY_ITEM_VALUE : v);
  return (
    <div className={cn('relative w-full', className)}>
      {name && <input type="hidden" name={name} value={value} disabled={disabled} />}
      <SelectPrimitive.Root
        value={toItemValue(value)}
        onValueChange={(v) => onChange(fromItemValue(v))}
        disabled={disabled}
      >
        <SelectPrimitive.Trigger
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex w-full h-9 items-center gap-2 pl-3 pr-9 rounded-md bg-card border border-border relative',
            'text-[13px] text-left text-foreground outline-none',
            'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/12',
            'hover:border-input transition-colors',
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          <SelectPrimitive.Value
            placeholder={placeholder ?? '— Select —'}
            className="flex-1 truncate data-[placeholder]:text-faint"
          />
          <SelectPrimitive.Icon className="absolute right-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none">
            <ChevronDown size={13} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            aria-label={ariaLabel}
            className={cn(
              'select-listbox max-h-72 overflow-y-auto rounded-md border border-border bg-card py-1 z-[1000]',
              'shadow-[0_8px_24px_rgba(15,17,21,0.12)]',
              'w-[var(--radix-select-trigger-width)]',
            )}
          >
            <SelectPrimitive.Viewport>
              {options.map((opt) => (
                <SelectPrimitive.Item
                  key={opt.value}
                  value={toItemValue(opt.value)}
                  className={cn(
                    'cursor-pointer px-3 py-1.5 text-[13px] flex items-start gap-2 rounded-none outline-none',
                    'data-[highlighted]:bg-muted',
                  )}
                >
                  <span className="mt-0.5 inline-flex h-3 w-3 items-center justify-center flex-shrink-0">
                    <SelectPrimitive.ItemIndicator>
                      <Check size={11} strokeWidth={3} />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                  <SelectPrimitive.ItemText>
                    <span className="block truncate">{opt.label}</span>
                    {opt.hint && <span className="block text-[11px] text-faint truncate">{opt.hint}</span>}
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </div>
  );
}
