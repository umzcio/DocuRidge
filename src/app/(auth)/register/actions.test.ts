import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deferred: [] as Array<() => unknown>,
  hashPassword: vi.fn(),
  completeRegistration: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/server', () => ({
  after: (task: () => unknown) => {
    mocks.deferred.push(task);
  },
}));
vi.mock('@/lib/auth/argon', () => ({ hashPassword: mocks.hashPassword }));
vi.mock('@/lib/auth/registration', () => ({ completeRegistration: mocks.completeRegistration }));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.1', userAgent: 'vitest' }),
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PASSWORD_MIN_LENGTH: 12 }) }));

import { registerAction } from './actions';

function form(email: string): FormData {
  const data = new FormData();
  data.set('name', 'Test Person');
  data.set('email', email);
  data.set('password', 'Correct-Horse-Battery-9');
  data.set('orgName', 'Test Co');
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deferred.length = 0;
  mocks.hashPassword.mockResolvedValue('argon-hash');
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 5, retryAfterSeconds: 60 });
});

describe('registerAction account-existence oracle', () => {
  it('returns the same body whatever the outcome, and does the account work after responding', async () => {
    const outcomes = ['created', 'notified', 'ignored'];
    const responses = [];
    for (const outcome of outcomes) {
      mocks.completeRegistration.mockResolvedValueOnce(outcome);
      responses.push(await registerAction({ ok: false }, form(`${outcome}@example.com`)));
    }

    expect(new Set(responses.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(responses[0]).toEqual({ ok: true, message: expect.stringMatching(/check your email/i) });
    expect(mocks.completeRegistration).not.toHaveBeenCalled();
    expect(mocks.hashPassword).toHaveBeenCalledTimes(outcomes.length);
  });

  it('hands the normalised address and the hash, never the plaintext, to the deferred step', async () => {
    await registerAction({ ok: false }, form('  New.Person@Example.COM '));
    expect(mocks.deferred).toHaveLength(1);
    await mocks.deferred[0]!();

    expect(mocks.completeRegistration).toHaveBeenCalledWith({
      name: 'Test Person',
      email: 'new.person@example.com',
      passwordHash: 'argon-hash',
      orgName: 'Test Co',
      ipAddress: '203.0.113.1',
      userAgent: 'vitest',
    });
  });

  it('keeps a failure in the deferred step out of the response', async () => {
    mocks.completeRegistration.mockRejectedValue(new Error('smtp down'));
    const result = await registerAction({ ok: false }, form('new@example.com'));
    await expect(Promise.resolve(mocks.deferred[0]!())).resolves.not.toThrow();
    expect(result.ok).toBe(true);
  });

  it('rejects invalid input without hashing or scheduling work', async () => {
    const data = form('not-an-email');
    const result = await registerAction({ ok: false }, data);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.email).toBeDefined();
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.deferred).toHaveLength(0);
  });
});
