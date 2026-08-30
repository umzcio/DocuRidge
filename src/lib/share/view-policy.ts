const DEFAULT_WINDOW_MINUTES = 60;

/**
 * Resolve the share-view audit window in milliseconds from
 * `SHARE_VIEW_AUDIT_WINDOW_MINUTES`, defaulting (and falling back) to 60
 * minutes for any missing, non-numeric, or non-positive value. Reads
 * `process.env` directly (same reasoning as `src/lib/mail/allowlist.ts:19-20`)
 * so this stays a pure, dependency-free module that is testable without a
 * database or the validated app env.
 */
export function resolveShareViewWindowMs(): number {
  const raw = process.env.SHARE_VIEW_AUDIT_WINDOW_MINUTES;
  const parsed = raw === undefined ? NaN : Number(raw);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Whether this share view should append a new audit-chain event.
 *
 * The share page is unauthenticated and uncached, so without a window every
 * refresh would append a permanently-immutable, signed row and fire a webhook
 * to every subscription. One event per window per link preserves the signal
 * ("this link was viewed") while bounding the cost and keeping the trail
 * legible as evidence.
 */
export function shouldRecordShareView(
  lastViewedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (lastViewedAt === null) return true;

  const elapsedMs = now.getTime() - lastViewedAt.getTime();
  // A lastViewedAt in the future (clock skew) yields a negative elapsed time,
  // which is < the window — but we want that to record, not suppress forever,
  // so treat any non-positive elapsed time as "outside the window" too.
  if (elapsedMs <= 0) return true;

  return elapsedMs >= resolveShareViewWindowMs();
}
