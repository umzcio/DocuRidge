import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { getEnvelopeForOwner } from '@/lib/envelopes/service';
import { Banner } from '@/components/ui/banner';
import { VoidEnvelopeButton } from './void-button';
import { SaveAsTemplateButton } from './save-template-button';
import { SendReminderButton } from './send-reminder-button';
import { SignNowButton } from '../sign-now-button';
import { cloneEnvelopeAction } from './actions';
import { ForwardButton } from './forward-button';
import { FolderPicker } from './folder-picker';
import { CommentsPanel } from './comments-panel';
import { DocumentPreview } from './document-preview';
import { LocalTime } from '@/components/ui/local-time';

export const dynamic = 'force-dynamic';

type Tab = 'document' | 'activity' | 'audit';

export default async function EnvelopeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const sp = await searchParams;
  const activeTab: Tab =
    sp.tab === 'audit' ? 'audit' : sp.tab === 'activity' ? 'activity' : 'document';
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const env = await getEnvelopeForOwner(ctx, id);
  if (!env) notFound();

  const [auditEvents, sealed, createdBy, allFolders, comments] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { envelopeId: env.id },
      orderBy: { seq: 'asc' },
    }),
    prisma.sealedDocument.findUnique({
      where: { envelopeId: env.id },
      include: { documentFile: true },
    }),
    prisma.user.findUnique({
      where: { id: env.createdById },
      select: { name: true, email: true },
    }),
    prisma.folder.findMany({
      where: { orgId: session.orgId, deletedAt: null, type: 'DOCUMENT' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.envelopeComment.findMany({
      where: { envelopeId: env.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, authorName: true, authorUserId: true, body: true, createdAt: true },
    }),
  ]);
  const orgKey = sealed
    ? await prisma.orgSigningKey.findUnique({ where: { id: sealed.signedByKeyId } })
    : null;

  // Resolve actor user names so the activity log doesn't show "System" for
  // every event the sender triggered.
  const actorUserIds = Array.from(
    new Set(auditEvents.map((e) => e.actorUserId).filter((v): v is string => !!v)),
  );
  const actorUsers = actorUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorUserIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const actorUserMap = new Map(actorUsers.map((u) => [u.id, u]));

  const canVoid =
    env.type === 'DOCUMENT' &&
    (env.status === 'DRAFT' || env.status === 'SENT' || env.status === 'IN_PROGRESS');
  const canSaveTemplate =
    env.type === 'DOCUMENT' &&
    (env.status === 'COMPLETED' || env.status === 'IN_PROGRESS' || env.status === 'SENT');

  const totalPages = env.items.reduce((sum, it) => sum + (it.pageCount ?? 0), 0);
  const firstItemTitle = env.items[0]?.title ?? null;
  const reminders = parseReminderSettings(env.meta?.reminderSettings);

  // Show "Sign now" if the current user is a pending signer on this document
  // and (in sequential mode) it's their turn.
  const myEmail = session.user.email.toLowerCase();
  const myRecipient = env.recipients.find(
    (r) => r.email.toLowerCase() === myEmail && r.recipientRole === 'SIGNER',
  );
  const earlierPending = myRecipient && env.routingMode === 'SEQUENTIAL'
    ? env.recipients
        .filter((r) => r.recipientRole === 'SIGNER' && r.signingOrder < myRecipient.signingOrder)
        .some((r) => r.signingStatus === 'NOT_SIGNED')
    : false;
  const canSignNow =
    !!myRecipient &&
    myRecipient.signingStatus === 'NOT_SIGNED' &&
    (env.status === 'SENT' || env.status === 'IN_PROGRESS') &&
    !earlierPending;

  return (
    <main id="detail-main" className="px-6 lg:px-8 py-6 lg:py-8 max-w-[1280px] mx-auto">
      <Link
        href="/dashboard/envelopes"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-secondary hover:text-ink mb-4"
      >
        <ChevronLeft /> All documents
      </Link>

      {/* Header */}
      <div className="rounded-lg border border-hairline bg-surface px-5 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[18px] font-semibold tracking-[-0.012em] text-ink truncate">{env.title}</h1>
            <FriendlyStatus status={env.status} />
          </div>
          <p className="mt-1 text-[12.5px] text-ink-tertiary">
            {firstItemTitle ?? env.title}
            {firstItemTitle && !firstItemTitle.endsWith('.pdf') && '.pdf'}
            <span className="mx-1.5">·</span>
            Created {fmtDate(env.createdAt)}
            <span className="mx-1.5">·</span>
            {env.recipients.length} recipient{env.recipients.length === 1 ? '' : 's'}
            {totalPages > 0 && (
              <>
                <span className="mx-1.5">·</span>
                {totalPages} page{totalPages === 1 ? '' : 's'}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canSignNow && <SignNowButton envelopeId={env.id} />}
          {(env.status === 'SENT' || env.status === 'IN_PROGRESS') && !canSignNow && (
            <SendReminderButton envelopeId={env.id} />
          )}
          {env.status === 'COMPLETED' && <ForwardButton envelopeId={env.id} />}
          <FolderPicker
            envelopeId={env.id}
            currentFolderId={env.folderId}
            folders={allFolders}
          />
          <form action={cloneEnvelopeAction} className="contents">
            <input type="hidden" name="envelopeId" value={env.id} />
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 transition-colors"
              title="Create a new draft with the same documents, recipients, and fields"
            >
              <CopyIcon /> Clone
            </button>
          </form>
          {sealed ? (
            <Link
              href={`/dashboard/envelopes/${env.id}/sealed`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-canvas px-3.5 text-[13px] font-medium text-white border border-canvas hover:bg-canvas-edge transition-colors"
            >
              <DownloadIcon /> Download
            </Link>
          ) : (
            <Link
              href={`/dashboard/envelopes/${env.id}/audit.json`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-muted/60 transition-colors"
            >
              <DownloadIcon /> Audit JSON
            </Link>
          )}
        </div>
      </div>

      {env.voidReason && (
        <div className="mt-3">
          <Banner tone="warning">
            Voided: <span className="italic">{env.voidReason}</span>
          </Banner>
        </div>
      )}

      {/* Tabs */}
      <nav className="mt-4 flex items-center gap-1 border-b border-hairline" aria-label="Detail sections">
        <TabLink href={`/dashboard/envelopes/${env.id}`} active={activeTab === 'document'}>
          <DocIconSm /> Document
        </TabLink>
        <TabLink href={`/dashboard/envelopes/${env.id}?tab=activity`} active={activeTab === 'activity'}>
          <ActivityIcon /> Activity
        </TabLink>
        <TabLink href={`/dashboard/envelopes/${env.id}?tab=audit`} active={activeTab === 'audit'}>
          <ShieldCheck /> Audit certificate
        </TabLink>
      </nav>

      {/* Body — two columns */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        <section className="rounded-lg border border-hairline bg-surface min-h-[520px]">
          {activeTab === 'document' && (
            <DocumentPane firstFileName={firstItemTitle} sealed={!!sealed} envelopeId={env.id} />
          )}
          {activeTab === 'activity' && (
            <ActivityPane
              events={[...auditEvents].reverse().map((e) => ({
                ...e,
                actorName:
                  e.actorName ??
                  (e.actorUserId ? actorUserMap.get(e.actorUserId)?.name ?? null : null),
                actorEmail:
                  e.actorEmail ??
                  (e.actorUserId ? actorUserMap.get(e.actorUserId)?.email ?? null : null),
              }))}
            />
          )}
          {activeTab === 'audit' && (
            <AuditCertificatePane
              env={env}
              auditEvents={auditEvents}
              sealed={sealed}
              orgKey={orgKey}
              senderName={createdBy?.name ?? '—'}
              senderEmail={createdBy?.email ?? null}
            />
          )}
        </section>

        {/* Right rail */}
        <aside className="flex flex-col gap-3">
          {/* Recipients */}
          <div className="rounded-lg border border-hairline bg-surface">
            <div className="px-4 py-3 border-b border-hairline flex items-center justify-between">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Recipients</h2>
              <span className="text-[11px] text-ink-tertiary tabular-nums">
                {env.recipients.filter((r) => r.signingStatus === 'SIGNED').length} of {env.recipients.length} signed
              </span>
            </div>
            <ol className="px-4 py-3 flex flex-col gap-3">
              {env.recipients.map((r, i) => (
                <li key={r.id} className="flex items-start gap-3">
                  <RecipientAvatar name={r.name} index={i} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <p className="text-[13px] font-medium text-ink truncate">{r.name}</p>
                      <span className="font-mono text-[10px] text-ink-tertiary tabular-nums">#{i + 1}</span>
                    </div>
                    <p className="text-[11.5px] text-ink-tertiary truncate">{r.email}</p>
                    <div className="mt-1.5">
                      <RecipientPill recipient={r} />
                    </div>
                    {r.signedAt && (
                      <p className="mt-0.5 font-mono text-[10.5px] text-ink-tertiary">
                        signed <LocalTime iso={r.signedAt.toISOString()} withSeconds />
                      </p>
                    )}
                    {r.declineReason && (
                      <p className="mt-0.5 italic text-[11px] text-status-declined">&ldquo;{r.declineReason}&rdquo;</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* Details */}
          <div className="rounded-lg border border-hairline bg-surface">
            <div className="px-4 py-3 border-b border-hairline flex items-center gap-2">
              <SettingsIcon />
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Details</h2>
            </div>
            <dl className="px-4 py-3 grid grid-cols-2 gap-y-2.5 gap-x-3 text-[12.5px]">
              <DetailRow label="Created" value={fmtDate(env.createdAt)} />
              <DetailRow label="Sent" value={env.sentAt ? fmtDate(env.sentAt) : '—'} />
              <DetailRow label="Expires" value={env.expiresAt ? fmtDate(env.expiresAt) : '—'} />
              <DetailRow label="Signing order" value={env.routingMode === 'PARALLEL' ? 'Parallel' : 'Sequential'} />
              <DetailRow label="Auto reminders" value={reminders.enabled ? 'On' : 'Off'} />
              <DetailRow label="Owner" value={createdBy?.name ?? '—'} />
            </dl>
          </div>

          {/* Actions */}
          {(canSaveTemplate || canVoid) && (
            <div className="rounded-lg border border-hairline bg-surface">
              <div className="px-4 py-3 border-b border-hairline">
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Actions</h2>
              </div>
              <div className="px-4 py-3 flex flex-col gap-2">
                {canSaveTemplate && (
                  <SaveAsTemplateButton envelopeId={env.id} suggestedTitle={`${env.title} template`} />
                )}
                {canVoid && <VoidEnvelopeButton envelopeId={env.id} />}
              </div>
            </div>
          )}

          {/* Email content */}
          {(env.message || env.meta?.emailSubject) && (
            <div className="rounded-lg border border-hairline bg-surface">
              <div className="px-4 py-3 border-b border-hairline flex items-center gap-2">
                <MailIcon />
                <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-tertiary">Email content</h2>
              </div>
              <div className="px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Subject</p>
                <p className="mt-1 text-[12.5px] text-ink leading-snug">
                  {env.meta?.emailSubject || `${createdBy?.name ?? 'A DocuRidge sender'} needs your signature: ${env.title}`}
                </p>
                {env.message && (
                  <>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-tertiary">Message</p>
                    <p className="mt-1 text-[12.5px] text-ink-secondary leading-relaxed whitespace-pre-wrap">{env.message}</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Discussion thread — sender + recipient back-channel. */}
          <CommentsPanel
            envelopeId={env.id}
            currentUserId={session.user.id}
            comments={comments.map((c) => ({
              id: c.id,
              authorName: c.authorName,
              isOwnPost: c.authorUserId === session.user.id,
              isSender: !!c.authorUserId,
              body: c.body,
              createdAt: c.createdAt.toISOString(),
            }))}
          />
        </aside>
      </div>
    </main>
  );
}

/* ─── Document tab ────────────────────────────────────────────── */
function DocumentPane({
  firstFileName,
  sealed,
  envelopeId,
}: {
  firstFileName: string | null;
  sealed: boolean;
  envelopeId: string;
}) {
  return (
    <div className="px-5 py-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <p className="text-[13px] font-medium text-ink truncate">
          {firstFileName ?? 'No document attached'}
        </p>
        {sealed && (
          <Link
            href={`/dashboard/envelopes/${envelopeId}/sealed`}
            className="text-[12.5px] text-accent font-medium hover:text-accent-deep"
          >
            Open sealed PDF →
          </Link>
        )}
      </div>
      <DocumentPreview envelopeId={envelopeId} title={firstFileName ?? 'document'} />
    </div>
  );
}

/* ─── Activity tab ─────────────────────────────────────────────── */
function ActivityPane({
  events,
}: {
  events: Array<{
    id: string;
    seq: number;
    type: string;
    actorName: string | null;
    actorEmail: string | null;
    ipAddress: string | null;
    createdAt: Date;
    data: unknown;
  }>;
}) {
  if (events.length === 0) {
    return (
      <div className="p-12 text-center text-[13px] text-ink-tertiary">No activity yet.</div>
    );
  }
  return (
    <div className="px-5 py-5">
      <h2 className="text-[14px] font-semibold text-ink">Activity log</h2>
      <p className="mt-0.5 text-[12.5px] text-ink-tertiary">All events related to this document.</p>
      <ol className="mt-4 space-y-2.5">
        {events.map((e) => {
          const meta = activityMeta(e.type);
          const actor = e.actorName ?? e.actorEmail ?? 'System';
          const ipLine = e.ipAddress ? ` · IP ${e.ipAddress}` : '';
          return (
            <li key={e.id} className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-surface-muted/40 transition-colors">
              <span className={`mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full flex-shrink-0 ${meta.tone}`}>
                {meta.icon}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-ink leading-tight">
                  <span className="font-medium">{actor}</span>{' '}
                  <span className="text-ink-secondary">{meta.verb}</span>
                  {meta.objectHint && (
                    <span className="text-ink-secondary"> {meta.objectHint}</span>
                  )}
                </p>
                <p className="mt-1 font-mono text-[11px] text-ink-tertiary tabular-nums">
                  <LocalTime iso={e.createdAt.toISOString()} withSeconds />{ipLine} · §{String(e.seq).padStart(2, '0')}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ─── Audit certificate tab ───────────────────────────────────── */
function AuditCertificatePane({
  env,
  auditEvents,
  sealed,
  orgKey,
  senderName,
  senderEmail,
}: {
  env: {
    id: string;
    title: string;
    status: string;
    routingMode: string;
    items: Array<{ pageCount: number }>;
    recipients: Array<{
      id: string;
      name: string;
      email: string;
      signingOrder: number;
      signingStatus: string;
      sendStatus: string;
      sentAt: Date | null;
      openedAt: Date | null;
      signedAt: Date | null;
      declinedAt: Date | null;
      ipAddress: string | null;
    }>;
  };
  auditEvents: Array<{
    seq: number;
    type: string;
    eventHash: string;
    createdAt: Date;
    actorEmail?: string | null;
    actorName?: string | null;
    ipAddress?: string | null;
  }>;
  sealed: { chainHeadHash: string; documentFile: { sha256: string } } | null;
  orgKey: { fingerprint: string } | null;
  senderName: string;
  senderEmail: string | null;
}) {
  const totalPages = env.items.reduce((s, it) => s + (it.pageCount ?? 0), 0);
  return (
    <div className="px-5 sm:px-6 py-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="text-status-completed" />
            <h2 className="text-[15px] font-semibold text-ink">Certificate of completion</h2>
          </div>
          <p className="mt-0.5 text-[12px] text-ink-tertiary">
            Tamper-evident audit trail for legal admissibility.
          </p>
        </div>
        <Link
          href={`/dashboard/envelopes/${env.id}/audit.json`}
          className="text-[12.5px] text-accent font-medium hover:text-accent-deep inline-flex items-center gap-1"
        >
          <DownloadIcon /> Download JSON
        </Link>
      </div>

      <div className="mt-5 rounded-md border border-hairline bg-surface-muted/30 p-5 sm:p-6">
        {/* Envelope metadata grid */}
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3.5 font-mono text-[11.5px] uppercase tracking-[0.04em]">
          <CertRow label="Envelope ID" value={env.id} mono />
          <CertRow label="Status" value={env.status.replace(/_/g, ' ')} />
          <CertRow label="Subject" value={env.title} className="sm:col-span-2" wrap />
          <CertRow label="Document pages" value={String(totalPages)} />
          <CertRow label="Sender" value={senderEmail ? `${senderName} <${senderEmail}>` : senderName} />
          <CertRow label="Signing order" value={env.routingMode} />
        </dl>

        {/* Recipient events table */}
        <div className="mt-6 pt-6 border-t border-hairline">
          <h3 className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-tertiary">
            Recipient events
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full font-mono text-[11px] tabular-nums">
              <thead>
                <tr className="text-left text-ink-tertiary uppercase tracking-[0.06em]">
                  <th className="py-1.5 pr-3 font-semibold">Recipient</th>
                  <th className="py-1.5 px-3 font-semibold">Status</th>
                  <th className="py-1.5 px-3 font-semibold">Timestamp</th>
                  <th className="py-1.5 px-3 font-semibold">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {env.recipients.map((r) => {
                  const meta = recipientCertStatus(r);
                  return (
                    <tr key={r.id} className="text-ink-secondary">
                      <td className="py-1.5 pr-3 text-ink">{r.email}</td>
                      <td className="py-1.5 px-3">{meta.status}</td>
                      <td className="py-1.5 px-3">{meta.timestamp ? <LocalTime iso={meta.timestamp.toISOString()} withSeconds /> : '—'}</td>
                      <td className="py-1.5 px-3">{r.ipAddress ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Hash + version */}
        <div className="mt-6 pt-6 border-t border-hairline space-y-2 font-mono text-[11px]">
          {sealed && (
            <>
              <p className="text-ink-tertiary uppercase tracking-[0.06em] text-[10.5px]">Document hash (sha-256)</p>
              <p className="text-ink-secondary break-all leading-snug">{sealed.documentFile.sha256}</p>
              <p className="mt-3 text-ink-tertiary uppercase tracking-[0.06em] text-[10.5px]">Audit chain head</p>
              <p className="text-ink-secondary break-all leading-snug">{sealed.chainHeadHash}</p>
            </>
          )}
          {!sealed && auditEvents.length > 0 && (
            <>
              <p className="text-ink-tertiary uppercase tracking-[0.06em] text-[10.5px]">Latest event hash</p>
              <p className="text-ink-secondary break-all leading-snug">
                {auditEvents[auditEvents.length - 1]!.eventHash}
              </p>
            </>
          )}
          <p className="mt-3 text-ink-tertiary uppercase tracking-[0.06em] text-[10.5px]">
            Certificate version · ed25519
          </p>
          <p className="text-ink-secondary leading-snug">
            {orgKey ? orgKey.fingerprint : 'unsigned · pre-Phase-4 envelope'}
          </p>
        </div>

        <p className="mt-6 pt-4 border-t border-hairline text-[11.5px] text-ink-tertiary leading-relaxed">
          This certificate provides evidence of the actions taken on this envelope. Each signer&rsquo;s identity is
          verified through email confirmation, and timestamps are recorded with an immutable audit trail.
        </p>
      </div>
    </div>
  );
}

/* ─── Right-rail recipient pill ────────────────────────────────── */
function RecipientPill({
  recipient,
}: {
  recipient: { signingStatus: string; readStatus: string; sendStatus: string; sentAt: Date | null };
}) {
  if (recipient.signingStatus === 'SIGNED') {
    return <Pill tone="completed"><Check /> Signed</Pill>;
  }
  if (recipient.signingStatus === 'DECLINED') {
    return <Pill tone="declined"><X /> Declined</Pill>;
  }
  if (recipient.signingStatus === 'SKIPPED') {
    return <Pill tone="muted"><MinusIcon /> Skipped</Pill>;
  }
  if (recipient.readStatus === 'OPENED' || recipient.signingStatus === 'OPENED') {
    return <Pill tone="progress"><EyeIcon /> Opened</Pill>;
  }
  if (recipient.sendStatus === 'BOUNCED' || recipient.sendStatus === 'FAILED') {
    return <Pill tone="declined"><AlertIcon /> Email failed</Pill>;
  }
  if (recipient.sentAt || recipient.sendStatus === 'SENT') {
    return <Pill tone="sent"><SendIconSm /> Sent</Pill>;
  }
  return <Pill tone="muted"><ClockIcon /> Pending</Pill>;
}

function Pill({ tone, children }: { tone: 'completed' | 'sent' | 'progress' | 'declined' | 'muted'; children: React.ReactNode }) {
  const klass = {
    completed: 'bg-status-completed-bg text-status-completed border-status-completed-border',
    sent: 'bg-status-sent-bg text-status-sent border-status-sent-border',
    progress: 'bg-status-progress-bg text-status-progress border-status-progress-border',
    declined: 'bg-status-declined-bg text-status-declined border-status-declined-border',
    muted: 'bg-surface-muted text-ink-secondary border-hairline',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10.5px] font-medium tracking-[0.02em] ${klass}`}>
      {children}
    </span>
  );
}

/* ─── Header status ───────────────────────────────────────────── */
function FriendlyStatus({ status }: { status: string }) {
  const map: Record<string, { tone: 'sent' | 'completed' | 'progress' | 'declined' | 'muted'; label: string }> = {
    DRAFT:       { tone: 'muted',     label: 'Draft' },
    SENT:        { tone: 'sent',      label: 'Sent' },
    IN_PROGRESS: { tone: 'progress',  label: 'In progress' },
    COMPLETED:   { tone: 'completed', label: 'Completed' },
    DECLINED:    { tone: 'declined',  label: 'Declined' },
    VOIDED:      { tone: 'muted',     label: 'Voided' },
    EXPIRED:     { tone: 'muted',     label: 'Expired' },
  };
  const v = map[status] ?? { tone: 'muted' as const, label: status };
  return <Pill tone={v.tone}>{v.label}</Pill>;
}

/* ─── Tab link ────────────────────────────────────────────────── */
function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex items-center gap-1.5 px-4 h-9 -mb-px rounded-t-md text-[13px] font-medium transition-colors border-b-2 ${
        active
          ? 'text-ink border-accent'
          : 'text-ink-secondary border-transparent hover:text-ink hover:bg-surface-muted/40'
      }`}
    >
      {children}
    </Link>
  );
}

/* ─── Recipient avatar (initials, color cycled) ──────────────── */
function RecipientAvatar({ name, index }: { name: string; index: number }) {
  const initials = name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  const palette = [
    { bg: '#DBEAFE', fg: '#1E40AF' },
    { bg: '#FED7AA', fg: '#92400E' },
    { bg: '#D1FAE5', fg: '#065F46' },
    { bg: '#FECDD3', fg: '#9F1239' },
    { bg: '#EDE9FE', fg: '#5B21B6' },
  ];
  const c = palette[index % palette.length]!;
  return (
    <span
      className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold flex-shrink-0"
      style={{ background: c.bg, color: c.fg }}
      aria-label={name}
    >
      {initials || '?'}
    </span>
  );
}

/* ─── Detail row (right rail) ────────────────────────────────── */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-tertiary">{label}</dt>
      <dd className="text-[12.5px] text-ink truncate">{value}</dd>
    </>
  );
}

/* ─── Audit certificate row ──────────────────────────────────── */
function CertRow({
  label, value, mono = false, wrap = false, className = '',
}: { label: string; value: string; mono?: boolean; wrap?: boolean; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-ink-tertiary text-[10px] uppercase tracking-[0.08em]">{label}</dt>
      <dd className={`mt-0.5 text-ink ${mono ? 'font-mono' : 'normal-case'} ${wrap ? 'break-words leading-snug whitespace-normal text-[12px] tracking-normal' : 'text-[12px] tracking-normal normal-case'}`}>
        {value}
      </dd>
    </div>
  );
}

/* ─── Audit-event sub-cells ──────────────────────────────────── */
function ActorFromEvent({ event }: { event: { actorName?: string | null; actorEmail?: string | null; data?: unknown } }) {
  return <>{event.actorName ?? event.actorEmail ?? extractRecipientFromData(event.data) ?? '—'}</>;
}
function IpFromEvent({ event }: { event: { ipAddress?: string | null } }) {
  return <>{event.ipAddress ?? '—'}</>;
}
function extractRecipientFromData(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.recipientEmail === 'string') return d.recipientEmail;
    if (typeof d.recipientName === 'string') return d.recipientName;
  }
  return null;
}

/* ─── Activity verb + icon mapping ──────────────────────────── */
function activityMeta(type: string): { verb: string; icon: React.ReactNode; tone: string; objectHint?: string } {
  const i = (cls: string, svg: React.ReactNode) => <span className={cls}>{svg}</span>;
  switch (type) {
    case 'envelope.created':           return { verb: 'created the envelope', icon: <FilePlusIcon />, tone: 'bg-status-sent-bg text-status-sent', objectHint: '' };
    case 'envelope.sent':              return { verb: 'sent the envelope to recipients', icon: <SendIconSm />, tone: 'bg-status-sent-bg text-status-sent' };
    case 'envelope.viewed_by_sender':  return { verb: 'opened the envelope', icon: <EyeIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'envelope.advanced':          return { verb: 'advanced to the next signer', icon: <ArrowRightIcon />, tone: 'bg-status-sent-bg text-status-sent' };
    case 'envelope.cloned':            return { verb: 'cloned this envelope', icon: <CopyIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'envelope.forwarded':         return { verb: 'forwarded the sealed PDF', icon: <SendIconSm />, tone: 'bg-status-sent-bg text-status-sent' };
    case 'envelope.share_viewed':      return { verb: 'opened the forwarded link', icon: <EyeIcon />, tone: 'bg-status-progress-bg text-status-progress' };
    case 'recipient.reassigned':       return { verb: 'reassigned to a new recipient', icon: <ArrowRightIcon />, tone: 'bg-status-sent-bg text-status-sent' };
    case 'envelope.completed':         return { verb: 'document completed', icon: <Check />, tone: 'bg-status-completed-bg text-status-completed' };
    case 'envelope.voided_by_sender':  return { verb: 'voided the document', icon: <X />, tone: 'bg-status-declined-bg text-status-declined' };
    case 'envelope.expired':           return { verb: 'envelope expired', icon: <ClockIcon />, tone: 'bg-surface-muted text-ink-tertiary' };
    case 'envelope.sealed':            return { verb: 'sealed the document', icon: <ShieldCheck />, tone: 'bg-status-completed-bg text-status-completed' };
    case 'envelope.downloaded':        return { verb: 'downloaded the sealed PDF', icon: <DownloadIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'envelope.verified':          return { verb: 'verified the audit chain', icon: <ShieldCheck />, tone: 'bg-status-completed-bg text-status-completed' };
    case 'envelope.field_added':       return { verb: 'placed a field', icon: <PenIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'envelope.field_removed':     return { verb: 'removed a field', icon: <X />, tone: 'bg-surface-muted text-ink-tertiary' };
    case 'envelope.field_updated':     return { verb: 'updated a field', icon: <PenIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'envelope.recipient_added':   return { verb: 'added a recipient', icon: <UserPlusIcon />, tone: 'bg-status-sent-bg text-status-sent' };
    case 'envelope.recipient_removed': return { verb: 'removed a recipient', icon: <X />, tone: 'bg-surface-muted text-ink-tertiary' };
    case 'envelope.recipient_updated': return { verb: 'updated a recipient', icon: <UserPlusIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'recipient.opened':           return { verb: 'viewed the document', icon: <EyeIcon />, tone: 'bg-status-progress-bg text-status-progress' };
    case 'recipient.skipped_by_condition': return { verb: 'was skipped by routing rule', icon: <MinusIcon />, tone: 'bg-status-voided-bg text-status-voided' };
    case 'recipient.consent_given':    return { verb: 'accepted the e-sign consent', icon: <Check />, tone: 'bg-status-completed-bg text-status-completed' };
    case 'recipient.field_filled':     return { verb: 'filled a field', icon: <PenIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'recipient.signed':           return { verb: 'signed the document', icon: <Check />, tone: 'bg-status-completed-bg text-status-completed' };
    case 'recipient.declined':         return { verb: 'declined to sign', icon: <X />, tone: 'bg-status-declined-bg text-status-declined' };
    case 'email.sent':                 return { verb: 'received the signing email', icon: <MailIcon />, tone: 'bg-surface-muted text-ink-secondary' };
    case 'email.failed':               return { verb: 'email delivery failed', icon: <AlertIcon />, tone: 'bg-status-declined-bg text-status-declined' };
    default:                           return { verb: type.replace(/[._]/g, ' '), icon: <DotIcon />, tone: 'bg-surface-muted text-ink-tertiary' };
  }
}

function recipientCertStatus(r: {
  signingStatus: string;
  sendStatus: string;
  sentAt: Date | null;
  openedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
}): { status: string; timestamp: Date | null } {
  if (r.signingStatus === 'SIGNED') return { status: 'SIGNED', timestamp: r.signedAt };
  if (r.signingStatus === 'DECLINED') return { status: 'DECLINED', timestamp: r.declinedAt };
  if (r.signingStatus === 'SKIPPED') return { status: 'SKIPPED', timestamp: null };
  if (r.openedAt) return { status: 'OPENED', timestamp: r.openedAt };
  if (r.sendStatus === 'BOUNCED' || r.sendStatus === 'FAILED') return { status: 'EMAIL FAILED', timestamp: r.sentAt };
  if (r.sentAt || r.sendStatus === 'SENT') return { status: 'SENT', timestamp: r.sentAt };
  return { status: 'PENDING', timestamp: null };
}

function certEventLabel(type: string): string {
  switch (type) {
    case 'recipient.opened':        return 'OPENED';
    case 'recipient.signed':        return 'SIGNED';
    case 'recipient.declined':      return 'DECLINED';
    case 'recipient.consent_given': return 'CONSENT';
    case 'recipient.field_filled':  return 'FILLED';
    case 'envelope.advanced':       return 'ADVANCED';
    case 'envelope.cloned':         return 'CLONED';
    case 'envelope.forwarded':      return 'FORWARDED';
    case 'envelope.share_viewed':   return 'SHARE OPENED';
    case 'recipient.reassigned':    return 'REASSIGNED';
    case 'recipient.skipped_by_condition': return 'SKIPPED';
    default:                        return type.replace(/[._]/g, ' ').toUpperCase();
  }
}

/* ─── Helpers ─────────────────────────────────────────────────── */
function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtTimestamp(d: Date): string {
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseReminderSettings(raw: unknown): { enabled: boolean } {
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const r = raw as Record<string, unknown>;
  const max = typeof r.maxReminders === 'number' ? r.maxReminders : 0;
  return { enabled: max > 0 };
}

/* ─── Icons ───────────────────────────────────────────────────── */
function ChevronLeft() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>); }
function DocIconSm() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>); }
function ActivityIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>); }
function FileIcon() { return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>); }
function BellIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>); }
function DownloadIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>); }
function MailIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>); }
function ShieldCheck({ className = '' }: { className?: string }) { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>); }
function SettingsIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>); }
function Check() { return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>); }
function X() { return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>); }
function EyeIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>); }
function MinusIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /></svg>); }
function CopyIcon() { return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>); }
function ClockIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>); }
function SendIconSm() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>); }
function AlertIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>); }
function ArrowRightIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>); }
function FilePlusIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>); }
function PenIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /></svg>); }
function UserPlusIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></svg>); }
function DotIcon() { return (<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="3" /></svg>); }
