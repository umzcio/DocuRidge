import { cn } from '@/lib/util';
import { Slot } from '@radix-ui/react-slot';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

const base =
  'inline-flex items-center justify-center gap-2 rounded-md border font-medium tracking-[-0.005em] transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white border-accent-deep hover:bg-accent-deep',
  secondary:
    'bg-surface text-ink border-hairline hover:bg-surface-muted',
  ghost:
    'bg-transparent text-ink border-transparent hover:bg-surface-muted',
  danger:
    'bg-status-declined text-white border-[#7E1822] hover:brightness-95',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-meta',
  md: 'h-10 px-4 text-[14px]',
  lg: 'h-12 px-5 text-body',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref as never}
        type={asChild ? undefined : type ?? 'button'}
        className={cn(base, variants[variant], sizes[size], className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
