import { cn } from '@/lib/util';
import { cva } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';

const bannerVariants = cva(
  'flex items-start gap-3 rounded-md border border-l-[3px] p-4 text-body',
  {
    variants: {
      tone: {
        info: 'border-border border-l-primary bg-accent text-accent-foreground',
        success:
          'border-success-border border-l-success bg-success-bg text-success',
        warning:
          'border-status-progress-border border-l-status-progress bg-status-progress-bg text-status-progress',
        error:
          'border-destructive-border border-l-destructive bg-destructive-bg text-destructive',
      },
    },
    defaultVariants: {
      tone: 'info',
    },
  },
);

interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'success' | 'warning' | 'error';
  children?: ReactNode;
}

export function Banner({ tone, className, children, ...props }: BannerProps) {
  return (
    <div
      className={cn(bannerVariants({ tone }), className)}
      {...props}
    >
      {children}
    </div>
  );
}
