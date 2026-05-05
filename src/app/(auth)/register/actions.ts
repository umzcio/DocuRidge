'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { hashPassword } from '@/lib/auth/argon';
import { mintToken } from '@/lib/auth/tokens';
import { sendMail } from '@/lib/mail';
import { recordUserSecurityEvent } from '@/lib/audit/user-security';
import { childLogger } from '@/lib/logger';
import { captureClientContext } from '@/lib/auth/session';
import { checkRateLimit } from '@/lib/ratelimit';
import { emailSchema, nameSchema, passwordSchema } from '@/lib/auth/passwords';
import { getEnv } from '@/lib/env';

export interface RegisterActionState {
  ok: boolean;
  message?: string;
  error?: string;
  fieldErrors?: { name?: string; email?: string; password?: string; orgName?: string };
}

export async function registerAction(
  _prev: RegisterActionState,
  formData: FormData,
): Promise<RegisterActionState> {
  const log = childLogger({ action: 'register' });
  const headerStore = await headers();
  const { ipAddress, userAgent } = captureClientContext(headerStore);

  const rl = await checkRateLimit(`ip:${ipAddress}`, 'register');
  if (!rl.allowed) {
    return { ok: false, error: 'Too many registration attempts. Try again later.' };
  }

  const InputSchema = z.object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema(),
    orgName: z.string().trim().min(1, 'Organisation name is required').max(120),
  });

  const parsed = InputSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
    password: formData.get('password'),
    orgName: formData.get('orgName'),
  });
  if (!parsed.success) {
    return { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
  }
  const { name, email, password, orgName } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Don't reveal whether the email exists. Pretend success and log.
    log.info({ email }, 'register attempted with existing email');
    return {
      ok: true,
      message:
        'If your email is unrecognised, you will receive a verification link shortly. Otherwise sign in or use password reset.',
    };
  }

  const passwordHash = await hashPassword(password);
  const slugBase = orgName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 40) || 'org';
  const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;

  // First user becomes ADMIN of the new org. Subsequent users would be
  // invited; that flow is out of v1 scope — every new self-registered
  // account gets its own org for now.
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organisation.create({
      data: { name: orgName, slug },
    });
    const user = await tx.user.create({
      data: { email, passwordHash, name, mustResetPassword: false },
    });
    await tx.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, org };
  });

  const ttl = 24 * 60 * 60; // 24h
  const minted = await mintToken({
    userId: result.user.id,
    purpose: 'email_verification',
    ttlSeconds: ttl,
  });
  await prisma.emailVerificationToken.create({
    data: {
      userId: result.user.id,
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    },
  });

  const env = getEnv();
  const verifyUrl = `${env.PUBLIC_URL}/verify?token=${encodeURIComponent(minted.token)}`;
  await sendMail({
    to: email,
    subject: `Verify your DocuRidge email`,
    text: [
      `Hi ${name},`,
      ``,
      `Please verify your email address to complete your DocuRidge registration:`,
      verifyUrl,
      ``,
      `This link expires in 24 hours.`,
      `If you did not request this, you can safely ignore the email.`,
    ].join('\n'),
    orgId: result.org.id,
  });

  await recordUserSecurityEvent({
    userId: result.user.id,
    type: 'register_succeeded',
    ipAddress,
    userAgent,
  });
  log.info(
    { userId: result.user.id, orgId: result.org.id, email },
    'registration succeeded',
  );

  return {
    ok: true,
    message:
      'Account created. Please check your email for a verification link to finish signing up.',
  };
}

function fieldErrorsFromZod(err: z.ZodError) {
  const out: RegisterActionState['fieldErrors'] = {};
  for (const issue of err.errors) {
    const key = issue.path[0];
    if (key === 'name' || key === 'email' || key === 'password' || key === 'orgName') {
      out[key as keyof typeof out] = issue.message;
    }
  }
  return out;
}
