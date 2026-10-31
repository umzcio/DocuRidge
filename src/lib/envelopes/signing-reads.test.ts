import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What signing-link requests read. Stored field values (other recipients'
 * drawings among them) are the bulk of what an envelope holds, so a link is
 * checked on the envelope's status and recipient rows alone, a live link
 * loads only its own recipient's fields, and a submission reads other
 * recipients' values only at the ids its conditions and formulas name.
 */

const db = vi.hoisted(() => ({
  envelopeFindUnique: vi.fn(),
  recipientFindUnique: vi.fn(),
  recipientFindMany: vi.fn(),
  fieldFindMany: vi.fn(),
  fieldUpdate: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    envelope: { findUnique: db.envelopeFindUnique },
    recipient: { findUnique: db.recipientFindUnique, findMany: db.recipientFindMany },
    field: { findMany: db.fieldFindMany },
    fieldAttachment: { findMany: async () => [] },
    organisation: { findUnique: async () => null },
  },
}));
vi.mock('../audit/envelope', () => {
  const tx = {
    recipient: { updateMany: async () => ({ count: 1 }) },
    envelope: { updateMany: async () => ({ count: 1 }) },
    field: { update: db.fieldUpdate },
    signature: { create: vi.fn() },
    user: { findUnique: async () => null },
  };
  return {
    recordEnvelopeEvent: vi.fn(),
    publishEnvelopeEvents: vi.fn(),
    commitWithEnvelopeEvents: async (_id: string, fn: (t: unknown, record: unknown) => unknown) => fn(tx, vi.fn()),
  };
});
vi.mock('../mail', () => ({ sendMail: vi.fn(async () => ({ delivered: true })) }));
vi.mock('../env', () => ({
  getEnv: () => ({
    PUBLIC_URL: 'https://docs.example.edu',
    JWS_SIGNING_TOKEN_SECRET: 'test-signing-secret-test-signing-secret',
  }),
}));
vi.mock('../pdf/seal', () => ({ buildSealedEnvelope: vi.fn(), persistSealedEnvelope: vi.fn() }));
vi.mock('../logger', () => {
  const quiet = (): Record<string, unknown> => ({ info() {}, warn() {}, error() {}, debug() {}, child: quiet });
  return { childLogger: quiet, getLogger: quiet };
});

import { completeRecipientSigning, loadSigningSession } from './lifecycle';
import { mintSigningToken } from '../signing/token';

const recipientRow = (over: Record<string, unknown> = {}) => ({
  id: 'r2', envelopeId: 'env1', email: 'bob@example.com', name: 'Bob', recipientRole: 'SIGNER',
  signingStatus: 'NOT_SIGNED', signingOrder: 2, tokenJti: null as string | null, currentTokenExpiresAt: null,
  consentGivenAt: new Date(), meta: null, ...over,
});

let token: string;
let jti: string;

beforeEach(async () => {
  vi.clearAllMocks();
  const minted = await mintSigningToken({ envelopeId: 'env1', recipientId: 'r2' });
  token = minted.token;
  jti = minted.jti;
  db.envelopeFindUnique.mockImplementation(async () => ({
    id: 'env1', status: 'IN_PROGRESS', expiresAt: null, routingMode: 'PARALLEL',
    recipients: [recipientRow({ tokenJti: jti })],
    items: [], fields: [], meta: null,
  }));
});

describe('loadSigningSession', () => {
  it('refuses a superseded link after one read of the status and recipients, loading no fields or documents', async () => {
    db.envelopeFindUnique.mockImplementation(async () => ({
      id: 'env1', status: 'IN_PROGRESS', expiresAt: null, routingMode: 'PARALLEL',
      recipients: [recipientRow({ tokenJti: 'a-newer-jti' })],
    }));

    expect(await loadSigningSession(token)).toEqual({ ok: false, reason: 'consumed' });

    expect(db.envelopeFindUnique).toHaveBeenCalledTimes(1);
    const query = db.envelopeFindUnique.mock.calls[0]![0];
    expect(query.include).toBeUndefined();
    expect(Object.keys(query.select).sort()).toEqual(['expiresAt', 'id', 'recipients', 'routingMode', 'status']);
  });

  it('refuses a link to a completed envelope the same way', async () => {
    db.envelopeFindUnique.mockImplementation(async () => ({
      id: 'env1', status: 'COMPLETED', expiresAt: null, routingMode: 'PARALLEL',
      recipients: [recipientRow({ tokenJti: jti, signingStatus: 'SIGNED' })],
    }));

    expect(await loadSigningSession(token)).toEqual({ ok: false, reason: 'envelope_closed' });
    expect(db.envelopeFindUnique).toHaveBeenCalledTimes(1);
  });

  it('loads a live link with its own recipient\'s fields only', async () => {
    const session = await loadSigningSession(token);

    expect(session.ok).toBe(true);
    expect(db.envelopeFindUnique).toHaveBeenCalledTimes(2);
    const heavy = db.envelopeFindUnique.mock.calls[1]![0];
    expect(heavy.include.fields.where).toEqual({ recipientId: 'r2' });
  });
});

describe('completeRecipientSigning', () => {
  const ownFields = [
    { id: 'b-sig', recipientId: 'r2', type: 'SIGNATURE', required: true, value: null, defaultValue: null, meta: null },
    {
      id: 'b-text', recipientId: 'r2', type: 'TEXT', required: true, value: null, defaultValue: null,
      // Shown only when Alice answered "yes".
      meta: { condition: { whenFieldId: 'a-answer', equals: 'yes' } },
    },
    {
      id: 'b-total', recipientId: 'r2', type: 'FORMULA', required: false, value: null, defaultValue: null,
      meta: { formula: '{ a-count } * 2 + {b-num}' },
    },
    { id: 'b-num', recipientId: 'r2', type: 'NUMBER', required: false, value: null, defaultValue: null, meta: null },
  ];

  beforeEach(() => {
    db.recipientFindUnique.mockImplementation(async () => ({
      ...recipientRow({ tokenJti: jti }), envelope: { fields: ownFields },
    }));
    db.fieldFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      [{ id: 'a-answer', value: 'yes' }, { id: 'a-count', value: '5' }, { id: 'a-drawing', value: 'data:image/png;base64,AAAA' }]
        .filter((f) => where.id.in.includes(f.id)));
    // After the commit: Bob is the last signer.
    db.envelopeFindUnique.mockImplementation(async () => ({
      id: 'env1', orgId: 'org1', status: 'IN_PROGRESS', routingMode: 'PARALLEL', title: 'T', message: null,
      expiresAt: null, createdBy: { name: 'Sender' },
      recipients: [recipientRow({ signingStatus: 'SIGNED' }), recipientRow({ id: 'r3', signingOrder: 3, meta: { condition: { whenFieldId: 'b-num', equals: '1' } } })],
    }));
    db.recipientFindMany.mockImplementation(async () => [recipientRow({ signingStatus: 'SIGNED' }), recipientRow({ id: 'r3' })]);
  });

  it('reads only its own fields, and other fields\' values only where its conditions and formulas point', async () => {
    await completeRecipientSigning({
      envelopeId: 'env1', recipientId: 'r2', jti, ipAddress: '203.0.113.9', userAgent: 'vitest',
      typedSignature: 'Bob', fieldValues: { 'b-text': 'shown', 'b-num': '3' },
    });

    expect(db.recipientFindUnique.mock.calls[0]![0].include.envelope.select.fields.where).toEqual({ recipientId: 'r2' });
    const valueReads = db.fieldFindMany.mock.calls.map((c) => c[0]);
    expect(valueReads[0]).toEqual({
      where: { envelopeId: 'env1', id: { in: ['a-answer', 'a-count'] } },
      select: { id: true, value: true },
    });
    // The condition on Alice's answer held, and the formula used her count.
    const written = Object.fromEntries(db.fieldUpdate.mock.calls.map((c) => [c[0].where.id, c[0].data.value]));
    expect(written).toMatchObject({ 'b-text': 'shown', 'b-num': '3', 'b-total': '13' });
    // Routing reads only the field a pending recipient's condition names.
    expect(valueReads[1]).toEqual({
      where: { envelopeId: 'env1', id: { in: ['b-num'] } },
      select: { id: true, value: true },
    });
    expect(db.envelopeFindUnique.mock.calls[0]![0].include.fields).toBeUndefined();
  });

  it('reads no other field values when its own fields refer to none', async () => {
    db.recipientFindUnique.mockImplementation(async () => ({
      ...recipientRow({ tokenJti: jti }), envelope: { fields: [ownFields[0]] },
    }));
    db.envelopeFindUnique.mockImplementation(async () => ({
      id: 'env1', orgId: 'org1', status: 'IN_PROGRESS', routingMode: 'PARALLEL', title: 'T', message: null,
      expiresAt: null, createdBy: { name: 'Sender' }, recipients: [recipientRow({ signingStatus: 'SIGNED' }), recipientRow({ id: 'r3' })],
    }));

    await completeRecipientSigning({
      envelopeId: 'env1', recipientId: 'r2', jti, ipAddress: '203.0.113.9', userAgent: 'vitest',
      typedSignature: 'Bob', fieldValues: {},
    });

    expect(db.fieldFindMany).not.toHaveBeenCalled();
  });
});
