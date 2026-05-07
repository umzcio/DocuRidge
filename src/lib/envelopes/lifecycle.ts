import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authorize, type AuthnContext } from '../authz/can';
import { mintSigningToken, verifySigningToken } from '../signing/token';
import { recordEnvelopeEvent } from '../audit/envelope';
import { evaluateFormula, formatFormulaValue } from '../formula/eval';
import { sendMail } from '../mail';
import { envelopeSentTemplate, envelopeCompletedTemplate, envelopeReminderTemplate } from '../email/templates';
import { getEnv } from '../env';
import { childLogger } from '../logger';
import { sealEnvelope } from '../pdf/seal';

const log = childLogger({ module: 'envelope-lifecycle' });

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
      items: true,
      meta: true,
    },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:send', { orgId: env.orgId, createdById: env.createdById });
  if (env.status !== 'DRAFT') {
    throw new Error('Envelope must be in DRAFT to send');
  }
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

  const initialRecipients =
    env.routingMode === 'PARALLEL'
      ? actionableRecipients
      : actionableRecipients.slice(0, 1);

  await prisma.envelope.update({
    where: { id: env.id },
    data: { status: 'SENT', sentAt: new Date() },
  });
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.sent',
    actorUserId: args.ctx.userId,
    data: { routingMode: env.routingMode, recipientCount: env.recipients.length },
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
    });
  }

  // Move from SENT to IN_PROGRESS the moment we've dispatched at least one invite.
  await prisma.envelope.update({
    where: { id: env.id },
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

  // Find the next pending actionable recipient (SIGNER / WITNESS /
  // IN_PERSON_SIGNER / APPROVER). Sequential = lowest-ordered NOT_SIGNED.
  const nextSigner = env.recipients.find(
    (r) => (r.recipientRole === 'SIGNER' || r.recipientRole === 'APPROVER'
            || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER')
      && r.signingStatus === 'NOT_SIGNED',
  );
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
  const minted = await mintSigningToken({ envelopeId: env.id, recipientId: nextSigner.id });
  await prisma.recipient.update({
    where: { id: nextSigner.id },
    data: {
      sendStatus: 'SENT',
      sentAt: new Date(),
      currentTokenExpiresAt: minted.expiresAt,
      lastReminderSentAt: new Date(),
    },
  });

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

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: result.delivered ? 'email.sent' : 'email.failed',
    actorUserId: args.ctx.userId,
    actorRecipientId: nextSigner.id,
    actorEmail: nextSigner.email,
    data: { reminder: true, messageId: result.messageId },
  });

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

async function dispatchSigningInvite(args: DispatchArgs) {
  const minted = await mintSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
  });
  await prisma.recipient.update({
    where: { id: args.recipientId },
    data: {
      sendStatus: 'SENT',
      sentAt: new Date(),
      currentTokenExpiresAt: minted.expiresAt,
    },
  });

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
  if (recipient.tokenJti && recipient.tokenJti !== claims.jti) {
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

export async function recordRecipientOpened(args: {
  envelopeId: string;
  recipientId: string;
  jti: string;
  ipAddress: string;
  userAgent: string;
}): Promise<void> {
  const result = await prisma.recipient.update({
    where: { id: args.recipientId },
    data: {
      readStatus: 'OPENED',
      openedAt: new Date(),
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      // Pin the jti as soon as the recipient opens — single-use clamp.
      tokenJti: args.jti,
    },
  });
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'recipient.opened',
    actorRecipientId: args.recipientId,
    actorEmail: result.email,
    actorName: result.name,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
}

export async function recordConsent(args: {
  envelopeId: string;
  recipientId: string;
  ipAddress: string;
  userAgent: string;
  disclosureVersion: string;
}): Promise<void> {
  await prisma.recipient.update({
    where: { id: args.recipientId },
    data: {
      consentGivenAt: new Date(),
      consentDisclosureVersion: args.disclosureVersion,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    },
  });
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'recipient.consent_given',
    actorRecipientId: args.recipientId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    data: { disclosureVersion: args.disclosureVersion },
  });
}

/**
 * Submit field values + signature image. Atomically writes Field.value rows,
 * captures the Signature, marks the Recipient as SIGNED, and either
 * advances to the next recipient or completes (sealing) the envelope.
 */
export async function completeRecipientSigning(args: {
  envelopeId: string;
  recipientId: string;
  ipAddress: string;
  userAgent: string;
  fieldValues: Record<string, string>;
  signatureImagePngBase64?: string;
  typedSignature?: string;
  signatureFont?: string;
  initialsImagePngBase64?: string;
  typedInitials?: string;
  initialsFont?: string;
}): Promise<{ envelopeStatus: 'IN_PROGRESS' | 'COMPLETED' }> {
  const recipient = await prisma.recipient.findUnique({
    where: { id: args.recipientId },
    include: { envelope: { include: { recipients: true, fields: true, items: true } } },
  });
  if (!recipient || recipient.envelopeId !== args.envelopeId) {
    throw new Error('Recipient not found');
  }

  // Persist field values and the signature.
  const fields = recipient.envelope.fields.filter((f) => f.recipientId === recipient.id);

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
    if (meta.pattern) {
      try {
        if (!new RegExp(meta.pattern).test(v)) {
          throw new Error(meta.patternMessage || `Field "${f.type}" does not match required format`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Field')) throw e;
        // Bad sender-supplied regex — log + accept, don't block the recipient.
      }
    }
  }

  await prisma.$transaction(async (tx) => {
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

    await tx.recipient.update({
      where: { id: recipient.id },
      data: {
        signingStatus: 'SIGNED',
        signedAt: new Date(),
      },
    });

    // If this recipient is a registered DocuRidge user, save the adopted
    // signature/initials as their default so future ceremonies pre-fill.
    // Email match is the only key we have at this layer — no consent
    // checkbox: storing your own adoption is implicit. Settings → Signatures
    // exposes a Clear button if they want to drop it.
    const matchingUser = await tx.user.findUnique({
      where: { email: recipient.email.toLowerCase() },
      select: { id: true },
    });
    if (matchingUser) {
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
  });

  for (const f of fields) {
    const v = args.fieldValues[f.id];
    if (v !== undefined) {
      await recordEnvelopeEvent({
        envelopeId: args.envelopeId,
        type: 'recipient.field_filled',
        actorRecipientId: recipient.id,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
        data: { fieldId: f.id, type: f.type },
      });
    }
  }
  await recordEnvelopeEvent({
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

  // Advance or complete.
  return advanceOrComplete(recipient.envelopeId, args.ipAddress, args.userAgent);
}

async function advanceOrComplete(
  envelopeId: string,
  ipAddress: string,
  userAgent: string,
): Promise<{ envelopeStatus: 'IN_PROGRESS' | 'COMPLETED' }> {
  const env = await prisma.envelope.findUnique({
    where: { id: envelopeId },
    include: {
      recipients: { orderBy: { signingOrder: 'asc' } },
      items: { include: { documentFile: true } },
      fields: true,
      createdBy: true,
    },
  });
  if (!env) throw new Error('Envelope vanished');

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
    await prisma.recipient.update({
      where: { id: s.id },
      data: { signingStatus: 'SKIPPED' },
    });
    await recordEnvelopeEvent({
      envelopeId: env.id,
      type: 'recipient.skipped_by_condition',
      actorRecipientId: s.id,
      data: {
        sourceFieldId: s.sourceFieldId,
        expected: s.equals,
        actual: s.actual,
      },
    });
  }
  // Re-fetch the latest actionable-recipient slice after marking skips.
  const signers = (await prisma.recipient.findMany({
    where: { envelopeId: env.id, recipientRole: { in: ['SIGNER', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER'] } },
    orderBy: { signingOrder: 'asc' },
  }));
  const remaining = signers.filter((r) => r.signingStatus === 'NOT_SIGNED');

  if (remaining.length === 0) {
    // Complete + seal.
    await sealEnvelope({ envelopeId: env.id });
    await prisma.envelope.update({
      where: { id: env.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await recordEnvelopeEvent({
      envelopeId: env.id,
      type: 'envelope.completed',
      ipAddress,
      userAgent,
    });

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
        completedAt: new Date(),
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
    return { envelopeStatus: 'COMPLETED' };
  }

  // Advance: notify the next pending signer (sequential) — parallel mode
  // already invited everyone at send time so nothing more to do.
  if (env.routingMode === 'SEQUENTIAL') {
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
    });
  }
  return { envelopeStatus: 'IN_PROGRESS' };
}

/**
 * Reassign a pending recipient to a different email. Mutates the existing
 * recipient row in place — the original email is recorded in the audit
 * event, so the chain preserves who was originally invited. Mints a fresh
 * signing token bound to the new email and dispatches an invite. Caller
 * must already have validated that the original recipient holds a valid
 * signing token (they're acting from inside the ceremony).
 */
/**
 * Mint a fresh single-use token for a recipient and pin it on their row.
 * Used by the in-app sign flow and the public-form submit path so the
 * caller can hand the visitor a working signing URL without an email
 * round-trip. Clears any prior tokenJti — see comments in
 * /dashboard/envelopes/sign-now-actions.ts for the security rationale.
 */
export async function mintFreshTokenForRecipient(args: {
  envelopeId: string;
  recipientId: string;
}): Promise<{ token: string }> {
  const minted = await mintSigningToken({
    envelopeId: args.envelopeId,
    recipientId: args.recipientId,
  });
  await prisma.recipient.update({
    where: { id: args.recipientId },
    data: { currentTokenExpiresAt: minted.expiresAt, tokenJti: null },
  });
  return { token: minted.token };
}

export async function reassignRecipient(args: {
  envelopeId: string;
  recipientId: string;
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

  const fromEmail = recipient.email;
  const fromName = recipient.name;
  const newEmailNorm = args.newEmail.toLowerCase().trim();

  await prisma.recipient.update({
    where: { id: args.recipientId },
    data: {
      email: newEmailNorm,
      name: args.newName.trim(),
      // Reset send / read state so the new person sees a fresh invite.
      sendStatus: 'NOT_SENT',
      sentAt: null,
      readStatus: 'NOT_OPENED',
      openedAt: null,
      tokenJti: null,
      currentTokenExpiresAt: null,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    },
  });

  // Audit the reassign explicitly so the original email is preserved in
  // the signed chain — losing it would otherwise muddy the trail.
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'recipient.reassigned',
    actorRecipientId: args.recipientId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    data: {
      fromEmail,
      fromName,
      toEmail: newEmailNorm,
      toName: args.newName.trim(),
      reason: args.reason ?? null,
    },
  });

  // Dispatch a fresh invite to the new address. dispatchSigningInvite
  // mints a new token, persists it on the recipient, and sends the email.
  await dispatchSigningInvite({
    envelopeId: args.envelopeId,
    orgId: recipient.envelope.orgId,
    recipientId: args.recipientId,
    recipientEmail: newEmailNorm,
    recipientName: args.newName.trim(),
    senderName: recipient.envelope.createdBy?.name ?? 'A DocuRidge sender',
    documentTitle: recipient.envelope.title,
    message: recipient.envelope.message ?? undefined,
    expiresAt: recipient.envelope.expiresAt ?? undefined,
    emailSubjectOverride: recipient.envelope.meta?.emailSubject ?? undefined,
    emailFooter: recipient.envelope.org?.emailFooter ?? undefined,
    brandColor: recipient.envelope.org?.brandColor ?? undefined,
  });

  return { token: 'dispatched' };
}

export async function declineEnvelope(args: {
  envelopeId: string;
  recipientId: string;
  reason: string;
  ipAddress: string;
  userAgent: string;
}): Promise<void> {
  await prisma.$transaction([
    prisma.recipient.update({
      where: { id: args.recipientId },
      data: {
        signingStatus: 'DECLINED',
        declinedAt: new Date(),
        declineReason: args.reason,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      },
    }),
    prisma.envelope.update({
      where: { id: args.envelopeId },
      data: { status: 'DECLINED', declinedAt: new Date() },
    }),
  ]);
  await recordEnvelopeEvent({
    envelopeId: args.envelopeId,
    type: 'recipient.declined',
    actorRecipientId: args.recipientId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
    data: { reason: args.reason },
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
  await prisma.envelope.update({
    where: { id: env.id },
    data: { status: 'VOIDED', voidedAt: new Date(), voidReason: args.reason },
  });
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.voided_by_sender',
    actorUserId: args.ctx.userId,
    data: { reason: args.reason },
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

