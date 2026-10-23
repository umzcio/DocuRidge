import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(), addEnvelopeFile: vi.fn(), addRecipient: vi.fn(),
  addField: vi.fn(), setEnvelopeItemPageCount: vi.fn(), sendEnvelope: vi.fn(),
  envelopeUpdate: vi.fn(), metaUpsert: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ user: { id: 'user' }, orgId: 'org', role: 'ADMIN' }),
  captureClientContext: () => ({ ipAddress: '127.0.0.1' }),
}));
vi.mock('@/lib/envelopes/service', () => mocks);
vi.mock('@/lib/envelopes/lifecycle', () => ({ sendEnvelope: mocks.sendEnvelope }));
vi.mock('@/lib/prisma', () => ({ prisma: {
  envelope: { update: mocks.envelopeUpdate }, envelopeMeta: { upsert: mocks.metaUpsert },
} }));
vi.mock('@/lib/logger', () => ({ childLogger: () => ({ warn: vi.fn(), error: vi.fn() }) }));

import { createAndSendEnvelopeAction } from './actions';
import { UploadValidationError } from '@/lib/storage';

const signer = { clientId: 'signer', name: 'Test Signer', email: 'signer@example.com', signingOrder: 1, role: 'SIGNER' };
const approver = { clientId: 'approver', name: 'Test Approver', email: 'approver@example.com', signingOrder: 2, role: 'APPROVER' };
const field = { id: 'field', documentClientId: 'document', recipientClientId: 'signer', type: 'SIGNATURE', page: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.1, required: true };

function submission(options: { recipients?: object[]; fields?: object[]; intent?: string; autoReminders?: string } = {}) {
  const data = new FormData();
  data.set('document', new File(['%PDF-test'], 'test.pdf', { type: 'application/pdf' }));
  data.set('documents', JSON.stringify([{ clientId: 'document', filename: 'test.pdf', pageCount: 1, order: 1 }]));
  data.set('recipients', JSON.stringify(options.recipients ?? [signer]));
  data.set('fields', JSON.stringify(options.fields ?? [field]));
  data.set('title', 'Signing test');
  data.set('intent', options.intent ?? 'send');
  data.set('autoReminders', options.autoReminders ?? 'true');
  return data;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createDraft.mockResolvedValue({ id: 'envelope' });
  mocks.addEnvelopeFile.mockResolvedValue({ item: { id: 'item' } });
  mocks.addRecipient.mockResolvedValue({ id: 'recipient' });
  mocks.addField.mockResolvedValue({ id: 'field-db' });
});

describe('create-and-send validation before persistence', () => {
  it('rejects an all-optional AI field set before creating a draft or sending mail', async () => {
    const result = await createAndSendEnvelopeAction({ ok: false }, submission({ fields: [{ ...field, required: false }] }));
    expect(result.error).toMatch(/required/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.sendEnvelope).not.toHaveBeenCalled();
  });

  it('allows approvers without fields alongside a signer', async () => {
    await expect(createAndSendEnvelopeAction({ ok: false }, submission({ recipients: [signer, approver] })))
      .rejects.toThrow('REDIRECT:/dashboard/envelopes/envelope');
    expect(mocks.sendEnvelope).toHaveBeenCalledOnce();
  });

  it('allows an approval-only envelope without artificial signature fields', async () => {
    await expect(createAndSendEnvelopeAction({ ok: false }, submission({ recipients: [approver], fields: [] })))
      .rejects.toThrow('REDIRECT:/dashboard/envelopes/envelope');
    expect(mocks.sendEnvelope).toHaveBeenCalledOnce();
  });

  it('rejects CC-only sends before creating a draft', async () => {
    const result = await createAndSendEnvelopeAction({ ok: false }, submission({ recipients: [{ ...signer, role: 'CC' }] }));
    expect(result.error).toMatch(/signer|approver/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('rejects an off-page field before uploading any document', async () => {
    const result = await createAndSendEnvelopeAction({ ok: false }, submission({ fields: [{ ...field, x: 0.95 }] }));
    expect(result.error).toMatch(/page bounds/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
    expect(mocks.addEnvelopeFile).not.toHaveBeenCalled();
  });

  it('keeps incomplete drafts saveable', async () => {
    await expect(createAndSendEnvelopeAction({ ok: false }, submission({ recipients: [], fields: [], intent: 'save' })))
      .rejects.toThrow('REDIRECT:/dashboard/envelopes/envelope');
    expect(mocks.sendEnvelope).not.toHaveBeenCalled();
  });

  it('persists auto-reminders disabled when the form posts the string false', async () => {
    await expect(createAndSendEnvelopeAction({ ok: false }, submission({ autoReminders: 'false' })))
      .rejects.toThrow('REDIRECT:/dashboard/envelopes/envelope');
    expect(mocks.metaUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ reminderSettings: { daysBeforeFirst: 0, daysBetween: 0, maxReminders: 0 } }),
    }));
  });

  it.each(['upload', 'field', 'upload-validation'])('returns the existing envelope for recovery after %s failure', async (stage) => {
    if (stage === 'field') mocks.addField.mockRejectedValue(new Error('Field write failed'));
    else if (stage === 'upload-validation') mocks.addEnvelopeFile.mockRejectedValue(new UploadValidationError('unreadable_pdf', 'PDF unreadable'));
    else mocks.addEnvelopeFile.mockRejectedValue(new Error('Storage unavailable'));

    const result = await createAndSendEnvelopeAction({ ok: false }, submission());
    expect(result).toEqual({ ok: false, envelopeId: 'envelope', error: expect.stringMatching(/review.*existing envelope/i) });
    expect(mocks.createDraft).toHaveBeenCalledOnce();
    expect(mocks.sendEnvelope).not.toHaveBeenCalled();
  });

  it('does not return an envelope link when draft creation failed', async () => {
    mocks.createDraft.mockRejectedValue(new Error('Database unavailable'));
    const result = await createAndSendEnvelopeAction({ ok: false }, submission());
    expect(result).toEqual({ ok: false, error: 'Database unavailable' });
    expect(result.envelopeId).toBeUndefined();
    expect(mocks.sendEnvelope).not.toHaveBeenCalled();
  });

  it('accepts the Drawing field offered by the builder and supported by signing', async () => {
    await expect(createAndSendEnvelopeAction({ ok: false }, submission({ fields: [{ ...field, type: 'DRAWING' }] })))
      .rejects.toThrow('REDIRECT:/dashboard/envelopes/envelope');
    expect(mocks.addField).toHaveBeenCalledWith(expect.objectContaining({ type: 'DRAWING' }));
    expect(mocks.sendEnvelope).toHaveBeenCalledOnce();
  });

  it('identifies the invalid recipient and property without discarding the builder', async () => {
    const result = await createAndSendEnvelopeAction({ ok: false }, submission({ recipients: [signer, { ...approver, email: 'bad-address' }] }));
    expect(result.error).toMatch(/Recipients 2.*email.*valid email/i);
    expect(result.error).not.toMatch(/reload|bad-address/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('identifies invalid field bounds from schema validation', async () => {
    const result = await createAndSendEnvelopeAction({ ok: false }, submission({ fields: [{ ...field, w: 0 }] }));
    expect(result.error).toMatch(/Fields 1.*w.*0\.005/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it('reports malformed document JSON without including submitted content', async () => {
    const data = submission();
    data.set('documents', '{private-content');
    const result = await createAndSendEnvelopeAction({ ok: false }, data);
    expect(result.error).toMatch(/Documents.*could not be read/i);
    expect(result.error).not.toContain('private-content');
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});
