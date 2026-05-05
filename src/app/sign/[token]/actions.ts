'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import {
  loadSigningSession,
  recordConsent,
  completeRecipientSigning,
  declineEnvelope,
} from '@/lib/envelopes/lifecycle';
import { captureClientContext } from '@/lib/auth/session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';

const log = childLogger({ action: 'signing-ceremony' });

export interface SignActionState {
  ok: boolean;
  message?: string;
  error?: string;
  completed?: boolean;
}

export async function consentAction(
  _prev: SignActionState,
  formData: FormData,
): Promise<SignActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);
  const token = String(formData.get('token') ?? '');
  const session = await loadSigningSession(token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  await recordConsent({
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    ipAddress,
    userAgent,
    disclosureVersion: '2026-05-01-uet-esign-v1',
  });
  return { ok: true, message: 'Consent recorded.' };
}

const SubmitSchema = z.object({
  token: z.string().min(1),
  fieldValues: z.record(z.string()),
  signatureImagePngBase64: z.string().optional(),
  typedSignature: z.string().max(120).optional(),
});

export async function submitSigningAction(
  _prev: SignActionState,
  formData: FormData,
): Promise<SignActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  let parsed;
  try {
    parsed = SubmitSchema.parse({
      token: formData.get('token'),
      fieldValues: JSON.parse(String(formData.get('fieldValues') ?? '{}')),
      signatureImagePngBase64: stripDataUrl(formData.get('signatureImagePngBase64')),
      typedSignature: formData.get('typedSignature') || undefined,
    });
  } catch (err) {
    return { ok: false, error: 'Invalid submission.' };
  }

  const session = await loadSigningSession(parsed.token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };
  if (!session.recipient.consentGivenAt) {
    return { ok: false, error: 'Please give consent before signing.' };
  }

  try {
    const result = await completeRecipientSigning({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      ipAddress,
      userAgent,
      fieldValues: parsed.fieldValues,
      signatureImagePngBase64: parsed.signatureImagePngBase64,
      typedSignature: parsed.typedSignature,
    });
    log.info(
      { envelopeId: session.envelope.id, recipientId: session.recipient.id, status: result.envelopeStatus },
      'recipient signing completed',
    );
    return {
      ok: true,
      completed: result.envelopeStatus === 'COMPLETED',
      message:
        result.envelopeStatus === 'COMPLETED'
          ? 'Document complete. All parties have signed.'
          : 'Signed. Thank you.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err: msg }, 'sign submission failed');
    return { ok: false, error: msg };
  }
}

export async function declineAction(
  _prev: SignActionState,
  formData: FormData,
): Promise<SignActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);
  const token = String(formData.get('token') ?? '');
  const reason = String(formData.get('reason') ?? 'No reason given');

  const session = await loadSigningSession(token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };

  await declineEnvelope({
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    reason,
    ipAddress,
    userAgent,
  });
  return { ok: true, message: 'You have declined this document. The sender has been notified.' };
}

function stripDataUrl(v: FormDataEntryValue | null): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const m = v.match(/^data:image\/png;base64,(.+)$/);
  return m ? m[1] : v;
}
