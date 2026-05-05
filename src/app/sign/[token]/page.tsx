import { headers } from 'next/headers';
import { loadSigningSession, recordRecipientOpened } from '@/lib/envelopes/lifecycle';
import { captureClientContext } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { SigningCeremony } from './ceremony';

export const dynamic = 'force-dynamic';

export default async function SignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const session = await loadSigningSession(token);
  if (!session.ok) return <ErrorState reason={session.reason} />;

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
  const recipientFields = session.envelope.fields.filter(
    (f) => f.recipientId === session.recipient.id,
  );

  return (
    <div className="min-h-screen bg-neutral-100">
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
        }}
        fields={recipientFields.map((f) => ({
          id: f.id,
          type: f.type,
          page: f.page,
          required: f.required,
          defaultValue: f.defaultValue,
        }))}
        consentAlreadyGiven={!!session.recipient.consentGivenAt}
      />
    </div>
  );
}

function ErrorState({ reason }: { reason: string }) {
  const messages: Record<string, string> = {
    invalid: 'This signing link is invalid.',
    consumed: 'This signing link has already been used.',
    expired: 'This signing link has expired. Please contact the sender for a new one.',
    envelope_closed: 'This document is no longer awaiting your signature.',
    recipient_done: 'You have already signed or declined this document.',
    wrong_turn: 'It is not yet your turn to sign. You will be notified when the prior signers complete.',
  };
  const message = messages[reason] ?? 'This signing link cannot be used.';
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-neutral-100">
      <div className="max-w-md rounded-lg border border-neutral-200 bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Signing unavailable</h1>
        <p className="mt-2 text-sm text-neutral-700">{message}</p>
      </div>
    </div>
  );
}
