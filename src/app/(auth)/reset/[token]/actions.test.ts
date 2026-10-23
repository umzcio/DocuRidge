import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resetFindUnique: vi.fn(),
  resetUpdate: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  verificationUpdateMany: vi.fn(),
  transaction: vi.fn(),
  verifyToken: vi.fn(),
  hashPassword: vi.fn(),
  clearFailedAttempts: vi.fn(),
  revokeAllSessionsForUser: vi.fn(),
  recordUserSecurityEvent: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    passwordResetToken: { findUnique: mocks.resetFindUnique, update: mocks.resetUpdate },
    user: { update: mocks.userUpdate, updateMany: mocks.userUpdateMany },
    emailVerificationToken: { updateMany: mocks.verificationUpdateMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock('@/lib/auth/tokens', () => ({
  verifyToken: mocks.verifyToken,
  hashToken: async (t: string) => `hash:${t}`,
}));
vi.mock('@/lib/auth/argon', () => ({ hashPassword: mocks.hashPassword }));
vi.mock('@/lib/auth/lockout', () => ({ clearFailedAttempts: mocks.clearFailedAttempts }));
vi.mock('@/lib/auth/session', () => ({
  revokeAllSessionsForUser: mocks.revokeAllSessionsForUser,
  captureClientContext: () => ({ ipAddress: '203.0.113.1', userAgent: 'vitest' }),
}));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordUserSecurityEvent }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PASSWORD_MIN_LENGTH: 12 }) }));

import { completeResetAction } from './actions';

function form(token: string): FormData {
  const data = new FormData();
  data.set('token', token);
  data.set('password', 'Owner-Chosen-Phrase-7');
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verifyToken.mockResolvedValue({ userId: 'user-1', purpose: 'password_reset', jti: 'j' });
  mocks.resetFindUnique.mockResolvedValue({
    userId: 'user-1',
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  });
  mocks.hashPassword.mockResolvedValue('owner-hash');
  for (const m of [mocks.resetUpdate, mocks.userUpdate, mocks.userUpdateMany, mocks.verificationUpdateMany]) {
    m.mockImplementation((args: unknown) => ({ op: m, args }));
  }
  mocks.transaction.mockResolvedValue([]);
});

describe('completeResetAction on an unverified account', () => {
  it('sets the password, marks the address verified and consumes outstanding verification links in one transaction', async () => {
    const result = await completeResetAction({ ok: false }, form('reset-token'));
    expect(result.ok).toBe(true);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    const ops = mocks.transaction.mock.calls[0]![0] as Array<{ op: unknown; args: unknown }>;
    expect(ops.map((o) => o.args)).toEqual([
      { where: { tokenHash: 'hash:reset-token' }, data: { consumedAt: expect.any(Date) } },
      { where: { id: 'user-1' }, data: { passwordHash: 'owner-hash', mustResetPassword: false } },
      { where: { id: 'user-1', emailVerifiedAt: null }, data: { emailVerifiedAt: expect.any(Date) } },
      { where: { userId: 'user-1', consumedAt: null }, data: { consumedAt: expect.any(Date) } },
    ]);
    expect(ops[2]!.op).toBe(mocks.userUpdateMany);
    expect(ops[3]!.op).toBe(mocks.verificationUpdateMany);
    expect(mocks.revokeAllSessionsForUser).toHaveBeenCalledWith('user-1');
  });

  it('changes nothing for a consumed reset link', async () => {
    mocks.resetFindUnique.mockResolvedValue({
      userId: 'user-1',
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await completeResetAction({ ok: false }, form('reset-token'));
    expect(result.ok).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    expect(mocks.verificationUpdateMany).not.toHaveBeenCalled();
  });
});
