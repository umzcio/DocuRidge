import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  findUnique: vi.fn(),
  tokenCreate: vi.fn(),
  mintToken: vi.fn(),
  sendMail: vi.fn(),
  checkRateLimit: vi.fn(),
  recordUserSecurityEvent: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/server', () => ({
  after: (task: () => unknown) => {
    mocks.deferred.push(task);
  },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
    passwordResetToken: { create: mocks.tokenCreate },
  },
}));
vi.mock('@/lib/auth/tokens', () => ({ mintToken: mocks.mintToken }));
vi.mock('@/lib/mail', () => ({ sendMail: mocks.sendMail }));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.1', userAgent: 'vitest' }),
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordUserSecurityEvent }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docuridge.example.com/DocuRidge' }) }));

import { requestResetAction } from './actions';

const known = { id: 'user-1', name: 'Known', deletedAt: null, memberships: [{ orgId: 'org-1' }] };

function form(email: string): FormData {
  const data = new FormData();
  data.set('email', email);
  return data;
}

async function runDeferred() {
  for (const task of mocks.deferred.splice(0)) await task();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deferred.length = 0;
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 3, retryAfterSeconds: 60 });
  mocks.mintToken.mockResolvedValue({ token: 'tok', tokenHash: 'hash', expiresAt: new Date() });
  mocks.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false });
});

describe('requestResetAction account-existence oracle', () => {
  it('responds identically for a known and an unknown address before any account work', async () => {
    mocks.findUnique.mockResolvedValueOnce(known).mockResolvedValueOnce(null);

    const forKnown = await requestResetAction({ ok: false }, form('known@example.com'));
    const forUnknown = await requestResetAction({ ok: false }, form('nobody@example.com'));

    expect(forKnown).toEqual(forUnknown);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.mintToken).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.deferred).toHaveLength(2);
  });

  it('mints, stores and mails a reset link for a known address after responding', async () => {
    mocks.findUnique.mockResolvedValue(known);
    await requestResetAction({ ok: false }, form('Known@Example.com'));
    await runDeferred();

    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'known@example.com' } }),
    );
    expect(mocks.tokenCreate).toHaveBeenCalledOnce();
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'known@example.com', orgId: 'org-1' }),
    );
  });

  it('does nothing for an unknown or deleted address', async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...known, deletedAt: new Date() });
    await requestResetAction({ ok: false }, form('nobody@example.com'));
    await requestResetAction({ ok: false }, form('deleted@example.com'));
    await runDeferred();

    expect(mocks.mintToken).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it('keeps a mail failure out of the response', async () => {
    mocks.findUnique.mockResolvedValue(known);
    mocks.sendMail.mockRejectedValue(new Error('smtp down'));
    const result = await requestResetAction({ ok: false }, form('known@example.com'));
    await expect(runDeferred()).resolves.toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
