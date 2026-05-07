'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import {
  loadSigningSession,
  recordConsent,
  completeRecipientSigning,
  declineEnvelope,
  reassignRecipient,
} from '@/lib/envelopes/lifecycle';
import { captureClientContext } from '@/lib/auth/session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';
import { prisma } from '@/lib/prisma';
import { saveRecipientAttachment, AttachmentValidationError } from '@/lib/storage';

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
  signatureFont: z.enum(['caveat', 'dancing', 'great-vibes', 'sacramento']).optional(),
  initialsImagePngBase64: z.string().optional(),
  typedInitials: z.string().max(20).optional(),
  initialsFont: z.enum(['caveat', 'dancing', 'great-vibes', 'sacramento']).optional(),
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
      signatureFont: formData.get('signatureFont') || undefined,
      initialsImagePngBase64: stripDataUrl(formData.get('initialsImagePngBase64')),
      typedInitials: formData.get('typedInitials') || undefined,
      initialsFont: formData.get('initialsFont') || undefined,
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
      signatureFont: parsed.signatureFont,
      initialsImagePngBase64: parsed.initialsImagePngBase64,
      typedInitials: parsed.typedInitials,
      initialsFont: parsed.initialsFont,
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

export interface AttachmentActionState {
  ok: boolean;
  error?: string;
  /** Server-trusted display info to render after a successful upload. */
  attachment?: { filename: string; sizeBytes: number; sha256: string };
  fieldId?: string;
}

/**
 * Upload a single recipient attachment file for one ATTACHMENT-typed field.
 * Auth: the signing token alone is enough — the recipient is acting as
 * themselves on a token they have. Rate-limited per-IP under the same
 * bucket as signing-token operations.
 */
export async function uploadAttachmentAction(
  _prev: AttachmentActionState,
  formData: FormData,
): Promise<AttachmentActionState> {
  const headerStore = await headers();
  const { ipAddress } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  const token = String(formData.get('token') ?? '');
  const fieldId = String(formData.get('fieldId') ?? '');
  const file = formData.get('file');
  if (!token || !fieldId) return { ok: false, error: 'Missing token or field.' };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'Pick a file to upload.' };
  }

  const session = await loadSigningSession(token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };

  // Field must (a) belong to this envelope, (b) be assigned to this
  // recipient, (c) actually be ATTACHMENT-typed.
  const field = session.envelope.fields.find((f) => f.id === fieldId);
  if (!field || field.recipientId !== session.recipient.id) {
    return { ok: false, error: 'Field not found.' };
  }
  if (field.type !== 'ATTACHMENT') {
    return { ok: false, error: 'Field does not accept uploads.' };
  }

  // Per-field MIME / size override (sender-configured in the builder).
  const meta = (field.meta && typeof field.meta === 'object' ? field.meta : {}) as {
    allowedMimes?: string[];
    maxAttachmentBytes?: number;
  };

  const buffer = Buffer.from(await file.arrayBuffer());
  let stored;
  try {
    stored = await saveRecipientAttachment({
      orgId: session.envelope.orgId,
      buffer,
      filename: file.name,
      declaredMime: file.type || 'application/octet-stream',
      allowedMimes: meta.allowedMimes,
      maxBytes: meta.maxAttachmentBytes,
    });
  } catch (err) {
    if (err instanceof AttachmentValidationError) {
      return { ok: false, error: err.message };
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed.' };
  }

  // Replace any prior attachment for this field — the @unique on fieldId
  // guarantees one row per field, so an upsert handles re-uploads.
  await prisma.fieldAttachment.upsert({
    where: { fieldId: field.id },
    update: {
      recipientId: session.recipient.id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storagePath: stored.relativePath,
      uploadedAt: new Date(),
    },
    create: {
      fieldId: field.id,
      recipientId: session.recipient.id,
      filename: stored.filename,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storagePath: stored.relativePath,
    },
  });

  log.info(
    { envelopeId: session.envelope.id, recipientId: session.recipient.id, fieldId, sha256: stored.sha256 },
    'recipient attachment uploaded',
  );

  return {
    ok: true,
    fieldId: field.id,
    attachment: {
      filename: stored.filename,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    },
  };
}

const CommentSchema = z.object({
  token: z.string().min(1),
  body: z.string().trim().min(1, 'Comment is required').max(4000),
});

export interface CommentActionState {
  ok: boolean;
  error?: string;
}

/**
 * Recipient posts a comment from inside the signing ceremony. Token-gated;
 * rate-limited per IP under the existing signing-token bucket. The comment
 * is recorded in the audit chain via the `comment.added` event.
 */
export async function addCommentRecipientAction(
  _prev: CommentActionState,
  formData: FormData,
): Promise<CommentActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);
  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  const parsed = CommentSchema.safeParse({
    token: formData.get('token'),
    body: formData.get('body'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const session = await loadSigningSession(parsed.data.token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };

  const { addComment } = await import('@/lib/comments/service');
  await addComment({
    envelopeId: session.envelope.id,
    body: parsed.data.body,
    authorRecipientId: session.recipient.id,
    authorName: session.recipient.name,
    authorEmail: session.recipient.email,
    ipAddress,
    userAgent,
  });
  return { ok: true };
}

const ReassignSchema = z.object({
  token: z.string().min(1),
  newEmail: z.string().trim().toLowerCase().email('Enter a valid email address'),
  newName: z.string().trim().min(1, 'Name is required').max(120),
  reason: z.string().trim().max(500).optional(),
});

export interface ReassignActionState {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * Recipient delegates the signing to a different email. Updates the
 * existing recipient row in place + dispatches a fresh invite to the new
 * address. The original email is preserved in the audit chain via the
 * `recipient.reassigned` event so the trail isn't lost.
 */
export async function reassignAction(
  _prev: ReassignActionState,
  formData: FormData,
): Promise<ReassignActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  let parsed;
  try {
    parsed = ReassignSchema.parse({
      token: formData.get('token'),
      newEmail: formData.get('newEmail'),
      newName: formData.get('newName'),
      reason: formData.get('reason') || undefined,
    });
  } catch (err) {
    const issue = err instanceof z.ZodError ? err.errors[0]?.message : 'Invalid input.';
    return { ok: false, error: issue ?? 'Invalid input.' };
  }

  const session = await loadSigningSession(parsed.token);
  if (!session.ok) return { ok: false, error: 'Signing session is no longer valid.' };

  // Refuse self-reassignment — silly but defensible.
  if (parsed.newEmail === session.recipient.email.toLowerCase()) {
    return { ok: false, error: 'Pick a different email — that is your own.' };
  }

  // Allowlist gate when MAIL_BACKEND=smtp_relay. Mirrors the forward action's
  // pattern so the user gets a clear error rather than silent drop.
  const { isAllowedRecipient } = await import('@/lib/mail');
  if (!isAllowedRecipient(parsed.newEmail)) {
    return { ok: false, error: `Email allowlist refused "${parsed.newEmail}". Contact your admin.` };
  }

  try {
    await reassignRecipient({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      newEmail: parsed.newEmail,
      newName: parsed.newName,
      reason: parsed.reason,
      ipAddress,
      userAgent,
    });
    log.info(
      { envelopeId: session.envelope.id, recipientId: session.recipient.id, toEmail: parsed.newEmail },
      'recipient reassigned',
    );
    return { ok: true, message: `Forwarded to ${parsed.newName} <${parsed.newEmail}>.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reassign.';
    log.error({ err: msg }, 'reassign failed');
    return { ok: false, error: msg };
  }
}
