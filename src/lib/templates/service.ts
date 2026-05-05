import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authorize, type AuthnContext } from '../authz/can';
import { recordEnvelopeEvent } from '../audit/envelope';
import { childLogger } from '../logger';

const log = childLogger({ module: 'templates' });

/**
 * Save an existing envelope as a reusable template.
 *
 *   - Creates a new Envelope row with type=TEMPLATE, copying:
 *     - items (the same DocumentFile is referenced — content-addressed, no re-upload)
 *     - fields (with x/y/w/h, type, page, required, defaultValue, mapped to the new recipient ids)
 *     - recipients as ROLES — recipient.name becomes the role label, recipient.email is set to a
 *       template-only placeholder so the row is well-formed but unmistakable
 *   - The source envelope is left untouched.
 *
 * The role label (Recipient.name on a TEMPLATE) is what the instantiator will see and what they
 * map real emails onto.
 */
export async function saveEnvelopeAsTemplate(args: {
  ctx: AuthnContext;
  sourceEnvelopeId: string;
  title: string;
}) {
  authorize(args.ctx, 'template:create', { orgId: args.ctx.orgId, createdById: args.ctx.userId });

  const source = await prisma.envelope.findFirst({
    where: { id: args.sourceEnvelopeId, orgId: args.ctx.orgId, deletedAt: null, type: 'DOCUMENT' },
    include: {
      items: { orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
    },
  });
  if (!source) throw new Error('Source envelope not found');
  authorize(args.ctx, 'envelope:read', { orgId: source.orgId, createdById: source.createdById });

  if (source.items.length === 0) throw new Error('Cannot template an envelope with no documents');
  if (source.recipients.length === 0) throw new Error('Cannot template an envelope with no recipients');

  const tpl = await prisma.$transaction(async (tx) => {
    const tplEnvelope = await tx.envelope.create({
      data: {
        orgId: args.ctx.orgId,
        createdById: args.ctx.userId,
        type: 'TEMPLATE',
        status: 'DRAFT',
        title: args.title,
        message: source.message ?? null,
        routingMode: source.routingMode,
        recipientPrivacy: source.recipientPrivacy,
        meta: { create: {} },
      },
    });

    // Copy items (reusing the same DocumentFile rows — content-addressed).
    const itemIdMap = new Map<string, string>();
    for (const item of source.items) {
      const created = await tx.envelopeItem.create({
        data: {
          envelopeId: tplEnvelope.id,
          documentFileId: item.documentFileId,
          order: item.order,
          title: item.title,
          pageCount: item.pageCount,
        },
      });
      itemIdMap.set(item.id, created.id);
    }

    // Copy recipients as ROLES. roleLabel = friendly name; email gets a placeholder.
    const recipientIdMap = new Map<string, string>();
    for (const r of source.recipients) {
      const roleLabel = r.roleLabel ?? r.name;
      const created = await tx.recipient.create({
        data: {
          envelopeId: tplEnvelope.id,
          email: `role-${r.signingOrder}@template.invalid`,
          name: roleLabel,
          roleLabel,
          recipientRole: r.recipientRole,
          signingOrder: r.signingOrder,
        },
      });
      recipientIdMap.set(r.id, created.id);
    }

    // Copy fields, mapping item + recipient ids.
    for (const f of source.fields) {
      const itemId = itemIdMap.get(f.envelopeItemId);
      const recipientId = recipientIdMap.get(f.recipientId);
      if (!itemId || !recipientId) continue;
      await tx.field.create({
        data: {
          envelopeId: tplEnvelope.id,
          envelopeItemId: itemId,
          recipientId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          required: f.required,
          defaultValue: f.defaultValue,
          meta: f.meta as Prisma.InputJsonValue | undefined,
        },
      });
    }

    return tplEnvelope;
  });

  log.info({ templateId: tpl.id, sourceId: source.id, userId: args.ctx.userId }, 'envelope saved as template');
  return tpl;
}

/**
 * Instantiate a template into a new DOCUMENT envelope and send it.
 *
 * `roleMappings` is keyed by the TEMPLATE's recipient.id → { name, email } for
 * the live person fulfilling that role. Every role must be supplied.
 *
 * The new envelope is created in DRAFT state, populated, then sent (transition to
 * SENT/IN_PROGRESS) by the lifecycle module.
 */
export async function instantiateTemplate(args: {
  ctx: AuthnContext;
  templateId: string;
  roleMappings: Record<string, { name: string; email: string }>;
}): Promise<{ envelopeId: string }> {
  authorize(args.ctx, 'template:instantiate', { orgId: args.ctx.orgId });

  const tpl = await prisma.envelope.findFirst({
    where: { id: args.templateId, orgId: args.ctx.orgId, deletedAt: null, type: 'TEMPLATE' },
    include: {
      items: { orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
    },
  });
  if (!tpl) throw new Error('Template not found');

  // Validate every role has a mapping.
  for (const r of tpl.recipients) {
    const m = args.roleMappings[r.id];
    if (!m || !m.name?.trim() || !m.email?.trim()) {
      throw new Error(`Missing recipient details for role "${r.roleLabel ?? r.name}"`);
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Build a snapshot of the template at instantiation time (D-021).
    const snapshot = {
      templateId: tpl.id,
      capturedAt: new Date().toISOString(),
      items: tpl.items.map((i) => ({ id: i.id, order: i.order, title: i.title, pageCount: i.pageCount, documentFileId: i.documentFileId })),
      recipients: tpl.recipients.map((r) => ({ id: r.id, roleLabel: r.roleLabel, signingOrder: r.signingOrder, recipientRole: r.recipientRole })),
      fields: tpl.fields.map((f) => ({
        id: f.id, envelopeItemId: f.envelopeItemId, recipientId: f.recipientId,
        type: f.type, page: f.page,
        x: f.x.toString(), y: f.y.toString(), w: f.w.toString(), h: f.h.toString(),
        required: f.required, defaultValue: f.defaultValue,
      })),
    };

    const env = await tx.envelope.create({
      data: {
        orgId: args.ctx.orgId,
        createdById: args.ctx.userId,
        type: 'DOCUMENT',
        status: 'DRAFT',
        title: tpl.title.replace(/ template$/i, ''),
        message: tpl.message ?? null,
        routingMode: tpl.routingMode,
        recipientPrivacy: tpl.recipientPrivacy,
        templateOriginId: tpl.id,
        templateSnapshot: snapshot as Prisma.InputJsonValue,
        meta: { create: {} },
      },
    });

    const itemIdMap = new Map<string, string>();
    for (const item of tpl.items) {
      const c = await tx.envelopeItem.create({
        data: {
          envelopeId: env.id,
          documentFileId: item.documentFileId,
          order: item.order,
          title: item.title,
          pageCount: item.pageCount,
        },
      });
      itemIdMap.set(item.id, c.id);
    }

    const recipientIdMap = new Map<string, string>();
    for (const r of tpl.recipients) {
      const m = args.roleMappings[r.id]!;
      const c = await tx.recipient.create({
        data: {
          envelopeId: env.id,
          email: m.email.toLowerCase().trim(),
          name: m.name.trim(),
          roleLabel: r.roleLabel ?? r.name,
          recipientRole: r.recipientRole,
          signingOrder: r.signingOrder,
        },
      });
      recipientIdMap.set(r.id, c.id);
    }

    for (const f of tpl.fields) {
      const itemId = itemIdMap.get(f.envelopeItemId);
      const recipientId = recipientIdMap.get(f.recipientId);
      if (!itemId || !recipientId) continue;
      await tx.field.create({
        data: {
          envelopeId: env.id,
          envelopeItemId: itemId,
          recipientId,
          type: f.type,
          page: f.page,
          x: f.x,
          y: f.y,
          w: f.w,
          h: f.h,
          required: f.required,
          defaultValue: f.defaultValue,
          meta: f.meta as Prisma.InputJsonValue | undefined,
        },
      });
    }

    return env;
  });

  await recordEnvelopeEvent({
    envelopeId: created.id,
    type: 'envelope.created',
    actorUserId: args.ctx.userId,
    data: { fromTemplate: tpl.id, fromTemplateTitle: tpl.title },
  });
  log.info({ envelopeId: created.id, templateId: tpl.id, userId: args.ctx.userId }, 'template instantiated');
  return { envelopeId: created.id };
}

export async function listTemplates(ctx: AuthnContext) {
  authorize(ctx, 'template:read', { orgId: ctx.orgId });
  return prisma.envelope.findMany({
    where: { orgId: ctx.orgId, type: 'TEMPLATE', deletedAt: null },
    orderBy: { createdAt: 'desc' },
    include: {
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      _count: { select: { fields: true, instantiations: true } },
    },
  });
}

export async function getTemplate(ctx: AuthnContext, templateId: string) {
  authorize(ctx, 'template:read', { orgId: ctx.orgId });
  return prisma.envelope.findFirst({
    where: { id: templateId, orgId: ctx.orgId, type: 'TEMPLATE', deletedAt: null },
    include: {
      items: { include: { documentFile: true }, orderBy: { order: 'asc' } },
      recipients: { orderBy: { signingOrder: 'asc' } },
      fields: true,
    },
  });
}
