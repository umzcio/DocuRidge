import Link from 'next/link';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { recordEnvelopeEvent } from '@/lib/audit/envelope';
import { captureClientContext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Public read-only viewer for a forwarded envelope. Anyone with the share
 * token can land here without dashboard auth — the URL itself is the
 * capability. Token is checked for existence + expiration + revocation;
 * if any fails the page shows a clean error state and never reveals
 * envelope contents. View counter increments on every successful render
 * so the sender can see whether their forward landed.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const share = await prisma.envelopeShare.findUnique({
    where: { token },
    include: {
      envelope: {
        select: {
          id: true,
          title: true,
          completedAt: true,
          status: true,
          createdBy: { select: { name: true, email: true } },
        },
      },
      createdBy: { select: { name: true } },
    },
  });

  if (!share) return <ShareError reason="invalid" />;
  if (share.revokedAt) return <ShareError reason="revoked" />;
  if (share.expiresAt.getTime() < Date.now()) return <ShareError reason="expired" />;
  if (share.envelope.status !== 'COMPLETED') return <ShareError reason="not_completed" />;

  // Increment view count + record an audit event. Best-effort — failure
  // here doesn't block rendering the document.
  await prisma.envelopeShare.update({
    where: { id: share.id },
    data: { lastViewedAt: new Date(), viewCount: { increment: 1 } },
  }).catch(() => null);
  await recordEnvelopeEvent({
    envelopeId: share.envelope.id,
    type: 'envelope.share_viewed',
    ipAddress,
    userAgent,
    data: { shareId: share.id, viewCount: share.viewCount + 1 },
  }).catch(() => null);

  const sender = share.envelope.createdBy;
  const completedAt = share.envelope.completedAt;
  const downloadUrl = `/share/${encodeURIComponent(token)}/download`;

  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-6 py-10">
      <div className="w-full max-w-xl rounded-lg border border-hairline bg-surface p-7 shadow-[0_4px_16px_rgba(15,17,21,0.06)]">
        <span className="inline-flex items-center gap-1.5 text-[10.5px] font-mono uppercase tracking-[0.06em] text-status-completed border border-status-completed-border bg-status-completed-bg/60 rounded-full px-2 py-0.5">
          <CheckIcon /> Sealed · Ed25519 audit
        </span>
        <h1 className="mt-4 text-[22px] font-semibold tracking-[-0.018em] text-ink leading-tight">
          {share.envelope.title}
        </h1>
        <p className="mt-2 text-[13.5px] text-ink-secondary">
          <strong>{share.createdBy.name}</strong> shared this signed document with you.
          {sender?.name && sender.name !== share.createdBy.name && (
            <> Originally sent by <strong>{sender.name}</strong>.</>
          )}
        </p>
        {share.note && (
          <div className="mt-4 rounded-md border border-hairline bg-surface-muted/40 p-3.5">
            <p className="text-[11px] font-mono uppercase tracking-[0.06em] text-ink-tertiary mb-1">Note</p>
            <p className="text-[13px] text-ink whitespace-pre-line">{share.note}</p>
          </div>
        )}
        <dl className="mt-5 grid grid-cols-2 gap-3 text-[12.5px]">
          <div>
            <dt className="text-ink-tertiary">Completed</dt>
            <dd className="text-ink">{completedAt ? completedAt.toUTCString() : '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-tertiary">Link expires</dt>
            <dd className="text-ink">{share.expiresAt.toUTCString()}</dd>
          </div>
        </dl>
        <a
          href={downloadUrl}
          className="mt-7 inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-accent px-5 text-[13.5px] font-medium text-white border border-accent-deep hover:bg-accent-deep transition-colors"
        >
          <DownloadIcon /> Download sealed PDF
        </a>
        <p className="mt-5 text-[11.5px] text-ink-tertiary leading-snug">
          You're viewing this document via a forwarded share link. Every view is recorded
          in the document's tamper-evident audit chain.
        </p>
      </div>
    </div>
  );
}

function ShareError({ reason }: { reason: 'invalid' | 'expired' | 'revoked' | 'not_completed' }) {
  const messages: Record<string, string> = {
    invalid: 'This link is not valid.',
    expired: 'This share link has expired. Ask the sender for a new one.',
    revoked: 'This share link has been revoked by the sender.',
    not_completed: 'The document this link points to is no longer available.',
  };
  return (
    <div className="min-h-screen bg-page flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-hairline bg-surface p-6 text-center shadow-[0_4px_16px_rgba(15,17,21,0.06)]">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-status-progress-bg text-status-progress">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
        </span>
        <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.012em] text-ink">Link unavailable</h1>
        <p className="mt-2 text-[13.5px] text-ink-secondary">{messages[reason]}</p>
        <Link
          href="/login"
          className="mt-5 inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-hairline bg-surface px-4 text-[13px] font-medium text-ink hover:bg-surface-muted/60"
        >
          Sign in to DocuRidge
        </Link>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>);
}
function DownloadIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>);
}
