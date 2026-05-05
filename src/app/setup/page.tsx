import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { SetupForm } from './form';

export const dynamic = 'force-dynamic';

/**
 * One-time bootstrap admin setup. Gated by the BOOTSTRAP_TOKEN that the
 * entrypoint script writes into .env on first boot. After completion, this
 * route 404s.
 */
export default async function SetupPage() {
  const state = await prisma.bootstrapState.findUnique({ where: { id: 1 } });
  if (!state) {
    // The entrypoint should have created the row. If it didn't, something is
    // wrong — but rather than expose details, behave as if no setup is pending.
    notFound();
  }
  if (state.completedAt) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-md mt-12 px-4">
      <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Welcome to DocuRidge</h1>
        <p className="mt-1 text-sm text-neutral-600">
          One-time setup. Enter the bootstrap token from your <code>.env</code> file and choose a
          password for the initial administrator account.
        </p>
        <div className="mt-6">
          <SetupForm />
        </div>
      </div>
    </div>
  );
}
