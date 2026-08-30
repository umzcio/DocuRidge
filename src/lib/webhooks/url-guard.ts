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

export type WebhookUrlRejection =
  | 'invalid_url'
  | 'bad_scheme'
  | 'loopback'
  | 'private_address'
  | 'link_local'
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

/** Parse a dotted-quad IPv4 literal into its four numeric octets, or null. */
function parseIPv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    // Reject empty, non-digit, or leading-zero-ambiguous segments; require
    // a clean decimal number 0-255 so "1192" cannot masquerade as "192".
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0] ?? 0, octets[1] ?? 0, octets[2] ?? 0, octets[3] ?? 0];
}

function isIPv4Loopback(o: [number, number, number, number]): boolean {
  return o[0] === 127;
}

function isIPv4PrivateAddress(o: [number, number, number, number]): boolean {
  if (o[0] === 10) return true; // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return true; // 192.168.0.0/16
  return false;
}

function isIPv4LinkLocal(o: [number, number, number, number]): boolean {
  return o[0] === 169 && o[1] === 254; // 169.254.0.0/16 (incl. cloud metadata)
}

/** Very small IPv6 literal checks — only the ranges this guard cares about. */
function isIPv6Loopback(hostname: string): boolean {
  return hostname === '::1';
}

function isIPv6UniqueLocal(hostname: string): boolean {
  // fc00::/7 covers prefixes fc00: through fdff:
  const first = hostname.split(':')[0]?.toLowerCase() ?? '';
  if (first.length < 2) return false;
  const firstByte = Number.parseInt(first.slice(0, 2), 16);
  if (Number.isNaN(firstByte)) return false;
  return firstByte === 0xfc || firstByte === 0xfd;
}

function isIPv6LinkLocal(hostname: string): boolean {
  // fe80::/10 covers prefixes fe80: through febf:
  const first = hostname.split(':')[0]?.toLowerCase() ?? '';
  return /^fe[89ab][0-9a-f]$/.test(first);
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

  // Literal loopback hostnames/addresses.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    isIPv6Loopback(hostname)
  ) {
    return reject('loopback');
  }

  const ipv4 = parseIPv4(hostname);
  if (ipv4) {
    if (isIPv4Loopback(ipv4)) return reject('loopback');
    if (isIPv4PrivateAddress(ipv4)) return reject('private_address');
    if (isIPv4LinkLocal(ipv4)) return reject('link_local');
    // A well-formed public IPv4 literal — accept.
    return { ok: true };
  }

  if (isIPv6UniqueLocal(hostname)) return reject('private_address');
  if (isIPv6LinkLocal(hostname)) return reject('link_local');

  // If it looks like it was intended as an IPv6 literal (contains a colon)
  // but isn't one of the ranges above, don't fall through to the
  // single-label hostname check — it's not a hostname at all.
  if (hostname.includes(':')) {
    return { ok: true };
  }

  // Docker service names ("docuridge_postgres", "redis") are single-label
  // hostnames with no dot. IP literals are already handled above, so this
  // only catches bare hostnames.
  if (!hostname.includes('.')) {
    return reject('non_public_hostname');
  }

  return { ok: true };
}
