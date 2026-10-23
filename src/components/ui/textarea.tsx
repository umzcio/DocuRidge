import { cn } from '@/lib/util';
import { forwardRef, type TextareaHTMLAttributes } from 'react';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full rounded-md border border-input bg-card px-3 py-2 text-[13.5px] text-foreground',
        'placeholder:text-faint outline-none transition-colors',
        'focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/12',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
