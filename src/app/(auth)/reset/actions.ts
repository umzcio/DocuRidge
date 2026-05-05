'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { mintToken } from '@/lib/auth/tokens';
import { sendMail } from '@/lib/mail';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { childLogger } from '@/lib/logger';
import { captureClientContext } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/ratelimit';
import { emailSchema } from '@/lib/auth/passwords';
import { getEnv } from '@/lib/env';

export interface ResetRequestState {
  ok: boolean;
  message?: string;
  error?: string;
}

export async function requestResetAction(
  _prev: ResetRequestState,
  formData: FormData,
): Promise<ResetRequestState> {
  const log = childLogger({ action: 'password_reset_request' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'password_reset');
  if (!rl.allowed) {
    return { ok: false, error: 'Too many reset attempts. Try again later.' };
  }

  const parsed = z.object({ email: emailSchema }).safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  const { email } = parsed.data;

  // Generic message regardless of whether user exists — no email-existence oracle.
  const GENERIC = 'If that email is registered, a reset link has been sent.';

  const user = await prisma.user.findUnique({
    where: { email },
    include: { memberships: true },
  });
  if (!user || user.deletedAt) {
    log.info({ email }, 'reset requested for unknown email');
    return { ok: true, message: GENERIC };
  }

  const minted = await mintToken({
    userId: user.id,
    purpose: 'password_reset',
    ttlSeconds: 60 * 60, // 1h
  });
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    },
  });

  const env = getEnv();
  const url = `${env.PUBLIC_URL}/reset/${encodeURIComponent(minted.token)}`;
  const orgId = user.memberships[0]?.orgId;
  await sendMail({
    to: email,
    subject: 'Reset your DocuRidge password',
    text: [
      `Hi ${user.name},`,
      ``,
      `A password reset was requested for your DocuRidge account. To set a new password, follow this link (valid for 1 hour):`,
      url,
      ``,
      `If you did not request this, you can safely ignore the email; your password is unchanged.`,
    ].join('\n'),
    orgId,
  });

  await recordUserSecurityEvent({
    userId: user.id,
    type: 'password_reset_requested',
    ipAddress,
    userAgent,
  });
  log.info({ userId: user.id }, 'password reset link sent');

  return { ok: true, message: GENERIC };
}
