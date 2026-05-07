'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { mintSigningToken } from '@/lib/signing/token';
import { childLogger } from '@/lib/logger';

export interface SignNowState {
  ok: boolean;
  error?: string;
}

/**
 * Mint a signing token for the current user and redirect into the ceremony.
 *
 * The current user must (a) belong to the envelope's org, (b) appear as a
 * recipient (matched on email), (c) still be NOT_SIGNED, and (d) be the
 * next-up signer when the envelope is sequential.
 */
export async function signNowAction(
  _prev: SignNowState,
  formData: FormData,
): Promise<SignNowState> {
  const log = childLogger({ action: 'sign_now' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const parsed = z.object({ envelopeId: z.string().min(1) }).safeParse({
    envelopeId: formData.get('envelopeId'),
  });
  if (!parsed.success) return { ok: false, error: 'Invalid request.' };
  const { envelopeId } = parsed.data;

  const env = await prisma.envelope.findFirst({
    where: { id: envelopeId, orgId: session.orgId, deletedAt: null },
    include: { recipients: { orderBy: { signingOrder: 'asc' } } },
  });
  if (!env) return { ok: false, error: 'Document not found.' };
  if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS') {
    return { ok: false, error: 'This document is not awaiting signature.' };
  }

  const userEmail = session.user.email.toLowerCase();
  const myRecipient = env.recipients.find(
    (r) => r.email.toLowerCase() === userEmail && r.recipientRole === 'SIGNER',
  );
  if (!myRecipient) return { ok: false, error: "You aren't a signer on this document." };
  if (myRecipient.signingStatus === 'SIGNED') return { ok: false, error: 'You already signed.' };
  if (myRecipient.signingStatus === 'DECLINED') return { ok: false, error: 'You already declined.' };

  // Sequential gate: if there's an earlier signer still pending, block.
  if (env.routingMode === 'SEQUENTIAL') {
    const earlierPending = env.recipients
      .filter((r) => r.recipientRole === 'SIGNER')
      .filter((r) => r.signingOrder < myRecipient.signingOrder)
      .some((r) => r.signingStatus === 'NOT_SIGNED');
    if (earlierPending) return { ok: false, error: "It isn't your turn yet." };
  }

  const minted = await mintSigningToken({
    envelopeId: env.id,
    recipientId: myRecipient.id,
  });
  // Clear any previously pinned JTI from a stale email link. The current
  // user is authenticated as this recipient (email match enforced above),
  // so issuing them a fresh single-use token is safe — recordRecipientOpened
  // will re-pin the new JTI on first open.
  await prisma.recipient.update({
    where: { id: myRecipient.id },
    data: { currentTokenExpiresAt: minted.expiresAt, tokenJti: null },
  });
  log.info({ envelopeId, recipientId: myRecipient.id }, 'in-app signing token minted');
  redirect(`/sign/${encodeURIComponent(minted.token)}`);
}
