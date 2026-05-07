import { Prisma, EnvelopeStatus, FieldType, RecipientRole } from '@prisma/client';
import { prisma } from '../prisma';
import { authorize, type AuthnContext } from '../authz/can';
import { recordEnvelopeEvent } from '../audit/envelope';
import { saveUploadedPdf, scanFile, UploadValidationError } from '../storage';
import { childLogger } from '../logger';

const log = childLogger({ module: 'envelope-service' });

export interface CreateDraftArgs {
  title: string;
  message?: string;
}

export async function createDraft(ctx: AuthnContext, args: CreateDraftArgs) {
  authorize(ctx, 'envelope:create', { orgId: ctx.orgId, createdById: ctx.userId });

  const env = getDefaultEnvelopeTtlMs();
  const envelope = await prisma.envelope.create({
    data: {
      orgId: ctx.orgId,
      createdById: ctx.userId,
      type: 'DOCUMENT',
      status: 'DRAFT',
      title: args.title,
      message: args.message ?? null,
      expiresAt: new Date(Date.now() + env),
      meta: { create: {} },
    },
  });

  await recordEnvelopeEvent({
    envelopeId: envelope.id,
    type: 'envelope.created',
    actorUserId: ctx.userId,
    data: { title: envelope.title },
  });
  return envelope;
}

export async function addEnvelopeFile(args: {
  ctx: AuthnContext;
  envelopeId: string;
  buffer: Buffer;
  declaredMime: string;
  filename: string;
}) {
  const env = await loadEnvelopeForMutation(args.ctx, args.envelopeId);

  let stored;
  try {
    stored = await saveUploadedPdf({
      orgId: args.ctx.orgId,
      buffer: args.buffer,
      declaredMime: args.declaredMime,
    });
  } catch (e) {
    if (e instanceof UploadValidationError) throw e;
    throw e;
  }
  const scanStatus = await scanFile(args.buffer);

  const docFile = await prisma.documentFile.create({
    data: {
      orgId: args.ctx.orgId,
      storageType: 'LOCAL_FS',
      storagePath: stored.relativePath,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      uploadedById: args.ctx.userId,
      scanStatus,
      scannedAt: new Date(),
    },
  });

  // pageCount is filled in lazily during build; the builder UI loads it
  // from pdfjs and updates the row.
  const lastOrder = await prisma.envelopeItem.aggregate({
    where: { envelopeId: env.id },
    _max: { order: true },
  });
  const order = (lastOrder._max.order ?? 0) + 1;

  const item = await prisma.envelopeItem.create({
    data: {
      envelopeId: env.id,
      documentFileId: docFile.id,
      order,
      title: args.filename,
      pageCount: 0,
    },
  });

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.field_added', // re-using the broader type; specific events come in Phase 3
    actorUserId: args.ctx.userId,
    data: { documentFileId: docFile.id, sha256: stored.sha256, sizeBytes: stored.sizeBytes },
  });
  return { item, docFile };
}

export async function setEnvelopeItemPageCount(args: {
  ctx: AuthnContext;
  envelopeItemId: string;
  pageCount: number;
}) {
  const item = await prisma.envelopeItem.findUnique({
    where: { id: args.envelopeItemId },
    include: { envelope: true },
  });
  if (!item || item.envelope.orgId !== args.ctx.orgId) {
    throw new Error('Envelope item not found');
  }
  await loadEnvelopeForMutation(args.ctx, item.envelopeId);
  await prisma.envelopeItem.update({
    where: { id: item.id },
    data: { pageCount: Math.max(1, args.pageCount | 0) },
  });
}

export interface AddRecipientArgs {
  ctx: AuthnContext;
  envelopeId: string;
  email: string;
  name: string;
  role?: RecipientRole;
  signingOrder?: number;
}

export async function addRecipient(args: AddRecipientArgs) {
  const env = await loadEnvelopeForMutation(args.ctx, args.envelopeId);
  const lastOrder = await prisma.recipient.aggregate({
    where: { envelopeId: env.id },
    _max: { signingOrder: true },
  });
  const signingOrder = args.signingOrder ?? (lastOrder._max.signingOrder ?? 0) + 1;

  const recipient = await prisma.recipient.create({
    data: {
      envelopeId: env.id,
      email: args.email.toLowerCase().trim(),
      name: args.name.trim(),
      recipientRole: args.role ?? 'SIGNER',
      signingOrder,
    },
  });

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.recipient_added',
    actorUserId: args.ctx.userId,
    data: { recipientId: recipient.id, email: recipient.email, name: recipient.name },
  });
  return recipient;
}

export interface AddFieldArgs {
  ctx: AuthnContext;
  envelopeItemId: string;
  recipientId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required?: boolean;
  defaultValue?: string;
  meta?: FieldMeta;
}

/** Sender-configured per-field properties. Stored in `Field.meta` JSON. */
export interface FieldMeta {
  readOnly?: boolean;
  charLimit?: number;
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  dataLabel?: string;
  /** DROPDOWN / RADIO: the set of values the recipient picks from. */
  options?: string[];
  /** FORMULA: expression evaluated against other fields' values. */
  formula?: string;
  /** NOTE: static annotation text rendered on the document. */
  noteText?: string;
  /** STAMP: sender-uploaded image (base64, no data: prefix). */
  stampImageBase64?: string;
  /** STAMP: MIME type of the uploaded image. */
  stampMimeType?: string;
  /**
   * Conditional visibility — field only renders / is enforced when the
   * value of `whenFieldId` equals `equals`. `whenFieldId` is the DB Field id.
   */
  condition?: { whenFieldId: string; equals: string };
}

export async function addField(args: AddFieldArgs) {
  const item = await prisma.envelopeItem.findUnique({
    where: { id: args.envelopeItemId },
    include: { envelope: true },
  });
  if (!item || item.envelope.orgId !== args.ctx.orgId) {
    throw new Error('Envelope item not found');
  }
  const env = await loadEnvelopeForMutation(args.ctx, item.envelopeId);

  // Recipient must belong to the same envelope.
  const recipient = await prisma.recipient.findUnique({
    where: { id: args.recipientId },
  });
  if (!recipient || recipient.envelopeId !== env.id) {
    throw new Error('Recipient not found in this envelope');
  }

  // Bounds check fractional coords.
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp01(args.x);
  const y = clamp01(args.y);
  const w = clamp01(args.w);
  const h = clamp01(args.h);
  if (x + w > 1.0001 || y + h > 1.0001) {
    throw new Error('Field extends past page bounds');
  }

  const field = await prisma.field.create({
    data: {
      envelopeId: env.id,
      envelopeItemId: item.id,
      recipientId: recipient.id,
      type: args.type,
      page: Math.max(1, args.page | 0),
      x: new Prisma.Decimal(x),
      y: new Prisma.Decimal(y),
      w: new Prisma.Decimal(w),
      h: new Prisma.Decimal(h),
      required: args.required ?? true,
      defaultValue: args.defaultValue ?? null,
      meta: args.meta && hasAnyMeta(args.meta) ? (args.meta as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });

  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.field_added',
    actorUserId: args.ctx.userId,
    data: { fieldId: field.id, type: field.type, page: field.page, recipientId: recipient.id },
  });
  return field;
}

function hasAnyMeta(m: FieldMeta): boolean {
  return Object.values(m).some((v) => v !== undefined && v !== null && v !== '');
}

export async function removeField(args: {
  ctx: AuthnContext;
  fieldId: string;
}) {
  const field = await prisma.field.findUnique({
    where: { id: args.fieldId },
    include: { envelope: true },
  });
  if (!field || field.envelope.orgId !== args.ctx.orgId) {
    throw new Error('Field not found');
  }
  const env = await loadEnvelopeForMutation(args.ctx, field.envelopeId);
  await prisma.field.delete({ where: { id: field.id } });
  await recordEnvelopeEvent({
    envelopeId: env.id,
    type: 'envelope.field_removed',
    actorUserId: args.ctx.userId,
    data: { fieldId: args.fieldId },
  });
}

export async function getEnvelopeForOwner(ctx: AuthnContext, envelopeId: string) {
  const env = await prisma.envelope.findFirst({
    where: { id: envelopeId, orgId: ctx.orgId, deletedAt: null },
    include: {
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
      meta: true,
    },
  });
  if (!env) return null;
  authorize(ctx, 'envelope:read', { orgId: env.orgId, createdById: env.createdById });
  return env;
}

async function loadEnvelopeForMutation(ctx: AuthnContext, envelopeId: string) {
  const env = await prisma.envelope.findFirst({
    where: { id: envelopeId, orgId: ctx.orgId, deletedAt: null },
  });
  if (!env) throw new Error('Envelope not found');
  authorize(ctx, 'envelope:update', { orgId: env.orgId, createdById: env.createdById });
  if (env.status !== 'DRAFT') {
    throw new Error('Envelope is not editable in its current state');
  }
  return env;
}

function getDefaultEnvelopeTtlMs(): number {
  return 30 * 24 * 60 * 60 * 1000;
}

export { EnvelopeStatus };
