import { cn } from '@/lib/util';
import type { ReactNode } from 'react';

type StatusKind =
  | 'DRAFT'
  | 'SENT'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DECLINED'
  | 'VOIDED'
  | 'EXPIRED'
  | 'NOT_SIGNED'
  | 'SIGNED'
  | 'NOT_OPENED'
  | 'OPENED'
  | 'NOT_SENT'
  | 'BOUNCED'
  | 'FAILED'
  | string;

const statusClass: Record<string, string> = {
  COMPLETED: 'bg-status-completed-bg text-status-completed border-status-completed-border',
  SIGNED: 'bg-status-completed-bg text-status-completed border-status-completed-border',
  IN_PROGRESS: 'bg-status-progress-bg text-status-progress border-status-progress-border',
  OPENED: 'bg-status-progress-bg text-status-progress border-status-progress-border',
  SENT: 'bg-status-sent-bg text-status-sent border-status-sent-border',
  DRAFT: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_SENT: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_OPENED: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_SIGNED: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  DECLINED: 'bg-status-declined-bg text-status-declined border-status-declined-border',
  BOUNCED: 'bg-status-declined-bg text-status-declined border-status-declined-border',
  FAILED: 'bg-status-declined-bg text-status-declined border-status-declined-border',
  VOIDED: 'bg-status-voided-bg text-status-voided border-status-voided-border',
  EXPIRED: 'bg-status-voided-bg text-status-voided border-status-voided-border',
};

export function StatusBadge({ status, className }: { status: StatusKind; className?: string }) {
  const klass = statusClass[status] ?? 'bg-surface-muted text-ink-secondary border-hairline';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium tracking-[0.05em] uppercase',
        klass,
        className,
      )}
    >
      {String(status).replace(/_/g, ' ')}
    </span>
  );
}

export function Badge({
  children,
  variant = 'neutral',
  className,
}: {
  children: ReactNode;
  variant?: 'neutral' | 'accent' | 'aging';
  className?: string;
}) {
  const variants = {
    neutral: 'bg-surface-muted text-ink-secondary border-hairline',
    accent: 'bg-accent-soft text-accent-ink border-accent/20',
    aging: 'bg-status-progress-bg text-status-progress border-status-progress-border',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-medium tracking-[0.05em] uppercase',
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
