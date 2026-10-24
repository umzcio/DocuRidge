import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), update: vi.fn() }));
vi.mock('./prisma', () => ({
  prisma: { $queryRaw: mocks.queryRaw, recipient: { update: mocks.update } },
}));
vi.mock('./env', () => ({
  getEnv: () => ({ ACCESS_CODE_MAX_ATTEMPTS: 5, ACCESS_CODE_LOCK_MINUTES: 15, ACCESS_CODE_LOCK_MAX_MINUTES: 1440 }),
}));

import { clearAccessCodeFailures, reserveAccessCodeAttempt } from './access-code-lockout';

function capturedSql(): { text: string; values: unknown[] } {
  const [strings, ...values] = mocks.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?').replace(/\s+/g, ' '), values };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('reserveAccessCodeAttempt', () => {
  it('reserves with one conditional UPDATE … RETURNING on the recipient row, never a read-then-write', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 1, lockedUntil: null, lockouts: 0 }]);
    await reserveAccessCodeAttempt('r1');

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
    const { text } = capturedSql();
    expect(text).toMatch(/^ ?UPDATE "recipient"/);
    expect(text).toMatch(/RETURNING/);
    // Locked rows match nothing, so a locked recipient never gets a comparison.
    expect(text).toMatch(/"accessCodeLockedUntil" IS NULL OR r\."accessCodeLockedUntil" <= /);
    // The lock escalates with each lockout, capped.
    expect(text).toMatch(/"accessCodeLockouts"/);
    expect(text).toMatch(/LEAST\(/);
  });

  it('passes the recipient id and the configured cap, base and max lock as bound parameters', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 1, lockedUntil: null, lockouts: 0 }]);
    await reserveAccessCodeAttempt('r1');
    const { values } = capturedSql();
    expect(values).toEqual(expect.arrayContaining(['r1', 5, 15, 1440]));
  });

  it('allows and reports the running count', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 3, lockedUntil: null, lockouts: 0 }]);
    await expect(reserveAccessCodeAttempt('r1')).resolves.toEqual({
      allowed: true, attempts: 3, lockedUntil: null, lockouts: 0,
    });
  });

  it('reports the lock this reservation set', async () => {
    const until = new Date('2026-10-24T12:30:00.000Z');
    mocks.queryRaw.mockResolvedValue([{ attempts: 5, lockedUntil: until, lockouts: 1 }]);
    await expect(reserveAccessCodeAttempt('r1')).resolves.toEqual({
      allowed: true, attempts: 5, lockedUntil: until, lockouts: 1,
    });
  });

  it('refuses when the UPDATE matched no row (recipient locked)', async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await expect(reserveAccessCodeAttempt('r1')).resolves.toEqual({ allowed: false });
  });
});

describe('clearAccessCodeFailures', () => {
  it('resets the running count and lock but keeps the escalation history', async () => {
    await clearAccessCodeFailures('r1');
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { accessCodeFailedAttempts: 0, accessCodeLockedUntil: null },
    });
  });
});
