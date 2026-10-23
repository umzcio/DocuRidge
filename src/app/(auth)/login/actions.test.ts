import { beforeEach, describe, expect, it, vi } from 'vitest';

const MAX_ATTEMPTS = 5;

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  userUpdate: vi.fn(),
  verifyPassword: vi.fn(),
  verifyDummyPassword: vi.fn(),
  reserveLoginAttempt: vi.fn(),
  clearFailedAttempts: vi.fn(),
  createSession: vi.fn(),
  checkRateLimit: vi.fn(),
  recordUserSecurityEvent: vi.fn(),
  ip: { current: '203.0.113.1' },
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: mocks.findUnique, update: mocks.userUpdate } },
}));
vi.mock('@/lib/auth/argon', () => ({
  verifyPassword: mocks.verifyPassword,
  verifyDummyPassword: mocks.verifyDummyPassword,
}));
vi.mock('@/lib/auth/lockout', () => ({
  reserveLoginAttempt: mocks.reserveLoginAttempt,
  clearFailedAttempts: mocks.clearFailedAttempts,
}));
vi.mock('@/lib/auth/session', () => ({
  createSession: mocks.createSession,
  captureClientContext: () => ({ ipAddress: mocks.ip.current, userAgent: 'vitest' }),
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('@/lib/audit/user-security', () => ({ recordUserSecurityEvent: mocks.recordUserSecurityEvent }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ PASSWORD_MIN_LENGTH: 12 }) }));

import { loginAction } from './actions';

const CORRECT = 'correct horse battery staple';

const victim = {
  id: 'user-1',
  email: 'victim@example.com',
  passwordHash: 'hash',
  emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  deletedAt: null,
  memberships: [{ orgId: 'org-1' }],
};

function form(email: string, password: string): FormData {
  const data = new FormData();
  data.set('email', email);
  data.set('password', password);
  return data;
}

/** Stand-in for the conditional UPDATE: each call atomically takes one slot. */
function atomicReservations() {
  let attempts = 0;
  let locked = false;
  return async () => {
    if (locked) return { allowed: false as const };
    attempts += 1;
    if (attempts >= MAX_ATTEMPTS) locked = true;
    return { allowed: true as const, attempts, lockedUntil: locked ? new Date() : null };
  };
}

/** Stand-in for the per-minute bucket table, counting per key. */
function perKeyBuckets(limits: Record<string, number>) {
  const counts = new Map<string, number>();
  return async (key: string, action: string) => {
    const bucketKey = `${action}:${key}`;
    const count = (counts.get(bucketKey) ?? 0) + 1;
    counts.set(bucketKey, count);
    const limit = limits[action] ?? Infinity;
    return { allowed: count <= limit, count, limit, retryAfterSeconds: 60 };
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ip.current = '203.0.113.1';
  mocks.findUnique.mockResolvedValue(victim);
  mocks.checkRateLimit.mockResolvedValue({ allowed: true, count: 1, limit: 10, retryAfterSeconds: 60 });
  mocks.verifyPassword.mockImplementation(async (_hash: string, plain: string) => {
    await new Promise((r) => setTimeout(r, 5));
    return plain === CORRECT;
  });
  mocks.verifyDummyPassword.mockResolvedValue(false);
  mocks.reserveLoginAttempt.mockImplementation(atomicReservations());
});

describe('loginAction lockout reservation', () => {
  it('reserves an attempt before comparing the password', async () => {
    const order: string[] = [];
    mocks.reserveLoginAttempt.mockImplementation(async () => {
      order.push('reserve');
      return { allowed: true, attempts: 1, lockedUntil: null };
    });
    mocks.verifyPassword.mockImplementation(async () => {
      order.push('verify');
      return false;
    });

    await loginAction({ ok: false }, form(victim.email, 'wrong-guess-123'));
    expect(order).toEqual(['reserve', 'verify']);
  });

  it('refuses a correct password without comparing it or creating a session when no slot is left', async () => {
    mocks.reserveLoginAttempt.mockResolvedValue({ allowed: false });

    const result = await loginAction({ ok: false }, form(victim.email, CORRECT));
    expect(result.ok).toBe(false);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.clearFailedAttempts).not.toHaveBeenCalled();
  });

  it('lets at most LOCKOUT_MAX_ATTEMPTS of 50 concurrent guesses from distinct addresses reach verifyPassword', async () => {
    const burst = Array.from({ length: 50 }, (_, i) => {
      mocks.ip.current = `198.51.100.${i + 1}`;
      return loginAction({ ok: false }, form(victim.email, `wrong-guess-${i}-xyz`));
    });
    const results = await Promise.all(burst);

    expect(mocks.verifyPassword).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(results.every((r) => r.ok === false)).toBe(true);
  });

  it('does not create a session for a correct password sent in the same burst after the cap', async () => {
    const wrong = Array.from({ length: MAX_ATTEMPTS }, (_, i) =>
      loginAction({ ok: false }, form(victim.email, `wrong-guess-${i}-xyz`)),
    );
    const late = loginAction({ ok: false }, form(victim.email, CORRECT));
    const results = await Promise.all([...wrong, late]);

    expect(results.at(-1)?.ok).toBe(false);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('records a lockout event when a failed attempt took the last slot', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await loginAction({ ok: false }, form(victim.email, `wrong-guess-${i}-xyz`));
    }
    const types = mocks.recordUserSecurityEvent.mock.calls.map(([e]) => (e as { type: string }).type);
    expect(types.filter((t) => t === 'lockout_triggered')).toHaveLength(1);
  });

  it('signs in and clears the counter when the password is correct and a slot is free', async () => {
    await expect(loginAction({ ok: false }, form(victim.email, CORRECT))).rejects.toThrow(
      'REDIRECT:/dashboard',
    );
    expect(mocks.clearFailedAttempts).toHaveBeenCalledWith(victim.id);
    expect(mocks.createSession).toHaveBeenCalledOnce();
  });

  it('clears the counter for a correct password on an unverified account but creates no session', async () => {
    mocks.findUnique.mockResolvedValue({ ...victim, emailVerifiedAt: null });

    const result = await loginAction({ ok: false }, form(victim.email, CORRECT));
    expect(result.error).toMatch(/verify your email/i);
    expect(mocks.clearFailedAttempts).toHaveBeenCalledWith(victim.id);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});

describe('loginAction per-account rate limit', () => {
  it('limits on the normalized email, independent of the source address', async () => {
    mocks.checkRateLimit.mockImplementation(perKeyBuckets({ login: 10, login_account: 3 }));
    mocks.reserveLoginAttempt.mockResolvedValue({ allowed: true, attempts: 1, lockedUntil: null });

    for (let i = 0; i < 6; i++) {
      mocks.ip.current = `198.51.100.${i + 1}`;
      await loginAction({ ok: false }, form('  Victim@Example.COM ', `wrong-guess-${i}-xyz`));
    }

    expect(mocks.checkRateLimit).toHaveBeenCalledWith('email:victim@example.com', 'login_account');
    expect(mocks.verifyPassword).toHaveBeenCalledTimes(3);
  });

  it('refuses before looking the account up once the account bucket is spent', async () => {
    mocks.checkRateLimit.mockImplementation(async (_key: string, action: string) =>
      action === 'login_account'
        ? { allowed: false, count: 11, limit: 10, retryAfterSeconds: 30 }
        : { allowed: true, count: 1, limit: 10, retryAfterSeconds: 30 },
    );

    const result = await loginAction({ ok: false }, form(victim.email, CORRECT));
    expect(result.error).toMatch(/too many attempts/i);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.reserveLoginAttempt).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });
});

describe('loginAction account-existence oracle', () => {
  const argonCalls = () =>
    mocks.verifyPassword.mock.calls.length + mocks.verifyDummyPassword.mock.calls.length;

  it.each([
    ['an unknown address', null],
    ['a deleted account', { ...victim, deletedAt: new Date() }],
    ['an account with no password set', { ...victim, passwordHash: null }],
  ])('answers %s exactly like a wrong password, after one Argon2 comparison', async (_label, row) => {
    const wrong = await loginAction({ ok: false }, form(victim.email, 'wrong-guess-123'));
    expect(argonCalls()).toBe(1);

    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(row);
    const probed = await loginAction({ ok: false }, form(victim.email, 'wrong-guess-123'));

    expect(probed).toEqual(wrong);
    expect(argonCalls()).toBe(1);
    expect(mocks.verifyDummyPassword).toHaveBeenCalledWith('wrong-guess-123');
  });

  it('answers a locked account exactly like a wrong password, after one Argon2 comparison', async () => {
    const wrong = await loginAction({ ok: false }, form(victim.email, 'wrong-guess-123'));

    vi.clearAllMocks();
    mocks.reserveLoginAttempt.mockResolvedValue({ allowed: false });
    const locked = await loginAction({ ok: false }, form(victim.email, CORRECT));

    expect(locked).toEqual(wrong);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.verifyDummyPassword).toHaveBeenCalledOnce();
  });

  it('gives the same six responses for a known and an unknown address', async () => {
    const known = [];
    for (let i = 0; i < 6; i++) {
      known.push(await loginAction({ ok: false }, form(victim.email, `wrong-guess-${i}-xyz`)));
    }
    mocks.findUnique.mockResolvedValue(null);
    const unknown = [];
    for (let i = 0; i < 6; i++) {
      unknown.push(await loginAction({ ok: false }, form('nobody@example.com', `wrong-guess-${i}-xyz`)));
    }

    expect(known).toEqual(unknown);
    expect(new Set(known.map((r) => r.error))).toEqual(new Set(['Email or password is incorrect.']));
  });
});
