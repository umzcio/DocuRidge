import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  allowed: true,
  recordEnvelopeEvent: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ user: { id: 'u1' }, orgId: 'org1', role: 'VIEWER' }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async () => ({
        id: 'env1', orgId: 'org1', createdById: 'owner', title: 'Contract', status: 'IN_PROGRESS',
        routingMode: 'PARALLEL', createdAt: new Date(), sentAt: null, completedAt: null, voidedAt: null, declinedAt: null,
      }),
    },
    auditEvent: { findMany: async () => [] },
    recipient: { findMany: async () => [] },
  },
}));
vi.mock('@/lib/audit/envelope', () => ({
  recordEnvelopeEvent: mocks.recordEnvelopeEvent,
  verifyEnvelopeChain: async () => ({ ok: true }),
}));
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: async () => ({ allowed: mocks.allowed, count: 11, limit: 10, retryAfterSeconds: 42 }),
}));

import { GET } from './route';

const get = () =>
  GET(new Request('https://docs.example.edu/dashboard/envelopes/env1/audit.json') as never, {
    params: Promise.resolve({ id: 'env1' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.allowed = true;
});

describe('GET audit.json', () => {
  it('serves the trail and records envelope.verified', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(mocks.recordEnvelopeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'envelope.verified' }));
  });

  it('answers 429 without appending to the chain once the rate limit is spent', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    mocks.recordEnvelopeEvent.mockClear();
    mocks.allowed = false;
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('42');
    expect(mocks.recordEnvelopeEvent).not.toHaveBeenCalled();
  });
});
