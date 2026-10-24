import Link from 'next/link';
import { headers } from 'next/headers';
import { recordRecipientOpened } from '@/lib/envelopes/lifecycle';
import { loadGatedSigningSession } from '@/lib/signing/session-gate';
import { captureClientContext, getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { accountDefaultsForRecipient } from '@/lib/signing/account-defaults';
import { SigningCeremony } from './ceremony';
import { AccessCodeGate } from './access-code-gate';

export const dynamic = 'force-dynamic';

export default async function SignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const session = await loadGatedSigningSession(token);
  if (!session.ok) {
    // A code-protected recipient without a valid unlock proof gets the code
    // form and nothing else: no title, sender, message, comments or fields
    // reach the RSC payload until the code is proven server-side.
    if (session.reason === 'access_code_required') return <AccessCodeGate token={token} />;
    return <ErrorState reason={session.reason} />;
  }

  // Mark opened (idempotent — pins the jti on first call).
  await recordRecipientOpened({
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    jti: session.jti,
    ipAddress,
    userAgent,
  });

  const sender = await prisma.user.findUnique({
    where: { id: session.envelope.createdById },
  });
  const dashSession = await getSession();
  const comments = await prisma.envelopeComment.findMany({
    where: { envelopeId: session.envelope.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, authorName: true, authorUserId: true, body: true, createdAt: true },
  });
  // When the recipient is signed in as themselves, pre-fill JOB_TITLE /
  // PHONE / ADDRESS / COMPANY and their saved marks. The recipient can still
  // edit any of these before signing.
  const accountDefaults = accountDefaultsForRecipient(dashSession, session.recipient.email);
  const recipientFields = session.envelope.fields.filter(
    (f) => f.recipientId === session.recipient.id,
  );

  return (
    <div className="min-h-screen bg-background">
      <SigningCeremony
        token={token}
        envelopeTitle={session.envelope.title}
        senderName={sender?.name ?? 'A DocuRidge sender'}
        senderEmail={sender?.email ?? ''}
        message={session.envelope.message}
        recipient={{
          id: session.recipient.id,
          name: session.recipient.name,
          email: session.recipient.email,
          role: session.recipient.recipientRole,
          jobTitle: accountDefaults?.jobTitle ?? null,
          phone: accountDefaults?.phone ?? null,
          address: accountDefaults?.address ?? null,
          company: accountDefaults?.company ?? null,
        }}
        defaultSignature={accountDefaults?.signature ?? null}
        defaultInitials={accountDefaults?.initials ?? null}
        fields={recipientFields.map((f) => {
          const m = (f.meta && typeof f.meta === 'object' ? f.meta : {}) as {
            readOnly?: boolean; charLimit?: number; pattern?: string;
            patternMessage?: string; min?: number; max?: number;
            options?: string[];
            formula?: string;
            noteText?: string;
            stampImageBase64?: string; stampMimeType?: string;
            condition?: { whenFieldId: string; equals: string };
          };
          return {
            id: f.id,
            type: f.type,
            page: f.page,
            required: f.required,
            defaultValue: f.defaultValue,
            x: Number(f.x),
            y: Number(f.y),
            w: Number(f.w),
            h: Number(f.h),
            readOnly: m.readOnly,
            charLimit: m.charLimit,
            pattern: m.pattern,
            patternMessage: m.patternMessage,
            min: m.min,
            max: m.max,
            options: Array.isArray(m.options) ? m.options : undefined,
            formula: m.formula,
            noteText: m.noteText,
            stampImageBase64: m.stampImageBase64,
            stampMimeType: m.stampMimeType,
            condition: m.condition,
            attachment: f.attachment
              ? { filename: f.attachment.filename, sizeBytes: f.attachment.sizeBytes, sha256: f.attachment.sha256 }
              : null,
          };
        })}
        consentAlreadyGiven={!!session.recipient.consentGivenAt}
        isSignedIn={!!dashSession}
        comments={comments.map((c) => ({
          id: c.id,
          authorName: c.authorName,
          isSender: !!c.authorUserId,
          isOwnPost: !c.authorUserId,
          body: c.body,
          createdAt: c.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}

async function ErrorState({ reason }: { reason: string }) {
  const messages: Record<string, string> = {
    invalid: 'This signing link is invalid.',
    consumed: 'This signing link has already been used.',
    expired: 'This signing link has expired. Please contact the sender for a new one.',
    envelope_closed: 'This document is no longer awaiting your signature.',
    recipient_done: 'You have already signed or declined this document.',
    wrong_turn: 'It is not yet your turn to sign. You will be notified when the prior signers complete.',
  };
  const message = messages[reason] ?? 'This signing link cannot be used.';
  // If the visitor is signed into the dashboard, give them a way back to
  // their queue / dashboard. Otherwise just show the message.
  const session = await getSession();
  const isSignedIn = !!session;
  const isReused = reason === 'consumed' || reason === 'recipient_done';
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-[0_4px_16px_rgba(15,17,21,0.06)]">
        <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${isReused ? 'bg-success-bg text-success' : 'bg-status-progress-bg text-status-progress'}`}>
          {isReused ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
        </span>
        <h1 className="mt-4 text-[18px] font-semibold tracking-[-0.012em] text-foreground">
          {isReused ? 'Already signed' : 'Signing unavailable'}
        </h1>
        <p className="mt-2 text-[13.5px] text-muted-foreground">{message}</p>

        <div className="mt-6 flex flex-col gap-2">
          {isSignedIn ? (
            <>
              <Link
                href="/dashboard/inbox"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors"
              >
                Go to my inbox
              </Link>
              <Link
                href="/dashboard"
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-border bg-card px-4 text-[13px] font-medium text-foreground hover:bg-muted/60 transition-colors"
              >
                Back to dashboard
              </Link>
            </>
          ) : (
            <Link
              href="/login"
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-medium text-white border border-primary-deep hover:bg-primary-deep transition-colors"
            >
              Sign in to DocuRidge
            </Link>
          )}
          <p className="text-[12px] text-faint mt-1">
            Need help? Contact the sender of this document.
          </p>
        </div>
      </div>
    </div>
  );
}
