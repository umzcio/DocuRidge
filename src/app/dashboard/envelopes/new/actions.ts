'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSession, captureClientContext } from '@/lib/auth/session';
import {
  createDraft,
  addEnvelopeFile,
  addRecipient,
  addField,
  setEnvelopeItemPageCount,
} from '@/lib/envelopes/service';
import { sendEnvelope } from '@/lib/envelopes/lifecycle';
import { prisma } from '@/lib/prisma';
import { childLogger } from '@/lib/logger';
import { UploadValidationError } from '@/lib/storage';
import { emailSchema, nameSchema } from '@/lib/auth/passwords';

export interface CreateEnvelopeState {
  ok: boolean;
  envelopeId?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const FieldItemSchema = z.object({
  id: z.string(),
  documentClientId: z.string(),
  recipientClientId: z.string(),
  type: z.enum([
    'SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'NUMBER', 'CHECKBOX',
    'NAME', 'EMAIL', 'JOB_TITLE', 'PHONE', 'ADDRESS', 'COMPANY',
    'DROPDOWN', 'RADIO', 'FORMULA', 'ATTACHMENT',
    'APPROVE', 'DECLINE', 'NOTE', 'LINE', 'STAMP',
  ]),
  page: z.coerce.number().int().min(1).max(2000),
  x: z.coerce.number().min(0).max(1),
  y: z.coerce.number().min(0).max(1),
  w: z.coerce.number().min(0.005).max(1),
  h: z.coerce.number().min(0.005).max(1),
  required: z.coerce.boolean().optional().default(true),
  defaultValue:    z.string().max(2000).optional(),
  readOnly:        z.coerce.boolean().optional(),
  charLimit:       z.coerce.number().int().min(1).max(10000).optional(),
  pattern:         z.string().max(500).optional(),
  patternMessage:  z.string().max(200).optional(),
  min:             z.coerce.number().optional(),
  max:             z.coerce.number().optional(),
  dataLabel:       z.string().max(120).optional(),
  options:         z.array(z.string().min(1).max(120)).max(50).optional(),
  formula:         z.string().max(2000).optional(),
  noteText:        z.string().max(2000).optional(),
  stampImageBase64: z.string().max(300_000).optional(),
  stampMimeType:    z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  condition:       z.object({
    whenFieldId:   z.string().min(1),
    equals:        z.string().max(2000),
  }).optional(),
});
const FieldsSchemaSend = z.array(FieldItemSchema).min(1, 'Place at least one field');
const FieldsSchemaSave = z.array(FieldItemSchema);

const DocumentsSchema = z
  .array(
    z.object({
      clientId: z.string(),
      filename: z.string().min(1),
      pageCount: z.coerce.number().int().min(1).max(2000),
      order: z.coerce.number().int().min(1).max(50),
    }),
  )
  .min(1, 'Add at least one PDF');

const RecipientItemSchema = z.object({
  clientId: z.string(),
  name: nameSchema,
  email: emailSchema,
  signingOrder: z.coerce.number().int().min(1).max(50),
  role: z.enum(['SIGNER', 'CC', 'APPROVER', 'WITNESS', 'IN_PERSON_SIGNER']).optional().default('SIGNER'),
  condition: z.object({
    whenFieldId: z.string().min(1),
    equals: z.string().max(2000),
  }).optional(),
});
const RecipientsSchemaSend = z.array(RecipientItemSchema).min(1, 'Add at least one recipient').max(50);
const RecipientsSchemaSave = z.array(RecipientItemSchema).max(50);

const Schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  message: z.string().max(2000).optional(),
  emailSubject: z.string().trim().max(200).optional(),
  routingMode: z.enum(['SEQUENTIAL', 'PARALLEL']).default('SEQUENTIAL'),
  autoReminders: z.coerce.boolean().default(true),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
  intent: z.enum(['send', 'save']).default('send'),
});

export async function createAndSendEnvelopeAction(
  _prev: CreateEnvelopeState,
  formData: FormData,
): Promise<CreateEnvelopeState> {
  const log = childLogger({ action: 'envelope_create_and_send' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const headerStore = await headers();
  const { ipAddress } = captureClientContext(headerStore);

  const files = formData.getAll('document').filter((v): v is File => v instanceof File && v.size > 0);
  if (files.length === 0) {
    return { ok: false, error: 'Attach at least one PDF.' };
  }

  const intent = (formData.get('intent') ?? 'send') === 'save' ? 'save' : 'send';

  let parsedDocs: z.infer<typeof DocumentsSchema>;
  let parsedFields: z.infer<typeof FieldsSchemaSend>;
  let parsedRecipients: z.infer<typeof RecipientsSchemaSend>;
  try {
    parsedDocs = DocumentsSchema.parse(JSON.parse(String(formData.get('documents') ?? '[]')));
    const fieldsSchema = intent === 'save' ? FieldsSchemaSave : FieldsSchemaSend;
    const recipientsSchema = intent === 'save' ? RecipientsSchemaSave : RecipientsSchemaSend;
    parsedFields = fieldsSchema.parse(JSON.parse(String(formData.get('fields') ?? '[]')));
    parsedRecipients = recipientsSchema.parse(JSON.parse(String(formData.get('recipients') ?? '[]')));
  } catch (err) {
    return { ok: false, error: 'Builder data is invalid. Please reload and try again.' };
  }

  if (files.length !== parsedDocs.length) {
    return {
      ok: false,
      error: `Document mismatch: got ${files.length} files but ${parsedDocs.length} document descriptors.`,
    };
  }

  // Recipient emails must be unique within an envelope.
  const seenEmails = new Set<string>();
  for (const r of parsedRecipients) {
    const e = r.email.toLowerCase();
    if (seenEmails.has(e)) {
      return { ok: false, error: `Recipient email "${r.email}" is duplicated.` };
    }
    seenEmails.add(e);
  }

  const parsed = Schema.safeParse({
    title: formData.get('title'),
    message: formData.get('message') || undefined,
    emailSubject: formData.get('emailSubject') || undefined,
    routingMode: formData.get('routingMode') || 'SEQUENTIAL',
    autoReminders: formData.get('autoReminders') ?? 'true',
    expiresInDays: formData.get('expiresInDays') || undefined,
    intent: formData.get('intent') || 'send',
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.errors) {
      const key = String(issue.path[0]);
      fieldErrors[key] = issue.message;
    }
    return { ok: false, fieldErrors, error: 'Please fix the highlighted fields.' };
  }
  const input = parsed.data;

  // Validate every field references a known document and recipient.
  const docByClientId = new Map(parsedDocs.map((d) => [d.clientId, d]));
  const recByClientId = new Map(parsedRecipients.map((r) => [r.clientId, r]));
  for (const f of parsedFields) {
    const d = docByClientId.get(f.documentClientId);
    if (!d) return { ok: false, error: 'A field references an unknown document.' };
    if (f.page < 1 || f.page > d.pageCount) {
      return {
        ok: false,
        error: `Field on page ${f.page} of ${d.filename}, but that document has ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}.`,
      };
    }
    if (!recByClientId.has(f.recipientClientId)) {
      return { ok: false, error: 'A field references an unknown recipient.' };
    }
  }

  // Each SIGNER recipient must have at least one assigned field when sending.
  // For 'save' intent we skip this — drafts can be incomplete. CC recipients
  // are never required to have fields.
  if (intent === 'send') {
    for (const r of parsedRecipients) {
      if (r.role === 'CC') continue;
      const has = parsedFields.some((f) => f.recipientClientId === r.clientId);
      if (!has) {
        return { ok: false, error: `Recipient "${r.name || r.email}" has no fields assigned.` };
      }
    }
  }

  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  let envelopeId: string;
  try {
    const env = await createDraft(ctx, { title: input.title, message: input.message });
    envelopeId = env.id;

    // Persist routing + expiry + email subject + reminder cadence.
    const envelopeUpdate: { routingMode?: 'PARALLEL' | 'SEQUENTIAL'; expiresAt?: Date } = {};
    if (input.routingMode === 'PARALLEL') envelopeUpdate.routingMode = 'PARALLEL';
    if (input.expiresInDays) {
      envelopeUpdate.expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
    }
    if (Object.keys(envelopeUpdate).length > 0) {
      await prisma.envelope.update({ where: { id: env.id }, data: envelopeUpdate });
    }

    // Persist email subject + reminder toggle on the envelope_meta row.
    const reminderSettings = input.autoReminders
      ? { daysBeforeFirst: 3, daysBetween: 3, maxReminders: 3 }
      : { daysBeforeFirst: 0, daysBetween: 0, maxReminders: 0 };
    await prisma.envelopeMeta.upsert({
      where: { envelopeId: env.id },
      update: {
        reminderSettings,
        emailSubject: input.emailSubject ?? null,
      },
      create: {
        envelopeId: env.id,
        reminderSettings,
        emailSubject: input.emailSubject ?? null,
      },
    });

    const itemByClientId = new Map<string, string>();
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const desc = parsedDocs[i]!;
      const buffer = Buffer.from(await file.arrayBuffer());
      const { item } = await addEnvelopeFile({
        ctx,
        envelopeId: env.id,
        buffer,
        declaredMime: file.type || 'application/pdf',
        filename: desc.filename || file.name,
      });
      await setEnvelopeItemPageCount({
        ctx,
        envelopeItemId: item.id,
        pageCount: desc.pageCount,
      });
      itemByClientId.set(desc.clientId, item.id);
    }

    const recipientByClientId = new Map<string, string>();
    for (const r of parsedRecipients) {
      const created = await addRecipient({
        ctx,
        envelopeId: env.id,
        email: r.email,
        name: r.name,
        signingOrder: r.signingOrder,
        role: r.role,
      });
      recipientByClientId.set(r.clientId, created.id);
    }

    // First pass: create every field. We capture the clientId → dbId mapping
    // so we can fix up cross-field references (Conditional logic) in a
    // second pass — at parse time the client only knows its own UUIDs.
    const fieldClientIdToDbId = new Map<string, string>();
    for (const f of parsedFields) {
      const itemId = itemByClientId.get(f.documentClientId);
      const recipientId = recipientByClientId.get(f.recipientClientId);
      if (!itemId || !recipientId) continue; // shouldn't happen — validated above
      const created = await addField({
        ctx,
        envelopeItemId: itemId,
        recipientId,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        w: f.w,
        h: f.h,
        required: f.required ?? true,
        defaultValue: f.defaultValue,
        meta: {
          readOnly: f.readOnly,
          charLimit: f.charLimit,
          pattern: f.pattern,
          patternMessage: f.patternMessage,
          min: f.min,
          max: f.max,
          dataLabel: f.dataLabel,
          options: f.options,
          formula: f.formula, // remapped in pass 2
          noteText: f.noteText,
          stampImageBase64: f.stampImageBase64,
          stampMimeType: f.stampMimeType,
        },
      });
      fieldClientIdToDbId.set(f.id, created.id);
    }

    // Build a quick lookup of dataLabel → dbId so formula refs that use a
    // human-readable label get rewritten to DB ids too.
    const dataLabelToDbId = new Map<string, string>();
    for (const f of parsedFields) {
      if (!f.dataLabel) continue;
      const dbId = fieldClientIdToDbId.get(f.id);
      if (dbId) dataLabelToDbId.set(f.dataLabel.trim(), dbId);
    }
    /**
     * Rewrite `{token}` refs inside a formula. token may be either a client-side
     * UUID (form-time) or a sender-supplied dataLabel; both resolve to the same
     * source field's DB id. Unknown tokens are preserved verbatim so the sender
     * sees the broken ref in their builder rather than a silent NaN.
     */
    function rewriteFormulaRefs(src: string): string {
      return src.replace(/\{([^}]+)\}/g, (_match, raw: string) => {
        const key = raw.trim();
        const byClientId = fieldClientIdToDbId.get(key);
        if (byClientId) return `{${byClientId}}`;
        const byLabel = dataLabelToDbId.get(key);
        if (byLabel) return `{${byLabel}}`;
        return `{${key}}`;
      });
    }

    // Second pass: cross-field reference remapping. Both Conditional logic
    // (`condition.whenFieldId`) and FORMULA expressions reference other fields
    // by client UUID at form time; rewrite both to DB ids now that the full
    // map is known.
    for (const f of parsedFields) {
      const dbId = fieldClientIdToDbId.get(f.id);
      if (!dbId) continue;
      const needsCondition = !!f.condition;
      const needsFormula = !!f.formula;
      if (!needsCondition && !needsFormula) continue;
      const existing = await prisma.field.findUnique({ where: { id: dbId }, select: { meta: true } });
      const merged: Record<string, unknown> = {
        ...((existing?.meta && typeof existing.meta === 'object') ? existing.meta as Record<string, unknown> : {}),
      };
      if (needsCondition) {
        const sourceDbId = fieldClientIdToDbId.get(f.condition!.whenFieldId);
        if (sourceDbId) {
          merged.condition = { whenFieldId: sourceDbId, equals: f.condition!.equals };
        } else {
          // Source was filtered out — drop the rule rather than orphan it.
          delete merged.condition;
        }
      }
      if (needsFormula) {
        merged.formula = rewriteFormulaRefs(f.formula!);
      }
      await prisma.field.update({
        where: { id: dbId },
        data: { meta: merged as Prisma.InputJsonValue },
      });
    }

    // Persist per-recipient conditional-routing rules. Same shape as the
    // field condition: source is a DB field id, equals is the trigger value.
    for (const r of parsedRecipients) {
      if (!r.condition) continue;
      const recipientDbId = recipientByClientId.get(r.clientId);
      const sourceDbId = fieldClientIdToDbId.get(r.condition.whenFieldId);
      if (!recipientDbId || !sourceDbId) continue;
      await prisma.recipient.update({
        where: { id: recipientDbId },
        data: {
          meta: { condition: { whenFieldId: sourceDbId, equals: r.condition.equals } } as Prisma.InputJsonValue,
        },
      });
    }

    if (input.intent === 'send') {
      // CC-only envelopes can't be sent (need at least one signer with fields).
      // The fields-per-recipient validation above already guarantees signers
      // got fields, so just send.
      await sendEnvelope({ ctx, envelopeId: env.id });
    }
    // intent === 'save' leaves the envelope as DRAFT and redirects.
  } catch (err) {
    if (err instanceof UploadValidationError) {
      log.warn({ code: err.code }, 'upload validation failed');
      return { ok: false, error: err.message };
    }
    const message = err instanceof Error ? err.message : 'Failed to create envelope';
    log.error({ err: message, ipAddress }, 'envelope creation failed');
    return { ok: false, error: message };
  }

  redirect(`/dashboard/envelopes/${envelopeId}`);
}
