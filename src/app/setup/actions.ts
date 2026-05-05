'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/argon';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { childLogger } from '@/lib/logger';
import { sha256Hex, timingSafeEqual } from '@/lib/util';
import { passwordSchema } from '@/lib/auth/passwords';
import { captureClientContext } from '@/lib/auth/session';

export interface SetupActionState {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: { password?: string };
}

export async function setupAction(
  _prev: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  const log = childLogger({ action: 'bootstrap_setup' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const parsed = z
    .object({
      bootstrapToken: z.string().min(1, 'Token is required'),
      password: passwordSchema(),
    })
    .safeParse({
      bootstrapToken: formData.get('bootstrapToken'),
      password: formData.get('password'),
    });
  if (!parsed.success) {
    const fe: SetupActionState['fieldErrors'] = {};
    let topErr: string | undefined;
    for (const issue of parsed.error.errors) {
      if (issue.path[0] === 'password') fe.password = issue.message;
      else if (issue.path[0] === 'bootstrapToken') topErr = issue.message;
    }
    return { ok: false, fieldErrors: fe, error: topErr };
  }

  const state = await prisma.bootstrapState.findUnique({ where: { id: 1 } });
  if (!state) {
    log.error({}, 'bootstrap state row missing');
    return { ok: false, error: 'Setup is not available.' };
  }
  if (state.completedAt) {
    return { ok: false, error: 'Setup has already been completed.' };
  }

  const provided = await sha256Hex(parsed.data.bootstrapToken);
  if (!timingSafeEqual(provided, state.tokenHash)) {
    log.warn({ ipAddress }, 'bootstrap token mismatch');
    return { ok: false, error: 'Bootstrap token is incorrect.' };
  }

  if (!state.pendingAdminUserId) {
    log.error({}, 'bootstrap state has no pending admin user');
    return { ok: false, error: 'Setup is not available.' };
  }

  const admin = await prisma.user.findUnique({
    where: { id: state.pendingAdminUserId },
  });
  if (!admin) {
    return { ok: false, error: 'Pending admin user not found.' };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        mustResetPassword: false,
        emailVerifiedAt: new Date(),
      },
    }),
    prisma.bootstrapState.update({
      where: { id: 1 },
      data: { completedAt: new Date() },
    }),
  ]);

  await recordUserSecurityEvent({
    userId: admin.id,
    type: 'bootstrap_completed',
    ipAddress,
    userAgent,
  });
  log.info({ userId: admin.id }, 'bootstrap completed');

  return { ok: true, message: 'Setup complete.' };
}
