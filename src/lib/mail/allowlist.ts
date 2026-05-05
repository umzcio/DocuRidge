/**
 * Recipient allowlist.
 *
 * SECURITY-CRITICAL. Enforced in code at the send pipeline whenever
 * MAIL_BACKEND=smtp_relay. This is the safety net that prevents accidental
 * outbound mail to real people during pre-production builds.
 *
 * Removal at production deploy is a documented procedure in DEPLOYMENT.md
 * involving (a) flipping the env flag and (b) removing this gate function in
 * the same commit. No flag-only override.
 */

const ALLOWED = new Set<string>([
  'admin@example.com',
  'user@example.com',
  'admin@example.com',
]);

/**
 * Returns true iff the address is on the allowlist (case-insensitive,
 * trimmed). Pure function — no side effects, no DB lookups, no env reads.
 */
export function isAllowedRecipient(rawAddress: string): boolean {
  if (typeof rawAddress !== 'string') return false;
  const normalized = rawAddress.trim().toLowerCase();
  if (!normalized) return false;
  return ALLOWED.has(normalized);
}

/** The list of allowed addresses, exposed for diagnostic display only. */
export function getAllowedRecipients(): readonly string[] {
  return Array.from(ALLOWED).sort();
}

/**
 * Thrown when the SMTP-UM backend refuses a non-allowlisted recipient.
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
