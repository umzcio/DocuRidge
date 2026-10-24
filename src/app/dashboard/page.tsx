import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { StatusBadge } from '@/components/ui/badge';
import { AvatarStack } from '@/components/ui/avatar';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const orgFilter = { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT' as const };

  const [grouped, awaitingMine, completedThisMonth, recent, recentActivity, completionAgg] =
    await Promise.all([
      prisma.envelope.groupBy({
        by: ['status'],
        where: orgFilter,
        _count: { _all: true },
      }),
      prisma.envelope.findMany({
        where: {
          ...orgFilter,
          status: { in: ['SENT', 'IN_PROGRESS'] },
          recipients: {
            some: {
              email: session.user.email.toLowerCase(),
              signingStatus: 'NOT_SIGNED',
            },
          },
        },
        orderBy: [{ sentAt: 'desc' }],
        take: 5,
        include: { recipients: { orderBy: { signingOrder: 'asc' } } },
      }),
      prisma.envelope.count({
        where: {
          ...orgFilter,
          status: 'COMPLETED',
          completedAt: { gte: startOfMonth() },
        },
      }),
      prisma.envelope.findMany({
        where: orgFilter,
        orderBy: [{ updatedAt: 'desc' }],
        take: 6,
        include: { recipients: { orderBy: { signingOrder: 'asc' } } },
      }),
      prisma.auditEvent.findMany({
        where: { envelope: orgFilter },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { envelope: { select: { id: true, title: true } } },
      }),
      prisma.envelope.groupBy({
        by: ['status'],
        where: { ...orgFilter, status: { in: ['SENT', 'IN_PROGRESS', 'COMPLETED'] } },
        _count: { _all: true },
      }),
    ]);

  // Resolve user names for the activity feed actors.
  const activityActorIds = Array.from(
    new Set(recentActivity.map((e) => e.actorUserId).filter((v): v is string => !!v)),
  );
  const activityActors = activityActorIds.length
    ? await prisma.user.findMany({ where: { id: { in: activityActorIds } }, select: { id: true, name: true } })
    : [];
  const activityActorMap = new Map(activityActors.map((u) => [u.id, u.name]));

  const byStatus = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const total = grouped.reduce((s, g) => s + g._count._all, 0);
  const awaitingCount = awaitingMine.length;
  const inDrafts = byStatus('DRAFT');
  const inProgress = byStatus('IN_PROGRESS') + byStatus('SENT');

  const completionSent =
    (completionAgg.find((a) => a.status === 'SENT')?._count._all ?? 0) +
    (completionAgg.find((a) => a.status === 'IN_PROGRESS')?._count._all ?? 0) +
    (completionAgg.find((a) => a.status === 'COMPLETED')?._count._all ?? 0);
  const completionDone = completionAgg.find((a) => a.status === 'COMPLETED')?._count._all ?? 0;
  const completionPct = completionSent === 0 ? 0 : Math.round((completionDone / completionSent) * 100);

  const firstName = session.user.name.trim().split(/\s+/)[0] ?? session.user.name;

  return (
    <main id="dashboard-main" className="px-6 lg:px-8 py-8 lg:py-10 max-w-[1280px] mx-auto">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="greeting-shimmer text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] leading-tight">
            {greeting()}, {firstName}
          </h1>
          <p className="mt-1 text-[14px] text-muted-foreground">
            Here&rsquo;s what&rsquo;s happening with your documents today.
          </p>
        </div>
        <Link
          href="/dashboard/envelopes/new"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-canvas px-4 text-[13.5px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors"
        >
          <PlusIcon /> Start a new document
        </Link>
      </div>

      {/* Stat cards */}
      <div className="mt-6 grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Awaiting signature"
          value={awaitingCount}
          icon={<ClockIcon />}
          tone="amber"
        />
        <StatCard
          label="Action required"
          value={awaitingCount}
          icon={<AlertIcon />}
          tone="rose"
        />
        <StatCard
          label="Completed this month"
          value={completedThisMonth}
          icon={<CheckIcon />}
          tone="emerald"
        />
        <StatCard
          label="In drafts"
          value={inDrafts}
          icon={<DocIcon />}
          tone="slate"
        />
      </div>

      {/* Two-column row 1 */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Action required */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card">
          <div className="p-5 flex items-start justify-between gap-3 border-b border-border">
            <div>
              <h2 className="text-[15px] font-semibold text-foreground">Action required</h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">Agreements waiting on your signature</p>
            </div>
            <Link href="/dashboard/inbox" className="text-[13px] text-primary font-medium hover:text-primary-deep">
              View all
            </Link>
          </div>
          {awaitingMine.length === 0 ? (
            <div className="p-12 flex flex-col items-center text-center">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-success-bg text-success">
                <CheckIcon />
              </span>
              <p className="mt-3 text-[13.5px] text-muted-foreground">All caught up — no pending signatures.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {awaitingMine.map((env) => (
                <li key={env.id}>
                  <Link href={`/dashboard/envelopes/${env.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/50 transition-colors">
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-muted border border-border text-muted-foreground">
                      <DocIcon />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13.5px] font-medium text-foreground truncate">{env.title}</span>
                      <span className="block text-[12px] text-faint">
                        {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'} · {relativeTime(env.sentAt ?? env.createdAt)}
                      </span>
                    </span>
                    <StatusBadge status={env.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent activity */}
        <div className="rounded-lg border border-border bg-card">
          <div className="p-5 border-b border-border">
            <h2 className="text-[15px] font-semibold text-foreground">Recent activity</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">Latest events across your documents</p>
          </div>
          {recentActivity.length === 0 ? (
            <div className="p-8 text-center text-[13px] text-faint">No activity yet.</div>
          ) : (
            <ul className="p-3 flex flex-col">
              {recentActivity.map((evt) => (
                <li key={evt.id} className="flex items-start gap-2.5 px-2 py-2">
                  <span className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${eventDotClass(evt.type)}`} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12.5px] text-foreground leading-tight">
                      <span className="font-medium">{evt.actorName ?? (evt.actorUserId ? activityActorMap.get(evt.actorUserId) : null) ?? 'System'}</span>{' '}
                      <span className="text-muted-foreground">{eventVerb(evt.type)}</span>{' '}
                      <Link href={`/dashboard/envelopes/${evt.envelopeId}`} className="text-primary hover:text-primary-deep truncate">
                        {evt.envelope?.title ? truncate(evt.envelope.title, 28) : 'document'}
                      </Link>
                    </span>
                    <span className="block text-[11px] text-faint mt-0.5">{relativeTime(evt.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Two-column row 2 */}
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Recent documents */}
        <div className="lg:col-span-2 rounded-lg border border-border bg-card">
          <div className="p-5 flex items-start justify-between gap-3 border-b border-border">
            <h2 className="text-[15px] font-semibold text-foreground">Recent documents</h2>
            <Link href="/dashboard/envelopes" className="text-[13px] text-primary font-medium hover:text-primary-deep">
              View all
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className="p-12 text-center text-[13px] text-faint">
              No documents yet. <Link href="/dashboard/envelopes/new" className="text-primary font-medium">Start one →</Link>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((env) => (
                <li key={env.id}>
                  <Link
                    href={`/dashboard/envelopes/${env.id}`}
                    className="flex items-center gap-3 px-5 py-3.5 hover:bg-muted/50 transition-colors"
                  >
                    <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-muted border border-border text-muted-foreground">
                      <DocIcon />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13.5px] font-medium text-foreground truncate">{env.title}</span>
                      <span className="block text-[12px] text-faint">
                        {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'} · Updated {relativeTime(env.updatedAt)}
                      </span>
                    </span>
                    <span className="hidden sm:inline-flex">
                      <AvatarStack names={env.recipients.map((r) => r.name)} max={3} size="xs" />
                    </span>
                    <StatusBadge status={env.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Completion rate */}
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            <TrendIcon />
            <h2 className="text-[15px] font-semibold text-foreground">Completion rate</h2>
          </div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">Across all sent documents</p>

          <div className="mt-6 flex items-baseline gap-3">
            <p className="text-[44px] font-semibold tracking-[-0.04em] text-foreground leading-none tnum">{completionPct}%</p>
            <p className="text-[12px] text-faint">{completionDone} of {completionSent}</p>
          </div>

          <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${completionPct}%` }} />
          </div>

          <div className="mt-6 grid grid-cols-3 gap-2 text-center">
            <Mini icon={<SendIconSm />} label="Sent" value={inProgress} />
            <Mini icon={<UsersIcon />} label="Signers" value={countSigners(recent)} />
            <Mini icon={<DocIcon />} label="Drafts" value={inDrafts} />
          </div>
        </div>
      </div>

      {/* Footer hint when totally empty */}
      {total === 0 && (
        <div className="mt-6 rounded-lg border border-dashed border-border bg-card px-6 py-10 text-center">
          <h3 className="text-[18px] font-semibold text-foreground">Send your first document</h3>
          <p className="mt-1 text-[13.5px] text-muted-foreground max-w-md mx-auto">
            Upload a PDF, place fields, and route to recipients &mdash; sealed and verifiable in minutes.
          </p>
          <Link
            href="/dashboard/envelopes/new"
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-[13.5px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors"
          >
            <PlusIcon /> New document
          </Link>
        </div>
      )}
    </main>
  );
}

/* ─── Helpers ──────────────────────────────────────────────────── */

function startOfMonth(): Date {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Welcome back';
  return 'Good evening';
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

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function countSigners(envs: { recipients: { id: string }[] }[]): number {
  return envs.reduce((s, e) => s + e.recipients.length, 0);
}

function eventVerb(type: string): string {
  switch (type) {
    case 'envelope.created': return 'created a document';
    case 'envelope.sent': return 'sent for signature';
    case 'envelope.viewed_by_sender': return 'opened';
    case 'recipient.opened': return 'viewed the document';
    case 'recipient.signed': return 'signed the document';
    case 'recipient.declined': return 'declined';
    case 'envelope.completed': return 'document completed';
    case 'envelope.voided_by_sender': return 'voided the document';
    case 'envelope.sealed': return 'sealed the document';
    case 'envelope.seal_failed': return 'could not seal';
    case 'recipient.consent_given': return 'gave consent on';
    case 'recipient.access_code_unlocked': return 'unlocked with access code on';
    case 'recipient.access_code_locked': return 'was locked out by wrong access codes on';
    case 'recipient.field_filled': return 'filled a field on';
    case 'envelope.advanced': return 'advanced to next signer on';
    case 'email.sent': return 'sent an email about';
    case 'email.failed': return 'failed to send email for';
    default: return type.replace(/[._]/g, ' ');
  }
}

function eventDotClass(type: string): string {
  if (type.startsWith('envelope.created') || type.startsWith('envelope.sent') || type.startsWith('envelope.advanced')) return 'bg-status-sent';
  if (type.startsWith('recipient.signed') || type === 'envelope.completed' || type === 'envelope.sealed') return 'bg-success';
  if (type.startsWith('recipient.declined') || type === 'envelope.voided_by_sender' || type === 'email.failed' || type === 'envelope.seal_failed') return 'bg-destructive';
  if (type.startsWith('recipient.opened') || type === 'envelope.viewed_by_sender') return 'bg-status-progress';
  return 'bg-faint';
}

/* ─── Sub-components ───────────────────────────────────────────── */

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: 'amber' | 'rose' | 'emerald' | 'slate';
}) {
  const toneClass = {
    amber: 'bg-status-progress-bg text-status-progress',
    rose: 'bg-destructive-bg text-destructive',
    emerald: 'bg-success-bg text-success',
    slate: 'bg-muted text-muted-foreground',
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between">
        <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint">{label}</p>
        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${toneClass}`}>
          {icon}
        </span>
      </div>
      <p className="mt-3 text-[28px] font-semibold tracking-[-0.022em] text-foreground leading-none tnum">{value}</p>
    </div>
  );
}

function Mini({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div>
      <span className="inline-flex items-center justify-center text-faint">{icon}</span>
      <p className="mt-1 text-[15px] font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-[11px] text-faint">{label}</p>
    </div>
  );
}

/* ─── Inline icons ────────────────────────────────────────────── */

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function AlertIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
function TrendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-primary">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
      <polyline points="16 7 22 7 22 13" />
    </svg>
  );
}
function SendIconSm() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function UsersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
