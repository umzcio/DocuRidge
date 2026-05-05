import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { prisma } from '@/lib/prisma';
import { Prisma, EnvelopeStatus } from '@prisma/client';

export const dynamic = 'force-dynamic';

const ALL_STATUSES: EnvelopeStatus[] = [
  'DRAFT',
  'SENT',
  'IN_PROGRESS',
  'COMPLETED',
  'DECLINED',
  'VOIDED',
  'EXPIRED',
];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  const sp = await searchParams;
  const filterStatus = sp.status && ALL_STATUSES.includes(sp.status as EnvelopeStatus) ? (sp.status as EnvelopeStatus) : null;
  const search = (sp.q ?? '').trim();

  const where: Prisma.EnvelopeWhereInput = {
    orgId: session.orgId,
    deletedAt: null,
    type: 'DOCUMENT',
  };
  if (filterStatus) where.status = filterStatus;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { recipients: { some: { email: { contains: search.toLowerCase(), mode: 'insensitive' } } } },
      { recipients: { some: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const envelopes = await prisma.envelope.findMany({
    where,
    orderBy: [
      // Surface stuck envelopes first when no filter is selected (R-10).
      { status: 'asc' },
      { sentAt: 'desc' },
      { createdAt: 'desc' },
    ],
    take: 100,
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome, {session.user.name}</h1>
          <p className="mt-1 text-sm text-neutral-600">
            <span className="font-medium">{session.role}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/dashboard/templates" className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-100">
            Templates
          </Link>
          <Link
            href="/dashboard/envelopes/new"
            className="inline-flex h-9 items-center rounded-md bg-accent-700 px-3 text-sm font-medium text-white hover:bg-accent-800"
          >
            + New envelope
          </Link>
          <form action={logoutAction}>
            <button type="submit" className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium text-neutral-900 hover:bg-neutral-100">
              Sign out
            </button>
          </form>
        </div>
      </div>

      <form className="mt-6 flex flex-wrap items-center gap-2" method="get" aria-label="Filter envelopes">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search title or recipient…"
          className="h-9 rounded-md border border-neutral-300 px-3 text-sm w-64"
        />
        {filterStatus && <input type="hidden" name="status" value={filterStatus} />}
        <button type="submit" className="inline-flex h-9 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-100">Search</button>

        <div className="flex flex-wrap items-center gap-1 ml-1">
          <FilterChip label="All" href={`/dashboard${search ? `?q=${encodeURIComponent(search)}` : ''}`} active={!filterStatus} />
          {ALL_STATUSES.map((s) => (
            <FilterChip
              key={s}
              label={s.replace('_', ' ')}
              href={`/dashboard?status=${s}${search ? `&q=${encodeURIComponent(search)}` : ''}`}
              active={filterStatus === s}
            />
          ))}
        </div>
      </form>

      {envelopes.length === 0 ? (
        <div className="mt-10 rounded-lg border border-dashed border-neutral-300 bg-white p-8 text-center">
          <h2 className="text-base font-medium text-neutral-800">No envelopes match.</h2>
          <p className="mt-2 text-sm text-neutral-600">
            {filterStatus || search
              ? 'Try clearing your filters.'
              : 'Create your first envelope to upload a PDF, place signature fields, and send it for signature.'}
          </p>
          <Link
            href="/dashboard/envelopes/new"
            className="mt-4 inline-flex items-center rounded-md bg-accent-700 px-4 py-2 text-sm font-medium text-white hover:bg-accent-800"
          >
            Create envelope
          </Link>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
          {envelopes.map((env) => {
            const nextRecipient = env.recipients.find((r) => r.signingStatus === 'NOT_SIGNED');
            const aging = env.sentAt ? Math.floor((Date.now() - env.sentAt.getTime()) / (24 * 60 * 60 * 1000)) : null;
            return (
              <li key={env.id} className="px-4 py-3">
                <Link href={`/dashboard/envelopes/${env.id}`} className="flex items-center justify-between gap-4 hover:bg-neutral-50 rounded-md -mx-2 px-2 py-1">
                  <div className="min-w-0">
                    <div className="font-medium text-neutral-900 truncate">{env.title}</div>
                    <div className="text-xs text-neutral-500 truncate">
                      {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'} · created {new Date(env.createdAt).toLocaleString()}
                      {nextRecipient && env.status === 'IN_PROGRESS' && (
                        <> · waiting on <span className="font-medium">{nextRecipient.name}</span></>
                      )}
                      {aging !== null && env.status === 'IN_PROGRESS' && aging >= 1 && (
                        <span className="ml-1 text-amber-700">— {aging} day{aging === 1 ? '' : 's'} old</span>
                      )}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${badgeClass(env.status)}`}>
                    {env.status.replace('_', ' ')}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium ${active ? 'border-accent-700 bg-accent-100 text-accent-900' : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100'}`}
    >
      {label}
    </Link>
  );
}

function badgeClass(status: string): string {
  return ({
    DRAFT: 'bg-neutral-100 text-neutral-800',
    SENT: 'bg-blue-100 text-blue-900',
    IN_PROGRESS: 'bg-amber-100 text-amber-900',
    COMPLETED: 'bg-emerald-100 text-emerald-900',
    DECLINED: 'bg-red-100 text-red-900',
    VOIDED: 'bg-red-100 text-red-900',
    EXPIRED: 'bg-red-100 text-red-900',
  } as Record<string, string>)[status] ?? 'bg-neutral-100 text-neutral-800';
}
