'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { verifyDummyPassword, verifyPassword } from '@/lib/auth/argon';
import {
  createSession,
  captureClientContext,
} from '@/lib/auth/session';
import { reserveLoginAttempt, clearFailedAttempts } from '@/lib/auth/lockout';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { checkRateLimit } from '@/lib/ratelimit';
import { childLogger } from '@/lib/logger';
import { emailSchema } from '@/lib/auth/passwords';
import { getClientIp } from '@/lib/util';

export interface LoginActionState {
  ok: boolean;
  error?: string;
  fieldErrors?: { email?: string; password?: string };
}

const InputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export async function loginAction(
  _prev: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const log = childLogger({ action: 'login' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  // Rate limit by IP first.
  const rl = await checkRateLimit(`ip:${ipAddress}`, 'login');
  if (!rl.allowed) {
    log.warn({ ipAddress, count: rl.count, limit: rl.limit }, 'login rate-limited');
    return { ok: false, error: 'Too many attempts. Try again in a minute.' };
  }

  const parsed = InputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
  }

  const { email, password } = parsed.data;

  const accountRl = await checkRateLimit(`email:${email}`, 'login_account');
  if (!accountRl.allowed) {
    log.warn({ email, ipAddress, count: accountRl.count }, 'login rate-limited for account');
    return { ok: false, error: 'Too many attempts. Try again in a minute.' };
  }

  // One message for unknown, deleted, password-less, locked and wrong-password
  // alike, each after one Argon2 verify: no oracle for whether the email exists.
  const GENERIC_FAIL = 'Email or password is incorrect.';

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: true },
  });

  if (!user || user.deletedAt) {
    log.info({ email, ipAddress }, 'login attempted with unknown email');
    await verifyDummyPassword(password);
    return { ok: false, error: GENERIC_FAIL };
  }

  if (!user.passwordHash) {
    // No password set yet — bootstrap admin pre-setup, or a never-completed
    // password reset.
    log.info({ userId: user.id }, 'login blocked — no password set');
    await verifyDummyPassword(password);
    return { ok: false, error: GENERIC_FAIL };
  }

  const reservation = await reserveLoginAttempt(user.id);
  if (!reservation.allowed) {
    log.warn({ userId: user.id }, 'login blocked — account locked');
    await recordUserSecurityEvent({
      userId: user.id,
      type: 'login_failed',
      ipAddress,
      userAgent,
      data: { reason: 'locked' },
    });
    await verifyDummyPassword(password);
    return { ok: false, error: GENERIC_FAIL };
  }

  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok) {
    await recordUserSecurityEvent({
      userId: user.id,
      type: 'login_failed',
      ipAddress,
      userAgent,
      data: { reason: 'bad_password' },
    });
    if (reservation.lockedUntil) {
      await recordUserSecurityEvent({
        userId: user.id,
        type: 'lockout_triggered',
        ipAddress,
        userAgent,
        data: { attempts: reservation.attempts, until: reservation.lockedUntil.toISOString() },
      });
    }
    return { ok: false, error: GENERIC_FAIL };
  }

  await clearFailedAttempts(user.id);

  // Password OK — now we can safely return the verification-required message
  // because the caller has proved they own the account.
  if (!user.emailVerifiedAt) {
    log.info({ userId: user.id }, 'login blocked — email not verified');
    return {
      ok: false,
      error: 'Please verify your email address before signing in.',
    };
  }

  // Pick the user's first membership as the active org. v1 is single-org per user.
  const membership = user.memberships[0];
  if (!membership) {
    log.error({ userId: user.id }, 'user has no org membership');
    return { ok: false, error: 'Account is not associated with an organisation.' };
  }

  await createSession({
    userId: user.id,
    orgId: membership.orgId,
    ipAddress,
    userAgent,
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { lastSignedInAt: new Date() },
  });
  await recordUserSecurityEvent({
    userId: user.id,
    type: 'login_succeeded',
    ipAddress,
    userAgent,
  });
  log.info({ userId: user.id, orgId: membership.orgId }, 'login succeeded');

  redirect('/dashboard');
}

function fieldErrorsFromZod(err: z.ZodError): { email?: string; password?: string } {
  const out: { email?: string; password?: string } = {};
  for (const issue of err.errors) {
    const key = issue.path[0];
    if (key === 'email' || key === 'password') {
      out[key] = issue.message;
    }
  }
  return out;
}

// Re-export getClientIp so the form can show server-resolved IP debug if needed.
export { getClientIp };
