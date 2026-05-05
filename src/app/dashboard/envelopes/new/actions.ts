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
      type: z.enum(['SIGNATURE', 'INITIALS', 'DATE', 'TEXT', 'CHECKBOX', 'NAME', 'EMAIL']),
      page: z.coerce.number().int().min(1).max(2000),
      x: z.coerce.number().min(0).max(1),
      y: z.coerce.number().min(0).max(1),
      w: z.coerce.number().min(0.01).max(1),
      h: z.coerce.number().min(0.01).max(1),
      required: z.coerce.boolean().optional(),
    }),
  )
  .min(1, 'Add at least one field');

const Schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  message: z.string().max(2000).optional(),
  recipientName: nameSchema,
  recipientEmail: emailSchema,
  pageCount: z.coerce.number().int().min(1).max(2000),
  fields: FieldsSchema,
});

export async function createAndSendEnvelopeAction(
  _prev: CreateEnvelopeState,
  formData: FormData,
): Promise<CreateEnvelopeState> {
  const log = childLogger({ action: 'envelope_create_and_send' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const file = formData.get('document');
  if (!(file instanceof File)) {
    return { ok: false, error: 'Please attach a PDF.' };
  }

  const fieldsRaw = formData.get('fields');
  let parsedFields: unknown;
  try {
    parsedFields = JSON.parse(typeof fieldsRaw === 'string' ? fieldsRaw : '[]');
  } catch {
    return { ok: false, error: 'Field placement data is invalid.' };
  }

  const parsed = Schema.safeParse({
    title: formData.get('title'),
    message: formData.get('message') || undefined,
    recipientName: formData.get('recipientName'),
    recipientEmail: formData.get('recipientEmail'),
    pageCount: formData.get('pageCount'),
    fields: parsedFields,
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

  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  let envelopeId: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const env = await createDraft(ctx, { title: input.title, message: input.message });
    envelopeId = env.id;

    const { item } = await addEnvelopeFile({
      ctx,
      envelopeId: env.id,
      buffer,
      declaredMime: file.type || 'application/pdf',
      filename: file.name || `${input.title}.pdf`,
    });
    await setEnvelopeItemPageCount({
      ctx,
      envelopeItemId: item.id,
      pageCount: input.pageCount,
    });

    const recipient = await addRecipient({
      ctx,
      envelopeId: env.id,
      email: input.recipientEmail,
      name: input.recipientName,
    });

    for (const f of input.fields) {
      await addField({
        ctx,
        envelopeItemId: item.id,
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
