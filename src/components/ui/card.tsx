import { cn } from '@/lib/util';
import type { ComponentProps } from 'react';

/**
 * Card primitive. NO drop shadow — the inset 1px highlight on the top edge
 * (paper-thickness) plus a 1px hairline border defines the surface against
 * the warm page background.
 */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'rounded-md border border-hairline bg-surface',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.6)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('p-6 sm:p-8', className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('px-6 sm:px-8 pt-6 sm:pt-8 pb-4 border-b border-hairline', className)}
      {...props}
    />
  );
}
