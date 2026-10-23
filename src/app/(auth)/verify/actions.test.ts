import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tokenFindUnique: vi.fn(),
  tokenUpdateMany: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  verifyToken: vi.fn(),
  verifyPassword: vi.fn(),
  reserveLoginAttempt: vi.fn(),
  clearFailedAttempts: vi.fn(),
  checkRateLimit: vi.fn(),
  recordUserSecurityEvent: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    emailVerificationToken: { findUnique: mocks.tokenFindUnique, updateMany: mocks.tokenUpdateMany },
    user: { findUnique: mocks.userFindUnique, update: mocks.userUpdate },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/auth/tokens', () => ({
  verifyToken: mocks.verifyToken,
  hashToken: async (t: string) => `hash:${t}`,
}));
vi.mock('@/lib/auth/argon', () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock('@/lib/auth/lockout', () => ({
  reserveLoginAttempt: mocks.reserveLoginAttempt,
  clearFailedAttempts: mocks.clearFailedAttempts,
}));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.1', userAgent: 'vitest' }),
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordUserSecurityEvent }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { confirmEmailAction } from './actions';

const REGISTRANT_PASSWORD = 'Registrant-Chose-This-1';

function form(token: string, password: string): FormData {
  const data = new FormData();
  data.set('token', token);
  data.set('password', password);
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 10, retryAfterSeconds: 60 });
  mocks.verifyToken.mockResolvedValue({ userId: 'user-1', purpose: 'email_verification', jti: 'j' });
  mocks.tokenFindUnique.mockResolvedValue({
    userId: 'user-1',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  mocks.userFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'registrant-hash', deletedAt: null });
  mocks.reserveLoginAttempt.mockResolvedValue({ allowed: true, attempts: 1, lockedUntil: null });
  mocks.verifyPassword.mockImplementation(async (_h: string, plain: string) => plain === REGISTRANT_PASSWORD);
  mocks.tokenUpdateMany.mockImplementation((args: unknown) => ({ op: 'tokens', args }));
  mocks.userUpdate.mockImplementation((args: unknown) => ({ op: 'user', args }));
  mocks.transaction.mockResolvedValue([]);
});

describe('confirmEmailAction', () => {
  it('does not activate the account for someone who does not know the registered password', async () => {
    const result = await confirmEmailAction({ ok: false }, form('verify-token', 'Mailbox-Owner-Guess-2'));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reset/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('verifies the address, consumes every outstanding link and sends the user to sign in', async () => {
    await expect(
      confirmEmailAction({ ok: false }, form('verify-token', REGISTRANT_PASSWORD)),
    ).rejects.toThrow('REDIRECT:/login?verified=1');

    const ops = mocks.transaction.mock.calls[0]![0] as Array<{ op: string; args: unknown }>;
    expect(ops).toEqual([
      { op: 'tokens', args: { where: { userId: 'user-1', consumedAt: null }, data: { consumedAt: expect.any(Date) } } },
      { op: 'user', args: { where: { id: 'user-1' }, data: { emailVerifiedAt: expect.any(Date) } } },
    ]);
    expect(mocks.clearFailedAttempts).toHaveBeenCalledWith('user-1');
  });

  it('counts the check against the account lockout and refuses without comparing once locked', async () => {
    mocks.reserveLoginAttempt.mockResolvedValue({ allowed: false });

    const result = await confirmEmailAction({ ok: false }, form('verify-token', REGISTRANT_PASSWORD));
    expect(result.ok).toBe(false);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a token that fails signature or expiry checks', () => mocks.verifyToken.mockResolvedValue(null)],
    ['a token with no stored row', () => mocks.tokenFindUnique.mockResolvedValue(null)],
    [
      'a consumed token',
      () =>
        mocks.tokenFindUnique.mockResolvedValue({
          userId: 'user-1',
          consumedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
    ],
    [
      'an expired token row',
      () =>
        mocks.tokenFindUnique.mockResolvedValue({
          userId: 'user-1',
          consumedAt: null,
          expiresAt: new Date(Date.now() - 1),
        }),
    ],
    [
      'a stored row for another user',
      () =>
        mocks.tokenFindUnique.mockResolvedValue({
          userId: 'user-2',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
    ],
    ['a deleted account', () => mocks.userFindUnique.mockResolvedValue({ id: 'user-1', passwordHash: 'h', deletedAt: new Date() })],
  ])('refuses %s without comparing a password', async (_label, arrange) => {
    arrange();
    const result = await confirmEmailAction({ ok: false }, form('verify-token', REGISTRANT_PASSWORD));

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/invalid or has expired/i) });
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('refuses when the per-IP limit is spent', async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, count: 11, limit: 10, retryAfterSeconds: 30 });
    const result = await confirmEmailAction({ ok: false }, form('verify-token', REGISTRANT_PASSWORD));
    expect(result.error).toMatch(/too many/i);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
  });
});
