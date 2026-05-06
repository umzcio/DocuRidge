import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { logoutAction } from '@/app/(auth)/logout/actions';
import { prisma } from '@/lib/prisma';
import { Prisma, EnvelopeStatus } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { SectionLabel } from '@/components/ui/section-label';
import { AvatarStack } from '@/components/ui/avatar';

export const dynamic = 'force-dynamic';

const ALL_STATUSES: EnvelopeStatus[] = [
  'DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED',
];

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return date.toLocaleDateString();
}

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
    orderBy: [{ status: 'asc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
    take: 100,
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });

  return (
    <div className="min-h-screen bg-page">
      <div className="mx-auto max-w-6xl px-6 py-10 lg:py-16">
        {/* Header */}
        <div className="flex flex-col gap-4 border-b border-hairline pb-6 sm:flex-row sm:items-end sm:justify-between fade-up-1">
          <div>
            <SectionLabel>Workspace</SectionLabel>
            <h1
              className="mt-1.5 font-display text-display-1 text-ink"
             
            >
              Envelopes
            </h1>
            <p className="mt-1.5 text-meta text-ink-secondary">
              Signed in as <span className="text-ink">{session.user.name}</span> · <span className="font-mono tracking-tight">{session.role.toLowerCase()}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="md" asChild>
              <Link href="/dashboard/templates">Templates</Link>
            </Button>
            <Button variant="primary" size="md" asChild>
              <Link href="/dashboard/envelopes/new">+ New envelope</Link>
            </Button>
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="md">Sign out</Button>
            </form>
          </div>
        </div>

        {/* Filters */}
        <form className="mt-8 flex flex-col gap-4 fade-up-2 sm:flex-row sm:items-center" method="get" aria-label="Filter envelopes">
          <div className="flex-1 max-w-md">
            <label htmlFor="q" className="sr-only">Search</label>
            <Input
              id="q"
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Search title or recipient…"
            />
          </div>
          {filterStatus && <input type="hidden" name="status" value={filterStatus} />}

          <div className="flex flex-wrap items-center gap-1.5">
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

        {/* List */}
        {envelopes.length === 0 ? (
          <div className="mt-12 rounded-md border border-hairline border-dashed bg-surface p-12 text-center fade-up-3">
            <SectionLabel className="text-center">No matches</SectionLabel>
            <h2
              className="mt-3 font-display text-display-2 text-ink"
             
            >
              {filterStatus || search ? 'No envelopes match.' : 'No envelopes yet.'}
            </h2>
            <p className="mt-2 text-meta italic font-display text-ink-secondary">
              {filterStatus || search ? 'Try clearing your filters.' : 'Your first signature is one click away.'}
            </p>
            <div className="mt-6">
              <Button variant="primary" size="md" asChild>
                <Link href="/dashboard/envelopes/new">Create envelope</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-8 fade-up-3">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-hairline text-left">
                  <th className="py-3 pr-4 text-label font-medium uppercase tracking-label text-ink-tertiary">Document</th>
                  <th className="py-3 px-4 text-label font-medium uppercase tracking-label text-ink-tertiary hidden md:table-cell">Recipients</th>
                  <th className="py-3 px-4 text-label font-medium uppercase tracking-label text-ink-tertiary">Status</th>
                  <th className="py-3 pl-4 text-label font-medium uppercase tracking-label text-ink-tertiary text-right hidden sm:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {envelopes.map((env) => {
                  const nextRecipient = env.recipients.find((r) => r.signingStatus === 'NOT_SIGNED');
                  const aging = env.sentAt ? Math.floor((Date.now() - env.sentAt.getTime()) / (24 * 60 * 60 * 1000)) : null;
                  const updated = env.completedAt ?? env.sentAt ?? env.createdAt;
                  return (
                    <tr key={env.id} className="group transition-colors hover:bg-surface-muted/60">
                      <td className="py-4 pr-4">
                        <Link href={`/dashboard/envelopes/${env.id}`} className="block focus-visible:outline-none">
                          <div className="text-ink font-medium group-hover:text-accent transition-colors">
                            {env.title}
                          </div>
                          <div className="mt-0.5 text-[12px] text-ink-tertiary tnum">
                            {env.routingMode === 'PARALLEL' ? 'parallel' : 'sequential'} · {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'}
                            {nextRecipient && env.status === 'IN_PROGRESS' && (
                              <> · waiting on <span className="text-ink-secondary">{nextRecipient.name}</span></>
                            )}
                          </div>
                        </Link>
                      </td>
                      <td className="py-4 px-4 hidden md:table-cell">
                        <AvatarStack names={env.recipients.map((r) => r.name)} max={3} size="sm" />
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-1.5">
                          <StatusBadge status={env.status} />
                          {aging !== null && env.status === 'IN_PROGRESS' && aging >= 1 && (
                            <Badge variant="aging">Waiting {aging}d</Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-4 pl-4 text-right hidden sm:table-cell">
                        <span className="font-mono text-[12px] text-ink-tertiary tnum">
                          {relativeTime(updated)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-7 items-center rounded-full border px-3 text-[11px] font-medium tracking-[0.05em] uppercase transition-colors ${
        active
          ? 'border-accent bg-accent text-white'
          : 'border-hairline bg-surface text-ink-secondary hover:bg-surface-muted hover:text-ink'
      }`}
    >
      {label}
    </Link>
  );
}
