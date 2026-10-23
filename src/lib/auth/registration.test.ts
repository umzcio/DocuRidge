import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdateMany: vi.fn(),
  orgCreate: vi.fn(),
  orgUpdate: vi.fn(),
  liveTokenCount: vi.fn(),
  tokenUpdateMany: vi.fn(),
  memberCreate: vi.fn(),
  verificationCreate: vi.fn(),
  mintToken: vi.fn(),
  sendMail: vi.fn(),
  recordUserSecurityEvent: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tx = {
    organisation: { create: mocks.orgCreate, update: mocks.orgUpdate },
    user: { create: mocks.userCreate, updateMany: mocks.userUpdateMany },
    orgMember: { create: mocks.memberCreate },
    emailVerificationToken: { updateMany: mocks.tokenUpdateMany },
  };
  return {
    prisma: {
      user: { findUnique: mocks.userFindUnique },
      emailVerificationToken: { create: mocks.verificationCreate, count: mocks.liveTokenCount },
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock('@/lib/auth/tokens', () => ({ mintToken: mocks.mintToken }));
vi.mock('@/lib/mail', () => ({ sendMail: mocks.sendMail }));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordUserSecurityEvent }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docuridge.example.com/DocuRidge' }) }));

import { completeRegistration } from './registration';

const request = {
  name: 'New Person',
  email: 'person@example.com',
  passwordHash: 'argon-hash',
  orgName: 'New Co',
  ipAddress: '203.0.113.1',
  userAgent: 'vitest',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.orgCreate.mockResolvedValue({ id: 'org-1' });
  mocks.userCreate.mockResolvedValue({ id: 'user-1' });
  mocks.mintToken.mockResolvedValue({
    token: 'verify-token',
    tokenHash: 'verify-hash',
    expiresAt: new Date('2026-10-24T00:00:00.000Z'),
  });
  mocks.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false });
});

describe('completeRegistration', () => {
  it('creates the account, org and ADMIN membership and mails a verification link for a new address', async () => {
    mocks.userFindUnique.mockResolvedValue(null);

    await expect(completeRegistration(request)).resolves.toBe('created');
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: { email: request.email, passwordHash: 'argon-hash', name: 'New Person', mustResetPassword: false },
    });
    expect(mocks.memberCreate).toHaveBeenCalledWith({
      data: { orgId: 'org-1', userId: 'user-1', role: 'ADMIN' },
    });
    expect(mocks.verificationCreate).toHaveBeenCalledWith({
      data: { userId: 'user-1', tokenHash: 'verify-hash', expiresAt: expect.any(Date) },
    });
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: request.email, text: expect.stringContaining('/verify?token=verify-token') }),
    );
  });

  it('tells the mailbox of an existing account instead of creating anything', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-0',
      name: 'Owner',
      emailVerifiedAt: new Date(),
      deletedAt: null,
      passwordHash: 'owner-hash',
      memberships: [{ orgId: 'org-0' }],
    });

    await expect(completeRegistration(request)).resolves.toBe('notified');
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.verificationCreate).not.toHaveBeenCalled();
    expect(mocks.sendMail).toHaveBeenCalledOnce();
    const mail = mocks.sendMail.mock.calls[0]![0] as { to: string; text: string };
    expect(mail.to).toBe(request.email);
    expect(mail.text).toMatch(/already has a DocuRidge account/);
    expect(mail.text).toContain('/reset');
    expect(mail.text).not.toContain('verify?token');
  });

  it('ignores a deleted account without mailing', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 'user-0',
      name: 'Gone',
      emailVerifiedAt: new Date(),
      deletedAt: new Date(),
      passwordHash: 'hash',
      memberships: [],
    });

    await expect(completeRegistration(request)).resolves.toBe('ignored');
    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });
});

describe('completeRegistration over an unverified registration', () => {
  const squatted = {
    id: 'user-0',
    name: 'Squatter',
    emailVerifiedAt: null,
    deletedAt: null,
    passwordHash: 'squatter-hash',
    memberships: [{ orgId: 'org-0', role: 'ADMIN' }],
  };

  beforeEach(() => {
    mocks.userFindUnique.mockResolvedValue(squatted);
    mocks.userUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('replaces it once its verification link has lapsed, and mails a working link', async () => {
    mocks.liveTokenCount.mockResolvedValue(0);

    await expect(completeRegistration(request)).resolves.toBe('replaced');
    expect(mocks.liveTokenCount).toHaveBeenCalledWith({
      where: { userId: 'user-0', consumedAt: null, expiresAt: { gt: expect.any(Date) } },
    });
    expect(mocks.userUpdateMany).toHaveBeenCalledWith({
      where: { id: 'user-0', emailVerifiedAt: null },
      data: {
        name: 'New Person',
        passwordHash: 'argon-hash',
        mustResetPassword: false,
        failedAttempts: 0,
        lockedUntil: null,
        firstFailedAttemptAt: null,
      },
    });
    expect(mocks.tokenUpdateMany).toHaveBeenCalledWith({
      where: { userId: 'user-0', consumedAt: null },
      data: { consumedAt: expect.any(Date) },
    });
    expect(mocks.orgUpdate).toHaveBeenCalledWith({
      where: { id: 'org-0' },
      data: { name: 'New Co', slug: expect.stringMatching(/^new-co-/) },
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.verificationCreate).toHaveBeenCalledWith({
      data: { userId: 'user-0', tokenHash: 'verify-hash', expiresAt: expect.any(Date) },
    });
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: request.email, text: expect.stringContaining('/verify?token=verify-token') }),
    );
  });

  it('gives the replaced account its own org when it has none', async () => {
    mocks.liveTokenCount.mockResolvedValue(0);
    mocks.userFindUnique.mockResolvedValue({ ...squatted, memberships: [] });

    await expect(completeRegistration(request)).resolves.toBe('replaced');
    expect(mocks.orgCreate).toHaveBeenCalledOnce();
    expect(mocks.memberCreate).toHaveBeenCalledWith({
      data: { orgId: 'org-1', userId: 'user-0', role: 'ADMIN' },
    });
  });

  it('leaves it alone and mails the notice while its verification link is still live', async () => {
    mocks.liveTokenCount.mockResolvedValue(1);

    await expect(completeRegistration(request)).resolves.toBe('notified');
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
    expect(mocks.verificationCreate).not.toHaveBeenCalled();
  });

  it('never replaces a password-less unverified account (the pending bootstrap admin)', async () => {
    mocks.liveTokenCount.mockResolvedValue(0);
    mocks.userFindUnique.mockResolvedValue({ ...squatted, passwordHash: null });

    await expect(completeRegistration(request)).resolves.toBe('notified');
    expect(mocks.userUpdateMany).not.toHaveBeenCalled();
  });

  it('falls back to the notice when the account was verified in the meantime', async () => {
    mocks.liveTokenCount.mockResolvedValue(0);
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });

    await expect(completeRegistration(request)).resolves.toBe('notified');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
    expect(mocks.verificationCreate).not.toHaveBeenCalled();
    expect(mocks.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/already has a DocuRidge account/) }),
    );
  });
});
