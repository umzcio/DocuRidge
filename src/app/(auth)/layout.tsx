import Link from 'next/link';
import { BrandLockup } from '@/components/ui/wordmark';

/**
 * Split-screen auth. Left = deep navy canvas (the brand "Docu" color) with
 * the actual product icon as a generous hero element + a soft cobalt glow.
 * Right = form column. No marketing copy.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_0.95fr] bg-page">
      <aside
        className="hidden lg:flex flex-col justify-between p-12 text-white relative overflow-hidden bg-canvas"
        style={{
          backgroundImage:
            'radial-gradient(120% 80% at 8% 12%, rgba(37,68,251,0.22) 0%, rgba(10,22,63,0) 60%)',
        }}
      >
        {/* Hairline ruled lines for atmosphere */}
        <RuledLines />

        {/* Top: brand lockup in white-on-dark */}
        <div className="relative z-10 fade-up-1">
          <Link href="/login">
            <BrandLockup size="lg" tone="onDark" />
          </Link>
        </div>

        {/* Center: oversized icon + seal mark */}
        <Hero />

        {/* Footer: mono metadata only */}
        <div className="relative z-10 fade-up-3 flex items-end justify-between">
          <p className="text-[11px] tracking-[0.06em] text-white/40 font-mono">
            your-host.example.com / DocuRidge
          </p>
          <p className="text-[10px] tracking-[0.18em] uppercase text-white/30 font-mono">
            v1 · ed25519
          </p>
        </div>
      </aside>

      <div className="flex items-center justify-center p-6 sm:p-12 relative">
        <div className="lg:hidden absolute top-6 left-6">
          <BrandLockup size="md" />
        </div>
        <div className="w-full max-w-[400px] mt-12 lg:mt-0 fade-up-2">
          {children}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="relative z-10 fade-up-2 my-auto flex items-center gap-12">
      {/* Real product icon, big — the WOW anchor. */}
      <img
        src="/DocuRidge/docuridge-icon.png"
        alt=""
        aria-hidden="true"
        width={240}
        className="block"
        style={{ filter: 'drop-shadow(0 18px 40px rgba(37,68,251,0.35))' }}
      />
      <div className="flex flex-col gap-3">
        <span className="h-px w-20 bg-white/25" aria-hidden="true" />
        <span className="inline-flex items-center gap-2 self-start rounded-full border border-white/20 px-3 py-1.5 text-[10px] tracking-[0.18em] uppercase text-white/65 font-mono">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          Ed25519 sealed
        </span>
      </div>
    </div>
  );
}

function RuledLines() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 w-full h-full opacity-[0.06] pointer-events-none"
      preserveAspectRatio="none"
    >
      <defs>
        <pattern id="ruled" x="0" y="0" width="100%" height="40" patternUnits="userSpaceOnUse">
          <line x1="0" y1="39.5" x2="100%" y2="39.5" stroke="#7B8AFF" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#ruled)" />
    </svg>
  );
}
