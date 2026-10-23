/**
 * Webhook URL guard — SSRF surface reduction.
 *
 * Webhook URLs are admin-supplied and the dispatcher `fetch`es them from
 * inside the app container, which sits on the same Docker network as
 * Postgres and MailHog. Without a check, an admin (or a hijacked admin
 * session) can point a webhook at an internal address and use response
 * status / failure text (persisted on `WebhookCall` rows and surfaced in the
 * settings UI) as an oracle for what is listening inside the network.
 *
 * This is a literal-and-hostname-shape check, NOT full SSRF defense: it does
 * not resolve DNS, so a public hostname that resolves to a private address
 * (DNS rebinding, or a domain a rebinding attacker controls) is not caught
 * here. Closing that gap needs a resolve-then-validate-then-connect
 * dispatcher and is out of scope — see plan 008's maintenance notes.
 *
 * Leaf module: reads `WEBHOOK_ALLOWED_INTERNAL_HOSTS` from `process.env`
 * directly (matching `src/lib/mail/allowlist.ts`) so it stays usable in
 * tests without a fully validated app env, and so it can be called from both
 * the server action (creation time) and the dispatcher (delivery time)
 * without a dependency edge back into either.
 */
import { isIP } from 'node:net';
import { classifyIp } from '../net/ip-policy';

export type WebhookUrlRejection =
  | 'invalid_url'
  | 'bad_scheme'
  | 'loopback'
  | 'private_address'
  | 'link_local'
  | 'reserved_address'
  | 'non_public_hostname';

export interface WebhookUrlCheck {
  ok: boolean;
  reason?: WebhookUrlRejection;
  /** Operator-facing explanation, safe to show an admin. */
  message?: string;
}

const REJECTION_MESSAGES: Record<WebhookUrlRejection, string> = {
  invalid_url: 'Webhook URL must be a valid absolute URL.',
  bad_scheme: 'Webhook URL must use http or https.',
  loopback:
    'Webhook URL must point at a public host — loopback addresses are refused.',
  private_address:
    'Webhook URL must point at a public host — internal and loopback addresses are refused.',
  link_local:
    'Webhook URL must point at a public host — link-local and metadata addresses are refused.',
  reserved_address:
    'Webhook URL must point at a public host — reserved and multicast addresses are refused.',
  non_public_hostname:
    'Webhook URL must point at a public host — internal and loopback addresses are refused.',
};

function reject(reason: WebhookUrlRejection): WebhookUrlCheck {
  return { ok: false, reason, message: REJECTION_MESSAGES[reason] };
}

function readAllowedInternalHosts(): ReadonlySet<string> {
  const raw = process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS ?? '';
  const hosts = raw
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
  return new Set(hosts);
}

/** Strip surrounding IPv6 brackets, e.g. `[::1]` -> `::1`. */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

export function checkWebhookUrl(raw: string): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return reject('bad_scheme');
  }

  const hostname = stripBrackets(url.hostname.toLowerCase());

  const allowedInternalHosts = readAllowedInternalHosts();
  if (allowedInternalHosts.has(hostname)) {
    return { ok: true };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return reject('loopback');
  }

  // IP literals are classified on their full value: IPv6 is parsed to 128
  // bits so IPv4-mapped/compatible/NAT64 forms (`[::ffff:7f00:1]`) are judged
  // by the IPv4 address they reach, and `::` is treated like 0.0.0.0.
  if (isIP(hostname)) {
    const rejection = classifyIp(hostname);
    return rejection ? reject(rejection) : { ok: true };
  }

  // Docker service names ("docuridge_postgres", "redis") are single-label
  // hostnames with no dot. IP literals are already handled above, so this
  // only catches bare hostnames.
  if (!hostname.includes('.')) {
    return reject('non_public_hostname');
  }

  return { ok: true };
}
