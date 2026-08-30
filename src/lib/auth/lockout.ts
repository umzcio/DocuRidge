import { prisma } from '../prisma';
import { getEnv } from '../env';
import { recordUserSecurityEvent } from '../audit/user-security';

export interface LockoutState {
  locked: boolean;
  /** ISO timestamp the lockout ends, if locked. */
  lockedUntil?: Date;
}

const DEFAULT_LOCKOUT_WINDOW_MINUTES = 15;

/**
 * Whether a new failure continues the current series or starts a fresh one.
 *
 * Measured from the first failure of the series, so an unrelated write to the
 * user row cannot extend the window, and a long-idle account starts counting
 * from zero again.
 */
export function isWithinLockoutWindow(
  firstFailedAttemptAt: Date | null,
  windowMinutes: number,
  now: Date = new Date(),
): boolean {
  if (firstFailedAttemptAt === null) return false;

  const effectiveWindowMinutes =
    Number.isFinite(windowMinutes) && windowMinutes > 0
      ? windowMinutes
      : DEFAULT_LOCKOUT_WINDOW_MINUTES;

  const windowMs = effectiveWindowMinutes * 60 * 1000;
  const elapsedMs = now.getTime() - firstFailedAttemptAt.getTime();

  // A future firstFailedAttemptAt (clock skew) must not suppress counting
  // forever, so treat it the same as "outside the window".
  if (elapsedMs < 0) return false;

  return elapsedMs < windowMs;
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
    select: { id: true, failedAttempts: true, lockedUntil: true, firstFailedAttemptAt: true },
  });
  if (!user) return { locked: false };

  const now = new Date();
  const continuingSeries = isWithinLockoutWindow(
    user.firstFailedAttemptAt,
    env.LOCKOUT_WINDOW_MINUTES,
    now,
  );

  let attempts: number;
  if (continuingSeries) {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    attempts = updated.failedAttempts;
  } else {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: 1, firstFailedAttemptAt: now },
      select: { failedAttempts: true },
    });
    attempts = updated.failedAttempts;
  }

  const shouldLock = attempts >= env.LOCKOUT_MAX_ATTEMPTS;

  if (shouldLock) {
    const lockedUntil = new Date(now.getTime() + env.LOCKOUT_DURATION_MINUTES * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil },
    });

    await recordUserSecurityEvent({
      userId: user.id,
      type: 'lockout_triggered',
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      data: { attempts, until: lockedUntil.toISOString() },
    });
    return { locked: true, lockedUntil };
  }
  return { locked: false };
}

export async function clearFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedAttempts: 0, lockedUntil: null, firstFailedAttemptAt: null },
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
