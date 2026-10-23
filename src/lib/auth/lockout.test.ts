import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: { $queryRaw: mocks.queryRaw, user: { update: mocks.update } },
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ LOCKOUT_MAX_ATTEMPTS: 5, LOCKOUT_WINDOW_MINUTES: 15, LOCKOUT_DURATION_MINUTES: 30 }),
}));

import { reserveLoginAttempt } from './lockout';

function capturedSql(): { text: string; values: unknown[] } {
  const [strings, ...values] = mocks.queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
  return { text: strings.join('?').replace(/\s+/g, ' '), values };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('reserveLoginAttempt', () => {
  it('reserves the attempt with one conditional UPDATE … RETURNING, never a read-then-write', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 1, lockedUntil: null }]);
    await reserveLoginAttempt('user-1');

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.update).not.toHaveBeenCalled();
    const { text } = capturedSql();
    expect(text).toMatch(/^ ?UPDATE "user"/);
    expect(text).toMatch(/RETURNING/);
    expect(text).toMatch(/"lockedUntil" IS NULL OR u\."lockedUntil" <= /);
  });

  it('passes the user id and the configured cap, window and duration as bound parameters', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 1, lockedUntil: null }]);
    await reserveLoginAttempt('user-1');

    const { values } = capturedSql();
    expect(values).toEqual(expect.arrayContaining(['user-1', 5, 15, 30]));
  });

  it('allows the attempt and reports the running count when a row was reserved', async () => {
    mocks.queryRaw.mockResolvedValue([{ attempts: 3, lockedUntil: null }]);
    await expect(reserveLoginAttempt('user-1')).resolves.toEqual({
      allowed: true,
      attempts: 3,
      lockedUntil: null,
    });
  });

  it('reports the lock this reservation set when it reached the cap', async () => {
    const until = new Date('2026-10-23T12:30:00.000Z');
    mocks.queryRaw.mockResolvedValue([{ attempts: 5, lockedUntil: until }]);
    await expect(reserveLoginAttempt('user-1')).resolves.toEqual({
      allowed: true,
      attempts: 5,
      lockedUntil: until,
    });
  });

  it('refuses when the conditional UPDATE matched no row (account locked)', async () => {
    mocks.queryRaw.mockResolvedValue([]);
    await expect(reserveLoginAttempt('user-1')).resolves.toEqual({ allowed: false });
  });
});
