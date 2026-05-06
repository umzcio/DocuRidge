import { cn } from '@/lib/util';
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const base =
  'block w-full rounded-md border border-hairline bg-surface px-3.5 text-body text-ink ' +
  'placeholder:text-ink-tertiary transition-colors ' +
  'focus-visible:outline-none focus-visible:border-accent ' +
  'aria-[invalid=true]:border-status-declined aria-[invalid=true]:focus-visible:border-status-declined';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn('h-10', base, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea ref={ref} rows={rows} className={cn(base, 'py-2.5', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';
