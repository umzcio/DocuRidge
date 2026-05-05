import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Landing page. Routes the user to the right place:
 *  - First boot (no BootstrapState completed) → /setup
 *  - Authenticated → /dashboard
 *  - Otherwise → /login
 */
export default async function Home() {
  const bootstrap = await prisma.bootstrapState.findUnique({ where: { id: 1 } });
  if (!bootstrap || !bootstrap.completedAt) {
    redirect('/setup');
  }

  const session = await getSession();
  if (session) {
    redirect('/dashboard');
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">DocuRidge</h1>
      <p className="mt-2 text-neutral-600">
        Self-hosted e-signature for the Acme Org.
      </p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/login"
          className="inline-flex h-10 items-center rounded-md bg-accent-700 px-4 text-sm font-medium text-white hover:bg-accent-800"
        >
          Sign in
        </Link>
        <Link
          href="/register"
          className="inline-flex h-10 items-center rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
        >
          Create account
        </Link>
      </div>
    </div>
  );
}
