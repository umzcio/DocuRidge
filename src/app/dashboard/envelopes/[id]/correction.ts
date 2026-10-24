import { z } from 'zod';

/**
 * Envelope correction (DocuSign-style) — pure guard + validation logic for
 * `correctEnvelopeAction`. Kept free of prisma/mail imports so vitest can
 * cover the whole state matrix without a database.
 */

/**
 * Roles that gate routing — the same set lifecycle.ts treats as actionable.
 * CC / VIEWER recipients observe but never hold a signing turn.
 */
export const ACTIONABLE_ROLES = ['SIGNER', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER'] as const;

export function isActionableRole(role: string): boolean {
  return (ACTIONABLE_ROLES as readonly string[]).includes(role);
}

/**
 * Whether the envelope page should offer "Retry sealing": every routing
 * recipient has signed or been skipped, the envelope is awaiting signature or
 * COMPLETED, and no sealed document exists. No `envelope.seal_failed` event
 * is required, because a crash mid-seal or a failed claim may leave none
 * (retryEnvelopeSealing is idempotent, so offering it while a completion is
 * still in flight is harmless).
 */
export function needsSealRetry(env: {
  type: string;
  status: string;
  hasSealedDocument: boolean;
  recipients: ReadonlyArray<{ recipientRole: string; signingStatus: string }>;
}): boolean {
  if (env.type !== 'DOCUMENT' || env.hasSealedDocument) return false;
  if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS' && env.status !== 'COMPLETED') return false;
  const routing = env.recipients.filter((r) => isActionableRole(r.recipientRole));
  return routing.length > 0 && routing.every((r) => r.signingStatus === 'SIGNED' || r.signingStatus === 'SKIPPED');
}

/**
 * Corrections are only allowed while the envelope is still awaiting
 * signature. COMPLETED / DECLINED / VOIDED / EXPIRED envelopes are frozen
 * records; DRAFTs are edited through the normal builder instead.
 */
export function canCorrectEnvelope(status: string): boolean {
  return status === 'SENT' || status === 'IN_PROGRESS';
}

export interface CorrectionRecipient {
  id: string;
  name: string;
  email: string;
  recipientRole: string;
  signingStatus: string;
}

/** Only recipients who haven't acted yet can be replaced or removed. */
export function canMutateRecipient(
  recipient: Pick<CorrectionRecipient, 'signingStatus'>,
): boolean {
  return recipient.signingStatus === 'NOT_SIGNED';
}

/**
 * Refuse a removal that would leave the envelope with no pending signer:
 * nothing would remain to trigger the advance/complete step, so the
 * envelope could never reach COMPLETED. Sequential routing is the case
 * called out in the plan, but parallel has the identical dead end, so the
 * guard applies to both. Recipients who already signed don't count — the
 * envelope still needs someone left to sign.
 */
export function canRemoveRecipient(args: {
  recipient: CorrectionRecipient;
  recipients: CorrectionRecipient[];
}): { ok: boolean; reason?: string } {
  if (!canMutateRecipient(args.recipient)) {
    return { ok: false, reason: 'Only recipients who have not signed yet can be removed.' };
  }
  const remaining = args.recipients.filter(
    (r) => r.id !== args.recipient.id && isActionableRole(r.recipientRole) && r.signingStatus === 'NOT_SIGNED',
  );
  if (remaining.length === 0) {
    return { ok: false, reason: 'Cannot remove the last remaining signer from this envelope.' };
  }
  return { ok: true };
}

/** Same shape the repo uses elsewhere for outbound email validation. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CORRECT_OPERATIONS = [
  'updateDetails',
  'addRecipient',
  'replaceRecipient',
  'removeRecipient',
] as const;
export type CorrectOperation = (typeof CORRECT_OPERATIONS)[number];

/**
 * One schema for every correction operation; `operation` discriminates which
 * fields are required (enforced in superRefine so the form can share it).
 */
export const CorrectEnvelopeSchema = z
  .object({
    envelopeId: z.string().min(1),
    operation: z.enum(CORRECT_OPERATIONS),
    recipientId: z.string().min(1).optional(),
    name: z.string().trim().max(200).optional(),
    email: z.string().trim().max(320).optional(),
    role: z.enum(['SIGNER', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER', 'CC', 'VIEWER']).optional(),
    message: z.string().trim().max(5000).optional(),
    expiration: z.string().max(10).optional(),
  })
  .superRefine((val, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [] });
    if (val.operation === 'addRecipient' || val.operation === 'replaceRecipient') {
      if (!val.name || val.name.length === 0) return issue('Name is required.');
      if (!val.email || !EMAIL_RE.test(val.email)) {
        return issue('A valid email address is required.');
      }
    }
    if (
      (val.operation === 'replaceRecipient' || val.operation === 'removeRecipient') &&
      !val.recipientId
    ) {
      issue('Recipient is required.');
    }
  });

export type CorrectEnvelopeInput = z.infer<typeof CorrectEnvelopeSchema>;

/**
 * Parse the expiration input from the date field. '' (or absent) clears the
 * expiration; 'YYYY-MM-DD' sets it to the end of that day (local time) so a
 * signer keeps the full final day. Anything else is rejected — a typo must
 * not silently shorten a contract's signing window.
 */
export function parseExpirationInput(
  raw: string | undefined,
): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) {
    return { ok: false, error: 'Enter the expiration as a date (YYYY-MM-DD) or leave it blank.' };
  }
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
  if (
    date.getFullYear() !== Number(y) ||
    date.getMonth() !== Number(mo) - 1 ||
    date.getDate() !== Number(d)
  ) {
    return { ok: false, error: 'That expiration date is not a real calendar date.' };
  }
  return { ok: true, value: date };
}
