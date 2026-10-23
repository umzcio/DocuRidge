/**
 * Outbound-request SSRF guard for URLs that users or org admins configure
 * (webhook receivers, the SSO issuer and the endpoints its metadata names).
 *
 * The app container shares Docker networks with Postgres, MailHog and the
 * reverse proxy, so a check on the URL's text is not enough: Docker service
 * names (`svc.network`, `svc.`) and attacker-controlled DNS (`10.0.0.1.nip.io`,
 * rebinding) resolve to internal addresses after any string check passes.
 *
 * `guardedFetch` therefore:
 *   1. rejects URL shapes that only make sense inside a network
 *      (single-label, trailing dot, underscores, `.local`/`.internal`, …),
 *   2. resolves the hostname once and refuses if ANY answer is non-public
 *      (see `classifyIp`),
 *   3. connects to exactly those vetted addresses through a pinned `lookup`,
 *      so a second DNS answer between check and connect cannot change the
 *      target, while Host and TLS SNI still carry the original name,
 *   4. never follows redirects (a 3xx comes back as a non-ok Response).
 *
 * Operators can exempt specific hostnames (e.g. a receiver deliberately on the
 * internal network) with an allowlist; exempt names skip the shape and range
 * rules but are still pinned.
 */
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyIp, type IpRejection } from './ip-policy';

export type OutboundRejection =
  | 'invalid_url'
  | 'bad_scheme'
  | IpRejection
  | 'non_public_hostname'
  | 'unresolvable';

export interface OutboundCheck {
  ok: boolean;
  reason?: OutboundRejection;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundPolicy {
  /** Lower-cased hostnames (as they appear in the URL) exempt from the range rules. */
  allowedInternalHosts?: ReadonlySet<string>;
  /** DNS resolver; defaults to the system resolver (getaddrinfo), which is what a socket would use. */
  resolve?: Resolver;
}

export class OutboundRefusedError extends Error {
  constructor(readonly reason: OutboundRejection) {
    super(`refused outbound request (${reason})`);
    this.name = 'OutboundRefusedError';
  }
}

const NON_PUBLIC_SUFFIXES = ['.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.intranet'];

const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Parse a comma-separated allowlist env value into a lower-cased set. */
export function parseHostAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

function hostOf(url: URL): string {
  const h = url.hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function parseHttpUrl(raw: string): { url: URL } | { reason: OutboundRejection } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'invalid_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'bad_scheme' };
  return { url };
}

function checkHost(host: string, policy: OutboundPolicy): OutboundCheck {
  if (policy.allowedInternalHosts?.has(host)) return { ok: true };

  if (isIP(host)) {
    const rejection = classifyIp(host);
    return rejection ? { ok: false, reason: rejection } : { ok: true };
  }

  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (name === 'localhost' || name.endsWith('.localhost')) return { ok: false, reason: 'loopback' };
  // Trailing dot: `svc.` is a fully qualified single label that Docker's
  // embedded DNS answers. Underscore: legal in DNS but never in a public web
  // hostname, and every compose container/network name here uses one.
  if (host.endsWith('.') || host.includes('_') || !name.includes('.')) {
    return { ok: false, reason: 'non_public_hostname' };
  }
  if (NON_PUBLIC_SUFFIXES.some((s) => name.endsWith(s))) {
    return { ok: false, reason: 'non_public_hostname' };
  }
  return { ok: true };
}

/** Synchronous shape + IP-literal check. Does NOT resolve DNS — use `vetOutboundUrl` before connecting. */
export function checkOutboundUrl(raw: string, policy: OutboundPolicy = {}): OutboundCheck {
  const parsed = parseHttpUrl(raw);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  return checkHost(hostOf(parsed.url), policy);
}

export type VetResult =
  | { ok: true; url: URL; host: string; addresses: ResolvedAddress[] }
  | { ok: false; reason: OutboundRejection };

/** Full check: shape, then resolve and require every answer to be public. */
export async function vetOutboundUrl(raw: string, policy: OutboundPolicy = {}): Promise<VetResult> {
  const parsed = parseHttpUrl(raw);
  if ('reason' in parsed) return { ok: false, reason: parsed.reason };
  const { url } = parsed;
  const host = hostOf(url);

  const shape = checkHost(host, policy);
  if (!shape.ok) return { ok: false, reason: shape.reason! };

  const literal = isIP(host);
  if (literal) return { ok: true, url, host, addresses: [{ address: host, family: literal === 6 ? 6 : 4 }] };

  let addresses: ResolvedAddress[];
  try {
    addresses = await (policy.resolve ?? systemResolver)(host);
  } catch {
    return { ok: false, reason: 'unresolvable' };
  }
  if (addresses.length === 0) return { ok: false, reason: 'unresolvable' };

  if (!policy.allowedInternalHosts?.has(host)) {
    for (const { address } of addresses) {
      const rejection = classifyIp(address);
      if (rejection) return { ok: false, reason: rejection };
    }
  }
  return { ok: true, url, host, addresses };
}

/**
 * A `lookup` for net/tls that only ever answers with the pre-vetted
 * addresses for the one expected hostname, so the socket cannot be steered
 * by a second DNS answer.
 */
export function pinnedLookup(expectedHost: string, addresses: ResolvedAddress[]): LookupFunction {
  return (hostname, options, callback) => {
    const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
    if (hostname.toLowerCase() !== expectedHost) {
      cb(Object.assign(new Error(`pinned lookup refused ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    const family = options?.family;
    const wanted = family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : 0;
    const matches = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    const first = matches[0];
    if (!first) {
      cb(Object.assign(new Error(`no pinned address for ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options?.all) cb(null, matches);
    else cb(null, first.address, first.family);
  };
}

export interface GuardedRequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | URLSearchParams | null;
  signal?: AbortSignal | null;
}

export interface GuardedFetchOptions extends OutboundPolicy {
  /** Overall deadline for resolve + connect + response. Default 10s. */
  timeoutMs?: number;
  /** Response bodies above this are refused. Default 1 MiB. */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function bodyBytes(body: GuardedRequestInit['body']): Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return Buffer.from(body);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * fetch-compatible request that is refused unless the target passes
 * `vetOutboundUrl`, and that connects only to the vetted addresses.
 * Throws `OutboundRefusedError` on refusal.
 */
export async function guardedFetch(
  raw: string,
  init: GuardedRequestInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  const vetted = await abortable(vetOutboundUrl(raw, options), signal);
  if (!vetted.ok) throw new OutboundRefusedError(vetted.reason);

  const { url, host, addresses } = vetted;
  const payload = bodyBytes(init.body);
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value;
  });
  if (payload && headers['content-length'] === undefined) headers['content-length'] = String(payload.length);
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        // No shared keep-alive pool: a pooled socket must never outlive the
        // vetting that justified it.
        agent: false,
        lookup: pinnedLookup(host, addresses),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new Error('Outbound response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (value === undefined) continue;
              for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
            }
            const status = res.statusCode ?? 0;
            const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks);
            resolve(new Response(body, { status, statusText: res.statusMessage, headers: responseHeaders }));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
