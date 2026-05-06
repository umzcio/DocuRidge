import Link from 'next/link';
import { Wordmark } from '@/components/ui/wordmark';

/**
 * Split-screen auth. Left: brand-mark only, no marketing copy.
 * Right: form column.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_0.9fr] bg-page">
      <aside className="hidden lg:flex flex-col justify-between p-12 border-r border-hairline bg-surface-muted">
        <div className="fade-up-1">
          <Link href="/login" className="inline-block">
            <Wordmark size="md" />
          </Link>
        </div>
        <p className="fade-up-3 text-[11px] tracking-[0.06em] text-ink-tertiary font-mono">
          your-host.example.com / DocuRidge
        </p>
      </aside>

      <div className="flex items-center justify-center p-6 sm:p-12 relative">
        <div className="lg:hidden absolute top-6 left-6">
          <Wordmark size="md" />
        </div>
        <div className="w-full max-w-[380px] mt-12 lg:mt-0 fade-up-2">
          {children}
        </div>
      </div>
    </div>
  );
}
