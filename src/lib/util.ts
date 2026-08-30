import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Constant-time string comparison. Use for any user-supplied secret comparison
 * (bootstrap token, hashed-token lookups never reach here — they go through
 * jose / argon2 verify).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** A base64url-encoded random byte string of the given length. */
export function randomBase64Url(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

/**
 * Resolve the client IP from the trusted proxy hop.
 *
 * The deployed nginx sets `X-Forwarded-For` with `$proxy_add_x_forwarded_for`,
 * which APPENDS its own peer address to whatever the client sent. The left-most
 * entry is therefore client-controlled; the right-most is what nginx actually
 * saw. `X-Real-IP` is set with `proxy_set_header` (which replaces rather than
 * appends), so it is preferred when present.
 *
 * This value is written into the Ed25519-signed audit chain and used as a
 * rate-limit key, so taking the client-supplied entry would let a signer choose
 * the IP recorded against their own signature.
 */
export function getClientIp(headers: Headers): string {
  const realIp = headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const fwd = headers.get('x-forwarded-for');
  if (fwd) {
    const list = fwd
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (list.length > 0) {
      const hops = getTrustedProxyHops();
      const index = list.length - hops;
      const entry = index >= 0 ? list[index] : list[0];
      if (entry) return entry;
    }
  }

  return 'unknown';
}

/**
 * Reads TRUSTED_PROXY_HOPS directly from process.env rather than through the
 * app's validated env loader — this module is imported in contexts without a
 * fully-validated app env (see the same constraint documented in
 * `src/lib/mail/allowlist.ts`), so it must not depend on that loader.
 */
function getTrustedProxyHops(): number {
  const raw = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) return 1;
  return raw;
}
