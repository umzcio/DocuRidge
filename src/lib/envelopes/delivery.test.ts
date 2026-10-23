import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recipientUpdate: vi.fn(), envelopeFind: vi.fn(), sendMail: vi.fn(), event: vi.fn(),
}));
vi.mock('../prisma', () => ({ prisma: {
  recipient: { update: mocks.recipientUpdate },
  envelope: { findFirst: mocks.envelopeFind },
  user: { findUnique: async () => ({ name: 'Sender' }) },
  organisation: { findUnique: async () => null },
} }));
vi.mock('../authz/can', () => ({ authorize: vi.fn() }));
vi.mock('../signing/token', () => ({ mintSigningToken: async () => ({ token: 'token', jti: 'jti', expiresAt: new Date() }) }));
vi.mock('../audit/envelope', () => ({ recordEnvelopeEvent: mocks.event }));
vi.mock('../mail', () => ({ sendMail: mocks.sendMail }));
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'http://localhost:3738/DocuRidge' }) }));
vi.mock('../pdf/seal', () => ({ sealEnvelope: vi.fn() }));

import { dispatchSigningInvite, sendReminderToNextSigner } from './lifecycle';

const dispatch = { envelopeId: 'envelope', orgId: 'org', recipientId: 'recipient', recipientEmail: 'signer@example.com', recipientName: 'Signer', senderName: 'Sender', documentTitle: 'Document' };
const ctx = { userId: 'user', orgId: 'org', role: 'ADMIN' as const };
const recipient = { id: 'recipient', name: 'Signer', email: 'signer@example.com', recipientRole: 'SIGNER', signingStatus: 'NOT_SIGNED', sendStatus: 'SENT', lastReminderSentAt: null };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sendMail.mockResolvedValue({ delivered: true, refusedByAllowlist: false });
  mocks.envelopeFind.mockResolvedValue({ id: 'envelope', orgId: 'org', createdById: 'user', title: 'Document', status: 'IN_PROGRESS', routingMode: 'SEQUENTIAL', recipients: [recipient] });
});

describe('truthful signing invitation delivery status', () => {
  it.each([false, true])('marks undelivered invitation FAILED (allowlist refusal=%s) without reopening create flow', async (refusedByAllowlist) => {
    mocks.sendMail.mockResolvedValue({ delivered: false, refusedByAllowlist });
    await expect(dispatchSigningInvite(dispatch)).resolves.toBeUndefined();
    expect(mocks.recipientUpdate).toHaveBeenLastCalledWith({ where: { id: 'recipient' }, data: { sendStatus: 'FAILED' } });
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'email.failed' }));
  });

  it('only marks SENT after the mail backend confirms delivery', async () => {
    mocks.sendMail.mockImplementation(async () => {
      expect(mocks.recipientUpdate.mock.calls.some(([input]) => input.data.sendStatus === 'SENT')).toBe(false);
      return { delivered: true, refusedByAllowlist: false };
    });
    await dispatchSigningInvite(dispatch);
    expect(mocks.recipientUpdate).toHaveBeenLastCalledWith({ where: { id: 'recipient' }, data: { sendStatus: 'SENT', sentAt: expect.any(Date) } });
  });

  it('returns a reminder delivery error and persists FAILED instead of a success toast', async () => {
    mocks.sendMail.mockResolvedValue({ delivered: false, refusedByAllowlist: false });
    await expect(sendReminderToNextSigner({ ctx, envelopeId: 'envelope' })).rejects.toThrow(/email.*not.*delivered/i);
    expect(mocks.recipientUpdate).toHaveBeenLastCalledWith({ where: { id: 'recipient' }, data: { sendStatus: 'FAILED' } });
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ type: 'email.failed' }));
  });

  it('retries the failed parallel recipient before reminding someone already emailed', async () => {
    mocks.envelopeFind.mockResolvedValue({ id: 'envelope', orgId: 'org', createdById: 'user', title: 'Document', status: 'IN_PROGRESS', routingMode: 'PARALLEL', recipients: [recipient, { ...recipient, id: 'failed', email: 'failed@example.com', sendStatus: 'FAILED' }] });
    const result = await sendReminderToNextSigner({ ctx, envelopeId: 'envelope' });
    expect(result.recipientId).toBe('failed');
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'failed@example.com' }));
  });
});
