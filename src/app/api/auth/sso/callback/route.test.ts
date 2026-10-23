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
const SLUG = 'org-one';

function callback(state: Record<string, unknown> = { orgSlug: SLUG, issuer: ISSUER }): NextRequest {
  const payload = { state: 's', nonce: 'n', orgId: 'org-1', ...state };
  const cookie = `dr_oidc_state=${encodeURIComponent(JSON.stringify(payload))}`;
  return new NextRequest('https://docuridge.example.com/DocuRidge/api/auth/sso/callback?code=c&state=s', {
    headers: { cookie },
  });
}

function expectRefused(res: Response) {
  expect(res.headers.get('location')).toMatch(/\/login\?sso=error$/);
  expect(mocks.discoverIssuer).not.toHaveBeenCalled();
  expect(mocks.createSession).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.trusted.list = `${SLUG}=${ISSUER}`;
  mocks.orgFindUnique.mockResolvedValue({
    id: 'org-1',
    slug: SLUG,
    ssoEnabled: true,
    ssoIssuer: ISSUER,
    ssoClientId: 'client',
    ssoClientSecret: 'secret-value',
  });
  mocks.discoverIssuer.mockRejectedValue(new Error('stop after the binding check'));
});

describe('SSO callback issuer binding', () => {
  it('proceeds to the IdP for an org whose issuer is bound to its slug', async () => {
    await GET(callback());
    expect(mocks.discoverIssuer).toHaveBeenCalledWith(ISSUER);
  });

  it('refuses an org whose issuer the operator has not listed, before contacting it', async () => {
    mocks.trusted.list = `${SLUG}=https://idp.example.edu/other`;
    expectRefused(await GET(callback()));
  });

  it('refuses an org whose binding was removed after the flow started', async () => {
    mocks.trusted.list = 'another-org=https://idp.example.edu/other';
    expectRefused(await GET(callback()));
  });

  it('refuses every org while no binding is listed', async () => {
    mocks.trusted.list = '';
    expectRefused(await GET(callback()));
  });

  it('refuses an org using a trusted issuer that is bound to a different slug', async () => {
    mocks.trusted.list = `real-org=${ISSUER}`;
    expectRefused(await GET(callback()));
  });

  it('refuses a legacy bare-issuer list (malformed entries fail closed)', async () => {
    mocks.trusted.list = ISSUER;
    expectRefused(await GET(callback()));
  });

  it('refuses when the state was minted for a different slug', async () => {
    expectRefused(await GET(callback({ orgSlug: 'other-org', issuer: ISSUER })));
  });

  it('refuses when the org changed issuer since the flow started', async () => {
    expectRefused(await GET(callback({ orgSlug: SLUG, issuer: 'https://idp.example.edu/old' })));
  });

  it('refuses a state cookie without the org binding (pre-binding format)', async () => {
    expectRefused(await GET(callback({ orgSlug: undefined, issuer: undefined })));
  });
});
