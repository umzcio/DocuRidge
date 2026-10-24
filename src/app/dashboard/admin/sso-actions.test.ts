import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  orgFind: vi.fn(),
  orgUpdate: vi.fn(),
  dnsLookup: vi.fn(),
  trusted: { list: '' },
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup, default: { lookup: mocks.dnsLookup } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ user: { id: 'user_1' }, orgId: 'org_1', role: 'ADMIN' }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { organisation: { findUnique: mocks.orgFind, update: mocks.orgUpdate } },
}));
vi.mock('@/lib/logger', () => ({ childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ SSO_TRUSTED_ISSUERS: mocks.trusted.list }),
}));

import { saveSsoConfigAction } from './sso-actions';

const ORG_SLUG = 'org-one';
const PUBLIC_ISSUER = 'https://idp.example.com/tenant/v2.0';

function form(issuer: string, enabled = true) {
  const data = new FormData();
  if (enabled) data.set('ssoEnabled', 'on');
  data.set('ssoIssuer', issuer);
  data.set('ssoClientId', 'client-123');
  data.set('ssoClientSecret', 'super-secret-value');
  return data;
}

/** Bind `issuer` to the session's org so a test reaches the later checks. */
function bindToOwnOrg(issuer: string) {
  mocks.trusted.list = `${ORG_SLUG}=${issuer}`;
}

beforeEach(() => {
  mocks.orgFind.mockReset().mockResolvedValue({ id: 'org_1', slug: ORG_SLUG, ssoClientSecret: null });
  mocks.orgUpdate.mockReset().mockResolvedValue({});
  mocks.dnsLookup.mockReset().mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  mocks.trusted.list = '';
  delete process.env.SSO_ALLOWED_INTERNAL_HOSTS;
});

describe('saveSsoConfigAction — issuer must be a public host', () => {
  it.each([
    'https://127.0.0.1/tenant',
    'https://[::ffff:7f00:1]/',
    'https://docuridge_mailhog.docuridge_internal/',
  ])('refuses the internal issuer %s', async (issuer) => {
    bindToOwnOrg(issuer);
    const result = await saveSsoConfigAction({ ok: false }, form(issuer));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/public host/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses an issuer name that resolves to a private address', async () => {
    bindToOwnOrg(PUBLIC_ISSUER);
    mocks.dnsLookup.mockResolvedValue([{ address: '172.18.0.4', family: 4 }]);
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/public host/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('saves a public issuer bound to this org', async () => {
    bindToOwnOrg(PUBLIC_ISSUER);
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.ok).toBe(true);
    expect(mocks.orgUpdate).toHaveBeenCalledOnce();
  });

  it('does not resolve anything when the issuer is cleared', async () => {
    const data = new FormData();
    data.set('ssoIssuer', '');
    const result = await saveSsoConfigAction({ ok: false }, data);
    expect(result.ok).toBe(true);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
  });
});

describe('saveSsoConfigAction — issuer refusals are not a DNS oracle', () => {
  it('SECURITY: a nonexistent issuer host and internal answers get identical responses', async () => {
    bindToOwnOrg(PUBLIC_ISSUER);
    const arrangements: Array<() => void> = [
      () => mocks.dnsLookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '240.0.0.1', family: 4 }]),
    ];
    const results = [];
    for (const arrange of arrangements) {
      mocks.dnsLookup.mockReset();
      arrange();
      results.push(await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER)));
    }
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.fieldErrors?.ssoIssuer).toMatch(/public host/i);
    for (const r of results) expect(r).toEqual(results[0]);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});

describe('saveSsoConfigAction — issuer must be bound to this org', () => {
  it('refuses a trusted issuer the operator bound to another org (self-registered attacker)', async () => {
    mocks.trusted.list = `real-org=${PUBLIC_ISSUER}`;
    mocks.orgFind.mockResolvedValue({ id: 'org_1', slug: 'attacker-org', ssoClientSecret: null });
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/not bound to this organisation/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
  });

  it('refuses it even with SSO left disabled, so it cannot be staged for later', async () => {
    mocks.trusted.list = `real-org=${PUBLIC_ISSUER}`;
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER, false));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/not bound/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses an issuer other than the one bound to this org', async () => {
    bindToOwnOrg('https://idp.example.edu/other');
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.fieldErrors?.ssoIssuer).toMatch(/not bound/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses every issuer while no binding is configured', async () => {
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.fieldErrors?.ssoIssuer).toMatch(/not bound/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses a legacy bare-issuer entry (no "=")', async () => {
    mocks.trusted.list = PUBLIC_ISSUER;
    const result = await saveSsoConfigAction({ ok: false }, form(PUBLIC_ISSUER));
    expect(result.fieldErrors?.ssoIssuer).toMatch(/not bound/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});
