import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  orgFindUnique: vi.fn(),
  discoverIssuer: vi.fn(),
  createSession: vi.fn(),
  trusted: { list: '' },
}));

vi.mock('@/lib/prisma', () => ({ prisma: { organisation: { findUnique: mocks.orgFindUnique } } }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ PUBLIC_URL: 'https://docuridge.example.com/DocuRidge', SSO_TRUSTED_ISSUERS: mocks.trusted.list }),
  getBasePath: () => '/DocuRidge',
}));
vi.mock('@/lib/auth/oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/oidc')>()),
  discoverIssuer: mocks.discoverIssuer,
}));
vi.mock('@/lib/auth/session', () => ({
  createSession: mocks.createSession,
  captureClientContext: () => ({ ipAddress: '203.0.113.1', userAgent: 'vitest' }),
}));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from './route';

const ISSUER = 'https://idp.example.com/tenant/v2.0';

function callback(): NextRequest {
  const cookie = `dr_oidc_state=${encodeURIComponent(JSON.stringify({ state: 's', nonce: 'n', orgId: 'org-1' }))}`;
  return new NextRequest('https://docuridge.example.com/DocuRidge/api/auth/sso/callback?code=c&state=s', {
    headers: { cookie },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.orgFindUnique.mockResolvedValue({
    id: 'org-1',
    ssoEnabled: true,
    ssoIssuer: ISSUER,
    ssoClientId: 'client',
    ssoClientSecret: 'secret-value',
  });
  mocks.discoverIssuer.mockRejectedValue(new Error('stop after the trust check'));
});

describe('SSO callback issuer trust', () => {
  it('refuses an org whose issuer the operator has not listed, before contacting it', async () => {
    mocks.trusted.list = 'https://idp.example.edu/other';
    const res = await GET(callback());

    expect(res.headers.get('location')).toMatch(/\/login\?sso=error$/);
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('refuses every org while no issuer is listed', async () => {
    mocks.trusted.list = '';
    await GET(callback());
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();
  });

  it('proceeds to the IdP for a listed issuer', async () => {
    mocks.trusted.list = ISSUER;
    await GET(callback());
    expect(mocks.discoverIssuer).toHaveBeenCalledWith(ISSUER);
  });
});
