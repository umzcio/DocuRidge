import { createHash } from 'node:crypto';
import { timingSafeEqual } from './util';
import { normalizeAccessCode } from './access-code';

/**
 * Server-only access-code hashing. Kept out of `./access-code` so client
 * components (builder form) can import the pattern/generator without
 * webpack pulling node:crypto into the browser bundle. Import this module
 * only from server code (actions, route handlers).
 */

/** Lowercase-trim → SHA-256 hex. */
export function hashAccessCode(code: string): string {
  return createHash('sha256').update(normalizeAccessCode(code), 'utf8').digest('hex');
}

/**
 * Constant-work compare of the attempt against a stored hash. A null hash
 * means no code is configured — the gate is open, so this returns true.
 */
export function verifyAccessCode(hash: string | null, attempt: string): boolean {
  if (hash === null) return true;
  return timingSafeEqual(hashAccessCode(attempt), hash);
}
