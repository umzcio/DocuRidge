import { cn } from '@/lib/util';
import { forwardRef, type InputHTMLAttributes } from 'react';

const inputBase =
  'block w-full rounded-md border border-input bg-card px-3.5 text-body text-foreground ' +
  'placeholder:text-faint transition-colors ' +
  'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/12 ' +
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:border-destructive';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn('h-10', inputBase, className)} {...props} />
  ),
);
Input.displayName = 'Input';

export { Textarea } from './textarea';
