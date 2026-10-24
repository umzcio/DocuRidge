import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  subCreate: vi.fn(),
  dnsLookup: vi.fn(),
  role: 'ADMIN' as string,
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup, default: { lookup: mocks.dnsLookup } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ user: { id: 'user_1' }, orgId: 'org_1', role: mocks.role }),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { webhookSubscription: { create: mocks.subCreate } } }));
vi.mock('@/lib/logger', () => ({ childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { createWebhookAction } from './webhook-actions';
import { WEBHOOK_TARGET_REFUSED_MESSAGE } from '@/lib/webhooks/url-guard';

function form(url: string) {
  const data = new FormData();
  data.set('url', url);
  return data;
}

beforeEach(() => {
  mocks.role = 'ADMIN';
  mocks.subCreate.mockReset().mockImplementation(async ({ data }: { data: { url: string } }) => ({
    id: 'sub_1',
    url: data.url,
  }));
  mocks.dnsLookup.mockReset();
  delete process.env.WEBHOOK_ALLOWED_INTERNAL_HOSTS;
});

describe('createWebhookAction — SSRF targets are refused at save time', () => {
  it.each([
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:172.18.0.2]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::]/',
    'http://docuridge_mailhog.docuridge_internal:8025/',
    'http://docuridge_mailhog.:8025/',
  ])('refuses the literal / internal name %s', async (url) => {
    const result = await createWebhookAction({ ok: false }, form(url));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public host/i);
    expect(mocks.subCreate).not.toHaveBeenCalled();
  });

  it('refuses a public-looking name that resolves to a private address', async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const result = await createWebhookAction({ ok: false }, form('http://10.0.0.1.nip.io/'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/public host/i);
    expect(mocks.subCreate).not.toHaveBeenCalled();
  });

  it('refuses a name that does not resolve with the generic refusal text', async () => {
    mocks.dnsLookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const result = await createWebhookAction({ ok: false }, form('https://nowhere.example.com/hook'));
    expect(result).toEqual({ ok: false, error: WEBHOOK_TARGET_REFUSED_MESSAGE });
    expect(mocks.subCreate).not.toHaveBeenCalled();
  });

  it('saves a public URL and reveals the secret once', async () => {
    mocks.dnsLookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
    const result = await createWebhookAction({ ok: false }, form('https://hooks.example.com/hook'));
    expect(result.ok).toBe(true);
    expect(result.revealedSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(mocks.subCreate).toHaveBeenCalledOnce();
  });

  it('refuses non-admins before validating anything', async () => {
    mocks.role = 'SENDER';
    const result = await createWebhookAction({ ok: false }, form('https://hooks.example.com/hook'));
    expect(result.ok).toBe(false);
    expect(mocks.dnsLookup).not.toHaveBeenCalled();
    expect(mocks.subCreate).not.toHaveBeenCalled();
  });
});

describe('createWebhookAction — refusals are not a DNS oracle', () => {
  const notFound = () => Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });

  it('SECURITY: a nonexistent host and hosts resolving to internal ranges get identical responses', async () => {
    const outcomes: Array<() => void> = [
      () => mocks.dnsLookup.mockRejectedValue(notFound()),
      () => mocks.dnsLookup.mockRejectedValue(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })),
      () => mocks.dnsLookup.mockResolvedValue([]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '240.0.0.1', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '192.168.1.10', family: 4 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: '::1', family: 6 }]),
      () => mocks.dnsLookup.mockResolvedValue([{ address: 'fd00::1', family: 6 }]),
    ];
    const results = [];
    for (const arrange of outcomes) {
      mocks.dnsLookup.mockReset();
      arrange();
      results.push(await createWebhookAction({ ok: false }, form('https://guessed-name.corp.example.com/x')));
    }
    for (const r of results) expect(r).toEqual({ ok: false, error: WEBHOOK_TARGET_REFUSED_MESSAGE });
    expect(mocks.subCreate).not.toHaveBeenCalled();
  });

  it('pre-resolution refusals (literals, internal-style names) use the same text', async () => {
    for (const url of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://docuridge_mailhog.docuridge_internal/']) {
      const result = await createWebhookAction({ ok: false }, form(url));
      expect(result).toEqual({ ok: false, error: WEBHOOK_TARGET_REFUSED_MESSAGE });
    }
  });
});
