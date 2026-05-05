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

const FieldsSchema = z
  .array(
    z.object({
      id: z.string(),
      documentClientId: z.string(),
      recipientClientId: z.string(),
      type: z.enum(['SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'CHECKBOX', 'NAME', 'EMAIL']),
      page: z.coerce.number().int().min(1).max(2000),
      x: z.coerce.number().min(0).max(1),
      y: z.coerce.number().min(0).max(1),
      w: z.coerce.number().min(0.005).max(1),
      h: z.coerce.number().min(0.005).max(1),
      required: z.coerce.boolean().optional().default(true),
    }),
  )
  .min(1, 'Place at least one field');

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

const RecipientsSchema = z
  .array(
    z.object({
      clientId: z.string(),
      name: nameSchema,
      email: emailSchema,
      signingOrder: z.coerce.number().int().min(1).max(50),
    }),
  )
  .min(1, 'Add at least one recipient')
  .max(50);

const Schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  message: z.string().max(2000).optional(),
  routingMode: z.enum(['SEQUENTIAL', 'PARALLEL']).default('SEQUENTIAL'),
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

  let parsedDocs: z.infer<typeof DocumentsSchema>;
  let parsedFields: z.infer<typeof FieldsSchema>;
  let parsedRecipients: z.infer<typeof RecipientsSchema>;
  try {
    parsedDocs = DocumentsSchema.parse(JSON.parse(String(formData.get('documents') ?? '[]')));
    parsedFields = FieldsSchema.parse(JSON.parse(String(formData.get('fields') ?? '[]')));
    parsedRecipients = RecipientsSchema.parse(JSON.parse(String(formData.get('recipients') ?? '[]')));
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
    routingMode: formData.get('routingMode') || 'SEQUENTIAL',
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

  // Each SIGNER recipient must have at least one assigned field (matches the
  // sendEnvelope check; we surface it pre-flight for a better error).
  for (const r of parsedRecipients) {
    const has = parsedFields.some((f) => f.recipientClientId === r.clientId);
    if (!has) {
      return { ok: false, error: `Recipient "${r.name || r.email}" has no fields assigned.` };
    }
  }

  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  let envelopeId: string;
  try {
    const env = await createDraft(ctx, { title: input.title, message: input.message });
    envelopeId = env.id;

    if (input.routingMode === 'PARALLEL') {
      await prisma.envelope.update({
        where: { id: env.id },
        data: { routingMode: 'PARALLEL' },
      });
    }

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
      });
      recipientByClientId.set(r.clientId, created.id);
    }

    for (const f of parsedFields) {
      const itemId = itemByClientId.get(f.documentClientId);
      const recipientId = recipientByClientId.get(f.recipientClientId);
      if (!itemId || !recipientId) continue; // shouldn't happen — validated above
      await addField({
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
      });
    }

    await sendEnvelope({ ctx, envelopeId: env.id });
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
