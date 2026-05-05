import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authorize, type AuthnContext } from '../authz/can';
import { mintSigningToken, verifySigningToken } from '../signing/token';
import { recordEnvelopeEvent } from '../audit/envelope';
import { sendMail } from '../mail';
import { envelopeSentTemplate, envelopeCompletedTemplate } from '../email/templates';
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
    },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(args.ctx, 'envelope:send', { orgId: env.orgId, createdById: env.createdById });
  if (env.status !== 'DRAFT') {
    throw new Error('Envelope must be in DRAFT to send');
  }
  if (env.items.length === 0) throw new Error('Envelope has no documents');
  if (env.recipients.length === 0) throw new Error('Envelope has no recipients');
  if (env.fields.filter((f) => f.required).length === 0) {
    throw new Error('Envelope has no required fields');
  }
  // Each SIGNER recipient must have at least one assigned field.
  for (const r of env.recipients.filter((rec) => rec.recipientRole === 'SIGNER')) {
    const has = env.fields.some((f) => f.recipientId === r.id);
    if (!has) throw new Error(`Recipient ${r.email} has no fields assigned`);
  }

  const initialRecipients =
    env.routingMode === 'PARALLEL'
      ? env.recipients.filter((r) => r.recipientRole === 'SIGNER')
      : env.recipients
          .filter((r) => r.recipientRole === 'SIGNER')
          .slice(0, 1);

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
  const senderName = sender?.name ?? 'A DocuRidge sender';

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
    });
  }

  // Move from SENT to IN_PROGRESS the moment we've dispatched at least one invite.
  await prisma.envelope.update({
    where: { id: env.id },
    data: { status: 'IN_PROGRESS' },
  });
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
  });
  const result = await sendMail({
    to: args.recipientEmail,
    subject: tmpl.subject,
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
  // Single-use: once tokenJti is set on the recipient, only THAT jti is
  // valid. A NEW token with a different jti is rejected.
  if (recipient.tokenJti && recipient.tokenJti !== claims.jti) {
    return { ok: false, reason: 'consumed' };
  }
  if (recipient.currentTokenExpiresAt && recipient.currentTokenExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // Sequential turn check.
  if (envelope.routingMode === 'SEQUENTIAL') {
    const earlier = envelope.recipients.filter(
      (r) =>
        r.recipientRole === 'SIGNER' &&
        r.signingOrder < recipient.signingOrder &&
        r.signingStatus !== 'SIGNED',
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

  // Required-field check: SIGNATURE/INITIALS fields are satisfied by the
  // submitted signature image OR typed signature, NOT by a value string.
  const hasSignature = !!args.signatureImagePngBase64 || !!args.typedSignature;
  for (const f of fields) {
    if (!f.required) continue;
    if (f.type === 'SIGNATURE' || f.type === 'INITIALS') {
      if (!hasSignature) {
        throw new Error(`Required field ${f.type} not filled`);
      }
      continue;
    }
    if (f.type === 'NAME' || f.type === 'EMAIL') {
      // Auto-filled — always satisfied.
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

    // One Signature row per recipient (canonical signature, reused across
    // signature fields when stamping).
    const signatureFieldId = fields.find((f) => f.type === 'SIGNATURE')?.id ?? null;
    await tx.signature.create({
      data: {
        recipientId: recipient.id,
        fieldId: signatureFieldId,
        imagePngBase64: args.signatureImagePngBase64 ?? null,
        typedSignature: args.typedSignature ?? null,
        ipAddress: args.ipAddress,
        userAgent: args.userAgent,
      },
    });

    await tx.recipient.update({
      where: { id: recipient.id },
      data: {
        signingStatus: 'SIGNED',
        signedAt: new Date(),
      },
    });
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

  const signers = env.recipients.filter((r) => r.recipientRole === 'SIGNER');
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

    // Notify sender + every signer.
    const downloadUrl = `${getEnv().PUBLIC_URL}/dashboard/envelopes/${env.id}/sealed`;
    const recipients = [
      { email: env.createdBy?.email, name: env.createdBy?.name ?? 'Sender' },
      ...signers.map((r) => ({ email: r.email, name: r.name })),
    ];
    for (const r of recipients) {
      if (!r.email) continue;
      const tmpl = envelopeCompletedTemplate({
        recipientName: r.name,
        documentTitle: env.title,
        downloadUrl,
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
    });
  }
  return { envelopeStatus: 'IN_PROGRESS' };
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
      fields: true,
      meta: true,
    },
  });
}
