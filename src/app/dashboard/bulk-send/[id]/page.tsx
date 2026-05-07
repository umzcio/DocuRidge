import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function BulkSendJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;

  const job = await prisma.bulkSendJob.findFirst({
    where: { id, orgId: session.orgId },
    include: {
      rows: { orderBy: { rowNumber: 'asc' } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!job) notFound();
  const tpl = await prisma.envelope.findUnique({
    where: { id: job.templateEnvelopeId },
    select: { id: true, title: true },
  });

  const total = job.totalRows;
  const dispatched = job.rows.filter((r) => r.status === 'DISPATCHED').length;
  const failed = job.rows.filter((r) => r.status === 'FAILED' || r.status === 'SKIPPED_ALLOWLIST').length;
  const pending = job.rows.filter((r) => r.status === 'PENDING').length;
  const pct = total === 0 ? 0 : Math.round(((dispatched + failed) / total) * 100);
  const stillRunning = job.status === 'RUNNING' || pending > 0;

  return (
    <main className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1024px] mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[12px] text-ink-tertiary font-mono uppercase tracking-[0.06em] mb-1">
            Bulk send · {job.csvFilename}
          </p>
          <h1 className="text-[24px] font-semibold tracking-[-0.018em] text-ink leading-tight">
            {tpl?.title ?? 'Template'}
          </h1>
          <p className="mt-1 text-[13px] text-ink-secondary">
            Started by {job.createdBy?.name ?? 'a sender'} · {job.createdAt.toUTCString()}
          </p>
        </div>
        <Link
          href="/dashboard/templates"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60"
        >
          ← Templates
        </Link>
      </div>

      <div className="mt-6 rounded-lg border border-hairline bg-surface p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[13px] text-ink">
            {stillRunning ? 'In progress' : 'Completed'}
          </p>
          <p className="text-[12.5px] font-mono tabular-nums text-ink-tertiary">
            {dispatched + failed} / {total} processed · {pct}%
          </p>
        </div>
        <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
          <div
            className="h-full bg-accent transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
          <Stat label="Sent" value={dispatched} tone="completed" />
          <Stat label="Failed" value={failed} tone="declined" />
          <Stat label="Pending" value={pending} tone="muted" />
        </div>
        {stillRunning && (
          <p className="mt-4 text-[11.5px] text-ink-tertiary text-center">
            Refresh the page to see updated progress (no live polling in v1).
          </p>
        )}
      </div>

      <h2 className="mt-8 text-[14px] font-semibold text-ink">Rows</h2>
      <div className="mt-3 rounded-lg border border-hairline bg-surface overflow-hidden">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left bg-surface-muted/40 border-b border-hairline">
              <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Row</th>
              <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Recipient</th>
              <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Status</th>
              <th className="py-2.5 px-4 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-tertiary">Envelope</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {job.rows.map((r) => {
              const m = r.recipientMap as { name?: string; email?: string };
              return (
                <tr key={r.id} className="text-[12.5px]">
                  <td className="py-2.5 px-4 font-mono text-ink-tertiary">{r.rowNumber}</td>
                  <td className="py-2.5 px-4 text-ink">
                    <span className="font-medium">{m.name}</span>
                    <span className="block text-[11.5px] text-ink-tertiary">{m.email}</span>
                  </td>
                  <td className="py-2.5 px-4">
                    <RowStatus status={r.status} error={r.error} />
                  </td>
                  <td className="py-2.5 px-4">
                    {r.envelopeId ? (
                      <Link href={`/dashboard/envelopes/${r.envelopeId}`} className="text-accent hover:text-accent-deep font-mono text-[11.5px]">
                        {r.envelopeId.slice(0, 10)}…
                      </Link>
                    ) : (
                      <span className="text-ink-tertiary">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'completed' | 'declined' | 'muted' }) {
  const palette = tone === 'completed'
    ? 'bg-status-completed-bg/60 text-status-completed border-status-completed-border'
    : tone === 'declined'
    ? 'bg-status-declined-bg/60 text-status-declined border-status-declined-border'
    : 'bg-surface-muted text-ink-secondary border-hairline';
  return (
    <div className={`rounded-md border px-3 py-2 ${palette}`}>
      <p className="text-[20px] font-semibold tabular-nums">{value}</p>
      <p className="text-[10.5px] uppercase tracking-[0.06em] mt-0.5">{label}</p>
    </div>
  );
}

function RowStatus({ status, error }: { status: string; error: string | null }) {
  const map: Record<string, { tone: string; label: string }> = {
    PENDING: { tone: 'bg-surface-muted text-ink-secondary', label: 'Pending' },
    DISPATCHED: { tone: 'bg-status-completed-bg/60 text-status-completed', label: 'Sent' },
    FAILED: { tone: 'bg-status-declined-bg/60 text-status-declined', label: 'Failed' },
    SKIPPED_ALLOWLIST: { tone: 'bg-status-voided-bg/60 text-status-voided', label: 'Skipped (allowlist)' },
  };
  const v = map[status] ?? map.PENDING!;
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex w-fit items-center px-2 py-0.5 rounded-full text-[10.5px] font-medium ${v.tone}`}>
        {v.label}
      </span>
      {error && <span className="text-[10.5px] text-status-declined truncate max-w-[40ch]" title={error}>{error}</span>}
    </div>
  );
}
