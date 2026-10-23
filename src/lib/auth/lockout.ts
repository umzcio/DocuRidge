import { prisma } from '../prisma';
import { getEnv } from '../env';

export type LoginAttemptReservation =
  | { allowed: true; attempts: number; lockedUntil: Date | null }
  | { allowed: false };

/**
 * Reserve one password comparison for this account, before the comparison
 * runs. The attempt is counted as a failure up front and only cleared by a
 * successful sign-in, so a concurrent burst cannot get more than
 * LOCKOUT_MAX_ATTEMPTS comparisons per lock period: Postgres serialises the
 * UPDATEs on the row and re-checks the WHERE clause against the row each one
 * finally sees, so the request that takes the last slot also writes
 * `lockedUntil` and every later request matches no row.
 *
 * The window is anchored on the first failure of the series, not on
 * `updatedAt`, so unrelated writes to the row cannot extend it. An anchor in
 * the future (clock skew) starts a new series rather than suppressing counting.
 */
export async function reserveLoginAttempt(userId: string): Promise<LoginAttemptReservation> {
  const env = getEnv();
  const rows = await prisma.$queryRaw<Array<{ attempts: number; lockedUntil: Date | null }>>`
    UPDATE "user" AS u
    SET
      "failedAttempts" = CASE
        WHEN u."firstFailedAttemptAt" > p.now - p.win AND u."firstFailedAttemptAt" <= p.now
          THEN u."failedAttempts" + 1
        ELSE 1
      END,
      "firstFailedAttemptAt" = CASE
        WHEN u."firstFailedAttemptAt" > p.now - p.win AND u."firstFailedAttemptAt" <= p.now
          THEN u."firstFailedAttemptAt"
        ELSE p.now
      END,
      "lockedUntil" = CASE
        WHEN (CASE
          WHEN u."firstFailedAttemptAt" > p.now - p.win AND u."firstFailedAttemptAt" <= p.now
            THEN u."failedAttempts" + 1
          ELSE 1
        END) >= p.max
          THEN p.now + p.dur
        ELSE NULL
      END
    FROM (
      SELECT
        (now() AT TIME ZONE 'UTC')::timestamp(3) AS now,
        make_interval(mins => ${env.LOCKOUT_WINDOW_MINUTES}::int) AS win,
        make_interval(mins => ${env.LOCKOUT_DURATION_MINUTES}::int) AS dur,
        ${env.LOCKOUT_MAX_ATTEMPTS}::int AS max
    ) AS p
    WHERE u.id = ${userId}
      AND (u."lockedUntil" IS NULL OR u."lockedUntil" <= p.now)
    RETURNING u."failedAttempts" AS attempts, u."lockedUntil" AS "lockedUntil"
  `;
  const row = rows[0];
  if (!row) return { allowed: false };
  return { allowed: true, attempts: row.attempts, lockedUntil: row.lockedUntil };
}

export async function clearFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedAttempts: 0, lockedUntil: null, firstFailedAttemptAt: null },
  });
}
