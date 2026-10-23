import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecipientRow {
  id: string; envelopeId: string; email: string; name: string;
  recipientRole: string; signingStatus: string; signingOrder: number;
  tokenJti: string | null; currentTokenExpiresAt: Date | null;
  consentGivenAt: Date | null; sendStatus: string;
}
interface State {
  recipients: Map<string, RecipientRow>;
  envelope: Record<string, unknown>;
  audit: Array<Record<string, unknown>>;
}

const db = vi.hoisted(() => ({
  state: null as unknown as {
    recipients: Map<string, unknown>;
    envelope: Record<string, unknown>;
    audit: Array<Record<string, unknown>>;
  },
  failAuditInsert: false,
  sendMail: vi.fn(),
}));

vi.mock('../prisma', () => {
  function client(holder: typeof db.state): Record<string, unknown> {
    const envelope = holder.envelope;
    return {
      recipient: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = holder.recipients.get(where.id);
          return r ? { ...r, envelope: { ...envelope, createdBy: { name: 'Sender' }, org: {}, meta: null } } : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = holder.recipients.get(where.id) as Record<string, unknown>;
          Object.assign(r, data);
          return { ...r };
        },
      },
      envelope: {
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(envelope, data),
        findUnique: async () => ({
          ...envelope,
          recipients: [...holder.recipients.values()].map((r) => ({ ...(r as object) })),
          items: [], fields: [], meta: null,
        }),
      },
      auditEvent: {
        findFirst: async () => holder.audit.at(-1) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (db.failAuditInsert) throw new Error('audit insert failed');
          if (JSON.stringify(data).includes('\\u0000')) {
            throw new Error('unsupported Unicode escape sequence');
          }
          holder.audit.push(data);
          return data;
        },
      },
      $executeRaw: async () => 0,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const draft = {
          recipients: structuredClone(holder.recipients),
          envelope: { ...holder.envelope },
          audit: [...holder.audit],
        };
        const result = await fn(client(draft));
        Object.assign(holder, draft);
        return result;
      },
    };
  }
  const prisma = new Proxy({}, { get: (_t, key) => client(db.state)[key as string] });
  return { prisma };
});
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'k1' }),
  signHex: async () => 'sig',
}));
vi.mock('../webhooks/dispatch', () => ({ dispatchWebhooks: vi.fn() }));
vi.mock('../mail', () => ({ sendMail: db.sendMail }));
vi.mock('../env', () => ({
  getEnv: () => ({
    PUBLIC_URL: 'https://docs.example.edu',
    JWS_SIGNING_TOKEN_SECRET: 'test-signing-secret-test-signing-secret',
  }),
}));
vi.mock('../pdf/seal', () => ({ sealEnvelope: vi.fn() }));

import { declineEnvelope, loadSigningSession, reassignRecipient, recordConsent } from './lifecycle';
import { mintSigningToken } from '../signing/token';

const reassign = {
  envelopeId: 'env1',
  recipientId: 'r1',
  newEmail: 'mallory@example.com',
  newName: 'Mallory',
  ipAddress: '203.0.113.9',
  userAgent: 'vitest',
};

let originalToken: string;

beforeEach(async () => {
  db.failAuditInsert = false;
  db.sendMail.mockReset();
  db.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false, messageId: 'm1' });
  const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1' });
  originalToken = minted.token;
  const recipient: RecipientRow = {
    id: 'r1', envelopeId: 'env1', email: 'alice@example.com', name: 'Alice',
    recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 1,
    tokenJti: minted.jti, currentTokenExpiresAt: minted.expiresAt,
    consentGivenAt: new Date(), sendStatus: 'SENT',
  };
  db.state = {
    recipients: new Map([['r1', recipient]]),
    envelope: {
      id: 'env1', orgId: 'org1', title: 'Contract', message: null, status: 'IN_PROGRESS',
      routingMode: 'PARALLEL', expiresAt: null, createdById: 'u1',
    },
    audit: [],
  } satisfies State;
});

function row(): RecipientRow {
  return db.state.recipients.get('r1') as RecipientRow;
}

describe('reassignRecipient atomicity', () => {
  it('leaves the recipient and its original link untouched when the audit append fails', async () => {
    db.failAuditInsert = true;
    await expect(reassignRecipient(reassign)).rejects.toThrow(/audit insert failed/);

    expect(row().email).toBe('alice@example.com');
    expect(row().name).toBe('Alice');
    expect(row().consentGivenAt).not.toBeNull();
    expect(db.state.audit).toHaveLength(0);
    expect(db.sendMail).not.toHaveBeenCalled();

    db.failAuditInsert = false;
    const session = await loadSigningSession(originalToken);
    expect(session.ok).toBe(true);
    if (session.ok) expect(session.recipient.email).toBe('alice@example.com');
  });

  it('records the identity change and revokes the original link in the same commit', async () => {
    await reassignRecipient({ ...reassign, reason: 'out of office' });

    expect(row().email).toBe('mallory@example.com');
    const event = db.state.audit.find((e) => e.type === 'recipient.reassigned');
    expect(event?.data).toMatchObject({
      fromEmail: 'alice@example.com', toEmail: 'mallory@example.com', reason: 'out of office',
    });
    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('cannot be made to skip its audit event with a NUL in the reason', async () => {
    await reassignRecipient({ ...reassign, reason: 'bye\u0000' });

    const event = db.state.audit.find((e) => e.type === 'recipient.reassigned');
    expect(event?.data).toMatchObject({ reason: 'bye' });
    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('keeps the reassignment committed when only the invite email fails', async () => {
    db.sendMail.mockResolvedValue({ delivered: false, refusedByAllowlist: false });
    await reassignRecipient(reassign);

    expect(row().email).toBe('mallory@example.com');
    expect(row().sendStatus).toBe('FAILED');
    expect(db.state.audit.map((e) => e.type)).toEqual(['recipient.reassigned', 'email.failed']);
  });
});

describe('other recipient transitions commit with their audit event', () => {
  const ctx = { envelopeId: 'env1', recipientId: 'r1', ipAddress: '203.0.113.9', userAgent: 'vitest' };

  it('does not leave an unaudited decline behind', async () => {
    db.failAuditInsert = true;
    await expect(declineEnvelope({ ...ctx, reason: 'no' })).rejects.toThrow();
    expect(row().signingStatus).toBe('NOT_SIGNED');
    expect(db.state.envelope.status).toBe('IN_PROGRESS');

    db.failAuditInsert = false;
    await declineEnvelope({ ...ctx, reason: 'no' });
    expect(row().signingStatus).toBe('DECLINED');
    expect(db.state.envelope.status).toBe('DECLINED');
    expect(db.state.audit.map((e) => e.type)).toEqual(['recipient.declined']);
  });

  it('does not record consent without its audit event', async () => {
    row().consentGivenAt = null;
    db.failAuditInsert = true;
    await expect(recordConsent({ ...ctx, disclosureVersion: 'v1' })).rejects.toThrow();
    expect(row().consentGivenAt).toBeNull();
  });
});
