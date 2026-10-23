import { cn } from '@/lib/util';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md border font-medium tracking-[-0.005em] ' +
    'transition duration-150 ease-out active:scale-[0.97] ' +
    'disabled:opacity-50 disabled:cursor-not-allowed ' +
    'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-primary/15',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-white border-primary-deep hover:bg-primary-deep',
        secondary:
          'bg-card text-foreground border-border hover:bg-muted',
        ghost:
          'bg-transparent text-foreground border-transparent hover:bg-muted',
        danger:
          'bg-destructive text-white border-[#7E1822] hover:brightness-95',
      },
      size: {
        sm: 'h-8 px-3 text-meta',
        md: 'h-10 px-4 text-[14px]',
        lg: 'h-12 px-5 text-body',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref as never}
        type={asChild ? undefined : type ?? 'button'}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
