'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { hashPassword } from '@/lib/auth/argon';
import { clearFailedAttempts } from '@/lib/auth/lockout';
import { revokeAllSessionsForUser, captureClientContext } from '@/lib/auth/session';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { childLogger } from '@/lib/logger';
import { passwordSchema } from '@/lib/auth/passwords';

export interface ResetCompleteState {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: { password?: string };
}

export async function completeResetAction(
  _prev: ResetCompleteState,
  formData: FormData,
): Promise<ResetCompleteState> {
  const log = childLogger({ action: 'password_reset_complete' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const parsed = z
    .object({ token: z.string().min(1), password: passwordSchema() })
    .safeParse({ token: formData.get('token'), password: formData.get('password') });
  if (!parsed.success) {
    const fieldErrors: ResetCompleteState['fieldErrors'] = {};
    for (const issue of parsed.error.errors) {
      if (issue.path[0] === 'password') fieldErrors.password = issue.message;
    }
    return { ok: false, fieldErrors, error: !fieldErrors.password ? 'Invalid request.' : undefined };
  }

  const verified = await verifyToken(parsed.data.token, 'password_reset');
  if (!verified) {
    return { ok: false, error: 'This reset link is invalid or has expired.' };
  }
  const tokenHash = await hashToken(parsed.data.token);
  const row = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) {
    return { ok: false, error: 'This reset link is invalid or has expired.' };
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { tokenHash },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: verified.userId },
      data: { passwordHash, mustResetPassword: false },
    }),
  ]);
  await clearFailedAttempts(verified.userId);
  await revokeAllSessionsForUser(verified.userId);
  await recordUserSecurityEvent({
    userId: verified.userId,
    type: 'password_reset_completed',
    ipAddress,
    userAgent,
  });
  log.info({ userId: verified.userId }, 'password reset completed');

  return {
    ok: true,
    message: 'Password updated.',
  };
}
