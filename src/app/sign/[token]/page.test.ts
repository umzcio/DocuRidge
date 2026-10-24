import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signing page must not put anything about the envelope into the RSC
 * payload until the access code is proven server-side: no title, sender,
 * message, comments or field definitions (note text, defaults, stamp images).
 */

const mocks = vi.hoisted(() => ({
  loadSigningSession: vi.fn(),
  recordRecipientOpened: vi.fn(),
  findUser: vi.fn(),
  findComments: vi.fn(),
  cookieJar: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
  cookies: async () => ({
    get: (name: string) => (mocks.cookieJar.has(name) ? { name, value: mocks.cookieJar.get(name)! } : undefined),
    set: () => undefined,
  }),
}));
vi.mock('@/lib/envelopes/lifecycle', () => ({
  loadSigningSession: mocks.loadSigningSession,
  recordRecipientOpened: mocks.recordRecipientOpened,
  recordAccessCodeUnlock: vi.fn(),
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({ JWS_SIGNING_TOKEN_SECRET: 'x'.repeat(48) }),
}));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.9', userAgent: 'vitest' }),
  getSession: async () => null,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findUnique: mocks.findUser }, envelopeComment: { findMany: mocks.findComments } },
}));
vi.mock('./ceremony', () => ({ SigningCeremony: function SigningCeremony() { return null; } }));
vi.mock('./access-code-gate', () => ({ AccessCodeGate: function AccessCodeGate() { return null; } }));

import * as React from 'react';
import SignPage from './page';
import { mintAccessProof } from '@/lib/signing/access-proof';
import { hashAccessCode } from '@/lib/access-code-server';
import { accessCodeCookieName } from '@/lib/access-code';

// The page relies on Next's automatic JSX runtime; vitest compiles it with the
// classic one, which expects a global React.
vi.stubGlobal('React', React);

const codeHash = hashAccessCode('K7P2QX');

const SECRET_BITS = ['Confidential Merger Agreement', 'please sign by friday', 'field-secret-1', 'NOTE-TEXT-SECRET'];

function protectedSession() {
  return {
    ok: true as const,
    envelope: {
      id: 'env1',
      createdById: 'u1',
      title: SECRET_BITS[0],
      message: SECRET_BITS[1],
      fields: [{
        id: SECRET_BITS[2], recipientId: 'r1', type: 'NOTE', page: 1, required: false, defaultValue: null,
        x: 0, y: 0, w: 1, h: 1, meta: { noteText: SECRET_BITS[3] }, attachment: null,
      }],
      items: [],
    },
    recipient: {
      id: 'r1', email: 'alice@example.com', name: 'Alice', recipientRole: 'SIGNER',
      accessCodeHash: codeHash, consentGivenAt: null,
    },
    jti: 'jti-1',
  };
}

/** Serialise a React element tree (props only) so we can grep it like an RSC payload. */
function serialise(node: unknown): string {
  return JSON.stringify(node, (_k, v) => (typeof v === 'function' ? `fn:${v.name}` : v)) ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieJar.clear();
  mocks.loadSigningSession.mockResolvedValue(protectedSession());
  mocks.findUser.mockResolvedValue({ name: 'Sender Person', email: 'sender@example.com' });
  mocks.findComments.mockResolvedValue([]);
});

describe('sign page with an access-code-protected recipient', () => {
  it('without a proof renders only the gate and leaks no envelope data', async () => {
    const tree = await SignPage({ params: Promise.resolve({ token: 'tok' }) });
    const out = serialise(tree);
    expect(out).toContain('fn:AccessCodeGate');
    expect(out).not.toContain('fn:SigningCeremony');
    for (const bit of SECRET_BITS) expect(out).not.toContain(bit);
    expect(out).not.toContain('sender@example.com');
    // Nothing else is read or recorded for an unproven visitor.
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.findComments).not.toHaveBeenCalled();
    expect(mocks.recordRecipientOpened).not.toHaveBeenCalled();
  });

  it('with a valid proof renders the ceremony', async () => {
    const { token } = await mintAccessProof({ envelopeId: 'env1', recipientId: 'r1', jti: 'jti-1', accessCodeHash: codeHash });
    mocks.cookieJar.set(accessCodeCookieName('r1'), token);
    const out = serialise(await SignPage({ params: Promise.resolve({ token: 'tok' }) }));
    expect(out).toContain('fn:SigningCeremony');
    expect(out).toContain(SECRET_BITS[0]);
    expect(mocks.recordRecipientOpened).toHaveBeenCalledOnce();
  });
});
