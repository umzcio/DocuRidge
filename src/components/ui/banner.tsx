import { cn } from '@/lib/util';
import type { HTMLAttributes, ReactNode } from 'react';

type Tone = 'info' | 'success' | 'warning' | 'error';

const tones: Record<Tone, string> = {
  info: 'border-hairline border-l-accent bg-accent-soft text-accent-ink',
  success:
    'border-status-completed-border border-l-status-completed bg-status-completed-bg text-status-completed',
  warning:
    'border-status-progress-border border-l-status-progress bg-status-progress-bg text-status-progress',
  error:
    'border-status-declined-border border-l-status-declined bg-status-declined-bg text-status-declined',
};

interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: Tone;
  children?: ReactNode;
}

export function Banner({ tone = 'info', className, children, ...props }: BannerProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-md border border-l-[3px] p-4 text-body',
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
