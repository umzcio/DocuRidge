import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
  ssoEnabled: boolean;
  ssoIssuer: string | null;
  ssoClientId: string | null;
  ssoScopes: string;
}

const mocks = vi.hoisted(() => ({
  orgs: [] as OrgRow[],
  findMany: vi.fn(),
  discoverIssuer: vi.fn(),
  trusted: { list: '' },
}));

vi.mock('@/lib/prisma', () => ({ prisma: { organisation: { findMany: mocks.findMany } } }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ PUBLIC_URL: 'https://docuridge.example.com/DocuRidge', SSO_TRUSTED_ISSUERS: mocks.trusted.list }),
  getBasePath: () => '/DocuRidge',
}));
vi.mock('@/lib/auth/oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/oidc')>()),
  discoverIssuer: mocks.discoverIssuer,
}));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { GET } from './route';

const CAMPUS_IDP = 'https://login.example.edu/tenant/v2.0';
const OTHER_IDP = 'https://idp.example.com/other/v2.0';

function org(slug: string, issuer: string, createdAt: string, extra: Partial<OrgRow> = {}): OrgRow {
  return {
    id: `id-${slug}`,
    slug,
    name: `Org ${slug}`,
    createdAt: new Date(createdAt),
    ssoEnabled: true,
    ssoIssuer: issuer,
    ssoClientId: `client-${slug}`,
    ssoScopes: 'openid profile email',
    ...extra,
  };
}

function login(query = ''): NextRequest {
  return new NextRequest(`https://docuridge.example.com/DocuRidge/api/auth/sso/login${query}`);
}

function authorizeTarget(res: Response): URL | null {
  const loc = res.headers.get('location');
  return loc && loc.startsWith('https://login.example.edu/') ? new URL(loc) : null;
}

function stateCookie(res: Response): Record<string, string> {
  const raw = res.headers.get('set-cookie') ?? '';
  const m = /dr_oidc_state=([^;]+)/.exec(raw);
  return m?.[1] ? JSON.parse(decodeURIComponent(m[1])) : {};
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.orgs = [];
  mocks.trusted.list = '';
  // Behave like the real query: slug IN (...), SSO enabled, client ID set.
  mocks.findMany.mockImplementation(
    async (args: { where: { slug: { in: string[] }; ssoEnabled: boolean } }) =>
      mocks.orgs.filter(
        (o) => args.where.slug.in.includes(o.slug) && o.ssoEnabled === args.where.ssoEnabled && o.ssoClientId !== null,
      ),
  );
  mocks.discoverIssuer.mockImplementation(async (issuer: string) => ({
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    userinfoEndpoint: `${issuer}/userinfo`,
  }));
});

describe('SSO login org selection', () => {
  it('routes to the single bound org and binds its slug + issuer into the state cookie', async () => {
    mocks.trusted.list = `campus=${CAMPUS_IDP}`;
    mocks.orgs = [org('campus', CAMPUS_IDP, '2026-01-01')];

    const res = await GET(login());
    const target = authorizeTarget(res);
    expect(target?.searchParams.get('client_id')).toBe('client-campus');
    expect(stateCookie(res)).toMatchObject({ orgId: 'id-campus', orgSlug: 'campus', issuer: CAMPUS_IDP });
  });

  it('never routes to an unbound org, even a newer one on the same trusted issuer', async () => {
    mocks.trusted.list = `campus=${CAMPUS_IDP}`;
    mocks.orgs = [
      org('campus', CAMPUS_IDP, '2026-01-01'),
      org('attacker', CAMPUS_IDP, '2026-10-01'),
    ];

    const res = await GET(login());
    expect(authorizeTarget(res)?.searchParams.get('client_id')).toBe('client-campus');

    const direct = await GET(login('?org=attacker'));
    expect(direct.status).toBe(404);
    expect(mocks.discoverIssuer).toHaveBeenCalledTimes(1);
  });

  it('refuses a bound slug whose org switched to an issuer other than its binding', async () => {
    mocks.trusted.list = `campus=${CAMPUS_IDP}`;
    mocks.orgs = [org('campus', OTHER_IDP, '2026-01-01')];

    const res = await GET(login());
    expect(res.status).toBe(404);
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();
  });

  it('requires org=<slug> when several bound orgs have SSO enabled, and honours it', async () => {
    mocks.trusted.list = `campus=${CAMPUS_IDP},law=${CAMPUS_IDP}`;
    mocks.orgs = [org('campus', CAMPUS_IDP, '2026-01-01'), org('law', CAMPUS_IDP, '2026-02-01')];

    const ambiguous = await GET(login());
    expect(ambiguous.status).toBe(400);
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();

    const chosen = await GET(login('?org=campus'));
    expect(authorizeTarget(chosen)?.searchParams.get('client_id')).toBe('client-campus');
    expect(stateCookie(chosen)).toMatchObject({ orgSlug: 'campus' });
  });

  it('404s an org=<slug> that is not bound + enabled', async () => {
    mocks.trusted.list = `campus=${CAMPUS_IDP},law=${CAMPUS_IDP}`;
    mocks.orgs = [
      org('campus', CAMPUS_IDP, '2026-01-01'),
      org('law', CAMPUS_IDP, '2026-02-01', { ssoEnabled: false }),
    ];

    expect((await GET(login('?org=law'))).status).toBe(404);
    expect((await GET(login('?org=nobody'))).status).toBe(404);
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();
  });

  it('404s when nothing is bound, without querying the database', async () => {
    mocks.orgs = [org('campus', CAMPUS_IDP, '2026-01-01')];
    expect((await GET(login())).status).toBe(404);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed (legacy bare-issuer) entry', async () => {
    mocks.trusted.list = CAMPUS_IDP;
    mocks.orgs = [org('campus', CAMPUS_IDP, '2026-01-01')];
    expect((await GET(login())).status).toBe(404);
    expect(mocks.discoverIssuer).not.toHaveBeenCalled();
  });
});
