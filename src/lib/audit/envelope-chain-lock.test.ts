import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Waiting for an envelope's audit chain must never pin a pooled connection
 * for long: the lock wait is bounded (lock_timeout), a timed-out append is
 * retried a bounded number of times, and an append refused by a completion's
 * seal fence waits for the fence with no transaction open.
 */

const h = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; values: unknown[]; inTx: boolean }>,
  inTx: false,
  transactions: 0,
  created: [] as Array<Record<string, unknown>>,
  // What the next chain-lock statements do: 'ok' or 'timeout', in turn.
  lockOutcomes: [] as Array<'ok' | 'timeout'>,
  // What fence checks report, in turn (then false).
  fenceUp: [] as boolean[],
}));

function lockTimeout(): Error {
  // How Prisma reports a raw query the database cancelled on lock_timeout.
  return Object.assign(new Error('Raw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`'), {
    code: 'P2010',
    meta: { code: '55P03', message: 'ERROR: canceling statement due to lock timeout' },
  });
}

vi.mock('../prisma', () => {
  const raw = (kind: 'execute' | 'query') => async (sql: TemplateStringsArray, ...values: unknown[]) => {
    const text = sql.join('?');
    h.sql.push({ text, values, inTx: h.inTx });
    if (text.includes('pg_advisory_xact_lock')) {
      if ((h.lockOutcomes.shift() ?? 'ok') === 'timeout') throw lockTimeout();
      return 0;
    }
    if (text.includes('AS "up"')) return [{ up: h.fenceUp.shift() ?? false }];
    return kind === 'execute' ? 0 : [];
  };
  const tx = {
    $executeRaw: raw('execute'),
    $queryRaw: raw('query'),
    envelope: { findUnique: async () => ({ orgId: 'org1' }) },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        h.created.push(data);
        return data;
      },
    },
  };
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
        h.inTx = true;
        h.transactions++;
        const created = h.created.length;
        try {
          // A fresh transaction client each time, as Prisma's interactive transactions have.
          return await fn({ ...tx });
        } catch (err) {
          // Rolled back.
          h.created.length = created;
          throw err;
        } finally {
          h.inTx = false;
        }
      },
    },
  };
});
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'k1' }),
  signHexWithKey: async () => 'sig',
}));
vi.mock('../webhooks/dispatch', () => ({ dispatchWebhooks: vi.fn() }));

import {
  CHAIN_LOCK_TIMEOUT_MS,
  EnvelopeChainBusyError,
  EnvelopeSealFencedError,
  commitWithEnvelopeEvents,
  recordEnvelopeEvent,
} from './envelope';

beforeEach(() => {
  h.sql.length = 0;
  h.created.length = 0;
  h.transactions = 0;
  h.lockOutcomes = [];
  h.fenceUp = [];
});

const statements = () => h.sql.map((s) => s.text);

describe('the audit-chain lock wait', () => {
  it('is bounded by lock_timeout, set before the advisory lock is requested', async () => {
    await recordEnvelopeEvent({ envelopeId: 'env1', type: 'envelope.downloaded' });

    const setAt = statements().findIndex((t) => t.includes("set_config('lock_timeout'"));
    const lockAt = statements().findIndex((t) => t.includes('pg_advisory_xact_lock'));
    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(setAt).toBeLessThan(lockAt);
    expect(h.sql[setAt]!.values).toEqual([`${CHAIN_LOCK_TIMEOUT_MS}ms`]);
    expect(CHAIN_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    expect(h.created).toHaveLength(1);
  });

  it('takes the lock and checks the fence once per transaction, however many events it appends', async () => {
    await commitWithEnvelopeEvents('env1', async (_tx, record) => {
      for (let i = 0; i < 5; i++) await record({ envelopeId: 'env1', type: 'recipient.field_filled' });
    });

    expect(statements().filter((t) => t.includes('pg_advisory_xact_lock'))).toHaveLength(1);
    expect(statements().filter((t) => t.includes('AS "up"'))).toHaveLength(1);
    expect(h.created).toHaveLength(5);
  });

  it('reruns a transaction whose lock wait timed out, and commits once', async () => {
    h.lockOutcomes = ['timeout'];
    const fn = vi.fn(async (_tx: unknown, record: (a: { envelopeId: string; type: 'envelope.downloaded' }) => Promise<void>) => {
      await record({ envelopeId: 'env1', type: 'envelope.downloaded' });
    });

    await commitWithEnvelopeEvents('env1', fn);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(h.created).toHaveLength(1);
  });

  it('gives up with EnvelopeChainBusyError after two reruns, never waiting unbounded', async () => {
    h.lockOutcomes = ['timeout', 'timeout', 'timeout', 'timeout'];

    await expect(recordEnvelopeEvent({ envelopeId: 'env1', type: 'envelope.downloaded' }))
      .rejects.toBeInstanceOf(EnvelopeChainBusyError);
    expect(h.transactions).toBe(3);
    expect(h.created).toHaveLength(0);
  });
});

describe('an append refused by the seal fence', () => {
  it('rolls back, waits for the fence with no transaction open, then commits', async () => {
    // Up at the append; the waiter's polls see it up once more, then lifted.
    h.fenceUp = [true, true, false];

    await recordEnvelopeEvent({ envelopeId: 'env1', type: 'envelope.verified' });

    expect(h.transactions).toBe(2);
    expect(h.created).toHaveLength(1);
    const checks = h.sql.filter((s) => s.text.includes('AS "up"'));
    // In the first transaction, then two polls outside any, then the rerun's.
    expect(checks.map((c) => c.inTx)).toEqual([true, false, false, true]);
  });

  it('is not committed even when the caller swallows the refusal', async () => {
    h.fenceUp = [true, false];
    let calls = 0;

    await commitWithEnvelopeEvents('env1', async (_tx, record) => {
      calls++;
      await record({ envelopeId: 'env1', type: 'comment.added' }).catch(() => undefined);
    });

    expect(calls).toBe(2);
    expect(h.created).toHaveLength(1);
  });

  it('gives up with EnvelopeSealFencedError once the fence has outlived its lease', async () => {
    vi.useFakeTimers();
    try {
      h.fenceUp = Array.from({ length: 10_000 }, () => true);
      const pending = recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added' });
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await settled).toBeInstanceOf(EnvelopeSealFencedError);
      expect(h.created).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
