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
  addField: vi.fn(),
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

import { bulkDeleteDraftsAction, correctEnvelopeAction, forwardCompletedAction } from './actions';

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

describe('bulkDeleteDraftsAction — per-item authorization', () => {
  const rows = [
    { id: 'd_own', orgId: 'org_1', type: 'DOCUMENT', createdById: 'u_sender' },
    { id: 'd_colleague', orgId: 'org_1', type: 'DOCUMENT', createdById: 'u_colleague' },
    { id: 't_own', orgId: 'org_1', type: 'TEMPLATE', createdById: 'u_sender' },
    { id: 't_admin', orgId: 'org_1', type: 'TEMPLATE', createdById: 'u_admin' },
  ];

  function deleteForm(ids: string[]): FormData {
    const data = new FormData();
    for (const id of ids) data.append('ids', id);
    return data;
  }

  function deletedIds(): string[] {
    return mocks.txEnvelopeUpdateMany.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
  }

  beforeEach(() => {
    mocks.envelopeFindMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) =>
      rows.filter((r) => where.id.in.includes(r.id)),
    );
  });

  it('only loads DRAFT rows in the caller\'s org that are not already deleted', async () => {
    actAs('u_sender', 'SENDER');
    await bulkDeleteDraftsAction(deleteForm(['d_own']));
    expect(mocks.envelopeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: 'org_1', deletedAt: null, status: 'DRAFT' }),
      }),
    );
  });

  it('SECURITY: a SENDER cannot delete a colleague\'s draft or template; their own are deleted', async () => {
    actAs('u_sender', 'SENDER');
    await bulkDeleteDraftsAction(deleteForm(rows.map((r) => r.id)));
    expect(deletedIds().sort()).toEqual(['d_own', 't_own']);
    // Nothing bypasses the per-row check with an unscoped bulk write.
    expect(mocks.envelopeUpdateMany).not.toHaveBeenCalled();
  });

  it('SECURITY: a batch of only colleagues\' rows deletes nothing', async () => {
    actAs('u_sender', 'SENDER');
    await bulkDeleteDraftsAction(deleteForm(['d_colleague', 't_admin']));
    expect(mocks.txEnvelopeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.envelopeUpdateMany).not.toHaveBeenCalled();
  });

  it('a VIEWER cannot delete anything, not even rows they created', async () => {
    actAs('u_sender', 'VIEWER');
    await bulkDeleteDraftsAction(deleteForm(rows.map((r) => r.id)));
    expect(mocks.txEnvelopeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.envelopeUpdateMany).not.toHaveBeenCalled();
  });

  it('an ADMIN can delete every draft and template in the org', async () => {
    actAs('u_admin', 'ADMIN');
    await bulkDeleteDraftsAction(deleteForm(rows.map((r) => r.id)));
    expect(deletedIds().sort()).toEqual(['d_colleague', 'd_own', 't_admin', 't_own']);
  });

  it('records an envelope.deleted audit event for each deleted row', async () => {
    actAs('u_sender', 'SENDER');
    await bulkDeleteDraftsAction(deleteForm(['d_own', 't_own']));
    expect(mocks.record).toHaveBeenCalledTimes(2);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 'd_own', type: 'envelope.deleted', actorUserId: 'u_sender' }),
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ envelopeId: 't_own', type: 'envelope.deleted', actorUserId: 'u_sender' }),
    );
  });

  it('re-checks DRAFT status and org inside the write, so a row sent meanwhile is untouched', async () => {
    actAs('u_sender', 'SENDER');
    mocks.txEnvelopeUpdateMany.mockResolvedValue({ count: 0 });
    await bulkDeleteDraftsAction(deleteForm(['d_own']));
    expect(mocks.txEnvelopeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'd_own', orgId: 'org_1', deletedAt: null, status: 'DRAFT' }),
      }),
    );
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

describe('forwardCompletedAction — send permission', () => {
  function forwardForm(): FormData {
    const data = new FormData();
    data.set('envelopeId', 'env_1');
    data.set('emails', 'outsider@example.com');
    return data;
  }

  it('refuses a VIEWER before loading the envelope or mailing anything', async () => {
    actAs('u_viewer', 'VIEWER');
    const result = await forwardCompletedAction({ ok: false }, forwardForm());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission to forward/);
    expect(mocks.envelopeFindFirst).not.toHaveBeenCalled();
    expect(mocks.recordEnvelopeEvent).not.toHaveBeenCalled();
  });

  it.each(['SENDER', 'ADMIN'] as const)('lets a %s past the permission check', async (role) => {
    actAs('u_owner', role);
    const result = await forwardCompletedAction({ ok: false }, forwardForm());
    expect(result.error ?? '').not.toMatch(/permission to forward/);
    expect(mocks.envelopeFindFirst).toHaveBeenCalled();
  });
});
