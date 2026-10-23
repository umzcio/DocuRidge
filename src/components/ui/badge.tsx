import { cn } from '@/lib/util';
import { cva } from 'class-variance-authority';
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
  | 'SKIPPED'
  | 'NOT_OPENED'
  | 'OPENED'
  | 'NOT_SENT'
  | 'BOUNCED'
  | 'FAILED'
  | string;

const statusClass: Record<string, string> = {
  COMPLETED: 'bg-success-bg text-success border-success-border',
  SIGNED: 'bg-success-bg text-success border-success-border',
  IN_PROGRESS: 'bg-status-progress-bg text-status-progress border-status-progress-border',
  OPENED: 'bg-status-progress-bg text-status-progress border-status-progress-border',
  SENT: 'bg-status-sent-bg text-status-sent border-status-sent-border',
  DRAFT: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_SENT: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_OPENED: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  NOT_SIGNED: 'bg-status-draft-bg text-status-draft border-status-draft-border',
  DECLINED: 'bg-destructive-bg text-destructive border-destructive-border',
  BOUNCED: 'bg-destructive-bg text-destructive border-destructive-border',
  FAILED: 'bg-destructive-bg text-destructive border-destructive-border',
  VOIDED: 'bg-status-voided-bg text-status-voided border-status-voided-border',
  EXPIRED: 'bg-status-voided-bg text-status-voided border-status-voided-border',
  SKIPPED: 'bg-status-voided-bg text-status-voided border-status-voided-border',
};

export function StatusBadge({ status, className }: { status: StatusKind; className?: string }) {
  const klass = statusClass[status] ?? 'bg-muted text-muted-foreground border-border';
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

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ' +
    'text-[11px] font-medium tracking-[0.05em] uppercase',
  {
    variants: {
      variant: {
        neutral: 'bg-muted text-muted-foreground border-border',
        accent: 'bg-accent text-accent-foreground border-primary/20',
        aging: 'bg-status-progress-bg text-status-progress border-status-progress-border',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export function Badge({
  children,
  variant,
  className,
}: {
  children: ReactNode;
  variant?: 'neutral' | 'accent' | 'aging';
  className?: string;
}) {
  return (
    <span className={cn(badgeVariants({ variant }), className)}>
      {children}
    </span>
  );
}
