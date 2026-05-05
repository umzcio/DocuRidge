import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const envelopes = await prisma.envelope.findMany({
    where: { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { recipients: true },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.user.name}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            <span className="font-medium">{session.role}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/dashboard/envelopes/new"
            className="inline-flex h-9 items-center rounded-md bg-accent-700 px-3 text-sm font-medium text-white hover:bg-accent-800"
          >
            + New envelope
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {envelopes.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
          <h2 className="text-base font-medium text-neutral-800">No envelopes yet</h2>
          <p className="mt-2 text-sm text-neutral-600">
            Create your first envelope to upload a PDF, place signature fields, and send it for signature.
          </p>
          <Link
            href="/dashboard/envelopes/new"
            className="mt-4 inline-flex items-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800"
          >
            Create envelope
          </Link>
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {envelopes.map((env) => (
            <li key={env.id} className="px-4 py-3">
              <Link href={`/dashboard/envelopes/${env.id}`} className="flex items-center justify-between gap-4 hover:bg-neutral-50 rounded-md -mx-2 px-2 py-1">
                <div>
                  <div className="font-medium text-neutral-900">{env.title}</div>
                  <div className="text-xs text-neutral-500">
                    {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'} · created {new Date(env.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700">{env.status.replace('_', ' ')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
