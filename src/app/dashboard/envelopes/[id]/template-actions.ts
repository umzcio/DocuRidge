'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth/session';
import { saveEnvelopeAsTemplate } from '@/lib/templates/service';
import { childLogger } from '@/lib/logger';

export interface SaveTemplateState {
  ok: boolean;
  error?: string;
}

export async function saveAsTemplateAction(
  _prev: SaveTemplateState,
  formData: FormData,
): Promise<SaveTemplateState> {
  const log = childLogger({ action: 'envelope_save_as_template' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const parsed = z
    .object({
      envelopeId: z.string().min(1),
      title: z.string().trim().min(1, 'Title is required').max(200),
    })
    .safeParse({
      envelopeId: formData.get('envelopeId'),
      title: formData.get('title'),
    });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid request.' };
  }

  let templateId: string;
  try {
    const tpl = await saveEnvelopeAsTemplate({
      ctx,
      sourceEnvelopeId: parsed.data.envelopeId,
      title: parsed.data.title,
    });
    templateId = tpl.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save template';
    log.error({ err: message }, 'save-as-template failed');
    return { ok: false, error: message };
  }
  redirect(`/dashboard/templates/${templateId}`);
}
