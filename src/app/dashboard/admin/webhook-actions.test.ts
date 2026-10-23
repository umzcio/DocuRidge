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

  it('refuses a name that does not resolve', async () => {
    mocks.dnsLookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const result = await createWebhookAction({ ok: false }, form('https://nowhere.example.com/hook'));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolve/i);
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
