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
  sealed: Record<string, unknown> | null;
  attachments?: Map<string, Record<string, unknown>>;
}

const db = vi.hoisted(() => ({
  state: null as unknown as {
    recipients: Map<string, unknown>;
    fields: Array<Record<string, unknown>>;
    signatures: Array<Record<string, unknown>>;
    envelope: Record<string, unknown>;
    audit: Array<Record<string, unknown>>;
    sealed?: Record<string, unknown> | null;
    attachments?: Map<string, Record<string, unknown>>;
  },
  failAuditInsert: false,
  sendMail: vi.fn(),
  // Runs once when the next transaction opens, before it reads anything, so a
  // test can commit a competing request between another request's
  // pre-transaction checks and its transaction.
  onNextTransaction: null as null | (() => Promise<unknown>),
  // Runs once right after the next transaction commits, before the committing
  // request continues, so a test can land a competing request between two
  // steps of one request (e.g. a signature's commit and its completion).
  onNextCommit: null as null | (() => Promise<unknown>),
  // Runs once on the next user lookup: a sender-side request (a reminder)
  // reads the recipients first and looks up the sender before it pins a link.
  onNextUserLookup: null as null | (() => Promise<unknown>),
  // The envelope's audit-chain advisory lock: held by one transaction until
  // it ends; another taking it waits, then reads the chain as committed.
  chainLock: { owner: null as object | null, waiters: [] as Array<() => void> },
}));

vi.mock('../prisma', () => {
  type Holder = typeof db.state;
  // Equality plus the few Prisma filter operators lifecycle.ts uses.
  const matchesValue = (actual: unknown, cond: unknown): boolean => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const op = cond as { in?: unknown[]; notIn?: unknown[]; lte?: Date };
      if (op.in) return op.in.includes(actual);
      if (op.notIn) return !op.notIn.includes(actual);
      if (op.lte) return actual instanceof Date && actual.getTime() <= op.lte.getTime();
    }
    return actual === cond;
  };
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => matchesValue(row[k], v));
  const copyRecipients = (holder: Holder) =>
    [...holder.recipients.values()].map((r) => ({ ...(r as object) }));
  function client(holder: Holder, tx?: object): Record<string, unknown> {
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
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          holder.fields.find((f) => matches(f, where)) ?? null,
      },
      fieldAttachment: {
        findMany: async () => [],
        upsert: async ({ where, create, update }: {
          where: { fieldId: string }; create: Record<string, unknown>; update: Record<string, unknown>;
        }) => {
          holder.attachments ??= new Map();
          const existing = holder.attachments.get(where.fieldId);
          const next = existing ? { ...existing, ...update } : { ...create };
          holder.attachments.set(where.fieldId, next);
          return next;
        },
      },
      signature: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          holder.signatures.push(data);
          return data;
        },
        findMany: async () => holder.signatures.map((s) => ({ ...s })),
      },
      envelope: {
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(envelope, data),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          // `recipients: { some: {...} }` is a relation filter on this envelope's recipients.
          const { recipients: related, ...own } = where as { recipients?: { some: Record<string, unknown> } };
          if (!matches(envelope, own)) return { count: 0 };
          if (related && ![...holder.recipients.values()].some((r) => matches(r as Record<string, unknown>, related.some))) {
            return { count: 0 };
          }
          Object.assign(envelope, data);
          return { count: 1 };
        },
        findFirst: async () => ({ ...envelope, recipients: copyRecipients(holder), meta: null }),
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
      user: {
        findUnique: async () => {
          const competing = db.onNextUserLookup;
          db.onNextUserLookup = null;
          if (competing) await competing();
          return { name: 'Sender', email: 'sender@example.com' };
        },
      },
      organisation: { findUnique: async () => null },
      sealedDocument: { findUnique: async () => holder.sealed ?? null },
      $executeRaw: async (sql: TemplateStringsArray) => {
        if (!tx || !sql.join('').includes('pg_advisory_xact_lock')) return 0;
        const lock = db.chainLock;
        if (lock.owner === tx) return 0;
        while (lock.owner) await new Promise<void>((resolve) => lock.waiters.push(resolve));
        lock.owner = tx;
        // Appends always take the lock first, so this transaction has written
        // no events yet: read the chain as committed now, as Postgres would.
        holder.audit = [...db.state.audit];
        return 0;
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const competing = db.onNextTransaction;
        db.onNextTransaction = null;
        if (competing) await competing();
        const txId = {};
        const envelopeBefore = { ...holder.envelope };
        const draft = {
          recipients: structuredClone(holder.recipients),
          fields: structuredClone(holder.fields),
          signatures: [...holder.signatures],
          envelope: { ...holder.envelope },
          audit: [...holder.audit],
          sealed: holder.sealed,
          attachments: new Map(holder.attachments ?? []),
        };
        let result: unknown;
        try {
          result = await fn(client(draft, txId));
        } finally {
          const lock = db.chainLock;
          if (lock.owner === txId) {
            lock.owner = null;
            lock.waiters.splice(0).forEach((wake) => wake());
          }
        }
        // Write back the envelope row only if this transaction changed it, so
        // one that merely read it cannot undo another's committed update.
        const { envelope: draftEnvelope, ...rest } = draft;
        Object.assign(holder, rest);
        const changed = Object.keys({ ...envelopeBefore, ...draftEnvelope })
          .some((k) => (draftEnvelope as Record<string, unknown>)[k] !== (envelopeBefore as Record<string, unknown>)[k]);
        if (changed) holder.envelope = draftEnvelope;
        const afterCommit = db.onNextCommit;
        db.onNextCommit = null;
        if (afterCommit) await afterCommit();
        return result;
      },
    };
  }
  const prisma = new Proxy({}, { get: (_t, key) => client(db.state)[key as string] });
  return { prisma };
});
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'k1' }),
  signHexWithKey: async () => 'sig',
}));
vi.mock('../webhooks/dispatch', () => ({ dispatchWebhooks: vi.fn() }));
vi.mock('../mail', () => ({ sendMail: db.sendMail }));
vi.mock('../env', () => ({
  getEnv: () => ({
    PUBLIC_URL: 'https://docs.example.edu',
    JWS_SIGNING_TOKEN_SECRET: 'test-signing-secret-test-signing-secret',
  }),
}));
vi.mock('../pdf/seal', () => ({ buildSealedEnvelope: vi.fn(), persistSealedEnvelope: vi.fn() }));
// Seal failures are logged at error level by design; keep the test output clean.
vi.mock('../logger', () => {
  const quiet = (): Record<string, unknown> => ({ info() {}, warn() {}, error() {}, debug() {}, child: quiet });
  return { childLogger: quiet, getLogger: quiet };
});

import {
  completeRecipientSigning,
  declineEnvelope,
  expireEnvelope,
  loadSigningSession,
  mintFreshTokenForRecipient,
  reassignRecipient,
  rebindRecipient,
  recordConsent,
  recordRecipientOpened,
  removePendingRecipient,
  sendReminderToNextSigner,
  retryEnvelopeSealing,
  attachRecipientFile,
  voidEnvelope,
} from './lifecycle';
import { mintSigningToken } from '../signing/token';
import { buildSealedEnvelope, persistSealedEnvelope, type SealedBuild } from '../pdf/seal';
import { PdfComplexityError } from '../pdf/seal-limits';
import { PdfDecodeLimitError, getPdfDecodeLimits } from '../pdf/decode-limits';
import { PdfWorkerError } from '../pdf-worker/errors';
import { dispatchWebhooks } from '../webhooks/dispatch';
import { prepareEnvelopeEvent, recordEnvelopeEvent } from '../audit/envelope';

/**
 * Stand-ins for the two halves of sealing. The build snapshots the recipients
 * and the audit chain head as they are when it runs and, given `completion`,
 * precomputes envelope.completed after that head (as the real one does);
 * the persist stores a SealedDocument once, for a COMPLETED envelope only.
 */
async function fakeBuild(args?: Parameters<typeof buildSealedEnvelope>[0]): Promise<SealedBuild> {
  const recipients = [...db.state.recipients.values()].map((r) => {
    const row = r as RecipientRow & { signedAt?: Date | null };
    return {
      id: row.id, name: row.name, email: row.email, role: row.recipientRole,
      signingOrder: row.signingOrder, signingStatus: row.signingStatus,
      signedAt: row.signedAt ? row.signedAt.toISOString() : null,
    };
  });
  const head = db.state.audit.at(-1) as { seq: number; eventHash: string } | undefined;
  const completionEvent = args?.completion
    ? await prepareEnvelopeEvent({
        key: { keyId: 'k1' } as never,
        prior: head ? { seq: head.seq, eventHash: head.eventHash } : null,
        createdAt: args.completion.completedAt,
        event: { envelopeId: 'env1', type: 'envelope.completed', ...args.completion.actor },
      })
    : undefined;
  return {
    envelopeId: 'env1', orgId: 'org1', bytes: Buffer.from('%PDF-sealed'), sha256: 'f'.repeat(64),
    manifest: {}, manifestSignature: 'sig', chainHeadHash: completionEvent?.eventHash ?? head?.eventHash ?? '0'.repeat(64),
    signedByKeyId: 'k1', sourceDocumentCount: 1, recipients, completionEvent,
  };
}
async function fakePersist(): Promise<'sealed' | 'already_sealed' | 'not_completed'> {
  if (db.state.envelope.status !== 'COMPLETED') return 'not_completed';
  if (db.state.sealed) return 'already_sealed';
  db.state.sealed = { envelopeId: 'env1' };
  return 'sealed';
}

let reassign: {
  envelopeId: string; recipientId: string; jti: string; newEmail: string; newName: string;
  ipAddress: string; userAgent: string; reason?: string;
};

let originalToken: string;
let originalJti: string;

beforeEach(async () => {
  db.failAuditInsert = false;
  db.onNextTransaction = null;
  db.onNextCommit = null;
  db.onNextUserLookup = null;
  db.sendMail.mockReset();
  vi.mocked(buildSealedEnvelope).mockReset().mockImplementation(fakeBuild);
  vi.mocked(persistSealedEnvelope).mockReset().mockImplementation(fakePersist);
  vi.mocked(dispatchWebhooks).mockClear();
  db.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false, messageId: 'm1' });
  const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r1' });
  originalToken = minted.token;
  originalJti = minted.jti;
  reassign = {
    envelopeId: 'env1', recipientId: 'r1', jti: minted.jti,
    newEmail: 'mallory@example.com', newName: 'Mallory',
    ipAddress: '203.0.113.9', userAgent: 'vitest',
  };
  const recipient: RecipientRow = {
    id: 'r1', envelopeId: 'env1', email: 'alice@example.com', name: 'Alice',
    recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 1,
    tokenJti: minted.jti, currentTokenExpiresAt: minted.expiresAt,
    consentGivenAt: new Date(), sendStatus: 'SENT',
  };
  db.chainLock = { owner: null, waiters: [] };
  db.state = {
    recipients: new Map([['r1', recipient]]),
    envelope: {
      id: 'env1', orgId: 'org1', title: 'Contract', message: null, status: 'IN_PROGRESS',
      routingMode: 'PARALLEL', expiresAt: null, createdById: 'u1',
    },
    fields: [],
    signatures: [],
    audit: [],
    sealed: null,
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
  const ctx = () => ({
    envelopeId: 'env1', recipientId: 'r1', jti: originalJti, ipAddress: '203.0.113.9', userAgent: 'vitest',
  });

  it('does not leave an unaudited decline behind', async () => {
    db.failAuditInsert = true;
    await expect(declineEnvelope({ ...ctx(), reason: 'no' })).rejects.toThrow();
    expect(row().signingStatus).toBe('NOT_SIGNED');
    expect(db.state.envelope.status).toBe('IN_PROGRESS');

    db.failAuditInsert = false;
    await declineEnvelope({ ...ctx(), reason: 'no' });
    expect(row().signingStatus).toBe('DECLINED');
    expect(db.state.envelope.status).toBe('DECLINED');
    expect(db.state.audit.map((e) => e.type)).toEqual(['recipient.declined']);
  });

  it('does not record consent without its audit event', async () => {
    row().consentGivenAt = null;
    db.failAuditInsert = true;
    await expect(recordConsent({ ...ctx(), disclosureVersion: 'v1' })).rejects.toThrow();
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

describe('a superseded link can never write its jti back', () => {
  const adminCtx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
  const opened = (jti: string) => ({
    envelopeId: 'env1', recipientId: 'r1', jti, ipAddress: '198.51.100.7', userAgent: 'old-link',
  });
  const replaceWithBob = (withInvite: boolean) => ({
    recipientId: 'r1',
    from: { email: 'alice@example.com' },
    to: { email: 'bob@example.com', name: 'Bob' },
    event: { envelopeId: 'env1', type: 'envelope.corrected' as const, actorUserId: 'u1', data: {} },
    invite: withInvite
      ? { envelopeId: 'env1', orgId: 'org1', senderName: 'Sender', documentTitle: 'Contract' }
      : null,
  });
  const types = () => db.state.audit.map((e) => e.type);
  /** The token in the most recent invite email. */
  function mailedToken(): string {
    const mail = db.sendMail.mock.calls.at(-1)?.[0] as { text: string };
    return decodeURIComponent(/\/sign\/([^\s"<]+)/.exec(mail.text)![1]!);
  }

  it('refuses a page open on a link that was reassigned between its check and its write', async () => {
    const session = await loadSigningSession(originalToken);
    expect(session.ok).toBe(true);
    db.onNextTransaction = () => reassignRecipient(reassign);

    await expect(recordRecipientOpened(opened(originalJti))).resolves.toBe(false);

    const newToken = mailedToken();
    expect(row().email).toBe('mallory@example.com');
    expect(row().tokenJti).not.toBe(originalJti);
    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
    expect((await loadSigningSession(newToken)).ok).toBe(true);
    expect(types()).not.toContain('recipient.opened');
  });

  it('refuses a page open on a link the sender replaced meanwhile', async () => {
    db.onNextTransaction = () => rebindRecipient(replaceWithBob(true));

    await expect(recordRecipientOpened(opened(originalJti))).resolves.toBe(false);

    expect(row()).toMatchObject({ email: 'bob@example.com', readStatus: 'NOT_OPENED' });
    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
    expect((await loadSigningSession(mailedToken())).ok).toBe(true);
    expect(types()).not.toContain('recipient.opened');
  });

  it('does not let the old link view the row after a replacement that sent no invite', async () => {
    await rebindRecipient(replaceWithBob(false));

    expect(row()).toMatchObject({ email: 'bob@example.com', tokenJti: null });
    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('refuses a page open after a reminder re-pinned the link', async () => {
    await sendReminderToNextSigner({ ctx: adminCtx, envelopeId: 'env1' });
    const reminded = mailedToken();

    await expect(recordRecipientOpened(opened(originalJti))).resolves.toBe(false);

    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
    expect((await loadSigningSession(reminded)).ok).toBe(true);
  });

  it('records the open for the current link', async () => {
    await expect(recordRecipientOpened(opened(originalJti))).resolves.toBe(true);

    expect(row()).toMatchObject({ readStatus: 'OPENED', tokenJti: originalJti });
    expect(db.state.audit.find((e) => e.type === 'recipient.opened'))
      .toMatchObject({ actorEmail: 'alice@example.com' });
  });

  it('does not record consent for the new person from the old link', async () => {
    row().consentGivenAt = null;
    db.onNextTransaction = () => reassignRecipient(reassign);

    await expect(recordConsent({ ...opened(originalJti), disclosureVersion: 'v1' })).resolves.toBe(false);

    expect(row()).toMatchObject({ email: 'mallory@example.com', consentGivenAt: null });
    expect(types()).not.toContain('recipient.consent_given');
  });

  it('does not let the old link reassign the replacement person away', async () => {
    // The old link's session was checked before the sender replaced Alice;
    // reassignRecipient then reads the row as it is now (Bob's).
    expect((await loadSigningSession(originalToken)).ok).toBe(true);
    await rebindRecipient(replaceWithBob(true));

    await expect(reassignRecipient(reassign)).rejects.toThrow(/already signed or was changed/i);

    expect(row().email).toBe('bob@example.com');
    expect(types()).not.toContain('recipient.reassigned');
  });

  it('does not mail a reminder link to the person a recipient was replaced by meanwhile', async () => {
    // The reminder reads the row (Alice) before the replacement commits; its
    // pin has to notice the identity changed underneath it.
    db.onNextUserLookup = () => rebindRecipient(replaceWithBob(false));

    await expect(sendReminderToNextSigner({ ctx: adminCtx, envelopeId: 'env1' })).rejects.toThrow(/already signed or was changed/i);
    expect(db.sendMail).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ email: 'bob@example.com', tokenJti: null });
  });

  it('pins a fresh in-app link and burns the emailed one', async () => {
    const { token } = await mintFreshTokenForRecipient({ envelopeId: 'env1', recipientId: 'r1' });

    expect(await loadSigningSession(originalToken)).toEqual({ ok: false, reason: 'consumed' });
    expect((await loadSigningSession(token)).ok).toBe(true);
  });
});

describe('terminal transitions: exactly one of sign, decline, void, expiry, completion wins', () => {
  const adminCtx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
  const submit = () => ({
    envelopeId: 'env1', recipientId: 'r1', jti: originalJti,
    ipAddress: '203.0.113.9', userAgent: 'vitest', fieldValues: {}, typedSignature: 'Alice Signer',
  });
  const decline = (recipientId: string, jti: string) => ({
    envelopeId: 'env1', recipientId, jti, reason: 'no', ipAddress: '203.0.113.9', userAgent: 'vitest',
  });
  const types = () => db.state.audit.map((e) => e.type);
  const r2 = () => db.state.recipients.get('r2') as RecipientRow;

  beforeEach(() => {
    db.state.fields.push({
      id: 'f1', envelopeId: 'env1', recipientId: 'r1', type: 'SIGNATURE', required: true,
      value: null, defaultValue: null, meta: null,
    });
    db.state.recipients.set('r2', {
      id: 'r2', envelopeId: 'env1', email: 'carol@example.com', name: 'Carol',
      recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 2,
      tokenJti: 'carol-jti', currentTokenExpiresAt: null, consentGivenAt: new Date(), sendStatus: 'SENT',
    });
  });

  function expectNotCompleted() {
    expect(persistSealedEnvelope).not.toHaveBeenCalled();
    expect(types()).not.toContain('envelope.completed');
    expect(db.sendMail).not.toHaveBeenCalled();
  }

  it('decline then sign on the same link: the decline wins, the signature writes nothing', async () => {
    db.onNextTransaction = () => declineEnvelope(decline('r1', originalJti));

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer valid/i);

    expect(row().signingStatus).toBe('DECLINED');
    expect(db.state.envelope.status).toBe('DECLINED');
    expect(db.state.signatures).toHaveLength(0);
    expect(types()).toEqual(['recipient.declined']);
  });

  it('sign then decline on the same link: the signature wins, the decline writes nothing', async () => {
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(declineEnvelope(decline('r1', originalJti))).rejects.toThrow(/no longer valid/i);

    expect(row().signingStatus).toBe('SIGNED');
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(db.state.signatures).toHaveLength(1);
    expect(types()).not.toContain('recipient.declined');
  });

  it('refuses a decline from a superseded link', async () => {
    await expect(declineEnvelope(decline('r1', 'some-older-jti'))).rejects.toThrow(/no longer valid/i);

    expect(row().signingStatus).toBe('NOT_SIGNED');
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(types()).toEqual([]);
  });

  it("refuses a signature once another signer's decline closed the envelope", async () => {
    db.onNextTransaction = () => declineEnvelope(decline('r2', 'carol-jti'));

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer awaiting signature/i);

    expect(row().signingStatus).toBe('NOT_SIGNED');
    expect(db.state.envelope.status).toBe('DECLINED');
    expect(db.state.signatures).toHaveLength(0);
    expect(types()).toEqual(['recipient.declined']);
  });

  it("refuses another signer's decline once completion claimed the envelope", async () => {
    r2().signingStatus = 'SIGNED';
    r2().tokenJti = 'carol-jti';
    await completeRecipientSigning(submit());
    expect(db.state.envelope.status).toBe('COMPLETED');

    // Carol's row is SIGNED, so take a third, still-pending recipient.
    db.state.recipients.set('r3', { ...r2(), id: 'r3', signingStatus: 'NOT_SIGNED', tokenJti: 'dan-jti' });
    await expect(declineEnvelope(decline('r3', 'dan-jti'))).rejects.toThrow(/no longer awaiting signature/i);
    expect(db.state.envelope.status).toBe('COMPLETED');
  });

  it('completes and seals when nothing intervenes', async () => {
    r2().signingStatus = 'SIGNED';

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });

    expect(db.state.envelope.status).toBe('COMPLETED');
    expect(buildSealedEnvelope).toHaveBeenCalledTimes(1);
    expect(persistSealedEnvelope).toHaveBeenCalledTimes(1);
    expect(types().filter((t) => t === 'envelope.completed')).toHaveLength(1);
  });

  it('does not complete when another signer declined after the last signature committed', async () => {
    db.onNextCommit = () => declineEnvelope(decline('r2', 'carol-jti'));

    await completeRecipientSigning(submit());

    expect(row().signingStatus).toBe('SIGNED');
    expect(r2().signingStatus).toBe('DECLINED');
    expect(db.state.envelope.status).toBe('DECLINED');
    expectNotCompleted();
  });

  it('does not complete or seal when the sender voids as completion is claimed', async () => {
    r2().signingStatus = 'SIGNED';
    // After the signature commits, land the void just as the completion
    // transaction opens (after advanceOrComplete has read the envelope).
    db.onNextCommit = async () => {
      db.onNextTransaction = () => voidEnvelope({ ctx: adminCtx, envelopeId: 'env1', reason: 'withdrawn' });
    };

    await completeRecipientSigning(submit());

    expect(db.state.envelope.status).toBe('VOIDED');
    expectNotCompleted();
  });

  it('completes rather than expires when the deadline passes after the last signature committed', async () => {
    // Everyone signed in time; only the seal was outstanding, so expiry
    // (which needs a pending recipient) leaves the envelope to its claim.
    r2().signingStatus = 'SIGNED';
    db.onNextCommit = async () => {
      db.onNextTransaction = async () => {
        db.state.envelope.expiresAt = new Date(Date.now() - 1000);
        await expireEnvelope('env1');
      };
    };

    await completeRecipientSigning(submit());

    expect(db.state.envelope.status).toBe('COMPLETED');
    expect(types()).not.toContain('envelope.expired');
  });

  it('does not complete or seal once the envelope expired with a recipient still pending', async () => {
    db.state.envelope.expiresAt = new Date(Date.now() - 1000);
    await expireEnvelope('env1');

    await expect(completeRecipientSigning(submit())).rejects.toThrow(/no longer awaiting signature/i);

    expect(db.state.envelope.status).toBe('EXPIRED');
    expectNotCompleted();
  });

  it('refuses to void an envelope that completed meanwhile', async () => {
    r2().signingStatus = 'SIGNED';
    db.onNextTransaction = () => completeRecipientSigning(submit());

    await expect(voidEnvelope({ ctx: adminCtx, envelopeId: 'env1', reason: 'late' }))
      .rejects.toThrow(/cannot be voided/i);

    expect(db.state.envelope.status).toBe('COMPLETED');
    expect(types()).not.toContain('envelope.voided_by_sender');
  });
});

describe('completion: build the seal, then claim, then persist, then notify', () => {
  const adminCtx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
  const submit = () => ({
    envelopeId: 'env1', recipientId: 'r1', jti: originalJti,
    ipAddress: '203.0.113.9', userAgent: 'vitest', fieldValues: {}, typedSignature: 'Alice Signer',
  });
  const types = () => db.state.audit.map((e) => e.type);
  const tooComplex = () => new PdfComplexityError('pages', 'PDF has more than 2000 pages');

  beforeEach(() => {
    db.state.fields.push({
      id: 'f1', envelopeId: 'env1', recipientId: 'r1', type: 'SIGNATURE', required: true,
      value: null, defaultValue: null, meta: null,
    });
  });

  it('builds while the envelope still awaits signatures, before anything is claimed', async () => {
    const statusAtBuild: unknown[] = [];
    vi.mocked(buildSealedEnvelope).mockImplementation(async (args) => {
      statusAtBuild.push(db.state.envelope.status);
      return fakeBuild(args);
    });

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });

    expect(statusAtBuild).toEqual(['IN_PROGRESS']);
    expect(persistSealedEnvelope).toHaveBeenCalledTimes(1);
    expect(db.state.sealed).toBeTruthy();
    expect(types()).toEqual(['recipient.signed', 'envelope.completed']);
    // The signer's completion mail (the fake has no sender), only once the seal is stored.
    expect(db.sendMail).toHaveBeenCalledTimes(1);
  });

  it('stores exactly the envelope.completed the seal was built with, at its completion time', async () => {
    await completeRecipientSigning(submit());

    const built = await vi.mocked(buildSealedEnvelope).mock.results[0]!.value as SealedBuild;
    const sealed = built.completionEvent!;
    const stored = db.state.audit.at(-1)!;
    expect(stored).toMatchObject({
      type: 'envelope.completed', seq: sealed.seq, prevHash: sealed.prevHash,
      eventHash: sealed.eventHash, signature: sealed.signature, createdAt: sealed.createdAt,
      ipAddress: '203.0.113.9', userAgent: 'vitest',
    });
    expect(db.state.envelope.completedAt).toEqual(sealed.createdAt);
    expect(vi.mocked(persistSealedEnvelope).mock.calls[0]![0].chainHeadHash).toBe(stored.eventHash);
  });

  it('rebuilds when an event is appended between the build and the claim, so none is missing from the seal', async () => {
    vi.mocked(buildSealedEnvelope).mockImplementationOnce(async (args) => {
      const build = await fakeBuild(args);
      // e.g. a concurrent seal_failed, or a comment, lands after the build read the chain.
      await recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' });
      return build;
    });

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(2);
    expect(types()).toEqual(['recipient.signed', 'comment.added', 'envelope.completed']);
    const comment = db.state.audit[1]!;
    const persisted = vi.mocked(persistSealedEnvelope).mock.calls[0]![0];
    expect(persisted.completionEvent!.prevHash).toBe(comment.eventHash);
    expect(db.state.audit.at(-1)!.eventHash).toBe(persisted.completionEvent!.eventHash);
  });

  it('completes despite events appended throughout: the last attempt builds with the audit chain locked', async () => {
    const appends: Promise<void>[] = [];
    vi.mocked(buildSealedEnvelope).mockImplementation(async (args) => {
      const build = await fakeBuild(args);
      // A member keeps appending (audit.json views, comments) during every build.
      appends.push(recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return build;
    });

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });
    await Promise.all(appends);

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(3);
    // The first two builds went stale; the third's append waited for the claim.
    expect(types()).toEqual([
      'recipient.signed', 'comment.added', 'comment.added', 'envelope.completed', 'comment.added',
    ]);
    const persisted = vi.mocked(persistSealedEnvelope).mock.calls[0]![0];
    expect(persisted.completionEvent!.prevHash).toBe(db.state.audit[2]!.eventHash);
    expect(db.state.audit[3]!.eventHash).toBe(persisted.completionEvent!.eventHash);
    expect(db.state.envelope.status).toBe('COMPLETED');
    // Timestamped once the chain lock was held, i.e. after the build began.
    expect(db.state.envelope.completedAt).toEqual(persisted.completionEvent!.createdAt);
    const lockedBuildArgs = vi.mocked(buildSealedEnvelope).mock.calls[2]![0];
    expect(lockedBuildArgs.completion!.completedAt).toEqual(persisted.completionEvent!.createdAt);
  });

  it('gives up after a bounded number of rebuilds when the recipients keep changing', async () => {
    vi.mocked(buildSealedEnvelope).mockImplementation(async (args) => {
      const build = await fakeBuild(args);
      // The manifest never matches the recipients the claim reads.
      return { ...build, recipients: [...build.recipients, { ...build.recipients[0]!, id: 'gone' }] };
    });

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(3);
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(types()).not.toContain('envelope.completed');
    expect(db.state.audit.at(-1)).toMatchObject({ type: 'envelope.seal_failed', data: { stage: 'claim', reason: 'error' } });
  });

  it('records a build failure inside the locked attempt as a build failure', async () => {
    vi.mocked(buildSealedEnvelope)
      .mockImplementationOnce(async (args) => {
        const build = await fakeBuild(args);
        await recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' });
        return build;
      })
      .mockImplementationOnce(async (args) => {
        const build = await fakeBuild(args);
        await recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' });
        return build;
      })
      .mockRejectedValueOnce(tooComplex());

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(db.state.envelope.completedAt ?? null).toBeNull();
    expect(db.state.audit.at(-1)).toMatchObject({ type: 'envelope.seal_failed', data: { stage: 'build' } });
  });

  it('keeps the envelope open and the signature committed when the seal cannot be built', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValue(tooComplex());

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(row().signingStatus).toBe('SIGNED');
    expect(db.state.signatures).toHaveLength(1);
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(persistSealedEnvelope).not.toHaveBeenCalled();
    expect(types()).not.toContain('envelope.completed');
    expect(db.sendMail).not.toHaveBeenCalled();
    const failure = db.state.audit.find((e) => e.type === 'envelope.seal_failed');
    expect(failure?.data).toMatchObject({ stage: 'build', reason: 'pdf_too_complex', limit: 'pages' });
  });

  it('does not record a raw internal error message in the audit chain', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValue(new Error('ENOENT: /data/uploads/org1/abc.pdf'));

    await completeRecipientSigning(submit());

    const failure = db.state.audit.find((e) => e.type === 'envelope.seal_failed');
    expect(failure?.data).toEqual({ stage: 'build', reason: 'error' });
  });

  it('a busy PDF worker leaves the envelope retryable', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValue(new PdfWorkerError('busy'));

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(row().signingStatus).toBe('SIGNED');
    expect(db.state.signatures).toHaveLength(1);
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(persistSealedEnvelope).not.toHaveBeenCalled();
    expect(db.state.audit.at(-1)).toMatchObject({ type: 'envelope.seal_failed', data: { stage: 'build' } });
    expect(db.state.audit.at(-1)!.data).toEqual({ stage: 'build', reason: 'worker_busy' });
  });

  it('records a busy or timed-out worker inside the locked attempt as a build failure', async () => {
    const stale = async (args?: Parameters<typeof buildSealedEnvelope>[0]) => {
      const build = await fakeBuild(args);
      await recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' });
      return build;
    };
    vi.mocked(buildSealedEnvelope)
      .mockImplementationOnce(stale)
      .mockImplementationOnce(stale)
      .mockRejectedValueOnce(new PdfWorkerError('busy'));

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(3);
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(db.state.envelope.completedAt ?? null).toBeNull();
    expect(types()).not.toContain('envelope.completed');
    expect(db.state.audit.at(-1)!.data).toEqual({ stage: 'build', reason: 'worker_busy' });
  });

  it('gives the locked build worker limits that run out before its transaction does', async () => {
    const stale = async (args?: Parameters<typeof buildSealedEnvelope>[0]) => {
      const build = await fakeBuild(args);
      await recordEnvelopeEvent({ envelopeId: 'env1', type: 'comment.added', actorUserId: 'u1' });
      return build;
    };
    vi.mocked(buildSealedEnvelope).mockImplementationOnce(stale).mockImplementationOnce(stale);

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });

    const calls = vi.mocked(buildSealedEnvelope).mock.calls.map((c) => c[0]);
    // Unlocked builds use the configured defaults.
    expect(calls[0]!.worker).toBeUndefined();
    expect(calls[1]!.worker).toBeUndefined();
    // The locked one must fail as a build failure before the 60 s transaction expires.
    const { timeoutMs, queueMs } = calls[2]!.worker!;
    expect(timeoutMs! + queueMs!).toBeLessThanOrEqual(50_000);
  });

  it('records fixed text for a limit, never the error message (which may come from the worker)', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValue(
      new PdfComplexityError('pages', 'PDF has more than 9 pages <script>forged by the child</script>'),
    );

    await completeRecipientSigning(submit());

    const failure = db.state.audit.find((e) => e.type === 'envelope.seal_failed');
    expect(failure?.data).toEqual({
      stage: 'build', reason: 'pdf_too_complex', limit: 'pages',
      message: 'PDF has more than 2000 pages',
    });
  });

  it('records fixed text for a decode limit', async () => {
    // As revived from a worker: limitBytes and message are the child's.
    const err = new PdfDecodeLimitError('stream', 64);
    err.message = 'forged by the child';
    vi.mocked(buildSealedEnvelope).mockRejectedValue(err);

    await completeRecipientSigning(submit());

    const failure = db.state.audit.find((e) => e.type === 'envelope.seal_failed');
    expect(failure?.data).toEqual({
      stage: 'build', reason: 'pdf_decode_limit', limit: 'stream',
      message: `PDF stream decodes past the ${getPdfDecodeLimits().maxStreamBytes}-byte per-stream limit`,
    });
  });

  it('discards the build when the claim loses', async () => {
    db.onNextCommit = async () => {
      db.onNextTransaction = () => voidEnvelope({ ctx: adminCtx, envelopeId: 'env1', reason: 'withdrawn' });
    };

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'IN_PROGRESS' });

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(1);
    expect(persistSealedEnvelope).not.toHaveBeenCalled();
    expect(db.state.envelope.status).toBe('VOIDED');
    expect(types()).not.toContain('envelope.completed');
  });

  it('rebuilds when a recipient was added between the build and the claim', async () => {
    vi.mocked(buildSealedEnvelope).mockImplementationOnce(async (args) => {
      const build = await fakeBuild(args);
      // A sender correction adds a CC after the build read the recipients.
      db.state.recipients.set('cc1', {
        id: 'cc1', envelopeId: 'env1', email: 'cc@example.com', name: 'Cee', recipientRole: 'CC',
        signingStatus: 'NOT_SIGNED', signingOrder: 9, tokenJti: null, currentTokenExpiresAt: null,
        consentGivenAt: null, sendStatus: 'NOT_SENT',
      });
      return build;
    });

    await expect(completeRecipientSigning(submit())).resolves.toEqual({ envelopeStatus: 'COMPLETED' });

    expect(buildSealedEnvelope).toHaveBeenCalledTimes(2);
    const persisted = vi.mocked(persistSealedEnvelope).mock.calls[0]![0];
    expect(persisted.recipients.map((r) => r.id).sort()).toEqual(['cc1', 'r1']);
    expect(types().filter((t) => t === 'envelope.completed')).toHaveLength(1);
  });

  it('dispatches webhooks in audit-chain order when storing the seal fails', async () => {
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full'));

    await completeRecipientSigning(submit());

    const dispatched = vi.mocked(dispatchWebhooks).mock.calls.map((c) => c[0].type);
    const chain = types();
    expect(chain.slice(-2)).toEqual(['envelope.completed', 'envelope.seal_failed']);
    expect(dispatched).toEqual(chain);
  });

  it('dispatches the envelope.seal_failed webhook after the events before it when a retry fails', async () => {
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full'));
    await completeRecipientSigning(submit());
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full again'));

    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).rejects.toThrow(/could not be sealed/i);

    expect(vi.mocked(dispatchWebhooks).mock.calls.map((c) => c[0].type)).toEqual(types());
  });

  it('dispatches the envelope.completed webhook only after the seal is stored', async () => {
    const webhooksAtPersist: string[] = [];
    vi.mocked(persistSealedEnvelope).mockImplementation(async () => {
      webhooksAtPersist.push(...vi.mocked(dispatchWebhooks).mock.calls.map((c) => c[0].type));
      return fakePersist();
    });

    await completeRecipientSigning(submit());

    expect(webhooksAtPersist).not.toContain('envelope.completed');
    expect(vi.mocked(dispatchWebhooks).mock.calls.map((c) => c[0].type)).toContain('envelope.completed');
  });

  it('stays COMPLETED without mail when storing the seal fails, and a retry seals it once', async () => {
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full'));

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'COMPLETED', sealFailed: true });

    expect(db.state.envelope.status).toBe('COMPLETED');
    expect(db.state.sealed).toBeFalsy();
    expect(db.sendMail).not.toHaveBeenCalled();
    expect(db.state.audit.find((e) => e.type === 'envelope.seal_failed')?.data)
      .toEqual({ stage: 'persist', reason: 'error' });

    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('sealed');
    expect(db.state.sealed).toBeTruthy();
    expect(db.sendMail).toHaveBeenCalledTimes(1);

    // Once sealed, a second retry (or one racing the first) changes nothing.
    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('already_sealed');
    expect(db.sendMail).toHaveBeenCalledTimes(1);
  });

  it('sends no completion mail from an attempt that lost the race to store the seal', async () => {
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full'));
    await completeRecipientSigning(submit());
    vi.mocked(persistSealedEnvelope).mockResolvedValueOnce('already_sealed');

    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('already_sealed');
    expect(db.sendMail).not.toHaveBeenCalled();
  });

  it('completes an envelope whose seal failed to build once a retry can build it', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValueOnce(tooComplex());
    await completeRecipientSigning(submit());
    expect(db.state.envelope.status).toBe('IN_PROGRESS');

    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('sealed');

    expect(db.state.envelope.status).toBe('COMPLETED');
    expect(db.state.sealed).toBeTruthy();
    expect(types().filter((t) => t === 'envelope.completed')).toHaveLength(1);
  });

  it('reports a retry whose build fails again, leaving the envelope as it was', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValue(tooComplex());
    await completeRecipientSigning(submit());

    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' }))
      .rejects.toThrow(/could not be sealed.*more than 2000 pages/i);
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(types().filter((t) => t === 'envelope.seal_failed')).toHaveLength(2);
  });

  it('refuses a retry from a sender who does not own the envelope', async () => {
    vi.mocked(persistSealedEnvelope).mockRejectedValueOnce(new Error('disk full'));
    await completeRecipientSigning(submit());

    await expect(retryEnvelopeSealing({
      ctx: { userId: 'someone-else', orgId: 'org1', role: 'SENDER' }, envelopeId: 'env1',
    })).rejects.toThrow();
    expect(db.state.sealed).toBeFalsy();
  });

  it('refuses a retry while a recipient is still pending', async () => {
    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' }))
      .rejects.toThrow(/not waiting to be sealed/i);
    expect(buildSealedEnvelope).not.toHaveBeenCalled();
  });
});

describe('a recipient attachment is recorded only for the link that is still current', () => {
  const staged = () => ({
    relativePath: 'org1/abc.pdf', sizeBytes: 3, sha256: 'ab'.repeat(32), mimeType: 'application/pdf',
    filename: 'proof.pdf', commit: vi.fn(async () => undefined), discard: vi.fn(async () => undefined),
  });
  const attach = (file: ReturnType<typeof staged>, jti = originalJti) => attachRecipientFile({
    envelopeId: 'env1', recipientId: 'r1', jti, fieldId: 'fa', file,
  });
  const attachments = () => db.state.attachments ?? new Map();

  beforeEach(() => {
    db.state.fields.push({
      id: 'fa', envelopeId: 'env1', recipientId: 'r1', type: 'ATTACHMENT', required: false,
      value: null, defaultValue: null, meta: null,
    });
    // A second pending signer keeps the envelope open after r1 signs.
    db.state.recipients.set('r2', {
      id: 'r2', envelopeId: 'env1', email: 'carol@example.com', name: 'Carol',
      recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 2,
      tokenJti: 'carol-jti', currentTokenExpiresAt: null, consentGivenAt: new Date(), sendStatus: 'SENT',
    });
  });

  it('records the attachment and moves the file into place for the current link', async () => {
    const file = staged();

    await expect(attach(file)).resolves.toBe(true);

    expect(file.commit).toHaveBeenCalledTimes(1);
    expect(attachments().get('fa')).toMatchObject({ recipientId: 'r1', storagePath: 'org1/abc.pdf', filename: 'proof.pdf' });
  });

  it('refuses an upload that finishes after the link was reassigned', async () => {
    const file = staged();
    db.onNextTransaction = () => reassignRecipient(reassign);

    await expect(attach(file)).resolves.toBe(false);

    expect(file.commit).not.toHaveBeenCalled();
    expect(attachments().size).toBe(0);
  });

  it('refuses an upload from a superseded link', async () => {
    const file = staged();
    await expect(attach(file, 'older-jti')).resolves.toBe(false);
    expect(attachments().size).toBe(0);
  });

  it('refuses an upload that finishes after the recipient signed', async () => {
    const file = staged();
    db.onNextTransaction = () => completeRecipientSigning({
      envelopeId: 'env1', recipientId: 'r1', jti: originalJti, ipAddress: '203.0.113.9', userAgent: 'vitest',
      fieldValues: {}, typedSignature: 'Alice',
    });

    await expect(attach(file)).resolves.toBe(false);

    expect(row().signingStatus).toBe('SIGNED');
    expect(attachments().size).toBe(0);
  });

  it('refuses an upload once another signer declined the envelope', async () => {
    const file = staged();
    db.onNextTransaction = () => declineEnvelope({
      envelopeId: 'env1', recipientId: 'r2', jti: 'carol-jti', reason: 'no', ipAddress: '203.0.113.9', userAgent: 'vitest',
    });

    await expect(attach(file)).resolves.toBe(false);

    expect(attachments().size).toBe(0);
  });

  it('refuses a field that is not this recipient\'s attachment field', async () => {
    const file = staged();
    await expect(attachRecipientFile({
      envelopeId: 'env1', recipientId: 'r1', jti: originalJti, fieldId: 'f-other', file,
    })).resolves.toBe(false);
    expect(file.commit).not.toHaveBeenCalled();
  });
});

describe('a replacement recipient does not inherit the previous holder\'s access-code lockout', () => {
  const lockedOut = () => Object.assign(row() as unknown as Record<string, unknown>, {
    accessCodeFailedAttempts: 4,
    accessCodeLockedUntil: new Date(Date.now() + 60 * 60_000),
    accessCodeLockouts: 3,
  });
  const lockout = () => {
    const r = row() as unknown as Record<string, unknown>;
    return {
      accessCodeFailedAttempts: r.accessCodeFailedAttempts,
      accessCodeLockedUntil: r.accessCodeLockedUntil,
      accessCodeLockouts: r.accessCodeLockouts,
    };
  };
  const cleared = { accessCodeFailedAttempts: 0, accessCodeLockedUntil: null, accessCodeLockouts: 0 };

  it('clears the lockout when the sender replaces the recipient', async () => {
    lockedOut();
    await rebindRecipient({
      recipientId: 'r1',
      from: { email: 'alice@example.com' },
      to: { email: 'bob@example.com', name: 'Bob' },
      event: { envelopeId: 'env1', type: 'envelope.corrected', actorUserId: 'u1', data: {} },
      invite: null,
    });
    expect(lockout()).toEqual(cleared);
  });

  it('clears the lockout when the recipient reassigns to someone else', async () => {
    lockedOut();
    await reassignRecipient(reassign);
    expect(row().email).toBe('mallory@example.com');
    expect(lockout()).toEqual(cleared);
  });

  it('keeps the lockout when the rebind loses its race', async () => {
    lockedOut();
    await expect(rebindRecipient({
      recipientId: 'r1',
      from: { email: 'someone-else@example.com' },
      to: { email: 'bob@example.com', name: 'Bob' },
      event: { envelopeId: 'env1', type: 'envelope.corrected', actorUserId: 'u1', data: {} },
      invite: null,
    })).rejects.toThrow(/already signed or was changed/i);
    expect(lockout()).toMatchObject({ accessCodeFailedAttempts: 4, accessCodeLockouts: 3 });
  });
});

describe('a fully signed envelope whose seal failed is never stranded', () => {
  const adminCtx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };
  const submit = () => ({
    envelopeId: 'env1', recipientId: 'r1', jti: originalJti,
    ipAddress: '203.0.113.9', userAgent: 'vitest', fieldValues: {}, typedSignature: 'Alice Signer',
  });
  const types = () => db.state.audit.map((e) => e.type);

  it('does not expire it at the deadline, so a retry can still complete it', async () => {
    vi.mocked(buildSealedEnvelope).mockRejectedValueOnce(new PdfComplexityError('pages', 'PDF has more than 2000 pages'));
    await completeRecipientSigning(submit());
    expect(db.state.envelope.status).toBe('IN_PROGRESS');

    db.state.envelope.expiresAt = new Date(Date.now() - 1000);
    await expireEnvelope('env1');

    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(types()).not.toContain('envelope.expired');
    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('sealed');
    expect(db.state.envelope.status).toBe('COMPLETED');
  });

  it('still expires an envelope with a pending signer', async () => {
    db.state.envelope.expiresAt = new Date(Date.now() - 1000);
    await expireEnvelope('env1');
    expect(db.state.envelope.status).toBe('EXPIRED');
    expect(types()).toEqual(['envelope.expired']);
  });

  it('records seal_failed (stage claim) instead of throwing when the claim itself fails', async () => {
    // The transaction after the signature commit is the completion claim.
    db.onNextCommit = async () => {
      db.onNextTransaction = async () => { throw new Error('Transaction already closed: timeout'); };
    };

    await expect(completeRecipientSigning(submit()))
      .resolves.toEqual({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });

    expect(row().signingStatus).toBe('SIGNED');
    expect(db.state.envelope.status).toBe('IN_PROGRESS');
    expect(db.state.audit.at(-1)).toMatchObject({ type: 'envelope.seal_failed', data: { stage: 'claim', reason: 'error' } });
    await expect(retryEnvelopeSealing({ ctx: adminCtx, envelopeId: 'env1' })).resolves.toBe('sealed');
  });
});
