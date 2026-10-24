import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Authorization of the envelope-detail server actions. Everything below the
 * action (prisma, lifecycle, audit, mail) is mocked so the tests can assert
 * that a refused caller never reaches a write, an invite or an audit event.
 */
const mocks = vi.hoisted(() => ({
  session: {
    user: { id: 'u_owner', name: 'Owner', email: 'owner@example.com' },
    orgId: 'org_1',
    role: 'SENDER' as 'ADMIN' | 'SENDER' | 'VIEWER',
  },
  envelopeFindFirst: vi.fn(),
  envelopeFindMany: vi.fn(),
  envelopeUpdateMany: vi.fn(),
  txEnvelopeUpdate: vi.fn(),
  txEnvelopeUpdateMany: vi.fn(),
  txRecipientCreate: vi.fn(),
  commitWithEnvelopeEvents: vi.fn(),
  recordEnvelopeEvent: vi.fn(),
  record: vi.fn(),
  rebindRecipient: vi.fn(),
  removePendingRecipient: vi.fn(),
  dispatchSigningInvite: vi.fn(),
  voidEnvelope: vi.fn(),
  sendReminderToNextSigner: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({ getSession: async () => mocks.session }));
vi.mock('@/lib/logger', () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/storage', () => ({ readPdfFromStorage: vi.fn() }));
vi.mock('@/lib/envelopes/service', () => ({
  createDraft: vi.fn(), addEnvelopeFile: vi.fn(), addRecipient: vi.fn(),
  addField: vi.fn(), setEnvelopeItemPageCount: vi.fn(),
}));
vi.mock('@/lib/envelopes/lifecycle', () => ({
  voidEnvelope: mocks.voidEnvelope,
  sendReminderToNextSigner: mocks.sendReminderToNextSigner,
  dispatchSigningInvite: mocks.dispatchSigningInvite,
  rebindRecipient: mocks.rebindRecipient,
  removePendingRecipient: mocks.removePendingRecipient,
}));
vi.mock('@/lib/audit/envelope', () => ({
  commitWithEnvelopeEvents: mocks.commitWithEnvelopeEvents,
  recordEnvelopeEvent: mocks.recordEnvelopeEvent,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    envelope: {
      findFirst: mocks.envelopeFindFirst,
      findMany: mocks.envelopeFindMany,
      updateMany: mocks.envelopeUpdateMany,
    },
  },
}));

import { correctEnvelopeAction } from './actions';

type Role = 'ADMIN' | 'SENDER' | 'VIEWER';
function actAs(userId: string, role: Role) {
  mocks.session = { user: { id: userId, name: userId, email: `${userId}@example.com` }, orgId: 'org_1', role };
}

function inFlightEnvelope(status: 'SENT' | 'IN_PROGRESS' = 'SENT') {
  return {
    id: 'env_1',
    orgId: 'org_1',
    createdById: 'u_owner',
    type: 'DOCUMENT',
    status,
    title: 'Contract',
    message: 'Please sign',
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    meta: null,
    org: null,
    createdBy: { name: 'Owner' },
    recipients: [
      { id: 'r1', name: 'Ada', email: 'ada@example.com', recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 1 },
      { id: 'r2', name: 'Bob', email: 'bob@example.com', recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', signingOrder: 2 },
    ],
  };
}

const OPERATIONS: Record<string, Record<string, string>> = {
  updateDetails: { message: 'Rewritten by someone else', expiration: '2000-01-01' },
  addRecipient: { name: 'Mallory', email: 'mallory@example.com', role: 'SIGNER' },
  replaceRecipient: { recipientId: 'r1', name: 'Mallory', email: 'mallory@example.com' },
  removeRecipient: { recipientId: 'r1' },
};

function correctionForm(operation: string): FormData {
  const data = new FormData();
  data.set('envelopeId', 'env_1');
  data.set('operation', operation);
  for (const [k, v] of Object.entries(OPERATIONS[operation]!)) data.set(k, v);
  return data;
}

function expectNoSideEffects() {
  expect(mocks.commitWithEnvelopeEvents).not.toHaveBeenCalled();
  expect(mocks.recordEnvelopeEvent).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.txEnvelopeUpdate).not.toHaveBeenCalled();
  expect(mocks.txRecipientCreate).not.toHaveBeenCalled();
  expect(mocks.rebindRecipient).not.toHaveBeenCalled();
  expect(mocks.removePendingRecipient).not.toHaveBeenCalled();
  expect(mocks.dispatchSigningInvite).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  actAs('u_owner', 'SENDER');
  mocks.envelopeFindFirst.mockImplementation(async () => inFlightEnvelope());
  mocks.txRecipientCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'r_new', ...data,
  }));
  mocks.txEnvelopeUpdateMany.mockResolvedValue({ count: 1 });
  mocks.commitWithEnvelopeEvents.mockImplementation(
    async (_id: string, fn: (tx: unknown, record: unknown) => Promise<unknown>) =>
      fn(
        {
          envelope: { update: mocks.txEnvelopeUpdate, updateMany: mocks.txEnvelopeUpdateMany },
          recipient: { create: mocks.txRecipientCreate },
        },
        mocks.record,
      ),
  );
});

describe('correctEnvelopeAction — ownership', () => {
  describe.each(Object.keys(OPERATIONS))('%s', (operation) => {
    it.each(['SENT', 'IN_PROGRESS'] as const)(
      'SECURITY: a SENDER cannot correct a colleague\'s %s envelope',
      async (status) => {
        actAs('u_colleague', 'SENDER');
        mocks.envelopeFindFirst.mockResolvedValue(inFlightEnvelope(status));
        const result = await correctEnvelopeAction({ ok: false }, correctionForm(operation));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/only the envelope's sender or an org admin/i);
        expectNoSideEffects();
      },
    );

    it('a VIEWER cannot correct', async () => {
      actAs('u_viewer', 'VIEWER');
      const result = await correctEnvelopeAction({ ok: false }, correctionForm(operation));
      expect(result.ok).toBe(false);
      expectNoSideEffects();
    });

    it('the envelope\'s creator (SENDER) can correct', async () => {
      actAs('u_owner', 'SENDER');
      const result = await correctEnvelopeAction({ ok: false }, correctionForm(operation));
      expect(result).toMatchObject({ ok: true, corrected: true });
    });

    it('an org ADMIN can correct a colleague\'s envelope', async () => {
      actAs('u_admin', 'ADMIN');
      const result = await correctEnvelopeAction({ ok: false }, correctionForm(operation));
      expect(result).toMatchObject({ ok: true, corrected: true });
    });
  });
});
