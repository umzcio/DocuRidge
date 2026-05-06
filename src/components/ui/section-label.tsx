import { cn } from '@/lib/util';
import type { HTMLAttributes } from 'react';

/**
 * SectionLabel — small all-caps marker used as a section header throughout
 * the app. Replaces low-impact `<h2 className="text-sm font-semibold">` and
 * gives every form, table head, and detail block a consistent legal-form feel.
 */
export function SectionLabel({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'text-label font-medium tracking-label uppercase text-ink-tertiary',
        className,
      )}
      {...props}
    />
  );
}
