/**
 * Whether `Session.lastSeenAt` is stale enough to be worth writing.
 *
 * getSession() runs many times per request; the timestamp is operator-facing
 * only and grants no extra session lifetime (expiresAt is fixed at creation),
 * so a write per read is pure cost.
 */

// Read process.env directly — this is a leaf module that must remain testable
// without a fully-validated app env, matching src/lib/mail/allowlist.ts.
const DEFAULT_INTERVAL_SECONDS = 60;

function getIntervalSeconds(): number {
  const raw = process.env.SESSION_HEARTBEAT_SECONDS;
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_INTERVAL_SECONDS;
  return parsed;
}

export function shouldWriteHeartbeat(lastSeenAt: Date, now: Date = new Date()): boolean {
  const intervalSeconds = getIntervalSeconds();
  if (intervalSeconds === 0) return true;

  const elapsedMs = now.getTime() - lastSeenAt.getTime();
  // A lastSeenAt in the future (clock skew) must not suppress the write forever.
  if (elapsedMs < 0) return true;

  return elapsedMs >= intervalSeconds * 1000;
}
