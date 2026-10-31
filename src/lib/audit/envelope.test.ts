import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  dispatchWebhooks: vi.fn(),
}));

vi.mock('../prisma', () => {
  const tx = {
    $executeRaw: async () => 0,
    // No seal fence: the append's fence check finds nothing.
    $queryRaw: async () => [],
    envelope: { findUnique: async () => ({ orgId: 'org1' }) },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        for (const v of Object.values(data)) {
          if (typeof v === 'string' && v.includes('\u0000')) throw new Error('invalid byte sequence 0x00');
        }
        if (JSON.stringify(data.data ?? null).includes('\\u0000')) {
          throw new Error('unsupported Unicode escape sequence');
        }
        mocks.created.push(data);
        return data;
      },
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'k1' }),
  signHexWithKey: async () => 'sig',
}));
vi.mock('../webhooks/dispatch', () => ({ dispatchWebhooks: mocks.dispatchWebhooks }));

import { recordEnvelopeEvent } from './envelope';
import { toStorableText } from '../storable-text';
import { hashAuditEventBody } from './canonical';

beforeEach(() => {
  mocks.created.length = 0;
  mocks.dispatchWebhooks.mockReset();
});

describe('toStorableText', () => {
  it('drops NUL characters', () => {
    expect(toStorableText('a\u0000b\u0000')).toBe('ab');
  });

  it('replaces lone surrogates and keeps valid pairs', () => {
    expect(toStorableText('x\uD83D')).toBe('x\uFFFD');
    expect(toStorableText('\uDE00y')).toBe('\uFFFDy');
    expect(toStorableText('ok \uD83D\uDE00')).toBe('ok \uD83D\uDE00');
  });
});

describe('recordEnvelopeEvent', () => {
  it('stores text Postgres can hold and hashes exactly what it stores', async () => {
    await recordEnvelopeEvent({
      envelopeId: 'env1',
      type: 'recipient.reassigned',
      actorName: 'Eve\u0000',
      userAgent: 'agent\u0000',
      data: { reason: 'bye\u0000', nested: { list: ['a\u0000', 'b\uD83D'] }, count: 2 },
    });

    expect(mocks.created).toHaveLength(1);
    const row = mocks.created[0]!;
    expect(row.actorName).toBe('Eve');
    expect(row.userAgent).toBe('agent');
    expect(row.data).toEqual({ reason: 'bye', nested: { list: ['a', 'b\uFFFD'] }, count: 2 });

    const rehash = await hashAuditEventBody({
      envelopeId: 'env1',
      seq: row.seq as number,
      type: 'recipient.reassigned',
      actorUserId: null,
      actorRecipientId: null,
      actorEmail: null,
      actorName: row.actorName as string,
      ipAddress: null,
      userAgent: row.userAgent as string,
      data: row.data,
      prevHash: row.prevHash as string,
    });
    expect(rehash).toBe(row.eventHash);
    expect(mocks.dispatchWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reason: 'bye', nested: { list: ['a', 'b\uFFFD'] }, count: 2 } }),
    );
  });
});
