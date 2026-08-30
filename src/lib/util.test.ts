import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getClientIp, timingSafeEqual, randomBase64Url, sha256Hex } from './util';

function makeHeaders(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const ORIGINAL_TRUSTED_PROXY_HOPS = process.env.TRUSTED_PROXY_HOPS;

describe('getClientIp', () => {
  beforeEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  afterAll(() => {
    if (ORIGINAL_TRUSTED_PROXY_HOPS === undefined) {
      delete process.env.TRUSTED_PROXY_HOPS;
    } else {
      process.env.TRUSTED_PROXY_HOPS = ORIGINAL_TRUSTED_PROXY_HOPS;
    }
  });

  it('blocks the XFF-spoofing forgery: returns the right-most entry, not the client-supplied left-most one', () => {
    const headers = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('prefers x-real-ip over the right-most x-forwarded-for entry when they differ', () => {
    const headers = makeHeaders({
      'x-forwarded-for': '1.2.3.4, 198.51.100.7',
      'x-real-ip': '203.0.113.9',
    });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('returns x-real-ip when there is no x-forwarded-for header at all', () => {
    const headers = makeHeaders({ 'x-real-ip': '203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('falls through to x-forwarded-for when x-real-ip is whitespace-only', () => {
    const headers = makeHeaders({
      'x-forwarded-for': '1.2.3.4, 203.0.113.9',
      'x-real-ip': '   ',
    });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('returns a single-entry x-forwarded-for as-is', () => {
    const headers = makeHeaders({ 'x-forwarded-for': '203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('with TRUSTED_PROXY_HOPS=2 returns the second entry from the right', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    const headers = makeHeaders({
      'x-forwarded-for': '1.2.3.4, 198.51.100.7, 203.0.113.9',
    });
    expect(getClientIp(headers)).toBe('198.51.100.7');
  });

  it('with TRUSTED_PROXY_HOPS=2 and a one-entry chain, clamps to that entry', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    const headers = makeHeaders({ 'x-forwarded-for': '203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('returns "unknown" when no headers are present', () => {
    expect(getClientIp(makeHeaders({}))).toBe('unknown');
  });

  it('returns "unknown" for an empty x-forwarded-for header', () => {
    const headers = makeHeaders({ 'x-forwarded-for': '' });
    expect(getClientIp(headers)).toBe('unknown');
  });

  it('returns "unknown" for an x-forwarded-for header of only commas and whitespace', () => {
    const headers = makeHeaders({ 'x-forwarded-for': ' , , ' });
    expect(getClientIp(headers)).toBe('unknown');
  });

  it('trims whitespace around entries', () => {
    const headers = makeHeaders({ 'x-forwarded-for': '  1.2.3.4  ,   203.0.113.9   ' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('returns an IPv6 entry unmodified', () => {
    const headers = makeHeaders({ 'x-forwarded-for': '2001:db8::1' });
    expect(getClientIp(headers)).toBe('2001:db8::1');
  });

  it('falls back to 1-hop behavior when TRUSTED_PROXY_HOPS is non-numeric', () => {
    process.env.TRUSTED_PROXY_HOPS = 'not-a-number';
    const headers = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('falls back to 1-hop behavior when TRUSTED_PROXY_HOPS is "0"', () => {
    process.env.TRUSTED_PROXY_HOPS = '0';
    const headers = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });

  it('falls back to 1-hop behavior when TRUSTED_PROXY_HOPS is negative', () => {
    process.env.TRUSTED_PROXY_HOPS = '-1';
    const headers = makeHeaders({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(getClientIp(headers)).toBe('203.0.113.9');
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('secret-value', 'secret-value')).toBe(true);
  });

  it('returns false for different same-length strings', () => {
    expect(timingSafeEqual('secret-value', 'secret-valuf')).toBe(false);
  });

  it('returns false for different-length strings', () => {
    expect(timingSafeEqual('short', 'much-longer-string')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('randomBase64Url', () => {
  it('returns a string', () => {
    expect(typeof randomBase64Url(32)).toBe('string');
  });

  it('returns different values across calls', () => {
    expect(randomBase64Url(32)).not.toBe(randomBase64Url(32));
  });

  it('decodes to the requested byte length', () => {
    const value = randomBase64Url(32);
    expect(Buffer.from(value, 'base64url').length).toBe(32);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 digest of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});
