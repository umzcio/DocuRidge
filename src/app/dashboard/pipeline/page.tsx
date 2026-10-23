import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { authorize } from '@/lib/authz/can';
import { StatusBadge } from '@/components/ui/badge';
import { PIPELINE_PAGE_SIZE, pipelineQuery } from './query';
import { PipelineStatusSelect } from './pipeline-table';

export const dynamic = 'force-dynamic';

function one(values: string | string[] | undefined): string {
  return Array.isArray(values) ? (values[0] ?? '') : (values ?? '');
}

/** Build a query string from the active filters — used for the export link
 *  and pagination so every control preserves the current filter set. */
function filterQuery(sp: Record<string, string | string[] | undefined>, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of ['status', 'sender', 'from', 'to']) {
    const v = one(sp[key]).trim();
    if (v) params.set(key, v);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  authorize(ctx, 'envelope:read');

  const sp = await searchParams;
  const filters = {
    status: one(sp.status),
    sender: one(sp.sender),
    from: one(sp.from),
    to: one(sp.to),
  };
  const page = Math.max(1, parseInt(one(sp.page), 10) || 1);
  const { rows, total } = await pipelineQuery(ctx.orgId, {
    ...filters,
    offset: (page - 1) * PIPELINE_PAGE_SIZE,
  });
  const pageCount = Math.max(1, Math.ceil(total / PIPELINE_PAGE_SIZE));

  return (
    <main id="pipeline-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1280px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-foreground leading-tight">
            Pipeline
          </h1>
          <p className="mt-1 text-[14px] text-muted-foreground">
            In-progress contracts, aging and outstanding signers
          </p>
        </div>
        <Link
          href={`/dashboard/pipeline/export${filterQuery(sp)}`}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-canvas px-3.5 text-[13px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors"
        >
          <DownloadIcon /> Export CSV
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-card overflow-hidden">
        {/* Filter bar — GET form, so URL state is shareable/back-button safe. */}
        <form data-pipeline-filters className="p-3 flex flex-wrap items-center gap-2 border-b border-border" method="get">
          <div className="relative flex-1 min-w-[200px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
              <SearchIcon />
            </span>
            <input
              type="search"
              name="sender"
              defaultValue={filters.sender}
              placeholder="Filter by sender"
              aria-label="Filter by sender"
              className="w-full h-9 pl-9 pr-3 rounded-md bg-card border border-border text-[13.5px] text-foreground placeholder:text-faint outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
            />
          </div>
          <input type="hidden" name="status" value={filters.status} />
          <PipelineStatusSelect value={filters.status} />
          <input
            type="date"
            name="from"
            defaultValue={filters.from}
            aria-label="Sent on or after"
            className="h-9 px-3 rounded-md bg-card border border-border text-[13px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
          <input
            type="date"
            name="to"
            defaultValue={filters.to}
            aria-label="Sent on or before"
            className="h-9 px-3 rounded-md bg-card border border-border text-[13px] text-foreground outline-none focus:border-primary focus:ring-3 focus:ring-primary/12"
          />
          <button type="submit" className="h-9 inline-flex items-center px-3 rounded-md text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
            Apply
          </button>
        </form>

        {rows.length === 0 ? (
          <div className="p-16 text-center">
            <p className="text-[13.5px] text-muted-foreground">No documents match these filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left bg-muted/40 border-b border-border">
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">Document</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">Status</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint hidden md:table-cell">Sender</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">Current signers</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint">Days pending</th>
                  <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-faint hidden sm:table-cell">Sent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id} className="group hover:bg-muted/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <Link
                        href={`/dashboard/envelopes/${row.id}`}
                        className="block text-[13.5px] font-medium text-foreground group-hover:text-primary transition-colors focus-visible:outline-none"
                      >
                        {row.title}
                      </Link>
                    </td>
                    <td className="py-3.5 px-4"><StatusBadge status={row.status} /></td>
                    <td className="py-3.5 px-4 hidden md:table-cell">
                      <span className="block text-[13px] text-foreground">{row.senderName}</span>
                      <span className="block text-[11.5px] text-faint truncate max-w-[28ch]">{row.senderEmail}</span>
                    </td>
                    <td className="py-3.5 px-4">
                      {row.currentSigners.length === 0 ? (
                        <span className="text-[12.5px] text-faint">—</span>
                      ) : (
                        <span className="text-[12.5px] text-muted-foreground">{row.currentSigners.join(', ')}</span>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <span className={`text-[13px] tabular-nums ${row.daysPending > 7 ? 'text-destructive font-medium' : 'text-foreground'}`}>
                        {row.daysPending}
                      </span>
                    </td>
                    <td className="py-3.5 px-4 hidden sm:table-cell">
                      <span className="block text-[12.5px] text-muted-foreground">
                        {(row.sentAt ?? row.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PIPELINE_PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <span className="text-[12px] text-faint tabular-nums">
              {total} documents · page {page} of {pageCount}
            </span>
            <div className="flex items-center gap-2">
              {page > 1 ? (
                <Link
                  href={`/dashboard/pipeline${filterQuery(sp, { page: String(page - 1) })}`}
                  className="h-8 inline-flex items-center px-3 rounded-md text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  ← Prev
                </Link>
              ) : (
                <span className="h-8 inline-flex items-center px-3 rounded-md text-[13px] text-faint">← Prev</span>
              )}
              {page < pageCount ? (
                <Link
                  href={`/dashboard/pipeline${filterQuery(sp, { page: String(page + 1) })}`}
                  className="h-8 inline-flex items-center px-3 rounded-md text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  Next →
                </Link>
              ) : (
                <span className="h-8 inline-flex items-center px-3 rounded-md text-[13px] text-faint">Next →</span>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function SearchIcon() { return (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>); }
function DownloadIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>); }
