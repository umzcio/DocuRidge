import { prisma } from '../prisma';
import { getEnv } from '../env';
import { recordUserSecurityEvent } from '../audit/user-security';

export interface LockoutState {
  locked: boolean;
  /** ISO timestamp the lockout ends, if locked. */
  lockedUntil?: Date;
}

/**
 * Increment failed-attempt counter. If we cross LOCKOUT_MAX_ATTEMPTS within
 * LOCKOUT_WINDOW_MINUTES, set lockedUntil and record an audit event.
 * Returns the resulting state.
 */
export async function recordFailedAttempt(args: {
  userId: string;
  ipAddress: string;
  userAgent: string;
}): Promise<LockoutState> {
  const env = getEnv();
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { id: true, failedAttempts: true, lockedUntil: true, updatedAt: true },
  });
  if (!user) return { locked: false };

  const windowMs = env.LOCKOUT_WINDOW_MINUTES * 60 * 1000;
  const now = Date.now();
  const updatedAtMs = user.updatedAt.getTime();
  const insideWindow = now - updatedAtMs < windowMs;

  const nextAttempts = insideWindow ? user.failedAttempts + 1 : 1;
  const shouldLock = nextAttempts >= env.LOCKOUT_MAX_ATTEMPTS;

  const lockedUntil = shouldLock
    ? new Date(now + env.LOCKOUT_DURATION_MINUTES * 60 * 1000)
    : null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedAttempts: nextAttempts,
      lockedUntil,
    },
  });

  if (shouldLock && lockedUntil) {
    await recordUserSecurityEvent({
      userId: user.id,
      type: 'lockout_triggered',
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: { attempts: nextAttempts, until: lockedUntil.toISOString() },
    });
    return { locked: true, lockedUntil };
  }
  return { locked: false };
}

export async function clearFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}

export async function isLockedOut(userId: string): Promise<LockoutState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lockedUntil: true },
  });
  if (!user || !user.lockedUntil) return { locked: false };
  if (user.lockedUntil.getTime() > Date.now()) {
    return { locked: true, lockedUntil: user.lockedUntil };
  }
  return { locked: false };
}
