import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { logoutAction } from '@/app/(auth)/logout/actions';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.user.name}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Role: <span className="font-medium">{session.role}</span> · Org:{' '}
            <span className="font-medium">{session.orgId}</span>
          </p>
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
          >
            Sign out
          </button>
        </form>
      </div>

      <div
        className="mt-10 rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center"
        role="region"
        aria-labelledby="phase-2-heading"
      >
        <h2 id="phase-2-heading" className="text-base font-medium text-neutral-700">
          Envelope features arrive in Phase 2
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          Document upload, field placement, and the signing ceremony are next.
        </p>
      </div>
    </div>
  );
}
