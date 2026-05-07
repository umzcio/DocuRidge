'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getSession, captureClientContext } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { addComment } from '@/lib/comments/service';

export interface CommentActionState {
  ok: boolean;
  error?: string;
}

const Schema = z.object({
  envelopeId: z.string().min(1),
  body: z.string().trim().min(1, 'Comment is required').max(4000),
});

/**
 * Sender posts a comment from the envelope detail page. Authorized via
 * dashboard session; the envelope must belong to the caller's org.
 */
export async function addCommentSenderAction(
  _prev: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const parsed = Schema.safeParse({
    envelopeId: formData.get('envelopeId'),
    body: formData.get('body'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const env = await prisma.envelope.findFirst({
    where: { id: parsed.data.envelopeId, orgId: session.orgId, deletedAt: null },
    select: { id: true },
  });
  if (!env) return { ok: false, error: 'Envelope not found.' };

  await addComment({
    envelopeId: env.id,
    body: parsed.data.body,
    authorUserId: session.user.id,
    authorName: session.user.name,
    authorEmail: session.user.email,
    ipAddress,
    userAgent,
  });
  revalidatePath(`/dashboard/envelopes/${env.id}`);
  return { ok: true };
}
