'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { instantiateTemplate } from '@/lib/templates/service';
import { sendEnvelope, mintFreshTokenForRecipient } from '@/lib/envelopes/lifecycle';
import { isAllowedRecipient } from '@/lib/mail';
import { captureClientContext } from '@/lib/auth/session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';

const log = childLogger({ action: 'public_form_submit' });

export interface PublicFormSubmitState {
  ok: boolean;
  error?: string;
}

const SubmitSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
});

/**
 * Handle a public-form submission. Validates the visitor's name/email,
 * verifies the public-form token resolves to an active template, then
 * instantiates a new envelope with the visitor as the single signer
 * recipient and redirects them straight into the signing ceremony.
 *
 * Auth is the token in the URL — anyone with the link can fill the form,
 * which is the entire point. Rate-limited per IP under the existing
 * signing-token bucket so a public URL can't be hammered.
 */
export async function submitPublicFormAction(
  _prev: PublicFormSubmitState,
  formData: FormData,
): Promise<PublicFormSubmitState> {
  const headerStore = await headers();
  const { ipAddress } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again in a moment.' };

  const parsed = SubmitSchema.safeParse({
    token: formData.get('token'),
    name: formData.get('name'),
    email: formData.get('email'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  // Resolve the token to a template + verify it's still enabled.
  const template = await prisma.envelope.findUnique({
    where: { publicFormToken: parsed.data.token },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      org: true,
      createdBy: true,
    },
  });
  if (!template || !template.publicFormEnabled || template.type !== 'TEMPLATE' || template.deletedAt) {
    return { ok: false, error: 'This form is no longer available.' };
  }

  const signers = template.recipients.filter(
    (r) => r.recipientRole === 'SIGNER' || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER',
  );
  if (signers.length !== 1) {
    return { ok: false, error: 'This form is not configured correctly. Contact the sender.' };
  }
  if (!isAllowedRecipient(parsed.data.email)) {
    return { ok: false, error: 'This email is not currently accepted by the form. Contact the sender.' };
  }

  // Spin up the envelope from the template using the existing service helper.
  // The visitor inherits the createdBy of the template — they're acting
  // *through* the template owner; ownership of the resulting envelope stays
  // with the original template author.
  const ctx = {
    userId: template.createdById,
    orgId: template.orgId,
    role: 'SENDER' as const,
  };
  const targetRole = signers[0]!;

  let envelopeId: string;
  let signingToken: string;
  try {
    const created = await instantiateTemplate({
      ctx,
      templateId: template.id,
      roleMappings: { [targetRole.id]: { name: parsed.data.name, email: parsed.data.email } },
    });
    envelopeId = created.envelopeId;
    await sendEnvelope({ ctx, envelopeId });
    // After send, the recipient row has a tokenJti assigned. To redirect the
    // visitor straight into the signing ceremony (no email round-trip), we
    // need a fresh single-use token for them.
    const recipient = await prisma.recipient.findFirst({
      where: { envelopeId, email: parsed.data.email },
      select: { id: true },
    });
    if (!recipient) throw new Error('Recipient row missing after send');
    const minted = await mintFreshTokenForRecipient({
      envelopeId,
      recipientId: recipient.id,
    });
    signingToken = minted.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to start signing.';
    log.error({ err: msg, templateId: template.id }, 'public form submit failed');
    return { ok: false, error: msg };
  }

  log.info({ templateId: template.id, envelopeId, visitorEmail: parsed.data.email }, 'public form envelope created');
  redirect(`/sign/${encodeURIComponent(signingToken)}`);
}
