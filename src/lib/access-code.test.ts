import { describe, it, expect } from 'vitest';
import {
  ACCESS_CODE_MAX_LENGTH,
  ACCESS_CODE_MIN_LENGTH,
  ACCESS_CODE_PATTERN,
  accessCodeCookieName,
  generateAccessCode,
  normalizeAccessCode,
} from './access-code';
import { hashAccessCode, verifyAccessCode } from './access-code-server';

describe('normalizeAccessCode', () => {
  it('lowercases and trims', () => {
    expect(normalizeAccessCode('  AbC123 ')).toBe('abc123');
  });
});

describe('hashAccessCode', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    const hash = hashAccessCode('ABC123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is case-insensitive', () => {
    expect(hashAccessCode('ABC123')).toBe(hashAccessCode('abc123'));
    expect(hashAccessCode('MiXeD42')).toBe(hashAccessCode('mixed42'));
  });

  it('ignores surrounding whitespace', () => {
    expect(hashAccessCode('  abc123  ')).toBe(hashAccessCode('abc123'));
  });

  it('is deterministic', () => {
    expect(hashAccessCode('hello1')).toBe(hashAccessCode('hello1'));
    expect(hashAccessCode('hello1')).not.toBe(hashAccessCode('hello2'));
  });
});

describe('verifyAccessCode', () => {
  const hash = hashAccessCode('SecRet9');

  it('returns true when no code is configured (null hash)', () => {
    expect(verifyAccessCode(null, 'anything')).toBe(true);
    expect(verifyAccessCode(null, '')).toBe(true);
  });

  it('returns true for the matching code regardless of case', () => {
    expect(verifyAccessCode(hash, 'SecRet9')).toBe(true);
    expect(verifyAccessCode(hash, 'secret9')).toBe(true);
    expect(verifyAccessCode(hash, '  SECRET9 ')).toBe(true);
  });

  it('returns false for a wrong code', () => {
    expect(verifyAccessCode(hash, 'wrong1')).toBe(false);
    expect(verifyAccessCode(hash, 'SecRet8')).toBe(false);
  });
});

describe('generateAccessCode', () => {
  it('generates a 6-char A–Z 0–9 code by default', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateAccessCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
    }
  });

  it('honours a custom length within the allowed range', () => {
    expect(generateAccessCode(ACCESS_CODE_MIN_LENGTH)).toMatch(
      new RegExp(`^[A-Z0-9]{${ACCESS_CODE_MIN_LENGTH}}$`),
    );
    expect(generateAccessCode(ACCESS_CODE_MAX_LENGTH)).toMatch(
      new RegExp(`^[A-Z0-9]{${ACCESS_CODE_MAX_LENGTH}}$`),
    );
  });

  it('generates codes accepted by the sender-side pattern', () => {
    for (let i = 0; i < 200; i++) {
      expect(ACCESS_CODE_PATTERN.test(generateAccessCode())).toBe(true);
    }
  });
});

describe('accessCodeCookieName', () => {
  it('is stable and recipient-scoped', () => {
    expect(accessCodeCookieName('rec_123')).toBe('dr_access_rec_123');
    expect(accessCodeCookieName('a')).not.toBe(accessCodeCookieName('b'));
  });
});
