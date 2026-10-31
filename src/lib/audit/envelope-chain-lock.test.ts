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
    // Raising a fence on an envelope that awaits signatures.
    if (text.includes('SET "sealFenceToken" = ?')) return 1;
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
  MAX_SEAL_FENCE_MS,
  SEAL_FENCE_WAIT_MS,
  commitWithEnvelopeEvents,
  lowerSealFence,
  raiseSealFence,
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

  it('reruns a transaction whose caller swallowed the lock timeout, never committing it', async () => {
    h.lockOutcomes = ['timeout'];
    let calls = 0;

    await commitWithEnvelopeEvents('env1', async (_tx, record) => {
      calls++;
      await record({ envelopeId: 'env1', type: 'comment.added' }).catch(() => undefined);
    });

    expect(calls).toBe(2);
    expect(h.transactions).toBe(2);
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
      await vi.advanceTimersByTimeAsync(SEAL_FENCE_WAIT_MS + 10_000);
      expect(await settled).toBeInstanceOf(EnvelopeSealFencedError);
      expect(h.created).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('raising and lowering a seal fence', () => {
  it('gives each fence a random token and starts its lease only once the chain lock is held', async () => {
    const first = await raiseSealFence('env1', 80_000);
    const second = await raiseSealFence('env1', 80_000);

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    const order = statements();
    const token = order.findIndex((t) => t.includes('SET "sealFenceToken" = ?'));
    const lock = order.findIndex((t) => t.includes('pg_advisory_xact_lock'));
    const lease = order.findIndex((t) => t.includes('SET "sealFenceUntil" = (clock_timestamp()'));
    expect(token).toBeLessThan(lock);
    expect(lock).toBeLessThan(lease);
    expect(h.sql[lease]!.values[0]).toBe('80000 milliseconds');
    expect(h.sql.find((q) => q.text.includes('SET "sealFenceToken" = ?'))!.values[0]).toBe(first);
  });

  it('lowers only the fence with the caller\'s token', async () => {
    await lowerSealFence('env1', 'my-token');

    const lower = h.sql.at(-1)!;
    expect(lower.text).toContain('"sealFenceToken" = ?');
    expect(lower.text).not.toContain('"sealFenceUntil" = ?');
    expect(lower.values).toEqual(['env1', 'my-token']);
  });

  it('refuses a lease beyond MAX_SEAL_FENCE_MS', async () => {
    await expect(raiseSealFence('env1', MAX_SEAL_FENCE_MS + 1)).rejects.toThrow(/lease/);
    expect(h.transactions).toBe(0);
  });

  it('does not refuse an append for the fence its own caller raised', async () => {
    // The fence check passes the caller's token; the database compares it.
    await commitWithEnvelopeEvents('env1', (_tx, record) => record({ envelopeId: 'env1', type: 'envelope.seal_failed' }), {
      ownSealFence: 'my-token',
    });

    const check = h.sql.find((q) => q.text.includes('AS "up"'))!;
    expect(check.text).toContain('"sealFenceToken" IS DISTINCT FROM ?');
    expect(check.values[0]).toBe('my-token');
  });
});
