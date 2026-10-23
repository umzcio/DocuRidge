/**
 * Per-recipient access codes (DocuSign-style). The sender optionally sets a
 * 4–12 char code (A–Z, 0–9) per recipient; the signer must enter it before
 * the ceremony opens. Only the SHA-256 hash is stored on the Recipient row —
 * the plaintext code exists transiently in the sender's builder and the
 * signer's keyboard. Hashing lives in `./access-code-server` (node:crypto)
 * so this module stays importable from client components.
 *
 * Codes are case-insensitive and surrounding-whitespace-tolerant on purpose:
 * a code read out over the phone ("ABC123" vs "abc123") must still match.
 */

export const ACCESS_CODE_MIN_LENGTH = 4;
export const ACCESS_CODE_MAX_LENGTH = 12;

/** Sender-editable shape: 4–12 alphanumeric characters. */
export const ACCESS_CODE_PATTERN = /^[A-Za-z0-9]{4,12}$/;

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Canonical form used for hashing and comparison. */
export function normalizeAccessCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Generate a sender-friendly code from the unambiguous A–Z 0–9 alphabet.
 * Uses Web Crypto `getRandomValues` (available in browsers and Node) with
 * rejection sampling so the distribution is uniform, not modulo-biased.
 * Default is the 6-char code DocuSign users expect.
 */
export function generateAccessCode(length = 6): string {
  const max = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  const buf = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    crypto.getRandomValues(buf.subarray(filled));
    for (let i = filled; i < length; i++) {
      if (buf[i]! < max) filled = i + 1;
      else break;
    }
  }
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[buf[i]! % CODE_ALPHABET.length];
  return out;
}

/** Cookie name carrying the signed "unlocked" marker for one recipient. */
export function accessCodeCookieName(recipientId: string): string {
  return `dr_access_${recipientId}`;
}

/** How long an unlock cookie stays valid (2 hours — one ceremony session). */
export const ACCESS_CODE_COOKIE_TTL_SECONDS = 2 * 60 * 60;
