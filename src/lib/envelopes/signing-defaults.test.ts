import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUser: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    recipient: {
      findUnique: async () => ({
        id: 'r1', envelopeId: 'env1', email: 'victim@example.com', name: 'Victim',
        recipientRole: 'SIGNER',
        envelope: {
          recipients: [],
          fields: [{ id: 'sig', recipientId: 'r1', type: 'SIGNATURE', required: true, value: null, defaultValue: null, meta: null }],
          items: [],
        },
      }),
    },
    fieldAttachment: { findMany: async () => [] },
  },
}));
vi.mock('../audit/envelope', () => {
  const tx = {
    field: { update: vi.fn() },
    signature: { create: vi.fn() },
    recipient: { updateMany: vi.fn(async () => ({ count: 1 })) },
    envelope: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: mocks.findUser, update: mocks.updateUser },
  };
  return {
    recordEnvelopeEvent: vi.fn(),
    commitWithEnvelopeEvents: async (_envelopeId: string, fn: (t: unknown, record: unknown) => unknown) => {
      await fn(tx, vi.fn());
      throw new Error('stop after signing transaction');
    },
  };
});
vi.mock('../mail', () => ({ sendMail: vi.fn() }));
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu' }) }));
vi.mock('../pdf/seal', () => ({ sealEnvelope: vi.fn() }));

import { completeRecipientSigning } from './lifecycle';

const submit = {
  envelopeId: 'env1',
  recipientId: 'r1',
  jti: 'jti1',
  ipAddress: '203.0.113.9',
  userAgent: 'vitest',
  fieldValues: {},
  typedSignature: 'Someone Else',
  typedInitials: 'SE',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUser.mockResolvedValue({ id: 'victim-user' });
});

describe('saving adopted marks as account defaults', () => {
  it('does not touch a registered user when the signer has no session', async () => {
    await expect(completeRecipientSigning(submit)).rejects.toThrow('stop after signing transaction');
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('does not touch a registered user from someone else\'s session', async () => {
    await expect(completeRecipientSigning({ ...submit, sessionUserId: 'attacker-user' }))
      .rejects.toThrow('stop after signing transaction');
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('saves the marks for the signed-in recipient', async () => {
    await expect(completeRecipientSigning({ ...submit, sessionUserId: 'victim-user' }))
      .rejects.toThrow('stop after signing transaction');
    expect(mocks.updateUser).toHaveBeenCalledWith({
      where: { id: 'victim-user' },
      data: {
        defaultSignaturePngBase64: null,
        defaultTypedSignature: 'Someone Else',
        defaultInitialsPngBase64: null,
        defaultTypedInitials: 'SE',
      },
    });
  });
});
