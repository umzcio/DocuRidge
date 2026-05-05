'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getSession } from '@/lib/auth/session';
import { instantiateTemplate } from '@/lib/templates/service';
import { sendEnvelope } from '@/lib/envelopes/lifecycle';
import { childLogger } from '@/lib/logger';

export interface InstantiateState {
  ok: boolean;
  error?: string;
}

export async function instantiateTemplateAction(
  _prev: InstantiateState,
  formData: FormData,
): Promise<InstantiateState> {
  const log = childLogger({ action: 'template_instantiate' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };

  const RolesSchema = z.record(
    z.string().min(1),
    z.object({
      name: z.string().trim().min(1, 'Name is required').max(120),
      email: z.string().trim().toLowerCase().email('Enter a valid email').max(320),
    }),
  );

  let parsed;
  try {
    parsed = z
      .object({
        templateId: z.string().min(1),
        roleMappings: RolesSchema,
      })
      .parse({
        templateId: formData.get('templateId'),
        roleMappings: JSON.parse(String(formData.get('roleMappings') ?? '{}')),
      });
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.errors[0]?.message ?? 'Invalid input' : 'Invalid input';
    return { ok: false, error: msg };
  }

  let envelopeId: string;
  try {
    const result = await instantiateTemplate({
      ctx,
      templateId: parsed.templateId,
      roleMappings: parsed.roleMappings,
    });
    envelopeId = result.envelopeId;
    await sendEnvelope({ ctx, envelopeId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to instantiate template';
    log.error({ err: message, templateId: parsed.templateId }, 'instantiate failed');
    return { ok: false, error: message };
  }
  redirect(`/dashboard/envelopes/${envelopeId}`);
}
