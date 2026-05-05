import { describe, it, expect } from 'vitest';
import { isAllowedRecipient, getAllowedRecipients, AllowlistRefusalError } from './allowlist';

describe('isAllowedRecipient', () => {
  it('accepts each canonical allowlisted address', () => {
    expect(isAllowedRecipient('admin@example.com')).toBe(true);
    expect(isAllowedRecipient('user@example.com')).toBe(true);
    expect(isAllowedRecipient('admin@example.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAllowedRecipient('ADMIN@EXAMPLE.COM')).toBe(true);
    expect(isAllowedRecipient('Admin@example.com')).toBe(true);
    expect(isAllowedRecipient('CIO@example.com')).toBe(true);
  });

  it('trims surrounding whitespace before checking', () => {
    expect(isAllowedRecipient('  admin@example.com  ')).toBe(true);
    expect(isAllowedRecipient('\tadmin@example.com\n')).toBe(true);
  });

  it('rejects unknown addresses', () => {
    expect(isAllowedRecipient('attacker@evil.com')).toBe(false);
    expect(isAllowedRecipient('user@example.com')).toBe(false); // close, but not the canonical form
    expect(isAllowedRecipient('cio@gmail.com')).toBe(false); // right user, wrong domain
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
    expect(isAllowedRecipient('admin@example.com.evil.com')).toBe(false);
    expect(isAllowedRecipient('admin@evil-example.com')).toBe(false);
    expect(isAllowedRecipient('cio@cio.example.com')).toBe(false);
  });

  it('rejects local-part spoofing', () => {
    expect(isAllowedRecipient('admin+x@example.com')).toBe(false);
    expect(isAllowedRecipient('admin.@example.com')).toBe(false);
    expect(isAllowedRecipient('.admin@example.com')).toBe(false);
  });
});

describe('getAllowedRecipients', () => {
  it('returns the canonical three addresses, sorted', () => {
    expect(getAllowedRecipients()).toEqual([
      'admin@example.com',
      'user@example.com',
      'admin@example.com',
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
