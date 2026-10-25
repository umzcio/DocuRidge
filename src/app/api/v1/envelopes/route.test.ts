import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  sendEnvelope: vi.fn(),
  instantiateTemplate: vi.fn(),
}));

vi.mock('@/lib/api/guard', () => ({
  guardApiRequest: async () => ({ ok: true, auth: { token: { id: 'tok1', orgId: 'org1', userId: 'u1' } } }),
}));
vi.mock('@/lib/api/auth', () => ({
  resolveApiActor: async () => ({ userId: 'u1', orgId: 'org1', role: 'ADMIN' }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async () => ({ id: 'tpl1', recipients: [{ id: 'role1', name: 'Signer', roleLabel: null }] }),
      findUnique: async () => ({ status: 'IN_PROGRESS' }),
      update: vi.fn(),
    },
  },
}));
vi.mock('@/lib/templates/service', () => ({ instantiateTemplate: mocks.instantiateTemplate }));
vi.mock('@/lib/envelopes/lifecycle', () => ({ sendEnvelope: mocks.sendEnvelope }));
vi.mock('@/lib/logger', () => ({ childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { POST } from './route';
import { EnvelopeNotSealableError } from '@/lib/pdf/envelope-seal-check';

function create(): Promise<Response> {
  return POST(new NextRequest('https://docs.example.edu/api/v1/envelopes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ templateId: 'tpl1', recipients: [{ name: 'Alice', email: 'alice@example.com' }] }),
  }));
}

describe('POST /api/v1/envelopes', () => {
  beforeEach(() => {
    mocks.instantiateTemplate.mockReset().mockResolvedValue({ envelopeId: 'env1' });
    mocks.sendEnvelope.mockReset().mockResolvedValue(undefined);
  });

  it('creates and sends', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ envelopeId: 'env1', status: 'IN_PROGRESS' });
  });

  it('answers 503 with Retry-After when send hits a busy PDF worker', async () => {
    mocks.sendEnvelope.mockRejectedValue(
      new EnvelopeNotSealableError('DocuRidge is busy processing other documents. Try sending again in a minute.', { retryable: true }),
    );

    const res = await create();

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: 'DocuRidge is busy processing other documents. Try sending again in a minute.' });
  });

  it('answers 503 when template use hits a busy PDF worker', async () => {
    mocks.instantiateTemplate.mockRejectedValue(new EnvelopeNotSealableError('busy', { retryable: true }));
    expect((await create()).status).toBe(503);
  });

  it('still answers 400 for a document that cannot be sealed', async () => {
    mocks.sendEnvelope.mockRejectedValue(new EnvelopeNotSealableError('"Doc" is too large or complex to seal.'));
    const res = await create();
    expect(res.status).toBe(400);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
