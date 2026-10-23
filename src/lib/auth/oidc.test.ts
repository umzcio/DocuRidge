import { beforeEach, describe, expect, it, vi } from 'vitest';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup, default: { lookup: dnsLookup } }));

import { OutboundRefusedError } from '../net/outbound';
import {
  buildAuthorizeUrl,
  discoverIssuer,
  exchangeCode,
  fetchUserInfo,
  isTrustedSsoIssuer,
  parseTrustedSsoIssuers,
  resolveSsoUser,
  type SsoResolveDb,
  type SsoUserRecord,
} from './oidc';

const CFG = {
  authorizationEndpoint: 'https://idp.example.com/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://idp.example.com/oauth2/v2.0/token',
  userinfoEndpoint: 'https://idp.example.com/oidc/userinfo',
  clientId: 'client-123',
  clientSecret: 'super-secret-value',
  scopes: 'openid profile email',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildAuthorizeUrl', () => {
  it('builds the exact authorization URL with URLSearchParams encoding', () => {
    const url = buildAuthorizeUrl(CFG, {
      state: 'state value+',
      nonce: 'nonce123',
      redirectUri: 'https://docs.example.edu/DocuRidge/api/auth/sso/callback',
    });
    expect(url).toBe(
      'https://idp.example.com/oauth2/v2.0/authorize?' +
        'client_id=client-123&response_type=code&scope=openid+profile+email' +
        '&redirect_uri=https%3A%2F%2Fdocs.example.edu%2FDocuRidge%2Fapi%2Fauth%2Fsso%2Fcallback' +
        '&state=state+value%2B&nonce=nonce123',
    );
  });
});

describe('discoverIssuer', () => {
  it('GETs the well-known configuration and returns the three endpoints', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        authorization_endpoint: CFG.authorizationEndpoint,
        token_endpoint: CFG.tokenEndpoint,
        userinfo_endpoint: CFG.userinfoEndpoint,
        issuer: 'https://idp.example.com/',
      }),
    );
    const endpoints = await discoverIssuer('https://idp.example.com/', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://idp.example.com/.well-known/openid-configuration',
      { headers: { accept: 'application/json' } },
    );
    expect(endpoints).toEqual({
      authorizationEndpoint: CFG.authorizationEndpoint,
      tokenEndpoint: CFG.tokenEndpoint,
      userinfoEndpoint: CFG.userinfoEndpoint,
    });
  });

  it('throws on a non-OK discovery response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(discoverIssuer('https://idp.example.com', fetchImpl)).rejects.toThrow(
      'Issuer discovery failed: HTTP 404',
    );
  });

  it('throws when a required endpoint is missing from the metadata', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ authorization_endpoint: CFG.authorizationEndpoint }),
    );
    await expect(discoverIssuer('https://idp.example.com', fetchImpl)).rejects.toThrow(
      'malformed metadata',
    );
  });
});

describe('exchangeCode', () => {
  it('POSTs form-urlencoded with basic auth and returns the tokens', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: 'at-1', id_token: 'it-1', token_type: 'Bearer' }),
    );
    const tokens = await exchangeCode(
      CFG,
      'the-code',
      'https://docs.example.edu/api/auth/sso/callback',
      fetchImpl,
    );
    expect(tokens).toEqual({ accessToken: 'at-1', idToken: 'it-1' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CFG.tokenEndpoint);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('client-123:super-secret-value').toString('base64')}`,
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('https://docs.example.edu/api/auth/sso/callback');
  });

  it('throws on a non-OK token response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(exchangeCode(CFG, 'bad-code', 'https://cb.example.com', fetchImpl)).rejects.toThrow(
      'Token exchange failed: HTTP 400',
    );
  });

  it('throws when the token response lacks an id_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'at-1' }));
    await expect(exchangeCode(CFG, 'code', 'https://cb.example.com', fetchImpl)).rejects.toThrow(
      'malformed response',
    );
  });
});

describe('fetchUserInfo', () => {
  it('returns sub/email/name on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ sub: 'sub-9', email: 'Ada@Example.COM', name: 'Ada Lovelace' }),
    );
    const info = await fetchUserInfo(CFG.userinfoEndpoint, 'at-1', fetchImpl);
    expect(info).toEqual({ sub: 'sub-9', email: 'Ada@Example.COM', name: 'Ada Lovelace' });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer at-1');
  });

  it('throws when email is absent (zod rejection)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ sub: 'sub-9' }));
    await expect(fetchUserInfo(CFG.userinfoEndpoint, 'at-1', fetchImpl)).rejects.toThrow(
      'malformed response',
    );
  });

  it('throws on a non-OK userinfo response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    await expect(fetchUserInfo(CFG.userinfoEndpoint, 'at-1', fetchImpl)).rejects.toThrow(
      'UserInfo failed: HTTP 401',
    );
  });
});

describe('resolveSsoUser', () => {
  const ORG_ID = 'org-1';
  const SUB = 'sub-abc';

  interface Calls {
    update: unknown[];
    create: unknown[];
    orgMemberCreate: unknown[];
    orgMemberDeleteMany: unknown[];
    tokenUpdateMany: unknown[];
  }

  function makeDb(overrides: {
    bySubject?: SsoUserRecord | null;
    byEmail?: SsoUserRecord | null;
    membership?: { id: string } | null;
  }): SsoResolveDb & { calls: Calls } {
    const calls: Calls = { update: [], create: [], orgMemberCreate: [], orgMemberDeleteMany: [], tokenUpdateMany: [] };
    const db: SsoResolveDb = {
      user: {
        findFirst: vi.fn().mockResolvedValue(overrides.bySubject ?? null),
        findUnique: vi.fn().mockResolvedValue(overrides.byEmail ?? null),
        update: vi.fn().mockImplementation((args: unknown) => {
          calls.update.push(args);
          return Promise.resolve({ ...(overrides.byEmail as object), ...(args as { data: object }).data });
        }),
        create: vi.fn().mockImplementation((args: unknown) => {
          calls.create.push(args);
          return Promise.resolve({ id: 'user-new', ...(args as { data: object }).data });
        }),
      },
      orgMember: {
        findUnique: vi.fn().mockResolvedValue(overrides.membership ?? null),
        create: vi.fn().mockImplementation((args: unknown) => {
          calls.orgMemberCreate.push(args);
          return Promise.resolve({ id: 'mem-1' });
        }),
        deleteMany: vi.fn().mockImplementation((args: unknown) => {
          calls.orgMemberDeleteMany.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      emailVerificationToken: {
        updateMany: vi.fn().mockImplementation((args: unknown) => {
          calls.tokenUpdateMany.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    return { ...db, calls } as SsoResolveDb & { calls: Calls };
  }

  it("returns 'linked' when the (ssoSubject, ssoOrgId) pair already exists", async () => {
    const db = makeDb({ bySubject: { id: 'u-1', email: 'a@b.c', name: 'A', ssoSubject: SUB, ssoOrgId: ORG_ID, passwordHash: null, emailVerifiedAt: null, deletedAt: null } });
    const result = await resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID });
    expect(result).toEqual({ status: 'linked', userId: 'u-1' });
    expect(db.calls.update).toHaveLength(0);
  });

  it("returns 'matched' and links an existing personal account by email", async () => {
    const db = makeDb({
      byEmail: { id: 'u-2', email: 'a@b.c', name: 'Ann', ssoSubject: null, ssoOrgId: null, passwordHash: null, emailVerifiedAt: null, deletedAt: null },
      membership: { id: 'mem-1' },
    });
    const result = await resolveSsoUser(db)({ sub: SUB, email: 'A@B.C', orgId: ORG_ID });
    expect(result).toEqual({ status: 'matched', userId: 'u-2' });
    expect(db.calls.update).toEqual([
      {
        where: { id: 'u-2' },
        data: { ssoSubject: SUB, ssoOrgId: ORG_ID, emailVerifiedAt: expect.any(Date) },
      },
    ]);
  });

  it('lower-cases the email before the uniqueness lookup', async () => {
    const db = makeDb({
      byEmail: { id: 'u-2', email: 'a@b.c', name: 'Ann', ssoSubject: null, ssoOrgId: null, passwordHash: null, emailVerifiedAt: null, deletedAt: null },
      membership: { id: 'mem-1' },
    });
    await resolveSsoUser(db)({ sub: SUB, email: '  A@B.C ', orgId: ORG_ID });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: 'a@b.c' } });
  });

  it("returns 'created' with an SSO-only user and SENDER membership when nothing matches", async () => {
    const db = makeDb({});
    const result = await resolveSsoUser(db)({ sub: SUB, email: 'new@b.c', orgId: ORG_ID, name: 'New Person' });
    expect(result).toEqual({ status: 'created', userId: 'user-new' });
    expect(db.calls.create).toEqual([
      {
        data: {
          email: 'new@b.c',
          name: 'New Person',
          passwordHash: null,
          emailVerifiedAt: expect.any(Date),
          ssoSubject: SUB,
          ssoOrgId: ORG_ID,
        },
      },
    ]);
    expect(db.calls.orgMemberCreate).toEqual([
      { data: { orgId: ORG_ID, userId: 'user-new', role: 'SENDER' } },
    ]);
  });

  it('falls back to the email local part when userinfo has no name', async () => {
    const db = makeDb({});
    await resolveSsoUser(db)({ sub: SUB, email: 'new@b.c', orgId: ORG_ID });
    expect((db.calls.create[0] as { data: { name: string } }).data.name).toBe('new');
  });

  it('refuses to rebind an email already linked to a different SSO subject', async () => {
    const db = makeDb({
      byEmail: { id: 'u-3', email: 'a@b.c', name: 'Ann', ssoSubject: 'other-sub', ssoOrgId: ORG_ID, passwordHash: null, emailVerifiedAt: null, deletedAt: null },
      membership: { id: 'mem-1' },
    });
    await expect(resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID })).rejects.toThrow(
      'sso_subject_conflict',
    );
  });

  it('refuses an email match that has no membership in the SSO org', async () => {
    const db = makeDb({
      byEmail: { id: 'u-2', email: 'a@b.c', name: 'Ann', ssoSubject: null, ssoOrgId: null, passwordHash: null, emailVerifiedAt: null, deletedAt: null },
    });
    await expect(resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID })).rejects.toThrow(
      'sso_email_not_in_org',
    );
  });

  it('refuses deleted accounts', async () => {
    const db = makeDb({
      bySubject: { id: 'u-1', email: 'a@b.c', name: 'A', ssoSubject: SUB, ssoOrgId: ORG_ID, passwordHash: null, emailVerifiedAt: null, deletedAt: new Date() },
    });
    await expect(resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID })).rejects.toThrow(
      'sso_user_deleted',
    );
  });
  it('still refuses a verified personal account outside the SSO org', async () => {
    const db = makeDb({
      byEmail: { id: 'u-2', email: 'a@b.c', name: 'Ann', ssoSubject: null, ssoOrgId: null, passwordHash: 'own-hash', emailVerifiedAt: new Date(), deletedAt: null },
    });
    await expect(resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID })).rejects.toThrow(
      'sso_email_not_in_org',
    );
    expect(db.calls.update).toHaveLength(0);
  });

  describe('an unverified registration for the asserted email', () => {
    const squatted: SsoUserRecord = {
      id: 'u-9', email: 'a@b.c', name: 'Squatter', ssoSubject: null, ssoOrgId: null,
      passwordHash: 'squatter-hash', emailVerifiedAt: null, deletedAt: null,
    };

    it('is reclaimed for the IdP identity: password dropped, links consumed, moved into the SSO org', async () => {
      const db = makeDb({ byEmail: squatted });
      const result = await resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID });

      expect(result).toEqual({ status: 'reclaimed', userId: 'u-9' });
      expect(db.calls.update).toEqual([
        {
          where: { id: 'u-9' },
          data: { passwordHash: null, ssoSubject: SUB, ssoOrgId: ORG_ID, emailVerifiedAt: expect.any(Date) },
        },
      ]);
      expect(db.calls.tokenUpdateMany).toEqual([
        { where: { userId: 'u-9', consumedAt: null }, data: { consumedAt: expect.any(Date) } },
      ]);
      expect(db.calls.orgMemberDeleteMany).toEqual([
        { where: { userId: 'u-9', orgId: { not: ORG_ID } } },
      ]);
      expect(db.calls.orgMemberCreate).toEqual([
        { data: { orgId: ORG_ID, userId: 'u-9', role: 'SENDER' } },
      ]);
    });

    it('keeps an existing membership in the SSO org instead of adding another', async () => {
      const db = makeDb({ byEmail: squatted, membership: { id: 'mem-1' } });
      const result = await resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID });

      expect(result.status).toBe('reclaimed');
      expect(db.calls.orgMemberCreate).toHaveLength(0);
      expect((db.calls.update[0] as { data: { passwordHash: unknown } }).data.passwordHash).toBeNull();
    });

    it('is still refused when it is bound to a different SSO subject', async () => {
      const db = makeDb({ byEmail: { ...squatted, ssoSubject: 'other-sub', ssoOrgId: ORG_ID } });
      await expect(resolveSsoUser(db)({ sub: SUB, email: 'a@b.c', orgId: ORG_ID })).rejects.toThrow(
        'sso_subject_conflict',
      );
      expect(db.calls.update).toHaveLength(0);
    });
  });
});

describe('trusted SSO issuers', () => {
  it('parses a comma-separated list, ignoring blanks and surrounding space', () => {
    expect(parseTrustedSsoIssuers(' https://idp.example.com/a/v2.0 , ,https://idp.example.edu ')).toEqual([
      'https://idp.example.com/a/v2.0',
      'https://idp.example.edu',
    ]);
    expect(parseTrustedSsoIssuers('')).toEqual([]);
  });

  it('trusts only an exact listed issuer', () => {
    const list = 'https://idp.example.com/tenant/v2.0';
    expect(isTrustedSsoIssuer('https://idp.example.com/tenant/v2.0', list)).toBe(true);
    expect(isTrustedSsoIssuer('https://idp.example.com/other/v2.0', list)).toBe(false);
    expect(isTrustedSsoIssuer('https://idp.example.com/tenant/v2.0.attacker.example', list)).toBe(false);
  });

  it('trusts nothing when the list is empty', () => {
    expect(isTrustedSsoIssuer('https://idp.example.com', '')).toBe(false);
    expect(isTrustedSsoIssuer('', '')).toBe(false);
  });
});

describe('default transport refuses internal IdP targets (SSRF)', () => {
  beforeEach(() => {
    dnsLookup.mockReset();
    delete process.env.SSO_ALLOWED_INTERNAL_HOSTS;
  });

  it.each([
    'https://127.0.0.1',
    'https://[::ffff:a9fe:a9fe]',
    'https://docuridge_mailhog.docuridge_internal:8025',
    'https://idp.example.com.',
  ])('discoverIssuer refuses %s without connecting', async (issuer) => {
    await expect(discoverIssuer(issuer)).rejects.toBeInstanceOf(OutboundRefusedError);
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('discoverIssuer refuses an issuer name that resolves to a private address', async () => {
    dnsLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(discoverIssuer('https://idp.example.com')).rejects.toMatchObject({
      reason: 'private_address',
    });
  });

  it('exchangeCode refuses a token endpoint that points inside the network', async () => {
    await expect(
      exchangeCode(
        { ...CFG, tokenEndpoint: 'http://169.254.169.254/latest/api/token' },
        'code',
        'https://cb.example.com',
      ),
    ).rejects.toMatchObject({ reason: 'link_local' });
  });

  it('fetchUserInfo refuses a userinfo endpoint that resolves to loopback', async () => {
    dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchUserInfo('https://userinfo.example.com/me', 'at-1')).rejects.toMatchObject({
      reason: 'loopback',
    });
  });
});
