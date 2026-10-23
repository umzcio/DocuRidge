import { prisma } from '../prisma';
import { mintToken } from './tokens';
import { sendMail } from '../mail';
import { recordUserSecurityEvent } from '../audit/user-security';
import { childLogger } from '../logger';
import { getEnv } from '../env';

export interface RegistrationRequest {
  name: string;
  email: string;
  passwordHash: string;
  orgName: string;
  ipAddress: string;
  userAgent: string;
}

export type RegistrationOutcome = 'created' | 'notified' | 'ignored';

const VERIFICATION_TTL_SECONDS = 24 * 60 * 60;

/**
 * The account-specific half of registration. registerAction runs it after the
 * response is sent, so the response and its timing are the same whether or
 * not the address already has an account; what differs goes only to the
 * mailbox.
 */
export async function completeRegistration(req: RegistrationRequest): Promise<RegistrationOutcome> {
  const log = childLogger({ module: 'registration' });
  const existing = await prisma.user.findUnique({
    where: { email: req.email },
    select: { id: true, name: true, deletedAt: true },
  });

  if (existing?.deletedAt) {
    log.info({ userId: existing.id }, 'register attempted for a deleted account');
    return 'ignored';
  }

  if (existing) {
    await sendExistingAccountNotice(req.email, existing.name);
    log.info({ userId: existing.id }, 'register attempted with existing email');
    return 'notified';
  }

  const { user, org } = await prisma.$transaction(async (tx) => {
    const org = await tx.organisation.create({
      data: { name: req.orgName, slug: orgSlug(req.orgName) },
    });
    const user = await tx.user.create({
      data: { email: req.email, passwordHash: req.passwordHash, name: req.name, mustResetPassword: false },
    });
    // Every self-registered account gets its own org and is its ADMIN.
    await tx.orgMember.create({
      data: { orgId: org.id, userId: user.id, role: 'ADMIN' },
    });
    return { user, org };
  });

  await sendVerificationLink({ userId: user.id, orgId: org.id, email: req.email, name: req.name });
  await recordUserSecurityEvent({
    userId: user.id,
    type: 'register_succeeded',
    ipAddress: req.ipAddress,
    userAgent: req.userAgent,
  });
  log.info({ userId: user.id, orgId: org.id }, 'registration succeeded');
  return 'created';
}

function orgSlug(orgName: string): string {
  const base =
    orgName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '')
      .slice(0, 40) || 'org';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sendVerificationLink(args: {
  userId: string;
  orgId: string;
  email: string;
  name: string;
}): Promise<void> {
  const minted = await mintToken({
    userId: args.userId,
    purpose: 'email_verification',
    ttlSeconds: VERIFICATION_TTL_SECONDS,
  });
  await prisma.emailVerificationToken.create({
    data: { userId: args.userId, tokenHash: minted.tokenHash, expiresAt: minted.expiresAt },
  });

  const verifyUrl = `${getEnv().PUBLIC_URL}/verify?token=${encodeURIComponent(minted.token)}`;
  await sendMail({
    to: args.email,
    subject: 'Verify your DocuRidge email',
    text: [
      `Hi ${args.name},`,
      ``,
      `Please verify your email address to complete your DocuRidge registration:`,
      verifyUrl,
      ``,
      `This link expires in 24 hours.`,
      `If you did not request this, you can safely ignore the email.`,
    ].join('\n'),
    orgId: args.orgId,
  });
}

async function sendExistingAccountNotice(email: string, name: string): Promise<void> {
  const base = getEnv().PUBLIC_URL;
  await sendMail({
    to: email,
    subject: 'Your DocuRidge account',
    text: [
      `Hi ${name},`,
      ``,
      `Someone tried to create a DocuRidge account with this address, but it already has a DocuRidge account.`,
      ``,
      `To sign in: ${base}/login`,
      `Forgotten your password? Reset it: ${base}/reset`,
      ``,
      `If this wasn't you, you can ignore this email; nothing has changed.`,
    ].join('\n'),
  });
}
