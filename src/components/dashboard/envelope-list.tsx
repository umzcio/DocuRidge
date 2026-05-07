import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { Prisma, EnvelopeStatus } from '@prisma/client';
import { StatusBadge } from '@/components/ui/badge';
import { AvatarStack } from '@/components/ui/avatar';
import { SignNowButton } from '@/app/dashboard/envelopes/sign-now-button';
import { BulkActionsBar } from './bulk-actions-bar';
import { EnvelopeListFilters } from './envelope-list-filters';

const ALL_STATUSES: EnvelopeStatus[] = [
  'DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED',
];

type Props = {
  title: string;
  subtitle: string;
  orgId: string;
  /** Pre-narrow the result set (e.g. only IN_PROGRESS for /sent). */
  baseStatus?: EnvelopeStatus[];
  /** For /inbox: only show envelopes where the current user is the next signer. */
  filterByUserEmail?: string;
  /** For /dashboard/folders/[id]: scope to a specific folder. */
  folderId?: string;
  searchParams: { q?: string; status?: string; sort?: string };
  /** When true, hide the status filter dropdown (e.g. on /drafts). */
  lockStatus?: boolean;
  /** When true, render a per-row "Sign now" button for envelopes where the
   *  current user is the next pending signer (Inbox only). */
  showSignNow?: boolean;
};

export async function EnvelopeListView({
  title,
  subtitle,
  orgId,
  baseStatus,
  filterByUserEmail,
  folderId,
  searchParams,
  lockStatus = false,
  showSignNow = false,
}: Props) {
  const search = (searchParams.q ?? '').trim();
  const sort = searchParams.sort === 'oldest' ? 'oldest' : 'recent';
  const userStatus = searchParams.status && ALL_STATUSES.includes(searchParams.status as EnvelopeStatus)
    ? (searchParams.status as EnvelopeStatus)
    : null;

  const where: Prisma.EnvelopeWhereInput = {
    orgId,
    deletedAt: null,
    type: 'DOCUMENT',
  };
  if (baseStatus) where.status = { in: baseStatus };
  if (userStatus && !lockStatus) where.status = userStatus;
  if (filterByUserEmail) {
    where.recipients = {
      some: {
        email: filterByUserEmail.toLowerCase(),
        signingStatus: 'NOT_SIGNED',
      },
    };
  }
  if (folderId) {
    where.folderId = folderId;
  }
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { recipients: { some: { email: { contains: search.toLowerCase(), mode: 'insensitive' } } } },
      { recipients: { some: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  const orderBy: Prisma.EnvelopeOrderByWithRelationInput =
    sort === 'oldest' ? { updatedAt: 'asc' } : { updatedAt: 'desc' };

  const envelopes = await prisma.envelope.findMany({
    where,
    orderBy,
    take: 100,
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });

  return (
    <main id="documents-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1280px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-ink leading-tight">
            {title}
          </h1>
          <p className="mt-1 text-[14px] text-ink-secondary">{subtitle}</p>
        </div>
        <Link
          href="/dashboard/envelopes/new"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-canvas px-3.5 text-[13px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors"
        >
          <PlusIcon /> New document
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-hairline bg-surface overflow-hidden">
        {/* Toolbar */}
        <form data-envelope-filters className="p-3 flex flex-wrap items-center gap-2 border-b border-hairline" method="get">
          <div className="relative flex-1 min-w-[220px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary">
              <SearchIcon />
            </span>
            <input
              type="search"
              name="q"
              defaultValue={search}
              placeholder="Search by name or recipient"
              aria-label="Search documents"
              className="w-full h-9 pl-9 pr-3 rounded-md bg-surface border border-hairline text-[13.5px] text-ink placeholder:text-ink-tertiary outline-none focus:border-accent focus:ring-3 focus:ring-accent/12"
            />
          </div>
          <EnvelopeListFilters
            showStatus={!lockStatus}
            statusValue={userStatus ?? ''}
            sortValue={sort}
          />
          <button type="submit" className="h-9 inline-flex items-center px-3 rounded-md text-[13px] text-ink-secondary hover:bg-surface-muted hover:text-ink transition-colors">
            Apply
          </button>
        </form>

        {/* Bulk-action toolbar — appears when 1+ envelopes are checked.
            The toolbar lives outside any form; the action buttons inside it
            target #bulk-form via the form= attribute, with each button's
            formAction prop pointing at a server action. */}
        <BulkActionsBar />
        {/* Hidden form that hosts the selected envelope ids. The form has no
            action by default; submit buttons in BulkActionsBar provide it. */}
        <form id="bulk-form" className="contents" />

        {envelopes.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-[13.5px] text-ink-secondary">No documents found.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left bg-surface-muted/40 border-b border-hairline">
                  <th className="py-2.5 px-4 w-8" aria-label="Select" />
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Name</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Status</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary hidden md:table-cell">Recipients</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary hidden sm:table-cell">Last update</th>
                  {showSignNow && <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary"></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {envelopes.map((env) => {
                  const signed = env.recipients.filter((r) => r.signingStatus === 'SIGNED').length;
                  const updated = env.completedAt ?? env.sentAt ?? env.updatedAt;
                  return (
                    <tr key={env.id} className="group hover:bg-surface-muted/40 transition-colors">
                      <td className="py-3.5 px-4 w-8">
                        <input
                          type="checkbox"
                          name="ids"
                          value={env.id}
                          form="bulk-form"
                          aria-label={`Select ${env.title}`}
                          className="h-4 w-4 rounded border-hairline-strong text-accent focus:ring-accent/30"
                        />
                      </td>
                      <td className="py-3.5 px-4">
                        <Link href={`/dashboard/envelopes/${env.id}`} className="block focus-visible:outline-none">
                          <span className="block text-[13.5px] font-medium text-ink group-hover:text-accent transition-colors">
                            {env.title}
                          </span>
                          <span className="block text-[12px] text-ink-tertiary mt-0.5 truncate max-w-[44ch]">
                            {env.title.endsWith('.pdf') ? env.title : `${env.title}.pdf`}
                          </span>
                        </Link>
                      </td>
                      <td className="py-3.5 px-4"><StatusBadge status={env.status} /></td>
                      <td className="py-3.5 px-4 hidden md:table-cell">
                        <div className="flex items-center gap-2">
                          <AvatarStack names={env.recipients.map((r) => r.name)} max={3} size="xs" />
                          <span className="text-[12px] text-ink-tertiary tabular-nums">{signed}/{env.recipients.length} signed</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 hidden sm:table-cell">
                        <span className="block text-[12.5px] text-ink-secondary">
                          {updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                        <span className="block text-[11px] text-ink-tertiary">{relativeTime(updated)}</span>
                      </td>
                      {showSignNow && (
                        <td className="py-3.5 px-4 text-right">
                          <SignNowButton envelopeId={env.id} size="sm" variant="primary" />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return date.toLocaleDateString();
}

function PlusIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>); }
function SearchIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>); }
