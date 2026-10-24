/**
 * Webhook URL guard — SSRF policy for admin-supplied webhook receivers.
 *
 * Webhook URLs are set by org admins (and open registration makes every new
 * user an admin of their own org), and the dispatcher POSTs to them from
 * inside the app container, which shares Docker networks with Postgres and
 * MailHog. The policy itself lives in `src/lib/net/outbound.ts`:
 *
 *   - `checkWebhookUrl` — synchronous shape + IP-literal check (no DNS);
 *     cheap enough for a zod refine.
 *   - `vetWebhookUrl`   — additionally resolves the hostname and requires
 *     every answer to be public. Used at creation time.
 *   - `webhookFetch`    — vets, then connects only to the vetted addresses
 *     (pinned lookup, no redirects). Used at delivery time, so a DNS answer
 *     that changes after creation (rebinding) is caught again.
 *
 * Leaf module: reads `WEBHOOK_ALLOWED_INTERNAL_HOSTS` from `process.env`
 * directly (matching `src/lib/mail/allowlist.ts`) so it stays usable in
 * tests without a fully validated app env.
 */
import {
  checkOutboundUrl,
  guardedFetch,
  parseHostAllowlist,
  vetOutboundUrl,
  type GuardedFetchOptions,
  type GuardedRequestInit,
  type OutboundRejection,
  type Resolver,
} from '../net/outbound';

export type WebhookUrlRejection = OutboundRejection;

export interface WebhookUrlCheck {
  ok: boolean;
  /** Specific refusal reason — for server logs only, never for the client. */
  reason?: WebhookUrlRejection;
  /** Client-safe explanation, safe to show an admin. */
  message?: string;
}

/**
 * The single client-visible text for every refused target, whether the host
 * did not resolve, resolved to loopback / private / link-local / reserved
 * space, or was refused by name before resolution. Distinct texts let an
 * admin map the app's internal DNS view (which names exist, and what kind of
 * address each points at) by submitting guesses; the specific reason goes to
 * the server log instead.
 */
export const WEBHOOK_TARGET_REFUSED_MESSAGE =
  'Webhook URL must point at a public host that resolves to a public address. Check the hostname and try again.';

const REJECTION_MESSAGES: Record<WebhookUrlRejection, string> = {
  // Shape errors say nothing about DNS, so they keep specific text.
  invalid_url: 'Webhook URL must be a valid absolute URL.',
  bad_scheme: 'Webhook URL must use http or https.',
  loopback: WEBHOOK_TARGET_REFUSED_MESSAGE,
  private_address: WEBHOOK_TARGET_REFUSED_MESSAGE,
  link_local: WEBHOOK_TARGET_REFUSED_MESSAGE,
  reserved_address: WEBHOOK_TARGET_REFUSED_MESSAGE,
  non_public_hostname: WEBHOOK_TARGET_REFUSED_MESSAGE,
  unresolvable: WEBHOOK_TARGET_REFUSED_MESSAGE,
};

function reject(reason: WebhookUrlRejection): WebhookUrlCheck {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

function allowedInternalHosts(): ReadonlySet<string> {
  return parseHostAllowlist(process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS);
}

export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  const result = checkOutboundUrl(raw, { allowedInternalHosts: allowedInternalHosts() });
  return result.ok ? { ok: true } : reject(result.reason!);
}

export async function vetWebhookUrl(
  raw: string,
  opts: { resolve?: Resolver } = {},
): Promise<WebhookUrlCheck> {
  const result = await vetOutboundUrl(raw, { allowedInternalHosts: allowedInternalHosts(), ...opts });
  return result.ok ? { ok: true } : reject(result.reason);
}

/** Deliver to a webhook URL through the SSRF guard. Throws `OutboundRefusedError` on refusal. */
export function webhookFetch(
  raw: string,
  init: GuardedRequestInit,
  opts: Omit<GuardedFetchOptions, 'allowedInternalHosts'> = {},
): Promise<Response> {
  return guardedFetch(raw, init, { ...opts, allowedInternalHosts: allowedInternalHosts() });
}
