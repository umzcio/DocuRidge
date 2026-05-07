import { describe, it, expect, beforeAll } from 'vitest';
import { isAllowedRecipient, getAllowedRecipients, AllowlistRefusalError, _resetAllowlistCache } from './allowlist';

// The allowlist reads from MAIL_ALLOWLIST. Seed three canonical addresses
// so the assertions below have a stable baseline.
beforeAll(() => {
  process.env.MAIL_ALLOWLIST = 'alice@example.com,bob@example.org,admin@example.com';
  _resetAllowlistCache();
});

describe('isAllowedRecipient', () => {
  it('accepts each canonical allowlisted address', () => {
    expect(isAllowedRecipient('alice@example.com')).toBe(true);
    expect(isAllowedRecipient('bob@example.org')).toBe(true);
    expect(isAllowedRecipient('admin@example.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedRecipient('ALICE@EXAMPLE.COM')).toBe(true);
    expect(isAllowedRecipient('Alice@example.com')).toBe(true);
    expect(isAllowedRecipient('ADMIN@example.com')).toBe(true);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isAllowedRecipient('  alice@example.com  ')).toBe(true);
    expect(isAllowedRecipient('\tadmin@example.com\n')).toBe(true);
  });

  it('rejects unknown addresses', () => {
    expect(isAllowedRecipient('attacker@evil.com')).toBe(false);
    expect(isAllowedRecipient('alice@example.org')).toBe(false); // right user, wrong domain
    expect(isAllowedRecipient('admin@example.org')).toBe(false);
  });

  it('rejects edge-case inputs without throwing', () => {
    expect(isAllowedRecipient('')).toBe(false);
    expect(isAllowedRecipient('   ')).toBe(false);
    // @ts-expect-error — runtime guard for non-strings
    expect(isAllowedRecipient(undefined)).toBe(false);
    // @ts-expect-error
    expect(isAllowedRecipient(null)).toBe(false);
    // @ts-expect-error
    expect(isAllowedRecipient(123)).toBe(false);
  });

  it('rejects subdomain spoofing attempts', () => {
    expect(isAllowedRecipient('alice@example.com.evil.com')).toBe(false);
    expect(isAllowedRecipient('alice@evil-example.com')).toBe(false);
    expect(isAllowedRecipient('admin@admin.example.com')).toBe(false);
  });

  it('rejects local-part spoofing', () => {
    expect(isAllowedRecipient('alice+x@example.com')).toBe(false);
    expect(isAllowedRecipient('alice.@example.com')).toBe(false);
    expect(isAllowedRecipient('.alice@example.com')).toBe(false);
  });
});

describe('getAllowedRecipients', () => {
  it('returns the canonical three addresses, sorted', () => {
    expect(getAllowedRecipients()).toEqual([
      'admin@example.com',
      'alice@example.com',
      'bob@example.org',
    ]);
  });

  it('returned list is independent of internal state (immutability sanity)', () => {
    const list = getAllowedRecipients() as string[];
    // Should be safe to mutate the returned array without affecting the source.
    list.push('attacker@evil.com');
    expect(isAllowedRecipient('attacker@evil.com')).toBe(false);
  });
});

describe('AllowlistRefusalError', () => {
  it('exposes the recipient that was refused', () => {
    const err = new AllowlistRefusalError('attacker@evil.com');
    expect(err.recipient).toBe('attacker@evil.com');
    expect(err.message).toContain('attacker@evil.com');
    expect(err.name).toBe('AllowlistRefusalError');
  });
});
