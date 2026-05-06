import { cn } from '@/lib/util';

/**
 * Brand wordmark.  "Docu" in Inter SemiBold ink, "Ridge" in Inter Medium
 * accent — a subtle two-tone, two-weight read.
 */
export function Wordmark({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dims = {
    sm: 'text-[15px] tracking-[-0.012em]',
    md: 'text-[18px] tracking-[-0.014em]',
    lg: 'text-[22px] tracking-[-0.02em]',
  }[size];
  return (
    <span className={cn('inline-flex items-baseline leading-none', dims, className)}>
      <span className="font-semibold text-ink">Docu</span>
      <span className="font-medium text-accent">Ridge</span>
    </span>
  );
}
