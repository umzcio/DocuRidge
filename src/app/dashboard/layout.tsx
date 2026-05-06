import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

/**
 * Dashboard chrome. Dark canvas header strip carries the wordmark + global
 * navigation + user menu. Below it sits the page content on the warm page
 * background. Same model as Mercury / Linear / Pilot — gives the product
 * actual chrome instead of the previous bare-page treatment.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="min-h-screen bg-page">
      <header className="bg-canvas text-white border-b border-canvas-edge">
        <div className="mx-auto max-w-7xl px-6 lg:px-10 py-4 flex items-center gap-6">
          <Link href="/dashboard" className="mr-4 inline-flex items-center gap-2">
            <img src="/DocuRidge/docuridge-icon.png" alt="" aria-hidden="true" width={22} className="block" />
            <span className="inline-flex items-baseline leading-none">
              <span className="font-semibold text-white text-[18px] tracking-[-0.014em]">Docu</span>
              <span className="font-medium text-accent text-[18px] tracking-[-0.014em]">Ridge</span>
            </span>
          </Link>
          <nav className="hidden sm:flex items-center gap-6 text-[13px] text-white/70">
            <Link href="/dashboard" className="hover:text-white transition-colors">Envelopes</Link>
            <Link href="/dashboard/templates" className="hover:text-white transition-colors">Templates</Link>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <Button variant="primary" size="sm" asChild className="bg-white text-canvas border-white/0 hover:bg-white/90 hover:text-canvas">
              <Link href="/dashboard/envelopes/new">+ New envelope</Link>
            </Button>
            <UserMenu name={session.user.name} email={session.user.email} role={session.role} />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function UserMenu({ name, email, role }: { name: string; email: string; role: string }) {
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <details className="relative">
      <summary className="list-none cursor-pointer flex items-center gap-2.5 outline-none">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white text-[12px] font-medium tracking-[0.02em]">
          {initials || '?'}
        </span>
        <span className="hidden md:flex flex-col items-start leading-tight">
          <span className="text-[13px] font-medium text-white">{name}</span>
          <span className="text-[11px] text-white/50 font-mono tracking-tight uppercase">{role.toLowerCase()}</span>
        </span>
      </summary>
      <div className="absolute right-0 mt-2 w-64 rounded-md border border-hairline bg-surface shadow-[0_8px_24px_-8px_rgba(0,0,0,0.18)] p-3 z-30">
        <div className="px-2 py-1">
          <p className="text-[13px] font-medium text-ink">{name}</p>
          <p className="text-[11px] text-ink-tertiary truncate">{email}</p>
        </div>
        <div className="my-2 h-px bg-hairline" />
        <form action={logoutAction}>
          <button type="submit" className="w-full text-left px-2 py-1.5 text-[13px] text-ink hover:bg-surface-muted rounded">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
