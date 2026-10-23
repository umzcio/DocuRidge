'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hashToken, verifyToken } from '@/lib/auth/tokens';
import { verifyPassword } from '@/lib/auth/argon';
import { reserveLoginAttempt, clearFailedAttempts } from '@/lib/auth/lockout';
import { captureClientContext } from '@/lib/auth/session';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { checkRateLimit } from '@/lib/ratelimit';
import { childLogger } from '@/lib/logger';

export interface VerifyEmailState {
  ok: boolean;
  error?: string;
  fieldErrors?: { password?: string };
}

const INVALID = 'This verification link is invalid or has expired.';

/**
 * Consume an email-verification link. The link alone is not enough: the
 * clicker must also give the password chosen at registration, so a link
 * mailed for someone else's sign-up cannot activate their password on this
 * address. Owners who never chose that password reset it instead, which also
 * verifies the address.
 */
export async function confirmEmailAction(
  _prev: VerifyEmailState,
  formData: FormData,
): Promise<VerifyEmailState> {
  const log = childLogger({ action: 'verify_email' });
  const { ipAddress, userAgent } = captureClientContext(await headers());

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'login');
  if (!rl.allowed) {
    return { ok: false, error: 'Too many attempts. Try again in a minute.' };
  }

  const parsed = z
    .object({ token: z.string().min(1), password: z.string().min(1, 'Password is required') })
    .safeParse({ token: formData.get('token'), password: formData.get('password') });
  if (!parsed.success) {
    const password = parsed.error.errors.find((e) => e.path[0] === 'password')?.message;
    return password ? { ok: false, fieldErrors: { password } } : { ok: false, error: INVALID };
  }
  const { token, password } = parsed.data;

  const verified = await verifyToken(token, 'email_verification');
  if (!verified) return { ok: false, error: INVALID };
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: await hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now() || row.userId !== verified.userId) {
    return { ok: false, error: INVALID };
  }

  const user = await prisma.user.findUnique({
    where: { id: verified.userId },
    select: { id: true, passwordHash: true, deletedAt: true },
  });
  if (!user || user.deletedAt || !user.passwordHash) return { ok: false, error: INVALID };

  const reservation = await reserveLoginAttempt(user.id);
  if (!reservation.allowed) {
    return { ok: false, error: 'Too many attempts. Try again later, or reset your password.' };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    log.info({ userId: user.id }, 'verification refused — password mismatch');
    return {
      ok: false,
      error:
        "That isn't the password this account was registered with. If you didn't create this account, reset its password instead.",
    };
  }
  await clearFailedAttempts(user.id);

  const now = new Date();
  await prisma.$transaction([
    prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: now },
    }),
  ]);

  await recordUserSecurityEvent({ userId: user.id, type: 'email_verified', ipAddress, userAgent });
  log.info({ userId: user.id }, 'email verified');

  redirect('/login?verified=1');
}
