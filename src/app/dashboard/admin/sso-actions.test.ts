import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  orgFind: vi.fn(),
  orgUpdate: vi.fn(),
  dnsLookup: vi.fn(),
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
// Trust every issuer used below so these tests reach the outbound-host check.
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    SSO_TRUSTED_ISSUERS: [
      'https://127.0.0.1/tenant',
      'https://[::ffff:7f00:1]/',
      'https://docuridge_mailhog.docuridge_internal/',
      'https://idp.example.com/tenant/v2.0',
    ].join(','),
  }),
}));

import { saveSsoConfigAction } from './sso-actions';

function form(issuer: string) {
  const data = new FormData();
  data.set('ssoEnabled', 'on');
  data.set('ssoIssuer', issuer);
  data.set('ssoClientId', 'client-123');
  data.set('ssoClientSecret', 'super-secret-value');
  return data;
}

beforeEach(() => {
  mocks.orgFind.mockReset().mockResolvedValue({ id: 'org_1', ssoClientSecret: null });
  mocks.orgUpdate.mockReset().mockResolvedValue({});
  mocks.dnsLookup.mockReset();
  delete process.env.SSO_ALLOWED_INTERNAL_HOSTS;
});

describe('saveSsoConfigAction — issuer must be a public host', () => {
  it.each([
    'https://127.0.0.1/tenant',
    'https://[::ffff:7f00:1]/',
    'https://docuridge_mailhog.docuridge_internal/',
  ])('refuses the internal issuer %s', async (issuer) => {
    const result = await saveSsoConfigAction({ ok: false }, form(issuer));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/public host/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses an issuer name that resolves to a private address', async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: '172.18.0.4', family: 4 }]);
    const result = await saveSsoConfigAction({ ok: false }, form('https://idp.example.com/tenant/v2.0'));
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.ssoIssuer).toMatch(/public host/i);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('saves a public issuer', async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    const result = await saveSsoConfigAction({ ok: false }, form('https://idp.example.com/tenant/v2.0'));
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
