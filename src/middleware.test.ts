import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

const PUBLIC_ORIGIN = 'https://docuridge.example.edu';
const TAILNET_ORIGIN = 'https://docuridge.tailnet.example';

beforeEach(() => {
  process.env.PUBLIC_URL = `${PUBLIC_ORIGIN}/DocuRidge`;
  delete process.env.TRUSTED_ORIGINS;
});

function post(origin?: string, method = 'POST') {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new NextRequest(`${PUBLIC_ORIGIN}/DocuRidge/login`, { method, headers });
}

describe('middleware origin allowlist', () => {
  it('allows the PUBLIC_URL origin', () => {
    expect(middleware(post(PUBLIC_ORIGIN)).status).not.toBe(403);
  });

  it('allows loopback', () => {
    expect(middleware(post('http://localhost:3737')).status).not.toBe(403);
  });

  it('allows a request with no Origin header (same-origin form nav)', () => {
    expect(middleware(post(undefined)).status).not.toBe(403);
  });

  it('rejects a third-party origin', () => {
    expect(middleware(post('https://evil.example.com')).status).toBe(403);
  });

  it('does not gate non-mutating methods', () => {
    expect(middleware(post('https://evil.example.com', 'GET')).status).not.toBe(403);
  });

  // The regression: DocuRidge is reachable over the tailnet via `tailscale serve`,
  // which forwards the real ts.net Host/Origin. That origin is not PUBLIC_URL, so
  // every login POST was rejected with 403 'Bad Origin'.
  it('allows an origin listed in TRUSTED_ORIGINS', () => {
    process.env.TRUSTED_ORIGINS = TAILNET_ORIGIN;
    expect(middleware(post(TAILNET_ORIGIN)).status).not.toBe(403);
  });

  it('supports a comma-separated TRUSTED_ORIGINS list, ignoring whitespace', () => {
    process.env.TRUSTED_ORIGINS = `https://a.example , ${TAILNET_ORIGIN} ,`;
    expect(middleware(post(TAILNET_ORIGIN)).status).not.toBe(403);
    expect(middleware(post('https://a.example')).status).not.toBe(403);
  });

  it('still rejects an origin absent from a populated TRUSTED_ORIGINS', () => {
    process.env.TRUSTED_ORIGINS = TAILNET_ORIGIN;
    expect(middleware(post('https://evil.example.com')).status).toBe(403);
  });

  it('does not treat an empty TRUSTED_ORIGINS as a wildcard', () => {
    process.env.TRUSTED_ORIGINS = '   ,  ,';
    expect(middleware(post('https://evil.example.com')).status).toBe(403);
  });
});
