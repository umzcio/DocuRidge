import { cn } from '@/lib/util';

const palette = [
  { fg: '#1E40AF', bg: '#DBEAFE' }, // blue
  { fg: '#92400E', bg: '#FED7AA' }, // amber
  { fg: '#065F46', bg: '#D1FAE5' }, // emerald
  { fg: '#9F1239', bg: '#FECDD3' }, // rose
  { fg: '#5B21B6', bg: '#EDE9FE' }, // violet
  { fg: '#783510', bg: '#FED7AA' }, // orange
];

export function avatarColor(seed: number) {
  return palette[seed % palette.length]!;
}

export function Avatar({
  name,
  size = 'md',
  seed = 0,
  className,
  asGroup = false,
}: {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  seed?: number;
  className?: string;
  asGroup?: boolean;
}) {
  const dims = {
    xs: 'h-5 w-5 text-[9px]',
    sm: 'h-6 w-6 text-[10px]',
    md: 'h-7 w-7 text-[11px]',
    lg: 'h-9 w-9 text-[13px]',
  }[size];
  const color = avatarColor(seed);
  const initials = computeInitials(name);
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-full font-medium tracking-[0.02em]',
        dims,
        asGroup && 'ring-2 ring-surface',
        className,
      )}
      style={{ background: color.bg, color: color.fg }}
      aria-label={name}
    >
      {initials}
    </span>
  );
}

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

export function AvatarStack({
  names,
  max = 3,
  size = 'sm',
}: {
  names: string[];
  max?: number;
  size?: 'xs' | 'sm' | 'md';
}) {
  const visible = names.slice(0, max);
  const remaining = Math.max(0, names.length - visible.length);
  return (
    <div className="flex -space-x-1.5">
      {visible.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} seed={i} size={size} asGroup />
      ))}
      {remaining > 0 && (
        <span
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-surface-muted ring-2 ring-surface text-ink-secondary',
            size === 'xs' && 'h-5 w-5 text-[9px]',
            size === 'sm' && 'h-6 w-6 text-[10px]',
            size === 'md' && 'h-7 w-7 text-[11px]',
          )}
          aria-label={`${remaining} more`}
        >
          +{remaining}
        </span>
      )}
    </div>
  );
}
