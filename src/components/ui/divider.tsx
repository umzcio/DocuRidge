import { cn } from '@/lib/util';

/**
 * Inline-label divider. Renders with optional centered label that has the
 * SectionLabel treatment. Used for "— or —" between signature options and
 * for major section breaks within long flows.
 */
export function Divider({ label, className }: { label?: string; className?: string }) {
  if (!label) {
    return <div className={cn('h-px w-full bg-hairline', className)} aria-hidden="true" />;
  }
  return (
    <div className={cn('flex items-center gap-3', className)} aria-hidden="true">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-label font-medium tracking-label uppercase text-ink-tertiary">
        {label}
      </span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}
