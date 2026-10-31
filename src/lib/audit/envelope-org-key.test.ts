import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The org signing key must be resolved before the audit transaction opens:
 * inside it the caller holds the envelope's advisory lock, so a lookup on the
 * global client would need a second pool connection per transaction, and a
 * key row created there would commit independently of the transaction.
 * This uses the real org-key module against a fake client that records
 * whether each global-client query ran while a transaction was open.
 */
const h = vi.hoisted(() => ({
  keysDir: '',
  inTx: false,
  globalCalls: [] as Array<{ op: string; inTx: boolean }>,
  keyRows: [] as Array<Record<string, unknown>>,
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock('../env', () => ({ getEnv: () => ({ KEYS_DIR: h.keysDir }) }));
vi.mock('../webhooks/dispatch', () => ({ dispatchWebhooks: vi.fn() }));
vi.mock('../prisma', () => {
  const orgOf = (envelopeId: string) => envelopeId.replace(/^env/, 'org');
  const tx = {
    $executeRaw: async () => 0,
    // No seal fence: the append's fence check finds nothing.
    $queryRaw: async () => [],
    envelope: {
      findUnique: async ({ where }: { where: { id: string } }) => ({ orgId: orgOf(where.id) }),
    },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
        return data;
      },
    },
  };
  const logged = <A extends unknown[], R>(op: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      h.globalCalls.push({ op, inTx: h.inTx });
      return fn(...a);
    };
  const prisma = {
    envelope: {
      findUnique: logged('envelope.findUnique', tx.envelope.findUnique),
    },
    orgSigningKey: {
      findFirst: logged('orgSigningKey.findFirst', async ({ where }: { where: { orgId: string } }) =>
        h.keyRows.find((k) => k.orgId === where.orgId) ?? null),
      create: logged('orgSigningKey.create', async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `key-${h.keyRows.length + 1}`, createdAt: new Date(), revokedAt: null, ...data };
        h.keyRows.push(row);
        return row;
      }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      h.inTx = true;
      try {
        return await fn(tx);
      } finally {
        h.inTx = false;
      }
    },
  };
  return { prisma };
});

import { commitWithEnvelopeEvents, recordEnvelopeEvent } from './envelope';
import { publicKeyFromPem, verifyHexSignature } from '../crypto/org-key';

h.keysDir = mkdtempSync(join(tmpdir(), 'docuridge-org-keys-'));

afterAll(() => {
  rmSync(h.keysDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.globalCalls.length = 0;
  h.created.length = 0;
});

const globalCallsInsideTx = () =>
  h.globalCalls.filter((c) => c.inTx);

describe('org signing key resolution', () => {
  it('creates a cold org key before the transaction and signs with it', async () => {
    await recordEnvelopeEvent({ envelopeId: 'env-cold', type: 'envelope.sent' });

    expect(h.globalCalls.map((c) => c.op)).toContain('orgSigningKey.create');
    expect(globalCallsInsideTx()).toEqual([]);

    const keyRow = h.keyRows.find((k) => k.orgId === 'org-cold')!;
    const event = h.created[0]!;
    expect(event.signedByKeyId).toBe(keyRow.id);
    expect(await verifyHexSignature({
      publicKey: publicKeyFromPem(keyRow.publicKeyPem as string),
      hexHash: event.eventHash as string,
      hexSignature: event.signature as string,
    })).toBe(true);
  });

  it('touches only the transaction client while several events are appended', async () => {
    await commitWithEnvelopeEvents('env-multi', async (_tx, record) => {
      await record({ envelopeId: 'env-multi', type: 'recipient.field_filled' });
      await record({ envelopeId: 'env-multi', type: 'recipient.signed' });
    });

    expect(h.created).toHaveLength(2);
    expect(globalCallsInsideTx()).toEqual([]);
  });

  it('refuses to sign an event for another org with the key resolved up front', async () => {
    await expect(commitWithEnvelopeEvents('env-a', async (_tx, record) => {
      await record({ envelopeId: 'env-b', type: 'envelope.sent' });
    })).rejects.toThrow(/org/i);
    expect(h.created).toHaveLength(0);
  });
});
