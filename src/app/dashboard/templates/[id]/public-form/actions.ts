'use server';

import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { childLogger } from '@/lib/logger';

export interface PublicFormActionState {
  ok: boolean;
  error?: string;
  token?: string | null;
}

/**
 * Toggle the public-form (PowerForms) state for a template.
 * Generates a fresh token on enable; clears it on disable so the prior
 * URL becomes immediately invalid.
 */
export async function togglePublicFormAction(
  _prev: PublicFormActionState,
  formData: FormData,
): Promise<PublicFormActionState> {
  const log = childLogger({ action: 'public_form_toggle' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };

  const templateId = String(formData.get('templateId') ?? '');
  const enable = String(formData.get('enable') ?? '') === '1';
  if (!templateId) return { ok: false, error: 'Template ID required.' };

  const tpl = await prisma.envelope.findFirst({
    where: { id: templateId, orgId: session.orgId, deletedAt: null, type: 'TEMPLATE' },
    select: { id: true, recipients: { select: { recipientRole: true } } },
  });
  if (!tpl) return { ok: false, error: 'Template not found.' };

  // Same v1 constraint as bulk send: exactly one signer recipient. The
  // public form maps the visitor to that single signer role.
  const signers = tpl.recipients.filter(
    (r) => r.recipientRole === 'SIGNER' || r.recipientRole === 'WITNESS' || r.recipientRole === 'IN_PERSON_SIGNER',
  );
  if (signers.length !== 1) {
    return { ok: false, error: 'PowerForms v1 needs templates with exactly one signing recipient.' };
  }

  const token = enable ? randomBytes(32).toString('base64url') : null;
  await prisma.envelope.update({
    where: { id: templateId },
    data: { publicFormEnabled: enable, publicFormToken: token },
  });
  log.info({ templateId, enabled: enable }, 'public form toggled');
  revalidatePath(`/dashboard/templates/${templateId}`);
  revalidatePath('/dashboard/templates');
  return { ok: true, token };
}
