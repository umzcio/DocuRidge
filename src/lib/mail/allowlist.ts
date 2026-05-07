/**
 * Recipient allowlist.
 *
 * SECURITY-CRITICAL. Enforced in code at the send pipeline whenever
 * MAIL_BACKEND=smtp_relay. This is the safety net that prevents accidental
 * outbound mail to real people during pre-production builds.
 *
 * Membership is configured via the `MAIL_ALLOWLIST` environment variable
 * (comma-separated email addresses). The CODE GATE — i.e. the existence of
 * `isAllowedRecipient` and its call from the mail pipeline — stays in source
 * so a misconfigured env var alone cannot disable the safety net.
 *
 * Empty list → nothing sends. To open delivery to additional recipients,
 * append to `MAIL_ALLOWLIST` and redeploy. To remove the gate entirely for
 * full production, follow the procedure in DEPLOYMENT.md (which involves
 * deleting the gate call sites in the same commit, not just an env flip).
 */

// Read process.env directly — allowlist only needs ONE variable and must
// remain usable in tests that don't have a fully-validated app env.
let cached: ReadonlySet<string> | null = null;

function load(): ReadonlySet<string> {
  if (cached) return cached;
  const raw = process.env.MAIL_ALLOWLIST ?? '';
  cached = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return cached;
}

/**
 * Test-only hook to reset the cached allowlist between tests that mutate
 * MAIL_ALLOWLIST. Not exported on the production hot path.
 */
export function _resetAllowlistCache(): void {
  cached = null;
}

/**
 * Returns true iff the address is on the allowlist (case-insensitive,
 * trimmed). Pure function — no DB lookups; reads env once and caches.
 */
export function isAllowedRecipient(rawAddress: string): boolean {
  if (typeof rawAddress !== 'string') return false;
  const normalized = rawAddress.trim().toLowerCase();
  if (!normalized) return false;
  return load().has(normalized);
}

/** The list of allowed addresses, exposed for diagnostic display only. */
export function getAllowedRecipients(): readonly string[] {
  return Array.from(load()).sort();
}

/**
 * Thrown when the SMTP relay backend refuses a non-allowlisted recipient.
 * In non-production environments this is rethrown to fail loudly; in
 * production it's caught by the mailer and converted to a structured warning.
 */
export class AllowlistRefusalError extends Error {
  readonly recipient: string;
  constructor(recipient: string) {
    super(`Mail recipient not on allowlist: ${recipient}`);
    this.name = 'AllowlistRefusalError';
    this.recipient = recipient;
  }
}
