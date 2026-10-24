'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import {
  recordConsent,
  attachRecipientFile,
  completeRecipientSigning,
  declineEnvelope,
  reassignRecipient,
  RecipientChangedError,
} from '@/lib/envelopes/lifecycle';
import { captureClientContext, getSession } from '@/lib/auth/session';
import { childLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/ratelimit';
import { stageRecipientAttachment, AttachmentValidationError } from '@/lib/storage';
import { checkSignatureImage, checkEmbeddableImage } from '@/lib/signing/signature-image';
import {
  loadGatedSigningSession,
  unlockSigningSession,
  type SigningSessionFailureReason,
} from '@/lib/signing/session-gate';
import { isStorableText, UNSUPPORTED_TEXT_MESSAGE } from '@/lib/storable-text';

const log = childLogger({ action: 'signing-ceremony' });

/** Every token-consuming action goes through `loadGatedSigningSession`, which
 *  also refuses a code-protected recipient until the code is proven. */
function sessionError(reason: SigningSessionFailureReason): string {
  return reason === 'access_code_required'
    ? 'Enter the access code to continue.'
    : 'Signing session is no longer valid.';
}

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
  const session = await loadGatedSigningSession(token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  const consented = await recordConsent({
    envelopeId: session.envelope.id,
    recipientId: session.recipient.id,
    jti: session.jti,
    ipAddress,
    userAgent,
    disclosureVersion: '2026-05-01-uet-esign-v1',
  });
  if (!consented) return { ok: false, error: 'Signing session is no longer valid.' };
  return { ok: true, message: 'Consent recorded.' };
}

const AccessCodeSchema = z.object({
  token: z.string().min(1),
  code: z.string().trim().min(1, 'Enter the access code.').max(64),
});

export interface AccessCodeActionState {
  ok: boolean;
  error?: string;
}

/** Generic error whether the code is wrong or the recipient has none —
 *  the gate must not reveal whether an access code is configured. */
const ACCESS_CODE_WRONG_ERROR = 'Incorrect access code. Check with the sender and try again.';

/**
 * Verify the per-recipient access code and, on success, set the unlock-proof
 * cookie (`dr_access_<recipientId>`). The proof is minted and later checked
 * server-side by `@/lib/signing/session-gate`: it is bound to the envelope,
 * the recipient and the jti of the current signing token, so it cannot
 * unlock another recipient and dies with any re-mint or reassign.
 *
 * Throttling is layered: the per-IP `signing_token` bucket gates every
 * request, and the gate keeps a durable per-recipient failure count that
 * locks the recipient after ACCESS_CODE_MAX_ATTEMPTS wrong codes from any
 * number of addresses (see `@/lib/access-code-lockout`).
 */
export async function verifyRecipientAccessCodeAction(
  _prev: AccessCodeActionState,
  formData: FormData,
): Promise<AccessCodeActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'signing_token');
  if (!rl.allowed) return { ok: false, error: 'Too many requests. Try again shortly.' };

  const parsed = AccessCodeSchema.safeParse({
    token: formData.get('token'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const result = await unlockSigningSession({ token: parsed.data.token, code: parsed.data.code, ipAddress, userAgent });
  if (result.ok) return { ok: true };
  if (result.reason === 'invalid_session') return { ok: false, error: 'Signing session is no longer valid.' };
  if (result.reason === 'locked') {
    return {
      ok: false,
      error: 'Too many incorrect attempts. Access to this document is paused; try again later or contact the sender.',
    };
  }
  return { ok: false, error: ACCESS_CODE_WRONG_ERROR };
}

const SubmitSchema = z.object({
  token: z.string().min(1),
  fieldValues: z.record(z.string()),
  signatureImagePngBase64: z.string()
    .refine((v) => checkSignatureImage(v).ok,
      (v) => ({ message: checkSignatureImage(v).message ?? 'Invalid signature image.' }))
    .optional(),
  typedSignature: z.string().max(120).refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE).optional(),
  signatureFont: z.enum(['caveat', 'dancing', 'great-vibes', 'sacramento']).optional(),
  initialsImagePngBase64: z.string()
    .refine((v) => checkSignatureImage(v).ok,
      (v) => ({ message: checkSignatureImage(v).message ?? 'Invalid signature image.' }))
    .optional(),
  typedInitials: z.string().max(20).refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE).optional(),
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
    const issue = err instanceof z.ZodError ? err.errors[0]?.message : undefined;
    return { ok: false, error: issue ?? 'Invalid submission.' };
  }

  const session = await loadGatedSigningSession(parsed.token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };
  if (!session.recipient.consentGivenAt) {
    return { ok: false, error: 'Please give consent before signing.' };
  }

  // DRAWING values ride in the untyped `fieldValues` record, so per-field
  // validation can only happen here, once `session.envelope.fields` gives us
  // each field's type. The sealer only ever calls `embedPng` for DRAWING (the
  // ceremony always exports PNG), so only PNG is accepted here — accepting
  // JPEG would parse fine and then seal as a blank box.
  for (const [fieldId, rawValue] of Object.entries(parsed.fieldValues)) {
    const field = session.envelope.fields.find((f) => f.id === fieldId);
    if (!field || field.type !== 'DRAWING') continue;
    if (!rawValue) continue;

    const payload = stripDrawingDataUrl(rawValue);
    if (payload === undefined) {
      return { ok: false, error: 'Drawing on one field could not be read: unsupported image format.' };
    }

    const check = checkEmbeddableImage(payload, ['png']);
    if (!check.ok) {
      return { ok: false, error: `Drawing on one field could not be read: ${check.message}` };
    }
  }

  const dashSession = await getSession();

  try {
    const result = await completeRecipientSigning({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      jti: session.jti,
      sessionUserId: dashSession?.user.id ?? null,
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
      {
        envelopeId: session.envelope.id,
        recipientId: session.recipient.id,
        status: result.envelopeStatus,
        sealFailed: result.sealFailed ?? false,
      },
      'recipient signing completed',
    );
    // A seal failure happens after this signer's signature committed: it is
    // recorded for the sender, and the signer is told what that means for them.
    const message = result.sealFailed
      ? result.envelopeStatus === 'COMPLETED'
        ? 'Signed. All parties have signed, but the final signed copy is not ready yet. The sender has been notified, and you will receive it by email once it is.'
        : 'Signed. Your signature has been recorded, but the final document could not be produced yet. The sender has been notified.'
      : result.envelopeStatus === 'COMPLETED'
        ? 'Document complete. All parties have signed.'
        : 'Signed. Thank you.';
    return { ok: true, completed: result.envelopeStatus === 'COMPLETED', message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    log.error({ err: msg }, 'sign submission failed');
    return { ok: false, error: msg };
  }
}

const DeclineSchema = z.object({
  token: z.string(),
  reason: z.string().trim().max(2000, 'Reason is too long.')
    .refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE).optional(),
});

export async function declineAction(
  _prev: SignActionState,
  formData: FormData,
): Promise<SignActionState> {
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);
  const parsed = DeclineSchema.safeParse({
    token: formData.get('token') ?? '',
    reason: formData.get('reason') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const session = await loadGatedSigningSession(parsed.data.token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };

  try {
    await declineEnvelope({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      jti: session.jti,
      reason: parsed.data.reason || 'No reason given',
      ipAddress,
      userAgent,
    });
  } catch (err) {
    if (err instanceof RecipientChangedError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, message: 'You have declined this document. The sender has been notified.' };
}

/**
 * Accept either a bare base64 payload or a `data:image/png;base64,` URL.
 * A `data:` prefix that isn't PNG base64 is rejected outright rather than
 * passed through — previously any non-matching string was forwarded verbatim,
 * which is how unvalidated junk reached the database.
 */
function stripDataUrl(v: FormDataEntryValue | null): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (v.startsWith('data:')) {
    const m = v.match(/^data:image\/png;base64,(.+)$/);
    return m ? m[1] : undefined;
  }
  return v;
}

/**
 * Same tightened shape as `stripDataUrl` above, but for DRAWING field values:
 * accepts a bare base64 payload, or a `data:image/png;base64,` /
 * `data:image/jpeg;base64,` prefix. A `data:` prefix matching neither is a
 * rejection, not a pass-through. The byte-format decision (PNG only) is left
 * to `checkEmbeddableImage`, not this parser.
 */
function stripDrawingDataUrl(v: string): string | undefined {
  if (v.startsWith('data:')) {
    const m = v.match(/^data:image\/(?:png|jpeg);base64,(.+)$/);
    return m ? m[1] : undefined;
  }
  return v;
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

  const session = await loadGatedSigningSession(token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };

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
    stored = await stageRecipientAttachment({
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

  // The upload took a while since the session check: record it only if this
  // link still holds the recipient and the envelope is still open (compare-
  // and-set), replacing any earlier upload for the field. Otherwise the
  // staged file is discarded and nothing is recorded.
  let recorded: boolean;
  try {
    recorded = await attachRecipientFile({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      jti: session.jti,
      fieldId: field.id,
      file: stored,
    });
  } finally {
    await stored.discard();
  }
  if (!recorded) {
    return {
      ok: false,
      error: 'This signing link is no longer valid: the document was already signed, declined or reassigned. Reload the page to see its current status.',
    };
  }

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
  body: z.string().trim().min(1, 'Comment is required').max(4000)
    .refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE),
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

  const session = await loadGatedSigningSession(parsed.data.token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };

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
  newName: z.string().trim().min(1, 'Name is required').max(120)
    .refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE),
  reason: z.string().trim().max(500).refine(isStorableText, UNSUPPORTED_TEXT_MESSAGE).optional(),
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

  const session = await loadGatedSigningSession(parsed.token);
  if (!session.ok) return { ok: false, error: sessionError(session.reason) };

  // Refuse self-reassignment — silly but defensible.
  if (parsed.newEmail === session.recipient.email.toLowerCase()) {
    return { ok: false, error: 'Pick a different email — that is your own.' };
  }

  // Allowlist gate — enforced only when MAIL_BACKEND=smtp_relay. Mirrors the
  // forward action's pattern so the user gets a clear error rather than a
  // silent drop.
  const { mayMailRecipient } = await import('@/lib/mail');
  if (!mayMailRecipient(parsed.newEmail)) {
    return { ok: false, error: `Email allowlist refused "${parsed.newEmail}". Contact your admin.` };
  }

  try {
    await reassignRecipient({
      envelopeId: session.envelope.id,
      recipientId: session.recipient.id,
      jti: session.jti,
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
