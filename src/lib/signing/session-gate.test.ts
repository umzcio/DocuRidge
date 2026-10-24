import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSigningSession: vi.fn(),
  recordAccessCodeUnlock: vi.fn(),
  cookieJar: new Map<string, string>(),
  setCookie: vi.fn(),
  recordEnvelopeEvent: vi.fn(),
  clearAccessCodeFailures: vi.fn(),
  verifySpy: vi.fn(),
  // In-memory stand-in for the recipient row's lockout columns. The real
  // reservation is one conditional UPDATE … RETURNING (see
  // access-code-lockout.test.ts); this mirrors its semantics, and the await
  // lets concurrent callers interleave the way requests would.
  row: { attempts: 0, lockedUntil: null as Date | null, lockouts: 0 },
  maxAttempts: 5,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { name, value: mocks.cookieJar.get(name)! } : undefined),
    set: mocks.setCookie,
  }),
}));
vi.mock('../envelopes/lifecycle', () => ({
  loadSigningSession: mocks.loadSigningSession,
  recordAccessCodeUnlock: mocks.recordAccessCodeUnlock,
}));
vi.mock('../env', () => ({
  getEnv: () => ({ JWS_SIGNING_TOKEN_SECRET: 'x'.repeat(48) }),
}));
vi.mock('../audit/envelope', () => ({ recordEnvelopeEvent: mocks.recordEnvelopeEvent }));
vi.mock('../access-code-lockout', () => ({
  reserveAccessCodeAttempt: async () => {
    await Promise.resolve();
    const row = mocks.row;
    const now = Date.now();
    if (row.lockedUntil && row.lockedUntil.getTime() > now) return { allowed: false };
    const attempts = row.lockedUntil ? 1 : row.attempts + 1;
    const locks = attempts >= mocks.maxAttempts;
    row.attempts = attempts;
    row.lockedUntil = locks ? new Date(now + 15 * 60_000 * 2 ** row.lockouts) : null;
    if (locks) row.lockouts += 1;
    return { allowed: true, attempts, lockedUntil: row.lockedUntil, lockouts: row.lockouts };
  },
  clearAccessCodeFailures: async (id: string) => {
    mocks.clearAccessCodeFailures(id);
    mocks.row.attempts = 0;
    mocks.row.lockedUntil = null;
  },
}));
vi.mock('../access-code-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../access-code-server')>();
  return {
    ...actual,
    verifyAccessCode: (hash: string | null, attempt: string) => {
      mocks.verifySpy(attempt);
      return actual.verifyAccessCode(hash, attempt);
    },
  };
});

import { loadGatedSigningSession, unlockSigningSession } from './session-gate';
import { mintAccessProof } from './access-proof';
import { hashAccessCode } from '../access-code-server';
import { accessCodeCookieName } from '../access-code';

const CODE = 'K7P2QX';
const codeHash = hashAccessCode(CODE);

function session(over: { accessCodeHash?: string | null; jti?: string; recipientId?: string } = {}) {
  return {
    ok: true as const,
    envelope: { id: 'env1', fields: [], items: [] },
    recipient: {
      id: over.recipientId ?? 'r1',
      email: 'alice@example.com',
      name: 'Alice',
      accessCodeHash: over.accessCodeHash === undefined ? codeHash : over.accessCodeHash,
    },
    jti: over.jti ?? 'jti-1',
  };
}

async function proofFor(b: { envelopeId?: string; recipientId?: string; jti?: string; accessCodeHash?: string } = {}) {
  const { token } = await mintAccessProof({
    envelopeId: b.envelopeId ?? 'env1',
    recipientId: b.recipientId ?? 'r1',
    jti: b.jti ?? 'jti-1',
    accessCodeHash: b.accessCodeHash ?? codeHash,
  });
  return token;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieJar.clear();
  mocks.row = { attempts: 0, lockedUntil: null, lockouts: 0 };
});

describe('loadGatedSigningSession', () => {
  it('passes a recipient without an access code straight through', async () => {
    mocks.loadSigningSession.mockResolvedValue(session({ accessCodeHash: null }));
    const res = await loadGatedSigningSession('tok');
    expect(res.ok).toBe(true);
  });

  it('passes token failures through unchanged', async () => {
    mocks.loadSigningSession.mockResolvedValue({ ok: false, reason: 'consumed' });
    expect(await loadGatedSigningSession('tok')).toEqual({ ok: false, reason: 'consumed' });
  });

  it('refuses a code-protected recipient with no proof', async () => {
    mocks.loadSigningSession.mockResolvedValue(session());
    expect(await loadGatedSigningSession('tok')).toEqual({ ok: false, reason: 'access_code_required' });
  });

  it('accepts a valid proof bound to this recipient and the current token jti', async () => {
    mocks.loadSigningSession.mockResolvedValue(session());
    mocks.cookieJar.set(accessCodeCookieName('r1'), await proofFor());
    const res = await loadGatedSigningSession('tok');
    expect(res.ok).toBe(true);
  });

  it('refuses a proof minted for another recipient, even under this recipient\'s cookie name', async () => {
    mocks.loadSigningSession.mockResolvedValue(session());
    mocks.cookieJar.set(accessCodeCookieName('r1'), await proofFor({ recipientId: 'r2' }));
    expect(await loadGatedSigningSession('tok')).toEqual({ ok: false, reason: 'access_code_required' });
  });

  it('refuses a proof minted for an earlier token jti (after reassign or re-mint)', async () => {
    mocks.loadSigningSession.mockResolvedValue(session({ jti: 'jti-2' }));
    mocks.cookieJar.set(accessCodeCookieName('r1'), await proofFor({ jti: 'jti-1' }));
    expect(await loadGatedSigningSession('tok')).toEqual({ ok: false, reason: 'access_code_required' });
  });

  it('refuses a legacy cookie holding a signing token', async () => {
    const { mintSigningToken } = await import('./token');
    const legacy = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1' });
    mocks.loadSigningSession.mockResolvedValue(session({ jti: legacy.jti }));
    mocks.cookieJar.set(accessCodeCookieName('r1'), legacy.token);
    expect(await loadGatedSigningSession('tok')).toEqual({ ok: false, reason: 'access_code_required' });
  });
});

describe('unlockSigningSession', () => {
  const ctx = { ipAddress: '203.0.113.9', userAgent: 'vitest' };

  it('refuses an invalid token without touching anything', async () => {
    mocks.loadSigningSession.mockResolvedValue({ ok: false, reason: 'invalid' });
    const res = await unlockSigningSession({ token: 'tok', code: CODE, ...ctx });
    expect(res).toEqual({ ok: false, reason: 'invalid_session' });
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it('a wrong code sets no proof and records no unlock', async () => {
    mocks.loadSigningSession.mockResolvedValue(session());
    const res = await unlockSigningSession({ token: 'tok', code: 'WRONG1', ...ctx });
    expect(res).toEqual({ ok: false, reason: 'wrong_code' });
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.recordAccessCodeUnlock).not.toHaveBeenCalled();
  });

  it('the right code sets a proof cookie that the gate then accepts, and records the unlock', async () => {
    mocks.loadSigningSession.mockResolvedValue(session());
    const res = await unlockSigningSession({ token: 'tok', code: ` ${CODE.toLowerCase()} `, ...ctx });
    expect(res).toEqual({ ok: true });
    expect(mocks.setCookie).toHaveBeenCalledOnce();
    const [name, value, opts] = mocks.setCookie.mock.calls[0]!;
    expect(name).toBe(accessCodeCookieName('r1'));
    expect(opts).toEqual(expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    expect(mocks.recordAccessCodeUnlock).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 'env1', recipientId: 'r1' }),
    );

    mocks.cookieJar.set(name, value);
    expect((await loadGatedSigningSession('tok')).ok).toBe(true);
  });

  it('is a no-op success for a recipient without a code (no oracle, no cookie)', async () => {
    mocks.loadSigningSession.mockResolvedValue(session({ accessCodeHash: null }));
    expect(await unlockSigningSession({ token: 'tok', code: 'ANY123', ...ctx })).toEqual({ ok: true });
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.recordAccessCodeUnlock).not.toHaveBeenCalled();
  });
});

describe('unlockSigningSession per-recipient lockout', () => {
  const ctx = { userAgent: 'vitest' };
  const attempt = (code: string, ip = '203.0.113.9') =>
    unlockSigningSession({ token: 'tok', code, ipAddress: ip, userAgent: ctx.userAgent });

  beforeEach(() => {
    mocks.loadSigningSession.mockResolvedValue(session());
  });

  it('reserves the attempt before comparing the code', async () => {
    await attempt('WRONG1');
    expect(mocks.verifySpy).toHaveBeenCalledOnce();
    expect(mocks.row.attempts).toBe(1);
  });

  it('locks on the Nth failure (from any IP) and refuses the correct code afterwards without comparing', async () => {
    for (let i = 0; i < 4; i++) {
      expect(await attempt(`BAD${i}X`, `198.51.100.${i}`)).toMatchObject({ ok: false, reason: 'wrong_code' });
    }
    expect(await attempt('BAD9X', '198.51.100.99')).toMatchObject({ ok: false, reason: 'locked' });
    mocks.verifySpy.mockClear();

    expect(await attempt(CODE, '192.0.2.1')).toMatchObject({ ok: false, reason: 'locked' });
    expect(mocks.verifySpy).not.toHaveBeenCalled();
    expect(mocks.setCookie).not.toHaveBeenCalled();
    expect(mocks.recordAccessCodeUnlock).not.toHaveBeenCalled();
  });

  it('records the lockout once as an envelope event', async () => {
    for (let i = 0; i < 5; i++) await attempt(`BAD${i}X`);
    await attempt(CODE);
    const locked = mocks.recordEnvelopeEvent.mock.calls.filter(([e]) => e.type === 'recipient.access_code_locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]![0]).toMatchObject({
      envelopeId: 'env1',
      actorRecipientId: 'r1',
      data: expect.objectContaining({ failedAttempts: 5, lockouts: 1 }),
    });
  });

  it('a concurrent burst of wrong guesses gets at most N comparisons', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => attempt(`GUESS${i}`, `198.51.100.${i}`)),
    );
    expect(mocks.verifySpy.mock.calls.length).toBeLessThanOrEqual(mocks.maxAttempts);
    expect(results.filter((r) => !r.ok && r.reason === 'locked').length).toBeGreaterThanOrEqual(25 - mocks.maxAttempts);
  });

  it('after the lock expires a fresh series is allowed, and the correct code clears the count', async () => {
    mocks.row = { attempts: 5, lockedUntil: new Date(Date.now() - 1000), lockouts: 1 };
    expect(await attempt(CODE)).toEqual({ ok: true });
    expect(mocks.clearAccessCodeFailures).toHaveBeenCalledWith('r1');
    expect(mocks.row.attempts).toBe(0);
    expect(mocks.row.lockouts).toBe(1);
  });

  it('a recipient without a code is never counted', async () => {
    mocks.loadSigningSession.mockResolvedValue(session({ accessCodeHash: null }));
    await attempt('WHATEVER');
    expect(mocks.row.attempts).toBe(0);
  });
});
