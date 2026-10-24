import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: null as null | { user: { id: string; name: string; email: string }; orgId: string; role: string },
  envelope: { id: 'env1', orgId: 'org1', createdById: 'owner' } as Record<string, unknown> | null,
  addComment: vi.fn(),
  allowed: true,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => mocks.session,
  captureClientContext: () => ({ ipAddress: '203.0.113.9', userAgent: 'vitest' }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: { envelope: { findFirst: async () => mocks.envelope } },
}));
vi.mock('@/lib/comments/service', () => ({ addComment: mocks.addComment }));
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: async () => ({ allowed: mocks.allowed, count: 1, limit: 10, retryAfterSeconds: 30 }),
}));

import { addCommentSenderAction } from './comment-actions';

function post() {
  const fd = new FormData();
  fd.set('envelopeId', 'env1');
  fd.set('body', 'Please sign by Friday');
  return addCommentSenderAction({ ok: false }, fd);
}

const as = (role: string, id = 'u1') => {
  mocks.session = { user: { id, name: 'Member', email: 'member@example.edu' }, orgId: 'org1', role };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed = true;
  mocks.envelope = { id: 'env1', orgId: 'org1', createdById: 'owner' };
});

describe('addCommentSenderAction', () => {
  it('refuses a read-only VIEWER and stores nothing', async () => {
    as('VIEWER');
    const res = await post();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(mocks.addComment).not.toHaveBeenCalled();
  });

  it.each(['ADMIN', 'SENDER'])('lets a %s comment on a colleague’s envelope', async (role) => {
    as(role);
    expect(await post()).toEqual({ ok: true });
    expect(mocks.addComment).toHaveBeenCalledOnce();
  });

  it('refuses once the per-envelope rate limit is spent', async () => {
    as('SENDER');
    mocks.allowed = false;
    const res = await post();
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/too many comments/i) });
    expect(mocks.addComment).not.toHaveBeenCalled();
  });
});
