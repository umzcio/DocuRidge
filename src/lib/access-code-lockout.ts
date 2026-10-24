import { prisma } from './prisma';
import { getEnv } from './env';

export type AccessCodeAttemptReservation =
  | { allowed: true; attempts: number; lockedUntil: Date | null; lockouts: number }
  | { allowed: false };

/**
 * Reserve one access-code comparison for this recipient, before the
 * comparison runs — the same pattern as `reserveLoginAttempt`
 * (src/lib/auth/lockout.ts). The attempt is counted as a failure up front and
 * only cleared by a correct code, so a concurrent burst gets at most
 * ACCESS_CODE_MAX_ATTEMPTS comparisons per lock: Postgres serialises the
 * UPDATEs on the row and re-checks the WHERE clause against the row each one
 * finally sees, so the request that takes the last slot also writes
 * `accessCodeLockedUntil` and every later request matches no row.
 *
 * Differences from the login lockout, because this guards a short code on a
 * long-lived bearer link rather than a password:
 *   - Failures never age out. A window would let an attacker who paces
 *     guesses just under it guess forever; only a success or a lock resets
 *     the running count.
 *   - Each lock is longer than the last: ACCESS_CODE_LOCK_MINUTES doubled per
 *     earlier lockout, capped at ACCESS_CODE_LOCK_MAX_MINUTES. The lockout
 *     count is not cleared by a success.
 *   - The first attempt after a lock has expired starts a fresh series of N.
 */
export async function reserveAccessCodeAttempt(
  recipientId: string,
): Promise<AccessCodeAttemptReservation> {
  const env = getEnv();
  const rows = await prisma.$queryRaw<Array<{ attempts: number; lockedUntil: Date | null; lockouts: number }>>`
    UPDATE "recipient" AS r
    SET
      "accessCodeFailedAttempts" = CASE
        WHEN r."accessCodeLockedUntil" IS NOT NULL THEN 1
        ELSE r."accessCodeFailedAttempts" + 1
      END,
      "accessCodeLockedUntil" = CASE
        WHEN (CASE
          WHEN r."accessCodeLockedUntil" IS NOT NULL THEN 1
          ELSE r."accessCodeFailedAttempts" + 1
        END) >= p.max
          THEN p.now + make_interval(mins => LEAST(
            p.base * power(2, LEAST(r."accessCodeLockouts", 20)),
            p.cap
          )::int)
        ELSE NULL
      END,
      "accessCodeLockouts" = CASE
        WHEN (CASE
          WHEN r."accessCodeLockedUntil" IS NOT NULL THEN 1
          ELSE r."accessCodeFailedAttempts" + 1
        END) >= p.max
          THEN r."accessCodeLockouts" + 1
        ELSE r."accessCodeLockouts"
      END
    FROM (
      SELECT
        (now() AT TIME ZONE 'UTC')::timestamp(3) AS now,
        ${env.ACCESS_CODE_MAX_ATTEMPTS}::int AS max,
        ${env.ACCESS_CODE_LOCK_MINUTES}::int AS base,
        ${env.ACCESS_CODE_LOCK_MAX_MINUTES}::int AS cap
    ) AS p
    WHERE r.id = ${recipientId}
      AND (r."accessCodeLockedUntil" IS NULL OR r."accessCodeLockedUntil" <= p.now)
    RETURNING
      r."accessCodeFailedAttempts" AS attempts,
      r."accessCodeLockedUntil" AS "lockedUntil",
      r."accessCodeLockouts" AS lockouts
  `;
  const row = rows[0];
  if (!row) return { allowed: false };
  return { allowed: true, attempts: row.attempts, lockedUntil: row.lockedUntil, lockouts: row.lockouts };
}

/** A correct code clears the running count and any lock; the escalation history stays. */
export async function clearAccessCodeFailures(recipientId: string): Promise<void> {
  await prisma.recipient.update({
    where: { id: recipientId },
    data: { accessCodeFailedAttempts: 0, accessCodeLockedUntil: null },
  });
}
