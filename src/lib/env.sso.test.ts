import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  PUBLIC_URL: 'https://docuridge.example.com/DocuRidge',
  DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/docuridge',
  SESSION_SECRET: 'x'.repeat(32),
  JWS_SIGNING_TOKEN_SECRET: 'y'.repeat(32),
  JWS_RESET_TOKEN_SECRET: 'z'.repeat(32),
  BOOTSTRAP_TOKEN: 'b'.repeat(16),
};

async function loadEnv(ssoTrustedIssuers: string) {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  vi.stubEnv('SSO_TRUSTED_ISSUERS', ssoTrustedIssuers);
  vi.resetModules();
  const { getEnv } = await import('./env');
  return getEnv;
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('SSO_TRUSTED_ISSUERS env validation', () => {
  it('accepts <org-slug>=<issuer-url> bindings and an empty value', async () => {
    expect((await loadEnv('acme=https://login.example.edu/t/v2.0, law=https://idp.example.com'))().SSO_TRUSTED_ISSUERS).toContain('acme=');
    expect((await loadEnv(''))().SSO_TRUSTED_ISSUERS).toBe('');
  });

  it.each([
    ['a bare issuer (old format)', 'https://login.example.edu/t/v2.0'],
    ['an empty slug', '=https://login.example.edu/t/v2.0'],
    ['a non-https issuer', 'acme=http://login.example.edu/t'],
    ['a slug bound twice', 'acme=https://idp.example.com/a,acme=https://idp.example.com/b'],
  ])('refuses to boot on %s', async (_label, value) => {
    const getEnv = await loadEnv(value);
    expect(() => getEnv()).toThrow(/SSO_TRUSTED_ISSUERS: invalid entry/);
  });
});
