'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { getSession } from '@/lib/auth/session';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/authz/can';
import { generateApiToken } from '@/lib/api/auth';
import { childLogger } from '@/lib/logger';

export interface ApiTokenActionState {
  ok: boolean;
  error?: string;
  /** Newly created token plaintext — surfaced to the admin exactly once. */
  revealedToken?: string;
  revealedName?: string;
}

const CreateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(100, 'Name is too long.'),
  scopes: z
    .array(z.enum(['read', 'write']))
    .min(1, 'Select at least one scope.'),
  expiresInDays: z
    .string()
    .optional()
    .refine((v) => v === undefined || v === '' || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 3650), {
      message: 'Expiration must be between 1 and 3650 days.',
    }),
});

/**
 * Create an org API token. The plaintext is generated server-side and
 * returned in the action state exactly once — only its SHA-256 is persisted.
 * Admin-only, mirroring the branding/webhooks gating (`org:update_settings`).
 */
export async function createApiTokenAction(
  _prev: ApiTokenActionState,
  formData: FormData,
): Promise<ApiTokenActionState> {
  const log = childLogger({ action: 'api_token_create' });
  const session = await getSession();
  if (!session) return { ok: false, error: 'Sign in required.' };
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  if (!can(ctx, 'org:update_settings', { orgId: session.orgId })) {
    return { ok: false, error: 'Only org admins can manage API tokens.' };
  }

  const scopesRaw = formData.getAll('scopes').map(String);
  const parsed = CreateSchema.safeParse({
    name: formData.get('name'),
    scopes: scopesRaw,
    expiresInDays: formData.get('expiresInDays') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? 'Invalid input.' };
  }

  // De-duplicate and order scopes deterministically.
  const scopes = Array.from(new Set(parsed.data.scopes)).join(',');
  const { plaintext, tokenHash } = generateApiToken();
  const expiresAt =
    parsed.data.expiresInDays && parsed.data.expiresInDays !== ''
      ? new Date(Date.now() + Number(parsed.data.expiresInDays) * 24 * 60 * 60 * 1000)
      : null;

  const token = await prisma.apiToken.create({
    data: {
      orgId: session.orgId,
      userId: session.user.id,
      name: parsed.data.name,
      scopes,
      tokenHash,
      expiresAt,
    },
  });
  log.info({ id: token.id, orgId: token.orgId }, 'API token created');
  revalidatePath('/dashboard/admin');
  return { ok: true, revealedToken: plaintext, revealedName: token.name };
}

/**
 * Revoke an org API token. Admin-only; scoped to the caller's org.
 */
export async function revokeApiTokenAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) throw new Error('Sign in required.');
  const ctx = { userId: session.user.id, orgId: session.orgId, role: session.role };
  if (!can(ctx, 'org:update_settings', { orgId: session.orgId })) {
    throw new Error('Only org admins can manage API tokens.');
  }

  const id = String(formData.get('id') ?? '');
  if (!id) throw new Error('Token ID required.');
  const token = await prisma.apiToken.findFirst({
    where: { id, orgId: session.orgId },
    select: { id: true, revokedAt: true },
  });
  if (!token) throw new Error('Token not found.');
  if (!token.revokedAt) {
    await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
  }
  revalidatePath('/dashboard/admin');
}
