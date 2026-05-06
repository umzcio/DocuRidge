import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { Prisma, EnvelopeStatus } from '@prisma/client';
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

  const [envelopes, counts] = await Promise.all([
    prisma.envelope.findMany({
      where,
      orderBy: [{ status: 'asc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      include: { recipients: { orderBy: { signingOrder: 'asc' } } },
    }),
    // Counts for the KPI hero, scoped to org-wide (not the filtered set).
    prisma.envelope.groupBy({
      by: ['status'],
      where: { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT' },
      _count: { _all: true },
    }),
  ]);

  const total = counts.reduce((s, c) => s + c._count._all, 0);
  const inProgress = counts.find((c) => c.status === 'IN_PROGRESS')?._count._all ?? 0;
  const completedThisMonth = await prisma.envelope.count({
    where: {
      orgId: session.orgId,
      deletedAt: null,
      type: 'DOCUMENT',
      status: 'COMPLETED',
      completedAt: { gte: startOfMonth() },
    },
  });
  const awaiting = inProgress + (counts.find((c) => c.status === 'SENT')?._count._all ?? 0);

  return (
    <div className="mx-auto max-w-7xl px-6 lg:px-10 py-10 lg:py-14">
      {/* Hero */}
      <div className="fade-up-1">
        <SectionLabel>Workspace</SectionLabel>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <h1
            className="font-semibold tracking-[-0.034em] text-ink text-[44px] leading-[1.05] sm:text-[56px]"
            style={{ fontVariationSettings: '"opsz" 32' }}
          >
            Envelopes
          </h1>
          <p className="text-[15px] text-ink-secondary">
            <span className="text-ink font-medium">{session.user.name}</span> · <span className="font-mono text-meta uppercase tracking-[0.05em] text-ink-tertiary">{session.role.toLowerCase()}</span>
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden rounded-md border border-hairline bg-hairline fade-up-2">
        <KpiTile value={total} label="Total" />
        <KpiTile value={awaiting} label="Awaiting" tone="progress" />
        <KpiTile value={completedThisMonth} label="Signed this month" tone="completed" />
        <KpiTile value={counts.find((c) => c.status === 'DRAFT')?._count._all ?? 0} label="Drafts" />
      </div>

      {/* Filters */}
      <form className="mt-10 flex flex-col gap-4 fade-up-3 sm:flex-row sm:items-center" method="get" aria-label="Filter envelopes">
        <div className="flex-1 max-w-md">
          <label htmlFor="q" className="sr-only">Search</label>
          <Input
            id="q"
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Search by title or recipient…"
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
        <EmptyState filtered={!!(filterStatus || search)} />
      ) : (
        <div className="mt-8 fade-up-3 rounded-md border border-hairline bg-surface overflow-hidden">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-hairline text-left bg-surface-muted/40">
                <th className="py-3 pl-5 pr-4 text-label font-medium uppercase tracking-label text-ink-tertiary">Document</th>
                <th className="py-3 px-4 text-label font-medium uppercase tracking-label text-ink-tertiary hidden md:table-cell">Recipients</th>
                <th className="py-3 px-4 text-label font-medium uppercase tracking-label text-ink-tertiary">Status</th>
                <th className="py-3 pl-4 pr-5 text-label font-medium uppercase tracking-label text-ink-tertiary text-right hidden sm:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {envelopes.map((env) => {
                const nextRecipient = env.recipients.find((r) => r.signingStatus === 'NOT_SIGNED');
                const aging = env.sentAt ? Math.floor((Date.now() - env.sentAt.getTime()) / (24 * 60 * 60 * 1000)) : null;
                const updated = env.completedAt ?? env.sentAt ?? env.createdAt;
                return (
                  <tr key={env.id} className="group transition-colors hover:bg-surface-muted/50">
                    <td className="py-4 pl-5 pr-4">
                      <Link href={`/dashboard/envelopes/${env.id}`} className="block focus-visible:outline-none">
                        <div className="text-[15px] text-ink font-medium group-hover:text-accent transition-colors">
                          {env.title}
                        </div>
                        <div className="mt-0.5 text-[12px] text-ink-tertiary">
                          <span className="font-mono uppercase tracking-[0.06em]">{env.routingMode === 'PARALLEL' ? 'parallel' : 'sequential'}</span>
                          <span className="mx-1.5">·</span>
                          {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'}
                          {nextRecipient && env.status === 'IN_PROGRESS' && (
                            <> · awaiting <span className="text-ink-secondary">{nextRecipient.name}</span></>
                          )}
                        </div>
                      </Link>
                    </td>
                    <td className="py-4 px-4 hidden md:table-cell">
                      <AvatarStack names={env.recipients.map((r) => r.name)} max={4} size="sm" />
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={env.status} />
                        {aging !== null && env.status === 'IN_PROGRESS' && aging >= 1 && (
                          <Badge variant="aging">{aging}d</Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-4 pl-4 pr-5 text-right hidden sm:table-cell">
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
  );
}

function startOfMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function KpiTile({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: 'progress' | 'completed';
}) {
  const accentColor = tone === 'progress'
    ? 'text-status-progress'
    : tone === 'completed'
    ? 'text-status-completed'
    : 'text-ink';
  return (
    <div className="bg-surface px-5 py-5">
      <p className="text-label font-medium uppercase tracking-label text-ink-tertiary">{label}</p>
      <p className={`mt-2 font-semibold tracking-[-0.04em] tnum text-[36px] leading-[1] sm:text-[44px] ${accentColor}`}
         style={{ fontVariationSettings: '"opsz" 32' }}>
        {value}
      </p>
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="mt-12 rounded-md border border-hairline border-dashed bg-surface px-8 py-16 text-center fade-up-3">
      <SectionLabel className="text-center">
        {filtered ? 'No matches' : 'Nothing here yet'}
      </SectionLabel>
      <h2
        className="mt-3 font-semibold tracking-[-0.028em] text-ink text-[28px] sm:text-[32px]"
        style={{ fontVariationSettings: '"opsz" 32' }}
      >
        {filtered ? 'No envelopes match.' : 'Create your first envelope.'}
      </h2>
      <p className="mt-2 text-meta text-ink-secondary max-w-sm mx-auto">
        {filtered
          ? 'Try clearing your filters or search.'
          : 'Upload a PDF, place fields, send to a recipient — sealed and verifiable in minutes.'}
      </p>
      <Link
        href="/dashboard/envelopes/new"
        className="mt-6 inline-flex h-10 items-center rounded-md bg-accent px-4 text-[14px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors"
      >
        + New envelope
      </Link>
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
