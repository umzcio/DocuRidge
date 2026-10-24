import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server-side access-code enforcement on every token-consuming path. These
 * run the real gate (`@/lib/signing/session-gate`) and the real proof
 * verifier; only the token/DB layer underneath is mocked, so a direct POST
 * to an action or GET of the document route — skipping the page and its
 * client-side gate — is what is being exercised.
 */

const mocks = vi.hoisted(() => ({
  loadSigningSession: vi.fn(),
  recordConsent: vi.fn(),
  completeRecipientSigning: vi.fn(),
  declineEnvelope: vi.fn(),
  reassignRecipient: vi.fn(),
  addComment: vi.fn(),
  saveRecipientAttachment: vi.fn(),
  upsertAttachment: vi.fn(),
  readPdfFromStorage: vi.fn(),
  cookieJar: new Map<string, string>(),
  setCookie: vi.fn(),
  ip: '203.0.113.9',
  row: { attempts: 0, lockedUntil: null as Date | null, lockouts: 0 },
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { name, value: mocks.cookieJar.get(name)! } : undefined),
    set: mocks.setCookie,
  }),
}));
vi.mock('@/lib/envelopes/lifecycle', () => ({
  loadSigningSession: mocks.loadSigningSession,
  recordConsent: mocks.recordConsent,
  recordAccessCodeUnlock: vi.fn(),
  completeRecipientSigning: mocks.completeRecipientSigning,
  declineEnvelope: mocks.declineEnvelope,
  reassignRecipient: mocks.reassignRecipient,
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ JWS_SIGNING_TOKEN_SECRET: 'x'.repeat(48) }),
}));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: mocks.ip, userAgent: 'vitest' }),
  getSession: async () => null,
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock('@/lib/prisma', () => ({ prisma: { fieldAttachment: { upsert: mocks.upsertAttachment } } }));
vi.mock('@/lib/storage', () => ({
  saveRecipientAttachment: mocks.saveRecipientAttachment,
  readPdfFromStorage: mocks.readPdfFromStorage,
  AttachmentValidationError: class extends Error {},
}));
vi.mock('@/lib/mail', () => ({ mayMailRecipient: () => true }));
vi.mock('@/lib/comments/service', () => ({ addComment: mocks.addComment }));
vi.mock('@/lib/audit/envelope', () => ({ recordEnvelopeEvent: vi.fn() }));
// Same semantics as the conditional UPDATE in access-code-lockout.ts, on one
// in-memory recipient row.
vi.mock('@/lib/access-code-lockout', () => ({
  reserveAccessCodeAttempt: async () => {
    const row = mocks.row;
    if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) return { allowed: false };
    const attempts = row.lockedUntil ? 1 : row.attempts + 1;
    row.attempts = attempts;
    row.lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60_000) : null;
    if (row.lockedUntil) row.lockouts += 1;
    return { allowed: true, attempts, lockedUntil: row.lockedUntil, lockouts: row.lockouts };
  },
  clearAccessCodeFailures: async () => { mocks.row.attempts = 0; mocks.row.lockedUntil = null; },
}));

import {
  addCommentRecipientAction,
  verifyRecipientAccessCodeAction,
  consentAction,
  declineAction,
  reassignAction,
  submitSigningAction,
  uploadAttachmentAction,
} from './actions';
import { GET as getDocument } from './document/route';
import { mintAccessProof } from '@/lib/signing/access-proof';
import { hashAccessCode } from '@/lib/access-code-server';
import { accessCodeCookieName } from '@/lib/access-code';

const codeHash = hashAccessCode('K7P2QX');

function form(values: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

function protectedSession(jti = 'jti-1') {
  return {
    ok: true as const,
    envelope: {
      id: 'env1',
      orgId: 'org1',
      fields: [{ id: 'f-att', type: 'ATTACHMENT', recipientId: 'r1', meta: null }],
      items: [{ documentFile: { storagePath: 'docs/x.pdf' } }],
    },
    recipient: {
      id: 'r1',
      email: 'alice@example.com',
      name: 'Alice',
      accessCodeHash: codeHash,
      consentGivenAt: new Date(),
    },
    jti,
  };
}

async function setProof(b: { recipientId?: string; jti?: string } = {}) {
  const { token } = await mintAccessProof({
    envelopeId: 'env1',
    recipientId: b.recipientId ?? 'r1',
    jti: b.jti ?? 'jti-1',
    accessCodeHash: codeHash,
  });
  mocks.cookieJar.set(accessCodeCookieName('r1'), token);
}

/** Every token-consuming entry point, with the side effect that must not happen. */
const paths: Array<{ name: string; call: () => Promise<{ ok?: boolean; status?: number }>; effect: () => unknown }> = [
  {
    name: 'consentAction',
    call: () => consentAction({ ok: false }, form({ token: 't' })),
    effect: () => mocks.recordConsent,
  },
  {
    name: 'submitSigningAction',
    call: () => submitSigningAction({ ok: false }, form({ token: 't', fieldValues: '{}', typedSignature: 'Alice' })),
    effect: () => mocks.completeRecipientSigning,
  },
  {
    name: 'declineAction',
    call: () => declineAction({ ok: false }, form({ token: 't', reason: 'no' })),
    effect: () => mocks.declineEnvelope,
  },
  {
    name: 'uploadAttachmentAction',
    call: () => uploadAttachmentAction({ ok: false }, form({
      token: 't', fieldId: 'f-att', file: new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' }),
    })),
    effect: () => mocks.saveRecipientAttachment,
  },
  {
    name: 'addCommentRecipientAction',
    call: () => addCommentRecipientAction({ ok: false }, form({ token: 't', body: 'hello' })),
    effect: () => mocks.addComment,
  },
  {
    name: 'reassignAction',
    call: () => reassignAction({ ok: false }, form({ token: 't', newEmail: 'bob@example.com', newName: 'Bob' })),
    effect: () => mocks.reassignRecipient,
  },
  {
    name: 'GET /sign/[token]/document',
    call: async () => {
      const res = await getDocument(new Request('https://docs.example.com/sign/t/document') as never, {
        params: Promise.resolve({ token: 't' }),
      });
      return { ok: res.status === 200, status: res.status };
    },
    effect: () => mocks.readPdfFromStorage,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieJar.clear();
  mocks.ip = '203.0.113.9';
  mocks.row = { attempts: 0, lockedUntil: null, lockouts: 0 };
  mocks.loadSigningSession.mockResolvedValue(protectedSession());
  mocks.completeRecipientSigning.mockResolvedValue({ envelopeStatus: 'IN_PROGRESS' });
  mocks.recordConsent.mockResolvedValue(true);
  mocks.saveRecipientAttachment.mockResolvedValue({
    filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3, sha256: 'ab', relativePath: 'x',
  });
  mocks.readPdfFromStorage.mockResolvedValue(Buffer.from('%PDF-1.7'));
});

describe.each(paths)('$name with a code-protected recipient', ({ call, effect }) => {
  it('refuses without an unlock proof', async () => {
    const res = await call();
    expect(res.ok).toBe(false);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('refuses a proof minted for a different recipient', async () => {
    await setProof({ recipientId: 'r2' });
    const res = await call();
    expect(res.ok).toBe(false);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('refuses a proof minted for an earlier token jti (after reassign or re-mint)', async () => {
    mocks.loadSigningSession.mockResolvedValue(protectedSession('jti-2'));
    await setProof({ jti: 'jti-1' });
    const res = await call();
    expect(res.ok).toBe(false);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('proceeds with a valid proof', async () => {
    await setProof();
    const res = await call();
    expect(res.ok).toBe(true);
    expect(effect()).toHaveBeenCalled();
  });
});

describe('document route', () => {
  it('answers 403 (no PDF bytes) without a proof', async () => {
    const res = await getDocument(new Request('https://docs.example.com/sign/t/document') as never, {
      params: Promise.resolve({ token: 't' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('verifyRecipientAccessCodeAction per-recipient lockout', () => {
  const unlock = (code: string) => verifyRecipientAccessCodeAction({ ok: false }, form({ token: 't', code }));

  it('after five wrong codes from different IPs the correct code is refused and no proof is set', async () => {
    for (let i = 0; i < 5; i++) {
      mocks.ip = `198.51.100.${i + 1}`;
      expect((await unlock(`WRONG${i}`)).ok).toBe(false);
    }
    mocks.ip = '192.0.2.77';
    const res = await unlock('K7P2QX');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many incorrect attempts/i);
    expect(mocks.setCookie).not.toHaveBeenCalled();
  });

  it('a wrong code below the threshold gets the generic error', async () => {
    const res = await unlock('WRONG1');
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/incorrect access code/i) });
  });

  it('the correct code sets the proof cookie', async () => {
    expect(await unlock('k7p2qx')).toEqual({ ok: true });
    expect(mocks.setCookie).toHaveBeenCalledOnce();
  });
});
