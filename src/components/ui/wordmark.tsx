import { cn } from '@/lib/util';

/**
 * Brand wordmark.  "Docu" in deep navy SemiBold, "Ridge" in cobalt Medium —
 * matched to the color values sampled from public/docuridge-icon.png.
 *
 * Use `tone="onDark"` when placed on the dark canvas panel; the navy half
 * inverts to white but the cobalt half stays cobalt for brand-recognition.
 */
export function Wordmark({
  size = 'md',
  tone = 'default',
  className,
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  tone?: 'default' | 'onDark';
  className?: string;
}) {
  const dims = {
    sm: 'text-[15px] tracking-[-0.012em]',
    md: 'text-[18px] tracking-[-0.014em]',
    lg: 'text-[22px] tracking-[-0.02em]',
    xl: 'text-[28px] tracking-[-0.024em]',
  }[size];
  const docuClass = tone === 'onDark' ? 'text-white' : 'text-canvas';
  return (
    <span className={cn('inline-flex items-baseline leading-none', dims, className)}>
      <span className={cn('font-semibold', docuClass)}>Docu</span>
      <span className="font-medium text-accent">Ridge</span>
    </span>
  );
}

export function BrandIcon({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/DocuRidge/docuridge-icon.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={Math.round((size * 242) / 216)}
      className={className}
      style={{ display: 'inline-block' }}
    />
  );
}

export function BrandLockup({
  size = 'md',
  tone = 'default',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'onDark';
  className?: string;
}) {
  const iconSize = { sm: 18, md: 22, lg: 28 }[size];
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <BrandIcon size={iconSize} />
      <Wordmark size={size} tone={tone} />
    </span>
  );
}
