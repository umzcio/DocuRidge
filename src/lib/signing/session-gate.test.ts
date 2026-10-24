import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSigningSession: vi.fn(),
  recordAccessCodeUnlock: vi.fn(),
  cookieJar: new Map<string, string>(),
  setCookie: vi.fn(),
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
    expect(res).toMatchObject({ ok: false, reason: 'wrong_code' });
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
