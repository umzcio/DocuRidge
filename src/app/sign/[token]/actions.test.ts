import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reassignRecipient: vi.fn(),
  declineEnvelope: vi.fn(),
  addComment: vi.fn(),
  loadSigningSession: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock('@/lib/envelopes/lifecycle', () => ({
  loadSigningSession: mocks.loadSigningSession,
  recordConsent: vi.fn(),
  recordAccessCodeUnlock: vi.fn(),
  completeRecipientSigning: vi.fn(),
  declineEnvelope: mocks.declineEnvelope,
  reassignRecipient: mocks.reassignRecipient,
}));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.9', userAgent: 'vitest' }),
  getSession: async () => null,
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/storage', () => ({ saveRecipientAttachment: vi.fn(), AttachmentValidationError: class extends Error {} }));
vi.mock('@/lib/mail', () => ({ mayMailRecipient: () => true }));
vi.mock('@/lib/comments/service', () => ({ addComment: mocks.addComment }));

import { addCommentRecipientAction, declineAction, reassignAction } from './actions';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSigningSession.mockResolvedValue({
    ok: true,
    envelope: { id: 'env1', fields: [] },
    recipient: { id: 'r1', email: 'alice@example.com', name: 'Alice' },
    jti: 'j1',
  });
});

describe('reassignAction input hygiene', () => {
  const base = { token: 't', newEmail: 'bob@example.com', newName: 'Bob' };

  it('rejects a NUL in the reason before anything changes', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, reason: 'bye\u0000' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported characters/i);
    expect(mocks.reassignRecipient).not.toHaveBeenCalled();
  });

  it('rejects a NUL in the new name', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, newName: 'Bo\u0000b' }));
    expect(res.ok).toBe(false);
    expect(mocks.reassignRecipient).not.toHaveBeenCalled();
  });

  it('accepts ordinary text', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, reason: 'On leave — back Monday' }));
    expect(res.ok).toBe(true);
    expect(mocks.reassignRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ newEmail: 'bob@example.com', reason: 'On leave — back Monday' }),
    );
  });
});

describe('other recipient free text', () => {
  it('declineAction rejects a NUL in the reason', async () => {
    const res = await declineAction({ ok: false }, form({ token: 't', reason: 'no\u0000' }));
    expect(res.ok).toBe(false);
    expect(mocks.declineEnvelope).not.toHaveBeenCalled();
  });

  it('declineAction rejects an oversized reason', async () => {
    const res = await declineAction({ ok: false }, form({ token: 't', reason: 'x'.repeat(5000) }));
    expect(res.ok).toBe(false);
    expect(mocks.declineEnvelope).not.toHaveBeenCalled();
  });

  it('addCommentRecipientAction rejects a NUL in the body', async () => {
    const res = await addCommentRecipientAction({ ok: false }, form({ token: 't', body: 'hi\u0000' }));
    expect(res.ok).toBe(false);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });
});
