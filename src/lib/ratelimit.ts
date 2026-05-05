import { prisma } from './prisma';
import { getEnv } from './env';

/**
 * In-DB token bucket. Composite PK on (key, action, bucket) where bucket is
 * the minute floor of the current time. Sufficient for v1 single-instance
 * deployment; documented upgrade path is Redis.
 */

export type Action =
  | 'login'
  | 'register'
  | 'password_reset'
  | 'signing_token'
  | 'bulk_send_create';

const LIMITS_PER_MIN: Record<Action, () => number> = {
  login: () => getEnv().RL_LOGIN_PER_MIN,
  register: () => getEnv().RL_REGISTER_PER_MIN,
  password_reset: () => getEnv().RL_PASSWORD_RESET_PER_MIN,
  signing_token: () => getEnv().RL_SIGNING_TOKEN_PER_MIN,
  bulk_send_create: () => 5,
};

export interface RateLimitResult {
  allowed: boolean;
  /** Current count within the active bucket. */
  count: number;
  /** Limit for this action. */
  limit: number;
  /** Seconds until the bucket rolls over. */
  retryAfterSeconds: number;
}

function bucketStart(): Date {
  const now = new Date();
  now.setSeconds(0, 0);
  return now;
}

function secondsUntilNextBucket(): number {
  const now = new Date();
  return 60 - now.getSeconds();
}

/**
 * Check a rate limit and increment the counter. Atomic via Prisma upsert.
 * Returns whether the request is allowed and how long until the next bucket.
 */
export async function checkRateLimit(
  key: string,
  action: Action,
): Promise<RateLimitResult> {
  const limit = LIMITS_PER_MIN[action]();
  const bucket = bucketStart();

  const updated = await prisma.rateLimit.upsert({
    where: { key_action_bucket: { key, action, bucket } },
    update: { count: { increment: 1 } },
    create: { key, action, bucket, count: 1 },
  });

  return {
    allowed: updated.count <= limit,
    count: updated.count,
    limit,
    retryAfterSeconds: secondsUntilNextBucket(),
  };
}

/**
 * Best-effort cleanup of buckets older than 1 hour. Call from a periodic
 * background job; safe to skip on a fresh stack.
 */
export async function cleanupOldBuckets(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const { count } = await prisma.rateLimit.deleteMany({
    where: { bucket: { lt: cutoff } },
  });
  return count;
}
