'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth/session';
import { voidEnvelope } from '@/lib/envelopes/lifecycle';
import { childLogger } from '@/lib/logger';

export interface VoidActionState {
  ok: boolean;
  error?: string;
}

export async function voidEnvelopeAction(
  _prev: VoidActionState,
  formData: FormData,
): Promise<VoidActionState> {
  const log = childLogger({ action: 'envelope_void' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const parsed = z
    .object({
      envelopeId: z.string().min(1),
      reason: z.string().trim().min(1, 'Reason is required').max(1000),
    })
    .safeParse({
      envelopeId: formData.get('envelopeId'),
      reason: formData.get('reason'),
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid request.' };
  }

  try {
    await voidEnvelope({ ctx, envelopeId: parsed.data.envelopeId, reason: parsed.data.reason });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to void envelope';
    log.error({ err: message, envelopeId: parsed.data.envelopeId }, 'void failed');
    return { ok: false, error: message };
  }
  redirect(`/dashboard/envelopes/${parsed.data.envelopeId}`);
}
