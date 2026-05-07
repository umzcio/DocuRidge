'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { childLogger } from '@/lib/logger';

export interface WebhookActionState {
  ok: boolean;
  error?: string;
  success?: string;
  /** Newly created webhook secret — surfaced to the admin exactly once. */
  revealedSecret?: string;
}

const CreateSchema = z.object({
  url: z.string()
    .trim()
    .max(500)
    .url('Webhook URL must be absolute (https://example.com/webhook)')
    .refine((u) => /^https?:/.test(u), 'Webhook URL must use http(s)'),
  description: z.string().trim().max(200).optional(),
});

/**
 * Create a webhook subscription. Generates a random 32-byte hex secret
 * server-side and surfaces it ONCE in the action state — the admin must
 * copy it now; the secret is hashed-by-receiver verification only and we
 * deliberately don't expose a "show again" path. Admin-only.
 */
export async function createWebhookAction(
  _prev: WebhookActionState,
  formData: FormData,
): Promise<WebhookActionState> {
  const log = childLogger({ action: 'webhook_create' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  if (session.role !== 'ADMIN') return { ok: false, error: 'Only org admins can manage webhooks.' };

  const parsed = CreateSchema.safeParse({
    url: formData.get('url'),
    description: formData.get('description') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  const secret = randomBytes(32).toString('hex');
  const sub = await prisma.webhookSubscription.create({
    data: {
      orgId: session.orgId,
      url: parsed.data.url,
      events: [], // empty = all events for v1
      secret,
      enabled: true,
    },
  });
  log.info({ id: sub.id, url: sub.url }, 'webhook created');
  revalidatePath('/dashboard/settings');
  return { ok: true, success: 'Webhook created.', revealedSecret: secret };
}

/**
 * Toggle a webhook's enabled flag. Pause without losing config.
 */
export async function toggleWebhookAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  if (session.role !== 'ADMIN') throw new Error('Only org admins can manage webhooks.');
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('Webhook ID required.');
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id, orgId: session.orgId },
    select: { enabled: true },
  });
  if (!sub) throw new Error('Webhook not found.');
  await prisma.webhookSubscription.update({
    where: { id },
    data: { enabled: !sub.enabled },
  });
  revalidatePath('/dashboard/settings');
}

/**
 * Delete a webhook subscription and its delivery history.
 */
export async function deleteWebhookAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  if (session.role !== 'ADMIN') throw new Error('Only org admins can manage webhooks.');
  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('Webhook ID required.');
  const sub = await prisma.webhookSubscription.findFirst({
    where: { id, orgId: session.orgId },
    select: { id: true },
  });
  if (!sub) throw new Error('Webhook not found.');
  await prisma.webhookSubscription.delete({ where: { id } });
  revalidatePath('/dashboard/settings');
}
