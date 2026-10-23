import { beforeEach, describe, expect, it, vi } from 'vitest';

interface RecipientRow {
  id: string; envelopeId: string; email: string; name: string;
  recipientRole: string; signingStatus: string; signingOrder: number;
  tokenJti: string | null; currentTokenExpiresAt: Date | null;
  consentGivenAt: Date | null; sendStatus: string;
}
interface FieldRow {
  id: string; envelopeId: string; recipientId: string; type: string; required: boolean;
  value: string | null; defaultValue: string | null; meta: unknown;
}
interface State {
  recipients: Map<string, RecipientRow>;
  fields: FieldRow[];
  signatures: Array<Record<string, unknown>>;
  envelope: Record<string, unknown>;
  audit: Array<Record<string, unknown>>;
}

const db = vi.hoisted(() => ({
  state: null as unknown as {
    recipients: Map<string, unknown>;
    fields: Array<Record<string, unknown>>;
    signatures: Array<Record<string, unknown>>;
    envelope: Record<string, unknown>;
    audit: Array<Record<string, unknown>>;
  },
  failAuditInsert: false,
  sendMail: vi.fn(),
  // Runs once when the next transaction opens, before it reads anything, so a
  // test can commit a competing request between another request's
  // pre-transaction checks and its transaction.
  onNextTransaction: null as null | (() => Promise<unknown>),
}));

vi.mock('../prisma', () => {
  type Holder = typeof db.state;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  const copyRecipients = (holder: Holder) =>
    [...holder.recipients.values()].map((r) => ({ ...(r as object) }));
  function client(holder: Holder): Record<string, unknown> {
    const envelope = holder.envelope;
    return {
      recipient: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = holder.recipients.get(where.id);
          return r
            ? {
                ...r,
                envelope: {
                  ...envelope, createdBy: { name: 'Sender' }, org: {}, meta: null,
                  recipients: copyRecipients(holder),
                  fields: holder.fields.map((f) => ({ ...f })),
                  items: [],
                },
              }
            : null;
        },
        findMany: async () => copyRecipients(holder),
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = holder.recipients.get(where.id) as Record<string, unknown> | undefined;
          if (!r) throw new Error('Record to update not found.');
          Object.assign(r, data);
          return { ...r };
        },
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          let count = 0;
          for (const r of holder.recipients.values()) {
            if (matches(r as Record<string, unknown>, where)) {
              Object.assign(r as object, data);
              count++;
            }
          }
          return { count };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const r = holder.recipients.get(where.id);
          if (!r) throw new Error('Record to delete does not exist.');
          holder.recipients.delete(where.id);
          return r;
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, r] of [...holder.recipients]) {
            if (matches(r as Record<string, unknown>, where)) {
              holder.recipients.delete(id);
              count++;
            }
          }
          return { count };
        },
      },
      field: {
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const f = holder.fields.find((x) => x.id === where.id);
          if (!f) throw new Error('Record to update not found.');
          return Object.assign(f, data);
        },
        deleteMany: async ({ where }: { where: { recipientId: string } }) => {
          const before = holder.fields.length;
          holder.fields = holder.fields.filter((f) => f.recipientId !== where.recipientId);
          return { count: before - holder.fields.length };
        },
      },
      fieldAttachment: { findMany: async () => [] },
      signature: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          holder.signatures.push(data);
          return data;
        },
      },
      envelope: {
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(envelope, data),
        findUnique: async () => ({
          ...envelope,
          recipients: copyRecipients(holder),
          items: [], fields: holder.fields.map((f) => ({ ...f })), meta: null,
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
        const competing = db.onNextTransaction;
        db.onNextTransaction = null;
        if (competing) await competing();
        const draft = {
          recipients: structuredClone(holder.recipients),
          fields: structuredClone(holder.fields),
          signatures: [...holder.signatures],
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

import {
  completeRecipientSigning,
  declineEnvelope,
  loadSigningSession,
  reassignRecipient,
  rebindRecipient,
  recordConsent,
  removePendingRecipient,
} from './lifecycle';
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
let originalJti: string;

beforeEach(async () => {
  db.failAuditInsert = false;
  db.onNextTransaction = null;
  db.sendMail.mockReset();
  db.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false, messageId: 'm1' });
  const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1' });
  originalToken = minted.token;
  originalJti = minted.jti;
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
    fields: [],
    signatures: [],
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

describe('concurrent changes to one pending recipient', () => {
  const submit = () => ({
    envelopeId: 'env1',
    recipientId: 'r1',
    jti: originalJti,
    ipAddress: '203.0.113.9',
    userAgent: 'vitest',
    fieldValues: {},
    typedSignature: 'Alice Signer',
  });
  const replaceWithBob = () => ({
    recipientId: 'r1',
    from: { email: 'alice@example.com' },
    to: { email: 'bob@example.com', name: 'Bob' },
    data: { lastReminderSentAt: null },
    event: {
      envelopeId: 'env1',
      type: 'envelope.corrected' as const,
      actorUserId: 'u1',
      data: { operation: 'replaceRecipient' },
    },
    invite: null,
  });
  const removal = () => ({
    envelopeId: 'env1',
    recipientId: 'r1',
    event: {
      envelopeId: 'env1',
      type: 'envelope.corrected' as const,
      actorUserId: 'u1',
      data: { operation: 'removeRecipient' },
    },
  });

  beforeEach(() => {
    db.state.fields.push({
      id: 'f1', envelopeId: 'env1', recipientId: 'r1', type: 'SIGNATURE', required: true,
      value: null, defaultValue: null, meta: null,
    });
    // A second pending signer keeps the envelope open after r1 signs.
    db.state.recipients.set('r2', {
      id: 'r2', envelopeId: 'env1', email: 'carol@example.com', name: 'Carol',
      recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 2,
      tokenJti: null, currentTokenExpiresAt: null, consentGivenAt: null, sendStatus: 'SENT',
    });
  });

  const types = () => db.state.audit.map((e) => e.type);

  it('refuses a reassignment that lands after the recipient signed', async () => {
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(reassignRecipient(reassign)).rejects.toThrow(/already signed or was changed/i);

    expect(row()).toMatchObject({ email: 'alice@example.com', name: 'Alice', signingStatus: 'SIGNED' });
    expect(db.state.signatures).toHaveLength(1);
    expect(types()).not.toContain('recipient.reassigned');
    expect(db.sendMail).not.toHaveBeenCalled();
  });

  it('refuses a signature submitted on a link that was reassigned meanwhile', async () => {
    db.onNextTransaction = () => reassignRecipient(reassign);

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer valid/i);

    expect(row()).toMatchObject({ email: 'mallory@example.com', signingStatus: 'NOT_SIGNED' });
    expect(db.state.signatures).toHaveLength(0);
    expect(db.state.fields[0]!.value).toBeNull();
    expect(types()).not.toContain('recipient.signed');
    expect(types()).not.toContain('recipient.field_filled');
  });

  it('records one signature when the same submission arrives twice', async () => {
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer valid/i);

    expect(db.state.signatures).toHaveLength(1);
    expect(types().filter((t) => t === 'recipient.signed')).toHaveLength(1);
  });

  it('refuses a correction that replaces a recipient who just signed', async () => {
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(rebindRecipient(replaceWithBob())).rejects.toThrow(/already signed or was changed/i);

    expect(row()).toMatchObject({ email: 'alice@example.com', signingStatus: 'SIGNED' });
    expect(types()).not.toContain('envelope.corrected');
  });

  it('refuses a correction based on an identity that changed meanwhile', async () => {
    db.onNextTransaction = () => reassignRecipient(reassign);

    await expect(rebindRecipient(replaceWithBob())).rejects.toThrow(/already signed or was changed/i);

    expect(row().email).toBe('mallory@example.com');
    expect(types()).not.toContain('envelope.corrected');
  });

  it('refuses to remove a recipient who just signed and keeps their fields', async () => {
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(removePendingRecipient(removal())).rejects.toThrow(/signed or changed/i);

    expect(row()).toMatchObject({ signingStatus: 'SIGNED' });
    expect(db.state.fields.map((f) => f.id)).toEqual(['f1']);
    expect(types()).not.toContain('envelope.corrected');
  });

  it('removes a still-pending recipient with its fields', async () => {
    await removePendingRecipient(removal());

    expect(db.state.recipients.has('r1')).toBe(false);
    expect(db.state.fields).toHaveLength(0);
    expect(types()).toEqual(['envelope.corrected']);
  });

  it('refuses a signature once the recipient was removed', async () => {
    db.onNextTransaction = () => removePendingRecipient(removal());

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer valid/i);

    expect(db.state.signatures).toHaveLength(0);
    expect(types()).toEqual(['envelope.corrected']);
  });
});
