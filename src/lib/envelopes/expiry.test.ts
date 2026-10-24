import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  envelope: {} as Record<string, unknown>,
  recipient: {} as Record<string, unknown>,
  events: [] as Array<{ type: string }>,
  sendMail: vi.fn(),
}));

vi.mock('../prisma', () => {
  const client = {
    envelope: {
      findUnique: async () => ({ ...db.envelope, recipients: [{ ...db.recipient }], items: [], fields: [], meta: null }),
      findFirst: async () => ({ ...db.envelope, recipients: [{ ...db.recipient }], meta: null }),
      updateMany: async ({ where, data }: { where: { status: { in: string[] }; expiresAt: { lte: Date } }; data: Record<string, unknown> }) => {
        const exp = db.envelope.expiresAt as Date | null;
        if (!where.status.in.includes(db.envelope.status as string) || !exp || exp > where.expiresAt.lte) return { count: 0 };
        Object.assign(db.envelope, data);
        return { count: 1 };
      },
    },
    recipient: {
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(db.recipient, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (Object.entries(where).some(([k, v]) => db.recipient[k] !== v)) return { count: 0 };
        Object.assign(db.recipient, data);
        return { count: 1 };
      },
    },
    user: { findUnique: async () => ({ name: 'Sender' }) },
    organisation: { findUnique: async () => null },
  };
  return { prisma: client };
});
vi.mock('../audit/envelope', async () => {
  const { prisma } = await import('../prisma');
  return {
    recordEnvelopeEvent: async (e: { type: string }) => { db.events.push(e); },
    commitWithEnvelopeEvents: async (_envelopeId: string, fn: (tx: unknown, record: unknown) => unknown) =>
      fn(prisma, async (e: { type: string }) => { db.events.push(e); }),
  };
});
vi.mock('../authz/can', () => ({ authorize: vi.fn() }));
vi.mock('../mail', () => ({ sendMail: db.sendMail }));
vi.mock('../env', () => ({
  getEnv: () => ({
    PUBLIC_URL: 'https://docs.example.edu',
    JWS_SIGNING_TOKEN_SECRET: 'test-signing-secret-test-signing-secret',
  }),
}));
vi.mock('../pdf/seal', () => ({ sealEnvelope: vi.fn() }));

import { loadSigningSession, sendReminderToNextSigner } from './lifecycle';
import { mintSigningToken } from '../signing/token';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-01T12:00:00Z');
const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };

async function pinToken(notAfter?: Date) {
  const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1', notAfter });
  Object.assign(db.recipient, { tokenJti: minted.jti, currentTokenExpiresAt: minted.expiresAt });
  return minted;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  db.events.length = 0;
  db.sendMail.mockReset();
  db.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false, messageId: 'm1' });
  db.envelope = {
    id: 'env1', orgId: 'org1', createdById: 'u1', title: 'Contract', message: null,
    status: 'IN_PROGRESS', routingMode: 'SEQUENTIAL', expiresAt: new Date(T0.getTime() + 3 * DAY),
  };
  db.recipient = {
    id: 'r1', envelopeId: 'env1', email: 'signer@example.com', name: 'Signer',
    recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 1,
    sendStatus: 'SENT', lastReminderSentAt: null, tokenJti: null, currentTokenExpiresAt: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mintSigningToken notAfter', () => {
  it('does not bake the deadline into the token, so a later extension still applies', async () => {
    const deadline = new Date(T0.getTime() + 2 * DAY);
    const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1', notAfter: deadline });
    expect(minted.expiresAt.getTime()).toBe(T0.getTime() + 14 * DAY);
    const exp = JSON.parse(Buffer.from(minted.token.split('.')[1]!, 'base64url').toString()).exp;
    expect(exp * 1000).toBe(T0.getTime() + 14 * DAY);
  });

  it('keeps the normal lifetime when the deadline is further away', async () => {
    const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1', notAfter: new Date(T0.getTime() + 60 * DAY) });
    expect(minted.expiresAt.getTime()).toBe(T0.getTime() + 14 * DAY);
  });

  it('refuses to mint once the deadline has passed', async () => {
    await expect(mintSigningToken({ envelopeId: 'env1', recipientId: 'r1', notAfter: new Date(T0.getTime() - 1) }))
      .rejects.toThrow(/expired/i);
  });
});

describe('loadSigningSession deadline', () => {
  it('admits a current token before the deadline', async () => {
    const { token } = await pinToken();
    expect((await loadSigningSession(token)).ok).toBe(true);
  });

  it('refuses a still-valid 14-day token after the deadline and marks the envelope expired once', async () => {
    const { token } = await pinToken();
    vi.setSystemTime(new Date(T0.getTime() + 4 * DAY));

    expect(await loadSigningSession(token)).toEqual({ ok: false, reason: 'expired' });
    expect(db.envelope.status).toBe('EXPIRED');
    expect(db.events.filter((e) => e.type === 'envelope.expired')).toHaveLength(1);

    expect((await loadSigningSession(token)).ok).toBe(false);
    expect(db.events.filter((e) => e.type === 'envelope.expired')).toHaveLength(1);
  });
});

describe('extending the deadline after send', () => {
  it('keeps the originally emailed link working until the new deadline, and no longer', async () => {
    // Invite minted while the deadline was day 3.
    const { token } = await pinToken(db.envelope.expiresAt as Date);
    // Correction (updateExpiration) moves the deadline to day 10 without re-minting.
    db.envelope.expiresAt = new Date(T0.getTime() + 10 * DAY);

    vi.setSystemTime(new Date(T0.getTime() + 5 * DAY));
    expect((await loadSigningSession(token)).ok).toBe(true);

    vi.setSystemTime(new Date(T0.getTime() + 10 * DAY - 1000));
    expect((await loadSigningSession(token)).ok).toBe(true);

    vi.setSystemTime(new Date(T0.getTime() + 10 * DAY + 1000));
    expect(await loadSigningSession(token)).toEqual({ ok: false, reason: 'expired' });
    expect(db.envelope.status).toBe('EXPIRED');
  });

  it('still cuts the link off at a deadline that was moved earlier', async () => {
    const { token } = await pinToken(db.envelope.expiresAt as Date);
    db.envelope.expiresAt = new Date(T0.getTime() + 1 * DAY);

    vi.setSystemTime(new Date(T0.getTime() + 2 * DAY));
    expect(await loadSigningSession(token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('reminders near and past the deadline', () => {
  it('a reminder sent a day before expiry mints a link that stops at the deadline', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 2 * DAY));
    await sendReminderToNextSigner({ ctx, envelopeId: 'env1' });
    const url = db.sendMail.mock.calls[0]![0].text.match(/\/sign\/([^\s]+)/)[1];
    const token = decodeURIComponent(url);

    expect((await loadSigningSession(token)).ok).toBe(true);
    vi.setSystemTime(new Date((db.envelope.expiresAt as Date).getTime() + 1000));
    expect((await loadSigningSession(token)).ok).toBe(false);
  });

  it('refuses a reminder once the envelope has expired', async () => {
    vi.setSystemTime(new Date(T0.getTime() + 4 * DAY));
    await expect(sendReminderToNextSigner({ ctx, envelopeId: 'env1' })).rejects.toThrow(/expired/i);
    expect(db.sendMail).not.toHaveBeenCalled();
    expect(db.envelope.status).toBe('EXPIRED');
  });
});
