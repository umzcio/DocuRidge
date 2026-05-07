import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { SectionLabel } from '@/components/ui/section-label';
import { SetupForm } from './form';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const state = await prisma.bootstrapState.findUnique({ where: { id: 1 } });
  if (!state) notFound();
  if (state.completedAt) notFound();

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_0.9fr] bg-page">
      <aside className="hidden lg:flex flex-col justify-between p-12 border-r border-hairline bg-surface-muted">
        <div className="fade-up-1">
          <span className="font-display text-h1 tracking-[-0.01em] text-ink">DocuRidge</span>
        </div>
        <p className="fade-up-3 text-[11px] tracking-[0.06em] text-ink-tertiary font-mono">
          DocuRidge · self-hosted
        </p>
      </aside>

      <div className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-[400px] mt-12 lg:mt-0 fade-up-2">
          <SectionLabel>§ Initial setup</SectionLabel>
          <h2 className="mt-2 font-display text-display-2 text-ink">Bootstrap administrator.</h2>
          <p className="mt-2 text-meta text-ink-secondary">
            Enter the bootstrap token from <span className="font-mono">.env</span> and choose a password.
          </p>
          <div className="mt-8">
            <SetupForm />
          </div>
        </div>
      </div>
    </div>
  );
}
