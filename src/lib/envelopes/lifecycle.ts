import { Prisma, type EnvelopeStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { authorize, type AuthnContext } from '../authz/can';
import { mintSigningToken, verifySigningToken, type MintedSigningToken } from '../signing/token';
import {
  commitWithEnvelopeEvents,
  lockEnvelopeChain,
  publishEnvelopeEvents,
  recordEnvelopeEvent,
  type AppendedEnvelopeEvent,
  type RecordEnvelopeEventArgs,
} from '../audit/envelope';
import { evaluateFormula, formatFormulaValue } from '../formula/eval';
import { sendMail } from '../mail';
import { envelopeSentTemplate, envelopeCompletedTemplate, envelopeReminderTemplate } from '../email/templates';
import { getEnv } from '../env';
import { childLogger } from '../logger';
import {
  buildSealedEnvelope,
  persistSealedEnvelope,
  type SealedBuild,
  type SealedRecipient,
  type SealPersistOutcome,
} from '../pdf/seal';
import { PdfComplexityError } from '../pdf/seal-limits';
import { PdfDecodeLimitError } from '../pdf/decode-limits';
import { assertEnvelopeItemsSealable } from '../pdf/envelope-seal-check';
import { MAX_FIELD_VALUE_LENGTH } from '../fields/pattern';
import { testFieldPattern } from '../fields/pattern-server';

const log = childLogger({ module: 'envelope-lifecycle' });

/**
 * A recipient changed between a request's checks and its write: it signed,
 * declined, was reassigned or removed by a concurrent request. The losing
 * transaction is rolled back; the message is safe to show to the user.
 */
export class RecipientChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientChangedError';
  }
}

const RECIPIENT_CHANGED_MESSAGE =
  'This recipient has already signed or was changed by someone else. Reload to see the current state.';

const LINK_NO_LONGER_VALID_MESSAGE =
  'This signing link is no longer valid: the document was already signed, declined or reassigned. Reload the page to see its current status.';

const ENVELOPE_CLOSED_MESSAGE =
  'This document is no longer awaiting signature: it was completed, declined, voided or expired meanwhile. Reload the page to see its current status.';

/**
 * The only statuses in which a signature, decline or completion may commit.
 * Each of those transitions re-checks this inside its transaction with a
 * conditional write on the envelope row, so the row lock serialises them
 * with each other and with void and expiry: whichever commits first wins,
 * and the others match nothing and roll back.
 */
const AWAITING_SIGNATURE: EnvelopeStatus[] = ['SENT', 'IN_PROGRESS'];

/**
 * Transition a draft envelope into SENT, mint signing tokens for each
 * recipient, and dispatch the "your turn" email to whoever is up first.
 *
 *   - SEQUENTIAL routing: only the recipient with the lowest signingOrder
 *     gets emailed initially. advanceEnvelope() handles handoff after each
 *     recipient signs.
 *   - PARALLEL routing: every SIGNER recipient is emailed at once.
 */
export async function sendEnvelope(args: {
  ctx: AuthnContext;
  envelopeId: string;
}): Promise<void> {
  const env = await prisma.envelope.findFirst({
    where: { id: args.envelopeId, orgId: args.ctx.orgId, deletedAt: null },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
      items: { include: { documentFile: { select: { storagePath: true } } }, orderBy: { order: 'asc' } },
      meta: true,
    },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:send', { orgId: env.orgId, createdById: env.createdById });
  if (env.status !== 'DRAFT') {
    throw new Error('Envelope must be in DRAFT to send');
  }
  if (isPastDeadline(env.expiresAt)) throw new Error('Envelope has expired');
  if (env.items.length === 0) throw new Error('Envelope has no documents');
  if (env.recipients.length === 0) throw new Error('Envelope has no recipients');
  // SIGNERs, WITNESSes, and IN_PERSON_SIGNERs all fill signature fields.
  // APPROVERs gate routing without filling fields. Require at least one
  // actionable recipient and required fields when any field-filler exists.
  type ActionableRole = 'SIGNER' | 'APPROVER' | 'WITNESS' | 'IN_PERSON_SIGNER';
  const isActionable = (role: string): role is ActionableRole =>
    role === 'SIGNER' || role === 'APPROVER' || role === 'WITNESS' || role === 'IN_PERSON_SIGNER';
  const isFieldFiller = (role: string) =>
    role === 'SIGNER' || role === 'WITNESS' || role === 'IN_PERSON_SIGNER';
  const actionableRecipients = env.recipients.filter((r) => isActionable(r.recipientRole));
  if (actionableRecipients.length === 0) {
    throw new Error('Envelope has no signer, witness, or approver recipients');
  }
  const hasFieldFiller = env.recipients.some((r) => isFieldFiller(r.recipientRole));
  if (hasFieldFiller && env.fields.filter((f) => f.required).length === 0) {
    throw new Error('Envelope has no required fields');
  }
  for (const r of env.recipients.filter((rec) => isFieldFiller(rec.recipientRole))) {
    const has = env.fields.some((f) => f.recipientId === r.id);
    if (!has) throw new Error(`Recipient ${r.email} has no fields assigned`);
  }
  // Sealing runs after the last signature, so a document it could not
  // process must be refused now. Uploads were checked already, but items
  // reused from a template or public form, and documents stored before the
  // seal caps existed, were not.
  await assertEnvelopeItemsSealable(env.items);

  const initialRecipients =
    env.routingMode === 'PARALLEL'
      ? actionableRecipients
      : actionableRecipients.slice(0, 1);

  await commitWithEnvelopeEvents(env.id, async (tx, record) => {
    // Two concurrent sends must not both dispatch invites.
    const { count } = await tx.envelope.updateMany({
      where: { id: env.id, status: 'DRAFT' },
      data: { status: 'SENT', sentAt: new Date() },
    });
    if (count === 0) throw new Error('Envelope must be in DRAFT to send');
    await record({
      envelopeId: env.id,
      type: 'envelope.sent',
      actorUserId: args.ctx.userId,
      data: { routingMode: env.routingMode, recipientCount: env.recipients.length },
    });
  });

  const sender = await prisma.user.findUnique({ where: { id: env.createdById } });
  const org = await prisma.organisation.findUnique({ where: { id: env.orgId } });
  // If the org sets a sender display name, use it; otherwise the user's name.
  const senderName = org?.senderEmailFromName?.trim() || sender?.name || 'A DocuRidge sender';

  const subjectOverride = env.meta?.emailSubject ?? undefined;
  for (const recipient of initialRecipients) {
    await dispatchSigningInvite({
      envelopeId: env.id,
      orgId: env.orgId,
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      senderName,
      documentTitle: env.title,
      message: env.message ?? undefined,
      expiresAt: env.expiresAt ?? undefined,
      emailSubjectOverride: subjectOverride,
      emailFooter: org?.emailFooter ?? undefined,
      brandColor: org?.brandColor ?? undefined,
    }, recipient.tokenJti);
  }

  // Move from SENT to IN_PROGRESS the moment we've dispatched at least one
  // invite, unless a decline, void or expiry already closed it meanwhile.
  await prisma.envelope.updateMany({
    where: { id: env.id, status: 'SENT' },
    data: { status: 'IN_PROGRESS' },
  });
}

/**
 * Re-dispatch the signing email to whoever is up next. Throttled to once per
 * minute per envelope to prevent abuse.
 */
export async function sendReminderToNextSigner(args: {
  ctx: AuthnContext;
  envelopeId: string;
}): Promise<{ recipientId: string; recipientName: string }> {
  const env = await prisma.envelope.findFirst({
    where: { id: args.envelopeId, orgId: args.ctx.orgId, deletedAt: null },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      meta: true,
    },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:send', { orgId: env.orgId, createdById: env.createdById });

  if (env.status !== 'SENT' && env.status !== 'IN_PROGRESS') {
    throw new Error('Reminders are only available while the envelope is awaiting signature.');
  }
  if (isPastDeadline(env.expiresAt)) {
    await expireEnvelope(env.id);
    throw new Error('This envelope has expired, so no reminder was sent.');
  }

  // Find the next pending actionable recipient (SIGNER / WITNESS /
  // IN_PERSON_SIGNER / APPROVER). Sequential = lowest-ordered NOT_SIGNED.
  const pendingRecipients = env.recipients.filter(
    (r) => (r.recipientRole === 'SIGNER' || r.recipientRole === 'APPROVER'
            || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER')
      && r.signingStatus === 'NOT_SIGNED',
  );
  // A failed parallel invite must be retryable even while an earlier
  // recipient who received their email is still waiting to sign.
  const nextSigner = (env.routingMode === 'PARALLEL'
    ? pendingRecipients.find((r) => r.sendStatus === 'FAILED' || r.sendStatus === 'BOUNCED')
    : undefined) ?? pendingRecipients[0];
  if (!nextSigner) {
    throw new Error('No pending signer to remind.');
  }

  // 1-minute throttle.
  const last = nextSigner.lastReminderSentAt;
  if (last && Date.now() - last.getTime() < 60_000) {
    throw new Error('A reminder was just sent. Try again in a minute.');
  }

  const sender = await prisma.user.findUnique({ where: { id: env.createdById } });
  const senderName = sender?.name ?? 'A DocuRidge sender';

  // Reminders use a distinct template that prefixes "Reminder:" and has body
  // copy explicitly explaining this is a follow-up. Mint a fresh signing URL.
  const minted = await mintSigningToken({
    envelopeId: env.id,
    recipientId: nextSigner.id,
    notAfter: env.expiresAt,
  });
  const pinned = await pinSigningToken({
    envelopeId: env.id,
    recipientId: nextSigner.id,
    expect: { email: nextSigner.email, tokenJti: nextSigner.tokenJti },
    minted,
    data: { lastReminderSentAt: new Date() },
  });
  if (!pinned) throw new RecipientChangedError(RECIPIENT_CHANGED_MESSAGE);

  const org = await prisma.organisation.findUnique({ where: { id: env.orgId } });
  const url = `${getEnv().PUBLIC_URL}/sign/${encodeURIComponent(minted.token)}`;
  const tmpl = envelopeReminderTemplate({
    recipientName: nextSigner.name,
    senderName,
    documentTitle: env.title,
    signingUrl: url,
    customSubject: env.meta?.emailSubject ?? undefined,
    message: env.message ?? undefined,
    expiresAt: env.expiresAt ?? undefined,
    emailFooter: org?.emailFooter ?? undefined,
    brandColor: org?.brandColor ?? undefined,
  });
  const result = await sendMail({
    to: nextSigner.email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    orgId: env.orgId,
    envelopeId: env.id,
    recipientId: nextSigner.id,
  });

  await prisma.recipient.update({
    where: { id: nextSigner.id },
    data: result.delivered
      ? { sendStatus: 'SENT', sentAt: new Date() }
      : { sendStatus: 'FAILED' },
  });

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: result.delivered ? 'email.sent' : 'email.failed',
    actorUserId: args.ctx.userId,
    actorRecipientId: nextSigner.id,
    actorEmail: nextSigner.email,
    data: { reminder: true, messageId: result.messageId },
  });

  if (!result.delivered) {
    throw new Error(result.refusedByAllowlist
      ? 'The email was not delivered because the recipient is blocked by the email allowlist. Contact your administrator.'
      : 'The email was not delivered. Your document is saved; try Send reminder again in a minute.');
  }

  return { recipientId: nextSigner.id, recipientName: nextSigner.name };
}

interface DispatchArgs {
  envelopeId: string;
  orgId: string;
  recipientId: string;
  recipientEmail: string;
  recipientName: string;
  senderName: string;
  documentTitle: string;
  message?: string;
  expiresAt?: Date;
  emailSubjectOverride?: string;
  emailFooter?: string;
  brandColor?: string | null;
}

/**
 * Exported for envelope correction (correctEnvelopeAction): adding or
 * replacing a recipient on a sent envelope dispatches the invite through
 * exactly the same mint + pin + template + mail path as the initial send.
 *
 * The pin is compare-and-set (see `pinSigningToken`): when the row is no
 * longer pending or no longer addressed to `recipientEmail` (or no longer
 * holds `expectedTokenJti`, when given), a concurrent request won and has
 * already dealt with the link, so nothing is pinned and no mail goes out.
 */
export async function dispatchSigningInvite(
  args: DispatchArgs,
  expectedTokenJti?: string | null,
): Promise<void> {
  const minted = await mintSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
    notAfter: args.expiresAt,
  });
  const pinned = await pinSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
    expect: { email: args.recipientEmail, tokenJti: expectedTokenJti },
    minted,
  });
  if (!pinned) {
    log.warn(
      { envelopeId: args.envelopeId, recipientId: args.recipientId },
      'recipient changed before its invite was pinned; invite not sent',
    );
    return;
  }
  await deliverSigningInvite(args, minted);
}

/**
 * Pin a freshly minted signing token on a recipient, compare-and-set: the
 * write only applies while the row is still pending on this envelope, still
 * addressed to `expect.email` (the person the caller is about to hand the
 * link to) and, unless `expect.tokenJti` is undefined, still holds the jti
 * the caller read. Returns false, having written nothing, when a concurrent
 * sign, decline, reassignment, correction or re-pin won, so a stale caller
 * can neither undo a newer pin nor hand out a live link to someone else's row.
 */
async function pinSigningToken(args: {
  envelopeId: string;
  recipientId: string;
  expect: { email: string; tokenJti?: string | null };
  minted: MintedSigningToken;
  data?: Prisma.RecipientUpdateManyMutationInput;
}): Promise<boolean> {
  const { count } = await prisma.recipient.updateMany({
    where: {
      id: args.recipientId,
      envelopeId: args.envelopeId,
      signingStatus: 'NOT_SIGNED',
      email: args.expect.email,
      ...(args.expect.tokenJti !== undefined ? { tokenJti: args.expect.tokenJti } : {}),
    },
    data: {
      ...args.data,
      tokenJti: args.minted.jti,
      currentTokenExpiresAt: args.minted.expiresAt,
    },
  });
  return count > 0;
}

/** Mail an invite for a token that is already pinned on the recipient. */
async function deliverSigningInvite(args: DispatchArgs, minted: MintedSigningToken) {
  const env = getEnv();
  const url = `${env.PUBLIC_URL}/sign/${encodeURIComponent(minted.token)}`;
  const tmpl = envelopeSentTemplate({
    recipientName: args.recipientName,
    senderName: args.senderName,
    documentTitle: args.documentTitle,
    signingUrl: url,
    message: args.message,
    expiresAt: args.expiresAt,
    emailFooter: args.emailFooter,
    brandColor: args.brandColor ?? undefined,
  });
  const subject = args.emailSubjectOverride?.trim() || tmpl.subject;
  const result = await sendMail({
    to: args.recipientEmail,
    subject,
    text: tmpl.text,
    html: tmpl.html,
    orgId: args.orgId,
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
  });

  // The signing link must be pinned before dispatch, but SENT describes the
  // mail result. Keep failed delivery on the existing envelope so retrying
  // from its detail page cannot create another envelope or duplicate invites.
  await prisma.recipient.update({
    where: { id: args.recipientId },
    data: result.delivered
      ? { sendStatus: 'SENT', sentAt: new Date() }
      : { sendStatus: 'FAILED' },
  });

  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: result.delivered ? 'email.sent' : 'email.failed',
    actorRecipientId: args.recipientId,
    actorEmail: args.recipientEmail,
    data: { messageId: result.messageId, refusedByAllowlist: result.refusedByAllowlist },
  });
}

/**
 * Resolve a signing token to its envelope/recipient, with all the data the
 * signing page needs. Validates: token sig, expiry, single-use jti
 * (returns 'consumed' if already used), envelope status, recipient status.
 */
export type FullEnvelope = NonNullable<Awaited<ReturnType<typeof loadFullEnvelope>>>;

export async function loadSigningSession(token: string): Promise<
  | { ok: true; envelope: FullEnvelope; recipient: FullEnvelope['recipients'][number]; jti: string }
  | { ok: false; reason: 'invalid' | 'consumed' | 'expired' | 'envelope_closed' | 'recipient_done' | 'wrong_turn' }
> {
  const claims = await verifySigningToken(token);
  if (!claims) return { ok: false, reason: 'invalid' };
  const envelope = await loadFullEnvelope(claims.envelopeId);
  if (!envelope) return { ok: false, reason: 'invalid' };
  const recipient = envelope.recipients.find((r) => r.id === claims.recipientId);
  if (!recipient) return { ok: false, reason: 'invalid' };

  if (
    envelope.status !== 'SENT' &&
    envelope.status !== 'IN_PROGRESS'
  ) {
    return { ok: false, reason: 'envelope_closed' };
  }
  if (isPastDeadline(envelope.expiresAt)) {
    await expireEnvelope(envelope.id);
    return { ok: false, reason: 'expired' };
  }
  if (recipient.signingStatus === 'SIGNED') {
    return { ok: false, reason: 'recipient_done' };
  }
  if (recipient.signingStatus === 'DECLINED') {
    return { ok: false, reason: 'recipient_done' };
  }
  if (recipient.signingStatus === 'SKIPPED') {
    // Sender's routing rule excluded this recipient.
    return { ok: false, reason: 'recipient_done' };
  }
  // Single-use: once tokenJti is set on the recipient, only THAT jti is
  // valid. A NEW token with a different jti is rejected.
  //
  // Invariant this guard relies on: every mint site pins tokenJti to its
  // own newly minted jti (see dispatchSigningInvite, sendReminderToNextSigner,
  // mintFreshTokenForRecipient, and sign-now-actions.ts), so the newest
  // minted token is always the only valid one. A non-null mismatch here
  // therefore means the presented token was superseded by a later mint for
  // the same recipient, not that the recipient never opened anything. A null
  // tokenJti means no live link exists (e.g. a sender replacement that sent no
  // invite), so any token presented for that row is a superseded one.
  if (recipient.tokenJti !== claims.jti) {
    return { ok: false, reason: 'consumed' };
  }
  if (recipient.currentTokenExpiresAt && recipient.currentTokenExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Sequential turn check. APPROVER / WITNESS / IN_PERSON_SIGNER all gate
  // routing identically to SIGNER — all four must complete (or be skipped
  // / declined) before a later recipient's turn arrives.
  if (envelope.routingMode === 'SEQUENTIAL') {
    const earlier = envelope.recipients.filter(
      (r) =>
        (r.recipientRole === 'SIGNER' || r.recipientRole === 'APPROVER'
         || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER') &&
        r.signingOrder < recipient.signingOrder &&
        r.signingStatus !== 'SIGNED' &&
        r.signingStatus !== 'SKIPPED',
    );
    if (earlier.length > 0) return { ok: false, reason: 'wrong_turn' };
  }

  return { ok: true, envelope, recipient, jti: claims.jti };
}

function isPastDeadline(expiresAt: Date | null | undefined): boolean {
  return !!expiresAt && expiresAt.getTime() <= Date.now();
}

/**
 * Move an awaiting-signature envelope whose deadline has passed to EXPIRED
 * and record `envelope.expired`. Idempotent: the conditional update only
 * matches once, so concurrent callers record a single event. An envelope
 * with no pending routing recipient is left alone: everyone signed before
 * the deadline and only its seal is outstanding.
 */
export async function expireEnvelope(envelopeId: string): Promise<void> {
  await commitWithEnvelopeEvents(envelopeId, async (tx, record) => {
    const now = new Date();
    const { count } = await tx.envelope.updateMany({
      where: {
        id: envelopeId,
        status: { in: ['SENT', 'IN_PROGRESS'] },
        expiresAt: { lte: now },
        // Only while someone still has to act. An envelope whose signers are
        // all done is waiting on its seal (which failed, or is in flight);
        // expiring it would strand those signatures beyond retryEnvelopeSealing.
        recipients: { some: { recipientRole: { in: [...ACTIONABLE_ROLES] }, signingStatus: 'NOT_SIGNED' } },
      },
      data: { status: 'EXPIRED' },
    });
    if (count > 0) {
      await record({ envelopeId, type: 'envelope.expired', data: { expiredAt: now.toISOString() } });
    }
  });
}

/**
 * Where-clause for a write made by a request authenticated with a signing
 * token: it only matches while the row is still pending on this envelope and
 * still pinned to `jti`, the token the request presented. The session check
 * ran earlier, outside any transaction, so a reassignment, correction,
 * reminder or sign-now may have re-pinned the row since; such a request must
 * change nothing, and above all never write its superseded jti back.
 */
function heldBy(args: { envelopeId: string; recipientId: string; jti: string }) {
  return {
    id: args.recipientId,
    envelopeId: args.envelopeId,
    signingStatus: 'NOT_SIGNED' as const,
    tokenJti: args.jti,
  };
}

/**
 * Mark the recipient's link opened. Returns false, recording nothing, when
 * the row no longer holds `jti` (the link was superseded after the page
 * checked it); the caller then treats the link as used. Never writes
 * tokenJti: every mint site pins it, and the newest pin must win.
 */
export async function recordRecipientOpened(args: {
  envelopeId: string;
  recipientId: string;
  jti: string;
  ipAddress: string;
  userAgent: string;
}): Promise<boolean> {
  return commitWithEnvelopeEvents(args.envelopeId, async (tx, record) => {
    const { count } = await tx.recipient.updateMany({
      where: heldBy(args),
      data: {
        readStatus: 'OPENED',
        openedAt: new Date(),
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      },
    });
    if (count === 0) return false;
    // Read under the row lock just taken: the person this link belongs to.
    const opener = await tx.recipient.findUnique({
      where: { id: args.recipientId },
      select: { email: true, name: true },
    });
    await record({
      envelopeId: args.envelopeId,
      type: 'recipient.opened',
      actorRecipientId: args.recipientId,
      actorEmail: opener?.email,
      actorName: opener?.name,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    });
    return true;
  });
}

/**
 * Record e-sign consent for the holder of `jti`. Returns false, writing
 * nothing, when the row no longer holds that link: consent is per person, and
 * a superseded link must not consent for whoever replaced its holder.
 */
export async function recordConsent(args: {
  envelopeId: string;
  recipientId: string;
  jti: string;
  ipAddress: string;
  userAgent: string;
  disclosureVersion: string;
}): Promise<boolean> {
  return commitWithEnvelopeEvents(args.envelopeId, async (tx, record) => {
    const { count } = await tx.recipient.updateMany({
      where: heldBy(args),
      data: {
        consentGivenAt: new Date(),
        consentDisclosureVersion: args.disclosureVersion,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      },
    });
    if (count === 0) return false;
    await record({
      envelopeId: args.envelopeId,
      type: 'recipient.consent_given',
      actorRecipientId: args.recipientId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: { disclosureVersion: args.disclosureVersion },
    });
    return true;
  });
}

/** A recipient's uploaded file, staged in storage (see `stageRecipientAttachment`). */
export interface StagedRecipientFile {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  filename: string;
  commit(): Promise<void>;
}

/**
 * Record `file` as the attachment for the holder of `jti` on ATTACHMENT field
 * `fieldId`, replacing any earlier upload. The upload ran after the session
 * check and can take a while, so the write is compare-and-set like every
 * other token-authorised write: it only applies while the recipient is still
 * pending and pinned to `jti` (`heldBy`), the envelope still awaits
 * signatures, and the field is still this recipient's attachment field. The
 * file is moved into place only then, inside the transaction. Returns false,
 * having written nothing, otherwise; the caller discards the staged file.
 */
export async function attachRecipientFile(args: {
  envelopeId: string;
  recipientId: string;
  jti: string;
  fieldId: string;
  file: StagedRecipientFile;
}): Promise<boolean> {
  const { file } = args;
  return prisma.$transaction(async (tx) => {
    // A no-op write: it takes the recipient row lock with the CAS condition,
    // so a concurrent sign, decline, reassignment or re-pin is serialised
    // with this, and the envelope write below takes the envelope row lock in
    // the same order the signing commit does.
    const held = await tx.recipient.updateMany({
      where: heldBy(args),
      data: { signingStatus: 'NOT_SIGNED' },
    });
    if (held.count === 0) return false;
    const open = await tx.envelope.updateMany({
      where: { id: args.envelopeId, status: { in: AWAITING_SIGNATURE } },
      data: { updatedAt: new Date() },
    });
    if (open.count === 0) return false;
    const field = await tx.field.findFirst({
      where: { id: args.fieldId, envelopeId: args.envelopeId, recipientId: args.recipientId, type: 'ATTACHMENT' },
      select: { id: true },
    });
    if (!field) return false;

    await file.commit();
    const row = {
      recipientId: args.recipientId,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      storagePath: file.relativePath,
    };
    // One row per field (@unique fieldId): a re-upload replaces the earlier one.
    await tx.fieldAttachment.upsert({
      where: { fieldId: args.fieldId },
      update: { ...row, uploadedAt: new Date() },
      create: { fieldId: args.fieldId, ...row },
    });
    return true;
  });
}

/**
 * Record a successful access-code unlock for a recipient whose sender set
 * an access code. Part of the audit chain — counsel may need to show not
 * just that the recipient signed, but that they held the second factor.
 */
export async function recordAccessCodeUnlock(args: {
  envelopeId: string;
  recipientId: string;
  ipAddress: string;
  userAgent: string;
}): Promise<void> {
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'recipient.access_code_unlocked',
    actorRecipientId: args.recipientId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
}

export interface SigningResult {
  envelopeStatus: 'IN_PROGRESS' | 'COMPLETED';
  /**
   * Every recipient is done, but the sealed document is not stored: it could
   * not be built (the envelope stays IN_PROGRESS, every signature committed)
   * or it could not be saved after the envelope was completed. Either way an
   * `envelope.seal_failed` event tells the sender, who can retry
   * (`retryEnvelopeSealing`).
   */
  sealFailed?: true;
}

/**
 * Submit field values + signature image. Atomically writes Field.value rows,
 * captures the Signature, marks the Recipient as SIGNED, and either
 * advances to the next recipient or completes (sealing) the envelope.
 */
export async function completeRecipientSigning(args: {
  envelopeId: string;
  recipientId: string;
  /** jti of the signing token that authorised this submission. */
  jti: string;
  ipAddress: string;
  userAgent: string;
  fieldValues: Record<string, string>;
  signatureImagePngBase64?: string;
  typedSignature?: string;
  signatureFont?: string;
  initialsImagePngBase64?: string;
  typedInitials?: string;
  initialsFont?: string;
  /** Dashboard user signed in on this request, if any. */
  sessionUserId?: string | null;
}): Promise<SigningResult> {
  const recipient = await prisma.recipient.findUnique({
    where: { id: args.recipientId },
    include: { envelope: { include: { recipients: true, fields: true, items: true } } },
  });
  if (!recipient || recipient.envelopeId !== args.envelopeId) {
    throw new Error('Recipient not found');
  }

  // Persist field values and the signature.
  const fields = recipient.envelope.fields.filter((f) => f.recipientId === recipient.id);

  // DRAWING values are image data URLs, size-checked by the submit action.
  for (const [fieldId, v] of Object.entries(args.fieldValues)) {
    if (fields.some((f) => f.id === fieldId && f.type === 'DRAWING')) continue;
    if (v.length > MAX_FIELD_VALUE_LENGTH) throw new Error('A field value is too long.');
  }

  // Pre-load attachment rows so the required-check can see what's uploaded.
  const attachmentRows = await prisma.fieldAttachment.findMany({
    where: { fieldId: { in: fields.map((f) => f.id) } },
    select: { fieldId: true },
  });
  const attachmentByFieldId = new Set(attachmentRows.map((a) => a.fieldId));

  // Conditional visibility — a field with `meta.condition` is treated as
  // hidden when its source value doesn't match. We blank its submitted value
  // so the sealed PDF never stamps a stale "show-if" answer, and we skip
  // required + meta enforcement for it.
  function getMeta(f: { meta: unknown }) {
    return (f.meta && typeof f.meta === 'object' ? f.meta : {}) as {
      readOnly?: boolean; charLimit?: number; pattern?: string;
      patternMessage?: string; min?: number; max?: number;
      options?: string[];
      formula?: string;
      condition?: { whenFieldId: string; equals: string };
    };
  }
  // Visibility is derived from the *full* envelope's field values + the
  // submitted values (later recipients can have conditions referencing
  // earlier recipients' fields). Keep this lookup over all fields.
  const allFieldsValueLookup: Record<string, string> = {};
  for (const allF of recipient.envelope.fields) {
    if (allF.recipientId === recipient.id) {
      // current recipient — use submitted value
      const v = args.fieldValues[allF.id];
      if (v !== undefined) allFieldsValueLookup[allF.id] = v;
      else if (allF.value != null) allFieldsValueLookup[allF.id] = allF.value;
    } else if (allF.value != null) {
      allFieldsValueLookup[allF.id] = allF.value;
    }
  }
  function isVisible(f: { meta: unknown }): boolean {
    const m = getMeta(f);
    if (!m.condition) return true;
    return (allFieldsValueLookup[m.condition.whenFieldId] ?? '') === m.condition.equals;
  }
  // Strip values for fields whose condition is unmet so they aren't stamped.
  for (const f of fields) {
    if (!isVisible(f)) {
      delete args.fieldValues[f.id];
    }
  }

  // APPROVE / NOTE / DECLINE — canonicalize what the client posted so a
  // tampered submission can't forge identity or stamp text. The client may
  // include any string; we replace it with the trusted server-generated
  // version (or strip it for display-only / non-action types).
  const approvalTs = new Date().toISOString();
  for (const f of fields) {
    if (f.type === 'APPROVE') {
      // Only keep an APPROVE value if the client actually submitted one
      // (signaling the recipient clicked the field). Then overwrite with
      // the server-trusted attestation containing the real recipient name.
      if (args.fieldValues[f.id]) {
        args.fieldValues[f.id] = `Approved by ${recipient.name} at ${approvalTs}`;
      }
    } else if (f.type === 'NOTE') {
      // Display-only; we use the sender-configured noteText for stamping
      // (handled by the seal layer reading meta.noteText) so we don't need
      // to keep a value here.
      delete args.fieldValues[f.id];
    } else if (f.type === 'DECLINE') {
      // The DECLINE field is a UI shortcut into the global decline flow. If
      // a recipient is submitting (not declining), they didn't click it —
      // strip any stale value.
      delete args.fieldValues[f.id];
    }
  }

  // FORMULA fields are recomputed server-side from the *complete* envelope
  // value lookup (other recipients' previously-signed values + this
  // recipient's submission). Whatever the client posted for a FORMULA field
  // is overwritten; the recipient cannot stamp an arbitrary value.
  {
    const refMap: Record<string, string> = { ...allFieldsValueLookup };
    // Apply this recipient's just-submitted values into the lookup so chained
    // formulas (one referencing another) settle correctly.
    for (const f of fields) {
      const v = args.fieldValues[f.id];
      if (v !== undefined) refMap[f.id] = v;
    }
    for (let pass = 0; pass < 5; pass++) {
      let changed = false;
      for (const f of fields) {
        if (f.type !== 'FORMULA') continue;
        if (!isVisible(f)) continue;
        const meta = getMeta(f);
        if (!meta.formula) {
          args.fieldValues[f.id] = '';
          continue;
        }
        const r = evaluateFormula(meta.formula, refMap);
        const next = r.ok ? formatFormulaValue(r.value) : '';
        if (refMap[f.id] !== next) {
          refMap[f.id] = next;
          args.fieldValues[f.id] = next;
          changed = true;
        }
      }
      if (!changed) break;
    }
  }

  // Required-field check: SIGNATURE / INITIALS each have their own
  // adopted-mark slot. NAME / EMAIL are auto-filled. JOB_TITLE is text-y.
  // APPROVER recipients have no fields; their action is the approval click,
  // recorded by the call into completeRecipientSigning itself — skip the
  // entire field-enforcement loop for them.
  const hasSignature = !!args.signatureImagePngBase64 || !!args.typedSignature;
  const hasInitials = !!args.initialsImagePngBase64 || !!args.typedInitials;
  const isApprover = recipient.recipientRole === 'APPROVER';
  for (const f of fields) {
    if (isApprover) break;
    if (!f.required) continue;
    if (!isVisible(f)) continue; // hidden → not required
    if (f.type === 'SIGNATURE') {
      if (!hasSignature) throw new Error('Required signature not filled');
      continue;
    }
    if (f.type === 'INITIALS') {
      if (!hasInitials) throw new Error('Required initials not filled');
      continue;
    }
    if (f.type === 'NAME' || f.type === 'EMAIL' || f.type === 'FORMULA' || f.type === 'NOTE') {
      // Auto-filled by the system or display-only — always satisfied.
      continue;
    }
    if (f.type === 'DECLINE') {
      // Recipient never *needs* to click decline; if they're submitting,
      // they didn't decline. Skip the required check unconditionally.
      continue;
    }
    if (f.type === 'APPROVE') {
      // Required APPROVE = recipient must explicitly click the approve
      // stamp before submitting. Value carries the timestamped attestation.
      const v = args.fieldValues[f.id];
      if (!v) {
        throw new Error('Required approval not given');
      }
      continue;
    }
    if (f.type === 'ATTACHMENT') {
      if (!attachmentByFieldId.has(f.id)) {
        throw new Error('Required attachment not uploaded');
      }
      continue;
    }
    if (f.type === 'DATE') {
      const v = args.fieldValues[f.id] ?? new Date().toISOString().slice(0, 10);
      args.fieldValues[f.id] = v;
      continue;
    }
    const v = args.fieldValues[f.id];
    if (v === undefined || v === '') {
      throw new Error(`Required field ${f.type} not filled`);
    }
  }

  // Per-field property enforcement (server-side — client-side is UX only).
  // Reject sender-locked read-only fields whose value differs from the
  // configured default. Reject values that exceed charLimit / fail pattern /
  // exceed numeric min/max. These mirror the ValueModal client checks.
  for (const f of fields) {
    if (!isVisible(f)) continue; // hidden → enforcement irrelevant
    const v = args.fieldValues[f.id];
    if (v === undefined || v === '') continue;
    const meta = (f.meta && typeof f.meta === 'object' ? f.meta : {}) as {
      readOnly?: boolean; charLimit?: number; pattern?: string;
      patternMessage?: string; min?: number; max?: number;
      options?: string[];
    };
    if ((f.type === 'DROPDOWN' || f.type === 'RADIO')) {
      const opts = Array.isArray(meta.options) ? meta.options : [];
      if (!opts.includes(v)) {
        throw new Error(`Field "${f.type}" value is not in the allowed options`);
      }
    }
    if (meta.readOnly && v !== (f.defaultValue ?? '')) {
      throw new Error(`Field "${f.type}" is read-only and cannot be modified`);
    }
    if (meta.charLimit && v.length > meta.charLimit) {
      throw new Error(`Field "${f.type}" exceeds character limit of ${meta.charLimit}`);
    }
    if (f.type === 'NUMBER') {
      const n = Number(v);
      if (Number.isNaN(n)) {
        throw new Error(`Field "${f.type}" must be a number`);
      }
      if (meta.min !== undefined && n < meta.min) {
        throw new Error(`Field "${f.type}" is below minimum ${meta.min}`);
      }
      if (meta.max !== undefined && n > meta.max) {
        throw new Error(`Field "${f.type}" exceeds maximum ${meta.max}`);
      }
    }
    if (meta.pattern && f.type !== 'DRAWING') {
      // An uncompilable sender pattern is accepted rather than blocking the
      // recipient; one that exhausts its time budget is a validation failure.
      const result = testFieldPattern(meta.pattern, v);
      if (result === 'mismatch') {
        throw new Error(meta.patternMessage || `Field "${f.type}" does not match required format`);
      }
      if (result === 'timeout') {
        log.warn({ envelopeId: args.envelopeId, fieldId: f.id }, 'field pattern evaluation timed out');
        throw new Error(`Field "${f.type}" could not be checked against its required format`);
      }
    }
  }

  await commitWithEnvelopeEvents(args.envelopeId, async (tx, record) => {
    // Claim the row first: only a still-pending recipient holding the same
    // link can sign. A concurrent submit, reassignment (which re-pins the
    // jti) or removal makes this match nothing, and throwing rolls back the
    // whole transaction, so no Signature row or event is written for it.
    const claimed = await tx.recipient.updateMany({
      where: {
        id: recipient.id,
        envelopeId: args.envelopeId,
        signingStatus: 'NOT_SIGNED',
        tokenJti: args.jti,
      },
      data: { signingStatus: 'SIGNED', signedAt: new Date() },
    });
    if (claimed.count === 0) throw new RecipientChangedError(LINK_NO_LONGER_VALID_MESSAGE);
    // Then the envelope: a signature only commits while the envelope still
    // awaits signatures. This write locks the envelope row, so a concurrent
    // decline (of any recipient), void, expiry or completion either committed
    // first and this matches nothing, or waits for this commit and re-checks.
    const stillOpen = await tx.envelope.updateMany({
      where: { id: args.envelopeId, status: { in: AWAITING_SIGNATURE } },
      data: { updatedAt: new Date() },
    });
    if (stillOpen.count === 0) throw new RecipientChangedError(ENVELOPE_CLOSED_MESSAGE);

    for (const f of fields) {
      const v = args.fieldValues[f.id];
      if (v !== undefined && v !== '') {
        await tx.field.update({
          where: { id: f.id },
          data: { value: v, filledAt: new Date() },
        });
      }
    }

    // Persist one Signature row for the canonical SIGNATURE adoption (if
    // any). We attach it to the first SIGNATURE field on this envelope so
    // the seal step has a fieldId anchor; the imagePngBase64 + typedSignature
    // get reused across every SIGNATURE field for this recipient at stamp time.
    if (hasSignature) {
      const signatureFieldId = fields.find((f) => f.type === 'SIGNATURE')?.id ?? null;
      await tx.signature.create({
        data: {
          recipientId: recipient.id,
          fieldId: signatureFieldId,
          imagePngBase64: args.signatureImagePngBase64 ?? null,
          typedSignature: args.typedSignature ?? null,
          typedFont: args.signatureFont ?? null,
          ipAddress: args.ipAddress,
          userAgent: args.userAgent,
        },
      });
    }
    // Initials are stored as a separate Signature row, anchored to the first
    // INITIALS field. Same recipient, distinct adopted mark.
    if (hasInitials) {
      const initialsFieldId = fields.find((f) => f.type === 'INITIALS')?.id ?? null;
      await tx.signature.create({
        data: {
          recipientId: recipient.id,
          fieldId: initialsFieldId,
          imagePngBase64: args.initialsImagePngBase64 ?? null,
          typedSignature: args.typedInitials ?? null,
          typedFont: args.initialsFont ?? null,
          ipAddress: args.ipAddress,
          userAgent: args.userAgent,
        },
      });
    }

    // When the recipient signs while logged in as themselves, save the
    // adopted signature/initials as their default so future ceremonies
    // pre-fill. A signing token alone never writes to an account: it only
    // proves someone holds the link. No consent checkbox: storing your own
    // adoption is implicit. Settings → Signatures exposes a Clear button.
    const matchingUser = args.sessionUserId
      ? await tx.user.findUnique({
          where: { email: recipient.email.toLowerCase() },
          select: { id: true },
        })
      : null;
    if (matchingUser && matchingUser.id === args.sessionUserId) {
      const userPatch: Record<string, string | null> = {};
      if (hasSignature) {
        userPatch.defaultSignaturePngBase64 = args.signatureImagePngBase64 ?? null;
        userPatch.defaultTypedSignature = args.typedSignature ?? null;
      }
      if (hasInitials) {
        userPatch.defaultInitialsPngBase64 = args.initialsImagePngBase64 ?? null;
        userPatch.defaultTypedInitials = args.typedInitials ?? null;
      }
      if (Object.keys(userPatch).length > 0) {
        await tx.user.update({ where: { id: matchingUser.id }, data: userPatch });
      }
    }

    for (const f of fields) {
      const v = args.fieldValues[f.id];
      if (v !== undefined) {
        await record({
          envelopeId: args.envelopeId,
          type: 'recipient.field_filled',
          actorRecipientId: recipient.id,
          ipAddress: args.ipAddress,
          userAgent: args.userAgent,
          data: { fieldId: f.id, type: f.type },
        });
      }
    }
    await record({
      envelopeId: args.envelopeId,
      type: 'recipient.signed',
      actorRecipientId: recipient.id,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: {
        hasDrawnSignature: !!args.signatureImagePngBase64,
        hasTypedSignature: !!args.typedSignature,
        hasDrawnInitials: !!args.initialsImagePngBase64,
        hasTypedInitials: !!args.typedInitials,
      },
    });
  });

  // Advance or complete.
  return advanceOrComplete(recipient.envelopeId, args.ipAddress, args.userAgent);
}

async function advanceOrComplete(
  envelopeId: string,
  ipAddress: string,
  userAgent: string,
): Promise<SigningResult> {
  const env = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
      createdBy: true,
    },
  });
  if (!env) throw new Error('Envelope vanished');
  // A decline, void or expiry that committed after this signature closed the
  // envelope: there is nothing to route or complete, and that outcome stands.
  if (!AWAITING_SIGNATURE.includes(env.status)) return { envelopeStatus: 'IN_PROGRESS' };

  // Conditional routing — apply *before* picking the next recipient. Any
  // NOT_SIGNED signer whose meta.condition is unmet against the current
  // field values is moved to SKIPPED with an audit event. The condition
  // can only reference earlier-signed fields by construction (the builder
  // restricts the source picker), so values are deterministic at this point.
  const fieldValueByDbId: Record<string, string> = {};
  for (const f of env.fields) {
    if (f.value != null) fieldValueByDbId[f.id] = f.value;
  }
  const skipsThisAdvance: { id: string; sourceFieldId: string; equals: string; actual: string }[] = [];
  for (const r of env.recipients) {
    if (r.recipientRole !== 'SIGNER' && r.recipientRole !== 'APPROVER'
        && r.recipientRole !== 'WITNESS' && r.recipientRole !== 'IN_PERSON_SIGNER') continue;
    if (r.signingStatus !== 'NOT_SIGNED') continue;
    const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as {
      condition?: { whenFieldId: string; equals: string };
    };
    if (!meta.condition) continue;
    // Only evaluate once the source field has actually been filled. A
    // condition referencing a not-yet-signed earlier recipient defers to a
    // later advance (this is harmless — sequential routing won't reach this
    // recipient until earlier ones complete). Without this guard, every
    // pending conditional recipient would be skipped at send time.
    if (!(meta.condition.whenFieldId in fieldValueByDbId)) continue;
    const actual = fieldValueByDbId[meta.condition.whenFieldId]!;
    if (actual === meta.condition.equals) continue;
    skipsThisAdvance.push({
      id: r.id,
      sourceFieldId: meta.condition.whenFieldId,
      equals: meta.condition.equals,
      actual,
    });
  }
  for (const s of skipsThisAdvance) {
    await commitWithEnvelopeEvents(env.id, async (tx, record) => {
      // Only a still-pending recipient is skipped; one who signed or declined
      // meanwhile keeps that outcome.
      const { count } = await tx.recipient.updateMany({
        where: { id: s.id, envelopeId: env.id, signingStatus: 'NOT_SIGNED' },
        data: { signingStatus: 'SKIPPED' },
      });
      if (count === 0) return;
      await record({
        envelopeId: env.id,
        type: 'recipient.skipped_by_condition',
        actorRecipientId: s.id,
        data: {
          sourceFieldId: s.sourceFieldId,
          expected: s.equals,
          actual: s.actual,
        },
      });
    });
  }
  // Re-fetch the latest actionable-recipient slice after marking skips.
  const signers = (await prisma.recipient.findMany({
    where: { envelopeId: env.id, recipientRole: { in: ['SIGNER', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER'] } },
    orderBy: { signingOrder: 'asc' },
  }));
  const remaining = signers.filter((r) => r.signingStatus === 'NOT_SIGNED');

  if (signers.every((r) => isSatisfied(r.signingStatus))) {
    const { result } = await completeEnvelope(env.id, { ipAddress, userAgent });
    return result;
  }

  // Advance: notify the next pending signer (sequential) — parallel mode
  // already invited everyone at send time so nothing more to do. (No one
  // pending yet not complete means a recipient declined: nothing to route.)
  if (env.routingMode === 'SEQUENTIAL' && remaining.length > 0) {
    const nextRecipient = remaining[0]!;
    await recordEnvelopeEvent({
      envelopeId: env.id,
      type: 'envelope.advanced',
      data: { nextRecipientId: nextRecipient.id, signingOrder: nextRecipient.signingOrder },
    });
    // Need org branding (footer + color) for the next-recipient invite.
    const orgBrand = await prisma.organisation.findUnique({
      where: { id: env.orgId },
      select: { emailFooter: true, brandColor: true },
    });
    await dispatchSigningInvite({
      envelopeId: env.id,
      orgId: env.orgId,
      recipientId: nextRecipient.id,
      recipientEmail: nextRecipient.email,
      recipientName: nextRecipient.name,
      senderName: env.createdBy?.name ?? 'A DocuRidge sender',
      documentTitle: env.title,
      message: env.message ?? undefined,
      expiresAt: env.expiresAt ?? undefined,
      emailFooter: orgBrand?.emailFooter ?? undefined,
      brandColor: orgBrand?.brandColor ?? undefined,
    }, nextRecipient.tokenJti);
  }
  return { envelopeStatus: 'IN_PROGRESS' };
}

const ACTIONABLE_ROLES = ['SIGNER', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER'] as const;

/** A routing recipient no longer holds completion back. DECLINED never does. */
function isSatisfied(signingStatus: string): boolean {
  return signingStatus === 'SIGNED' || signingStatus === 'SKIPPED';
}

/**
 * Completion attempts before giving up. Each but the last builds before the
 * claim; the last builds inside it with the audit chain locked, so events
 * appended during the build (views, comments, downloads) cannot make it
 * stale, and only a change to the recipients still can.
 */
const MAX_COMPLETION_ATTEMPTS = 3;
/** Transaction budget for the locked final attempt, which includes a build. */
const LOCKED_COMPLETION_TIMEOUT_MS = 60_000;

interface CompletionActor {
  ipAddress?: string | null;
  userAgent?: string | null;
  actorUserId?: string | null;
}

/**
 * Seal and complete an envelope whose routing recipients have all signed or
 * been skipped. The steps run in this order, each only after the one before
 * it succeeded:
 *
 *   1. build: `buildSealedEnvelope` renders the sealed PDF and its signed
 *      manifest in memory. This is the expensive, failure-prone step (source
 *      parsing and the seal-limits.ts caps) and it has no side effects, so a
 *      failure leaves the envelope IN_PROGRESS with every signature
 *      committed; `envelope.seal_failed` records it for the sender.
 *   2. claim: `claimCompletion` writes COMPLETED and stores the build's
 *      precomputed `envelope.completed` (the event the seal already ends
 *      with) only while the envelope still awaits signatures, every routing
 *      recipient is SIGNED or SKIPPED, the recipients are still the ones the
 *      build recorded, and the audit chain head is still the one the build
 *      sealed. A decline, void or expiry that won the envelope row means the
 *      build is discarded; a recipient change (a sender correction) or any
 *      event appended since the build means it is rebuilt.
 *   3. persist: `persistSealedEnvelope` stores the file, the SealedDocument
 *      and `envelope.sealed`, idempotently. If it fails, the envelope is
 *      COMPLETED without its sealed copy; `envelope.seal_failed` records it
 *      and `retryEnvelopeSealing` finishes the job.
 *   4. notify: completion emails link to the sealed copy, so they go out
 *      only once this call stored it (exactly once, whichever attempt wins).
 *      The `envelope.completed` and `envelope.sealed` webhooks are dispatched
 *      together after step 3, so a receiver of `envelope.completed` normally
 *      finds the sealed document already in place. If step 3 failed,
 *      `envelope.completed` goes out alone (the payload never claims a sealed
 *      document) and `envelope.sealed` follows when a retry stores it, so
 *      receivers that fetch the PDF should key on `envelope.sealed`.
 */
async function completeEnvelope(
  envelopeId: string,
  actor: CompletionActor,
): Promise<{ result: SigningResult; error?: unknown }> {
  const events: AppendedEnvelopeEvent[] = [];
  try {
    for (let attempt = 1; attempt <= MAX_COMPLETION_ATTEMPTS; attempt++) {
      const makeBuild = (completedAt: Date) => buildSealedEnvelope({
        envelopeId,
        completion: {
          completedAt,
          actor: { ipAddress: actor.ipAddress, userAgent: actor.userAgent, actorUserId: actor.actorUserId },
        },
      });
      let build: SealedBuild | ((completedAt: Date) => Promise<SealedBuild>) = makeBuild;
      if (attempt < MAX_COMPLETION_ATTEMPTS) {
        try {
          build = await makeBuild(new Date());
        } catch (err) {
          await recordSealFailure(envelopeId, 'build', err, events);
          return { result: { envelopeStatus: 'IN_PROGRESS', sealFailed: true }, error: err };
        }
      }
      let claim: Awaited<ReturnType<typeof claimCompletion>>;
      try {
        claim = await claimCompletion({ envelopeId, build, collect: events });
      } catch (err) {
        if (err instanceof SealBuildFailed) {
          await recordSealFailure(envelopeId, 'build', err.cause, events);
          return { result: { envelopeStatus: 'IN_PROGRESS', sealFailed: true }, error: err.cause };
        }
        // Not a lost race but a failure (database error, transaction
        // timeout, key lookup): nothing was claimed. Record it so the sender
        // sees it and can retry, and give the signer a clean answer.
        await recordSealFailure(envelopeId, 'claim', err, events);
        return { result: { envelopeStatus: 'IN_PROGRESS', sealFailed: true }, error: err };
      }
      if (claim.outcome === 'lost') return { result: { envelopeStatus: 'IN_PROGRESS' } };
      if (claim.outcome === 'stale') continue;
      const persisted = await persistAndNotify(claim.build, events);
      return persisted.outcome === 'failed'
        ? { result: { envelopeStatus: 'COMPLETED', sealFailed: true }, error: persisted.error }
        : { result: { envelopeStatus: 'COMPLETED' } };
    }
    const err = new Error('the envelope kept changing while it was being sealed');
    await recordSealFailure(envelopeId, 'claim', err, events);
    return { result: { envelopeStatus: 'IN_PROGRESS', sealFailed: true }, error: err };
  } finally {
    await publishEnvelopeEvents(events);
  }
}

/** Store a build; on success, send the completion emails it links to. */
async function persistAndNotify(
  build: SealedBuild,
  collect: AppendedEnvelopeEvent[],
): Promise<{ outcome: SealPersistOutcome } | { outcome: 'failed'; error: unknown }> {
  let outcome: SealPersistOutcome;
  try {
    outcome = await persistSealedEnvelope(build, { collect });
  } catch (err) {
    await recordSealFailure(build.envelopeId, 'persist', err, collect);
    return { outcome: 'failed', error: err };
  }
  if (outcome === 'sealed') await sendCompletionEmails(build.envelopeId);
  return { outcome };
}

/**
 * Audit data for a failed seal attempt. A cap the document exceeded is named
 * (its message is ours and safe to show); any other error is recorded only
 * as `error`, since its message may carry storage paths. Logs carry it all.
 */
function sealFailureData(stage: 'build' | 'claim' | 'persist', err: unknown): Record<string, unknown> {
  if (err instanceof PdfComplexityError || err instanceof PdfDecodeLimitError) {
    return { stage, reason: err.code, limit: err.limit, message: err.message };
  }
  return { stage, reason: 'error' };
}

/**
 * Record `envelope.seal_failed`. Pass the completion's `collect` array so its
 * webhook is dispatched with the events before it (e.g. a deferred
 * `envelope.completed`), in audit-chain order, rather than ahead of them.
 */
async function recordSealFailure(
  envelopeId: string,
  stage: 'build' | 'claim' | 'persist',
  err: unknown,
  collect: AppendedEnvelopeEvent[],
): Promise<void> {
  log.error(
    { envelopeId, stage, err: err instanceof Error ? err.message : String(err) },
    'envelope sealing failed',
  );
  try {
    await commitWithEnvelopeEvents(
      envelopeId,
      (_tx, record) => record({ envelopeId, type: 'envelope.seal_failed', data: sealFailureData(stage, err) }),
      { collect },
    );
  } catch (recordErr) {
    log.error(
      { envelopeId, err: recordErr instanceof Error ? recordErr.message : String(recordErr) },
      'could not record envelope.seal_failed',
    );
  }
}

/** A message for the sender about why a seal attempt failed. */
function sealFailureMessage(err: unknown): string {
  if (err instanceof PdfComplexityError || err instanceof PdfDecodeLimitError) {
    return `The final document could not be sealed: ${err.message}. Ask your administrator about the PDF limits, or void the envelope and send it again with a re-saved or printed-to-PDF copy of the document.`;
  }
  return 'The final document could not be sealed. Try again in a minute; if it keeps failing, contact your administrator.';
}

/** Mail the sender (unless opted out) and every routing recipient the sealed copy's link. */
async function sendCompletionEmails(envelopeId: string): Promise<void> {
  const env = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    include: { recipients: { orderBy: { signingOrder: 'asc' } }, createdBy: true },
  });
  if (!env) return;
  const signers = env.recipients.filter((r) => (ACTIONABLE_ROLES as readonly string[]).includes(r.recipientRole));

  // Pull each signer's adopted signature so the completion email can show
  // a thumbnail next to each signer's name (DocuSign-style).
  const signaturesByRecipient = await prisma.signature.findMany({
    where: { recipientId: { in: signers.map((s) => s.id) } },
    select: { recipientId: true, imagePngBase64: true, typedSignature: true },
  });
  const sigByRcpt = new Map(signaturesByRecipient.map((s) => [s.recipientId, s]));
  const org = await prisma.organisation.findUnique({ where: { id: env.orgId } });
  const signerSummaries = signers.map((s) => {
    const sig = sigByRcpt.get(s.id);
    return {
      name: s.name,
      email: s.email,
      signedAt: s.signedAt,
      signatureImageBase64: sig?.imagePngBase64 ?? null,
      typedSignature: sig?.typedSignature ?? null,
    };
  });

  // Notify sender + every signer. Sender's notification prefs gate this:
  // if they've opted out of "completed" emails, skip them but still mail signers.
  const downloadUrl = `${getEnv().PUBLIC_URL}/dashboard/envelopes/${env.id}/sealed`;
  const senderWantsCompleted = wantsNotification(env.createdBy?.notificationPrefs, 'completed');
  const recipients = [
    ...(senderWantsCompleted && env.createdBy?.email
      ? [{ email: env.createdBy.email, name: env.createdBy.name ?? 'Sender' }]
      : []),
    ...signers.map((r) => ({ email: r.email, name: r.name })),
  ];
  for (const r of recipients) {
    if (!r.email) continue;
    const tmpl = envelopeCompletedTemplate({
      recipientName: r.name,
      documentTitle: env.title,
      downloadUrl,
      senderName: env.createdBy?.name ?? undefined,
      senderEmail: env.createdBy?.email ?? undefined,
      signers: signerSummaries,
      orgLogoBase64: org?.logoBase64 ?? null,
      orgLogoMimeType: org?.logoMimeType ?? null,
      orgName: org?.name,
      emailFooter: org?.emailFooter ?? undefined,
      brandColor: org?.brandColor ?? undefined,
      completedAt: env.completedAt ?? new Date(),
    });
    await sendMail({
      to: r.email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      orgId: env.orgId,
      envelopeId: env.id,
    });
  }
}

class CompletionNotReady extends Error {}
class CompletionStale extends Error {}
/** The build made inside a locked completion claim failed; `cause` is why. */
class SealBuildFailed extends Error {
  constructor(override readonly cause: unknown) {
    super('Building the sealed envelope failed');
  }
}

/** Identity and status of each recipient, as the sealed manifest records them. */
function recipientsKey(rows: Array<Pick<SealedRecipient, 'id' | 'name' | 'email' | 'role' | 'signingOrder' | 'signingStatus'>>): string {
  return JSON.stringify(
    rows
      .map((r) => [r.id, r.name, r.email, r.role, r.signingOrder, r.signingStatus])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
}

/**
 * Move the envelope to COMPLETED and store the build's precomputed
 * `envelope.completed`, only while it still awaits signatures and every
 * routing recipient has signed or been skipped. Returns `lost`, with nothing
 * written, when a decline, void or expiry got there first, or a recipient is
 * not done after all; `stale`, with nothing written, when the recipients are
 * no longer the ones the build's manifest lists or the audit chain moved past
 * the head the build sealed.
 *
 * `build` is either a finished build or a function making one for a given
 * completion time. A function is called inside the transaction after the
 * envelope row and then its audit chain are locked (the order the signing
 * commit takes them), so no event can land between the head the build seals
 * and `envelope.completed`. The completion time is taken once both locks are
 * held, so it is never earlier than an event the seal lists before it. A
 * failed build is thrown as `SealBuildFailed`.
 */
async function claimCompletion(args: {
  envelopeId: string;
  build: SealedBuild | ((completedAt: Date) => Promise<SealedBuild>);
  collect: AppendedEnvelopeEvent[];
}): Promise<{ outcome: 'claimed'; build: SealedBuild } | { outcome: 'lost' } | { outcome: 'stale' }> {
  const { envelopeId } = args;
  const buildInside = typeof args.build === 'function' ? args.build : null;
  try {
    return await commitWithEnvelopeEvents(envelopeId, async (tx, _record, recordPrepared) => {
      const { count } = await tx.envelope.updateMany({
        where: { id: envelopeId, status: { in: AWAITING_SIGNATURE } },
        data: {
          status: 'COMPLETED',
          completedAt: buildInside ? new Date() : (args.build as SealedBuild).completionEvent?.createdAt,
        },
      });
      if (count === 0) return { outcome: 'lost' as const };
      let build: SealedBuild;
      if (buildInside) {
        await lockEnvelopeChain(tx, envelopeId);
        const completedAt = new Date();
        try {
          build = await buildInside(completedAt);
        } catch (err) {
          throw new SealBuildFailed(err);
        }
        await tx.envelope.update({ where: { id: envelopeId }, data: { completedAt } });
      } else {
        build = args.build as SealedBuild;
      }
      const { completionEvent } = build;
      if (!completionEvent) throw new Error('A completion claim needs a build made with `completion`');
      // Every signature and decline commit writes the envelope row too, so
      // with its lock held this read sees each one that committed. One still
      // in flight shows its recipient as pending here (completion backs off
      // and that request completes later), or finds COMPLETED and rolls back.
      const current = await tx.recipient.findMany({
        where: { envelopeId },
        select: {
          id: true, name: true, email: true, recipientRole: true, signingOrder: true, signingStatus: true,
        },
      });
      const pending = current.some(
        (r) => (ACTIONABLE_ROLES as readonly string[]).includes(r.recipientRole)
          && !isSatisfied(r.signingStatus),
      );
      if (pending) throw new CompletionNotReady();
      const now = recipientsKey(current.map((r) => ({ ...r, role: r.recipientRole })));
      if (now !== recipientsKey(build.recipients)) throw new CompletionStale();
      // Store exactly the envelope.completed the seal already contains, and
      // only directly after the chain head the build sealed: any event
      // appended since would be missing from the seal, so rebuild instead.
      if (!(await recordPrepared(completionEvent))) throw new CompletionStale();
      return { outcome: 'claimed' as const, build };
    }, { collect: args.collect, ...(buildInside ? { timeoutMs: LOCKED_COMPLETION_TIMEOUT_MS } : {}) });
  } catch (err) {
    if (err instanceof CompletionNotReady) return { outcome: 'lost' };
    if (err instanceof CompletionStale) return { outcome: 'stale' };
    throw err;
  }
}

/**
 * Finish sealing an envelope whose signers are all done but which has no
 * sealed document: COMPLETED without one (storing it failed after the
 * claim, or the envelope completed before build-then-claim existed), or
 * still SENT / IN_PROGRESS because the seal could not be built. For the
 * envelope's sender (owner) or an ADMIN, from the envelope page.
 *
 * Safe to run any number of times, concurrently or not: persisting is
 * idempotent and only the attempt that stores the seal sends completion
 * emails. Throws a message fit for the sender when sealing fails again.
 */
export async function retryEnvelopeSealing(args: {
  ctx: AuthnContext;
  envelopeId: string;
}): Promise<'sealed' | 'already_sealed'> {
  const env = await prisma.envelope.findFirst({
    where: { id: args.envelopeId, orgId: args.ctx.orgId, deletedAt: null },
    include: { recipients: true },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:correct', { orgId: env.orgId, createdById: env.createdById });

  if (env.status === 'COMPLETED') {
    const existing = await prisma.sealedDocument.findUnique({
      where: { envelopeId: env.id },
      select: { id: true },
    });
    if (existing) return 'already_sealed';
    const events: AppendedEnvelopeEvent[] = [];
    try {
      let build: SealedBuild;
      try {
        build = await buildSealedEnvelope({ envelopeId: env.id });
      } catch (err) {
        await recordSealFailure(env.id, 'build', err, events);
        throw new Error(sealFailureMessage(err));
      }
      const persisted = await persistAndNotify(build, events);
      if (persisted.outcome === 'failed') throw new Error(sealFailureMessage(persisted.error));
      if (persisted.outcome === 'not_completed') throw new Error('This envelope is not waiting to be sealed.');
      return persisted.outcome;
    } finally {
      await publishEnvelopeEvents(events);
    }
  }

  const routing = env.recipients.filter((r) => (ACTIONABLE_ROLES as readonly string[]).includes(r.recipientRole));
  if (!AWAITING_SIGNATURE.includes(env.status) || !routing.every((r) => isSatisfied(r.signingStatus))) {
    throw new Error('This envelope is not waiting to be sealed.');
  }
  const { result, error } = await completeEnvelope(env.id, { actorUserId: args.ctx.userId });
  if (result.sealFailed) throw new Error(sealFailureMessage(error));
  if (result.envelopeStatus === 'COMPLETED') return 'sealed';
  // The claim lost: a concurrent retry or signature completed it first, or a
  // decline, void or expiry closed it.
  const now = await prisma.envelope.findUnique({ where: { id: env.id }, select: { status: true } });
  if (now?.status === 'COMPLETED') return 'already_sealed';
  throw new Error('This envelope changed meanwhile and is no longer waiting to be sealed. Reload to see its current state.');
}

/**
 * Mint a fresh single-use token for a recipient and pin it on their row.
 * Used by the in-app sign flow and the public-form submit path so the
 * caller can hand the visitor a working signing URL without an email
 * round-trip. Pins tokenJti to the newly minted jti so any previously
 * emailed/shared link for this recipient stops working immediately — see
 * comments in /dashboard/envelopes/sign-now-actions.ts for the security
 * rationale.
 */
export async function mintFreshTokenForRecipient(args: {
  envelopeId: string;
  recipientId: string;
}): Promise<{ token: string }> {
  const recipient = await prisma.recipient.findUnique({
    where: { id: args.recipientId },
    include: { envelope: { select: { expiresAt: true } } },
  });
  if (!recipient || recipient.envelopeId !== args.envelopeId) throw new Error('Recipient not found');
  const minted = await mintSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
    notAfter: recipient.envelope.expiresAt,
  });
  const pinned = await pinSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
    expect: { email: recipient.email, tokenJti: recipient.tokenJti },
    minted,
  });
  if (!pinned) throw new RecipientChangedError(RECIPIENT_CHANGED_MESSAGE);
  return { token: minted.token };
}

/**
 * Point a pending recipient row at a different person: rewrite the identity,
 * reset send / read / consent state (consent is per-person and legally
 * meaningful) and the access-code lockout (it counts the previous holder's
 * wrong guesses), revoke every outstanding link by pinning a freshly minted jti
 * (or clearing it when no invite follows), and append `event` — all in one
 * transaction, so the identity change is never committed without its audit
 * event or while the previous holder's link still works. The invite email is
 * sent only after that commit.
 *
 * The write only matches while the row is still pending, on this envelope and
 * still addressed to `from.email` (what the caller checked) and, when the
 * caller acts through a signing link, still pinned to that link's
 * `from.tokenJti`; otherwise a concurrent sign, decline, reassignment,
 * removal or re-pin won, and this throws `RecipientChangedError` with nothing
 * written and no invite sent.
 */
export async function rebindRecipient(args: {
  recipientId: string;
  from: { email: string; tokenJti?: string };
  to: { email: string; name: string };
  data?: Prisma.RecipientUpdateManyMutationInput;
  event: RecordEnvelopeEventArgs;
  invite: Omit<DispatchArgs, 'recipientId' | 'recipientEmail' | 'recipientName'> | null;
}): Promise<void> {
  const minted = args.invite
    ? await mintSigningToken({
        envelopeId: args.invite.envelopeId,
        recipientId: args.recipientId,
        notAfter: args.invite.expiresAt,
      })
    : null;
  await commitWithEnvelopeEvents(args.event.envelopeId, async (tx, record) => {
    const { count } = await tx.recipient.updateMany({
      where: {
        id: args.recipientId,
        envelopeId: args.event.envelopeId,
        signingStatus: 'NOT_SIGNED',
        email: args.from.email,
        ...(args.from.tokenJti !== undefined ? { tokenJti: args.from.tokenJti } : {}),
      },
      data: {
        ...args.data,
        email: args.to.email,
        name: args.to.name,
        sendStatus: 'NOT_SENT',
        sentAt: null,
        readStatus: 'NOT_OPENED',
        openedAt: null,
        consentGivenAt: null,
        consentDisclosureVersion: null,
        // The access-code lockout counts the previous holder's wrong guesses;
        // the new person starts with a clean slate, not their lock.
        accessCodeFailedAttempts: 0,
        accessCodeLockedUntil: null,
        accessCodeLockouts: 0,
        tokenJti: minted?.jti ?? null,
        currentTokenExpiresAt: minted?.expiresAt ?? null,
      },
    });
    if (count === 0) throw new RecipientChangedError(RECIPIENT_CHANGED_MESSAGE);
    await record(args.event);
  });
  if (args.invite && minted) {
    await deliverSigningInvite({
      ...args.invite,
      recipientId: args.recipientId,
      recipientEmail: args.to.email,
      recipientName: args.to.name,
    }, minted);
  }
}

/**
 * Reassign a pending recipient to a different email. Mutates the existing
 * recipient row in place — the original email is recorded in the audit
 * event, so the chain preserves who was originally invited. Mints a fresh
 * signing token bound to the new email and dispatches an invite. Caller
 * must already have validated that the original recipient holds a valid
 * signing token (they're acting from inside the ceremony); `jti` is that
 * token's, and the rebind only applies while the row is still pinned to it.
 */
export async function reassignRecipient(args: {
  envelopeId: string;
  recipientId: string;
  /** jti of the signing token that authorised this reassignment. */
  jti: string;
  newEmail: string;
  newName: string;
  reason?: string;
  ipAddress: string;
  userAgent: string;
}): Promise<{ token: string }> {
  const recipient = await prisma.recipient.findUnique({
    where: { id: args.recipientId },
    include: { envelope: { include: { createdBy: true, org: true, meta: true } } },
  });
  if (!recipient) throw new Error('Recipient not found');
  if (recipient.envelopeId !== args.envelopeId) throw new Error('Envelope mismatch');
  if (recipient.signingStatus !== 'NOT_SIGNED') {
    throw new Error('Only pending recipients can be reassigned');
  }

  const to = { email: args.newEmail.toLowerCase().trim(), name: args.newName.trim() };
  await rebindRecipient({
    recipientId: args.recipientId,
    from: { email: recipient.email, tokenJti: args.jti },
    to,
    data: { ipAddress: args.ipAddress, userAgent: args.userAgent },
    event: {
      envelopeId: args.envelopeId,
      type: 'recipient.reassigned',
      actorRecipientId: args.recipientId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: {
        fromEmail: recipient.email,
        fromName: recipient.name,
        toEmail: to.email,
        toName: to.name,
        reason: args.reason ?? null,
      },
    },
    invite: {
      envelopeId: args.envelopeId,
      orgId: recipient.envelope.orgId,
      senderName: recipient.envelope.createdBy?.name ?? 'A DocuRidge sender',
      documentTitle: recipient.envelope.title,
      message: recipient.envelope.message ?? undefined,
      expiresAt: recipient.envelope.expiresAt ?? undefined,
      emailSubjectOverride: recipient.envelope.meta?.emailSubject ?? undefined,
      emailFooter: recipient.envelope.org?.emailFooter ?? undefined,
      brandColor: recipient.envelope.org?.brandColor ?? undefined,
    },
  });

  return { token: 'dispatched' };
}

/**
 * Delete a pending recipient and its fields (fields can't be filled by anyone
 * else) together with `event`. The recipient delete only matches while the
 * row is still pending on this envelope; if a concurrent request signed,
 * declined or removed it first, this throws `RecipientChangedError` and the
 * field deletes roll back with it.
 */
export async function removePendingRecipient(args: {
  envelopeId: string;
  recipientId: string;
  event: RecordEnvelopeEventArgs;
}): Promise<void> {
  await commitWithEnvelopeEvents(args.envelopeId, async (tx, record) => {
    // Field rows reference the recipient (onDelete: Restrict), so they go
    // first; attachments cascade with their field, comments SetNull.
    await tx.field.deleteMany({ where: { recipientId: args.recipientId } });
    const { count } = await tx.recipient.deleteMany({
      where: { id: args.recipientId, envelopeId: args.envelopeId, signingStatus: 'NOT_SIGNED' },
    });
    if (count === 0) {
      throw new RecipientChangedError(
        'This recipient signed or changed before the removal could be saved, so nothing was removed. Reload to see the current state.',
      );
    }
    await record(args.event);
  });
}

/**
 * Decline on behalf of the holder of `jti`. Like the signing commit, the
 * recipient write only matches while the row is pending and still pinned to
 * that link, and the envelope write only while it still awaits signatures;
 * when either matches nothing (a signature, another decline, a void, an
 * expiry or a completion won), this throws `RecipientChangedError` and the
 * whole transaction, event included, rolls back.
 */
export async function declineEnvelope(args: {
  envelopeId: string;
  recipientId: string;
  /** jti of the signing token that authorised this decline. */
  jti: string;
  reason: string;
  ipAddress: string;
  userAgent: string;
}): Promise<void> {
  await commitWithEnvelopeEvents(args.envelopeId, async (tx, record) => {
    const now = new Date();
    const declined = await tx.recipient.updateMany({
      where: heldBy(args),
      data: {
        signingStatus: 'DECLINED',
        declinedAt: now,
        declineReason: args.reason,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      },
    });
    if (declined.count === 0) throw new RecipientChangedError(LINK_NO_LONGER_VALID_MESSAGE);
    const closed = await tx.envelope.updateMany({
      where: { id: args.envelopeId, status: { in: AWAITING_SIGNATURE } },
      data: { status: 'DECLINED', declinedAt: now },
    });
    if (closed.count === 0) throw new RecipientChangedError(ENVELOPE_CLOSED_MESSAGE);
    await record({
      envelopeId: args.envelopeId,
      type: 'recipient.declined',
      actorRecipientId: args.recipientId,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: { reason: args.reason },
    });
  });
}

export async function voidEnvelope(args: {
  ctx: AuthnContext;
  envelopeId: string;
  reason: string;
}): Promise<void> {
  const env = await prisma.envelope.findFirst({
    where: { id: args.envelopeId, orgId: args.ctx.orgId, deletedAt: null },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:void', { orgId: env.orgId, createdById: env.createdById });
  if (env.status === 'COMPLETED' || env.status === 'VOIDED') {
    throw new Error('Envelope cannot be voided in its current state');
  }
  await commitWithEnvelopeEvents(env.id, async (tx, record) => {
    // Re-check under the row lock: a completion that committed since the
    // read above wins, and the void writes nothing.
    const { count } = await tx.envelope.updateMany({
      where: { id: env.id, status: { notIn: ['COMPLETED', 'VOIDED'] } },
      data: { status: 'VOIDED', voidedAt: new Date(), voidReason: args.reason },
    });
    if (count === 0) throw new Error('Envelope cannot be voided in its current state');
    await record({
      envelopeId: env.id,
      type: 'envelope.voided_by_sender',
      actorUserId: args.ctx.userId,
      data: { reason: args.reason },
    });
  });
}

async function loadFullEnvelope(envelopeId: string) {
  return prisma.envelope.findUnique({
    where: { id: envelopeId },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      fields: { include: { attachment: true } },
      meta: true,
    },
  });
}


/**
 * Read a user's notification preferences and return true if the named event
 * is opted-in. Defaults to true when the prefs row is missing or unparseable.
 */
function wantsNotification(prefs: unknown, event: 'sentForSignature' | 'recipientSigned' | 'completed' | 'declined'): boolean {
  if (!prefs || typeof prefs !== 'object') return true;
  const r = prefs as Record<string, unknown>;
  return r[event] !== false;
}
