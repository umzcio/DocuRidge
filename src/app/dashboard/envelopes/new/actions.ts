'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession, captureClientContext } from '@/lib/auth/session';
import {
  createDraft,
  addEnvelopeFile,
  addRecipient,
  addField,
  setEnvelopeItemPageCount,
} from '@/lib/envelopes/service';
import { sendEnvelope } from '@/lib/envelopes/lifecycle';
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
      type: z.enum(['SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'CHECKBOX', 'NAME', 'EMAIL']),
      page: z.coerce.number().int().min(1).max(2000),
      x: z.coerce.number().min(0).max(1),
      y: z.coerce.number().min(0).max(1),
      w: z.coerce.number().min(0.005).max(1),
      h: z.coerce.number().min(0.005).max(1),
      required: z.coerce.boolean().optional().default(true),
    }),
  )
  .min(1, 'Place at least one field on a document');

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

const Schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  message: z.string().max(2000).optional(),
  recipientName: nameSchema,
  recipientEmail: emailSchema,
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

  // Multiple <input name="document"> entries → File[].
  const files = formData.getAll('document').filter((v): v is File => v instanceof File && v.size > 0);
  if (files.length === 0) {
    return { ok: false, error: 'Attach at least one PDF.' };
  }

  let parsedDocs: z.infer<typeof DocumentsSchema>;
  let parsedFields: z.infer<typeof FieldsSchema>;
  try {
    parsedDocs = DocumentsSchema.parse(JSON.parse(String(formData.get('documents') ?? '[]')));
    parsedFields = FieldsSchema.parse(JSON.parse(String(formData.get('fields') ?? '[]')));
  } catch (err) {
    return { ok: false, error: 'Builder data is invalid. Please reload and try again.' };
  }

  if (files.length !== parsedDocs.length) {
    return {
      ok: false,
      error: `Document mismatch: got ${files.length} files but ${parsedDocs.length} document descriptors.`,
    };
  }

  const parsed = Schema.safeParse({
    title: formData.get('title'),
    message: formData.get('message') || undefined,
    recipientName: formData.get('recipientName'),
    recipientEmail: formData.get('recipientEmail'),
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

  // Validate every field references a known document and a page within that document.
  const docByClientId = new Map(parsedDocs.map((d) => [d.clientId, d]));
  for (const f of parsedFields) {
    const d = docByClientId.get(f.documentClientId);
    if (!d) {
      return { ok: false, error: `A field references an unknown document.` };
    }
    if (f.page < 1 || f.page > d.pageCount) {
      return { ok: false, error: `Field on page ${f.page} of ${d.filename}, but that document has only ${d.pageCount} page${d.pageCount === 1 ? '' : 's'}.` };
    }
  }

  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  let envelopeId: string;
  try {
    const env = await createDraft(ctx, { title: input.title, message: input.message });
    envelopeId = env.id;

    // Insert documents in the order the user added them. Pair each with the
    // matching `documents` descriptor by index so we can map clientId → itemId.
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

    const recipient = await addRecipient({
      ctx,
      envelopeId: env.id,
      email: input.recipientEmail,
      name: input.recipientName,
    });

    for (const f of parsedFields) {
      const itemId = itemByClientId.get(f.documentClientId);
      if (!itemId) continue; // shouldn't happen — validated above
      await addField({
        ctx,
        envelopeItemId: itemId,
        recipientId: recipient.id,
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
