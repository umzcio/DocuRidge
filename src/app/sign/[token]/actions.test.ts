import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reassignRecipient: vi.fn(),
  declineEnvelope: vi.fn(),
  addComment: vi.fn(),
  completeRecipientSigning: vi.fn(),
  attachRecipientFile: vi.fn(),
  stageRecipientAttachment: vi.fn(),
  loadSigningSession: vi.fn(),
  RecipientChangedError: class RecipientChangedError extends Error {},
  ensureCanonicalDocument: vi.fn(),
  CanonicalRefusedError: class CanonicalRefusedError extends Error {},
  CanonicalUnavailableError: class CanonicalUnavailableError extends Error {},
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock('@/lib/envelopes/lifecycle', () => ({
  loadSigningSession: mocks.loadSigningSession,
  recordConsent: vi.fn(),
  recordAccessCodeUnlock: vi.fn(),
  completeRecipientSigning: mocks.completeRecipientSigning,
  attachRecipientFile: mocks.attachRecipientFile,
  declineEnvelope: mocks.declineEnvelope,
  reassignRecipient: mocks.reassignRecipient,
  RecipientChangedError: mocks.RecipientChangedError,
}));
vi.mock('@/lib/auth/session', () => ({
  captureClientContext: () => ({ ipAddress: '203.0.113.9', userAgent: 'vitest' }),
  getSession: async () => null,
}));
vi.mock('@/lib/ratelimit', () => ({ checkRateLimit: async () => ({ allowed: true, count: 1 }) }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/storage', () => ({
  stageRecipientAttachment: mocks.stageRecipientAttachment,
  AttachmentValidationError: class extends Error {},
  CanonicalUnavailableError: mocks.CanonicalUnavailableError,
  CanonicalIntegrityError: class extends mocks.CanonicalUnavailableError {},
  readCanonicalPdf: vi.fn(),
}));
vi.mock('@/lib/pdf/canonical-source', () => ({
  ensureCanonicalDocument: mocks.ensureCanonicalDocument,
  CanonicalRefusedError: mocks.CanonicalRefusedError,
}));
vi.mock('@/lib/mail', () => ({ mayMailRecipient: () => true }));
vi.mock('@/lib/comments/service', () => ({ addComment: mocks.addComment }));

import { addCommentRecipientAction, declineAction, reassignAction, submitSigningAction, uploadAttachmentAction } from './actions';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadSigningSession.mockResolvedValue({
    ok: true,
    envelope: { id: 'env1', fields: [], items: [{ id: 'i1', documentFileId: 'df1' }] },
    recipient: { id: 'r1', email: 'alice@example.com', name: 'Alice' },
    jti: 'j1',
  });
  mocks.ensureCanonicalDocument.mockResolvedValue({ documentFileId: 'df1' });
});

describe('reassignAction input hygiene', () => {
  const base = { token: 't', newEmail: 'bob@example.com', newName: 'Bob' };

  it('rejects a NUL in the reason before anything changes', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, reason: 'bye\u0000' }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unsupported characters/i);
    expect(mocks.reassignRecipient).not.toHaveBeenCalled();
  });

  it('rejects a NUL in the new name', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, newName: 'Bo\u0000b' }));
    expect(res.ok).toBe(false);
    expect(mocks.reassignRecipient).not.toHaveBeenCalled();
  });

  it('accepts ordinary text', async () => {
    const res = await reassignAction({ ok: false }, form({ ...base, reason: 'On leave — back Monday' }));
    expect(res.ok).toBe(true);
    expect(mocks.reassignRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ newEmail: 'bob@example.com', reason: 'On leave — back Monday' }),
    );
  });
});

describe('other recipient free text', () => {
  it('declineAction rejects a NUL in the reason', async () => {
    const res = await declineAction({ ok: false }, form({ token: 't', reason: 'no\u0000' }));
    expect(res.ok).toBe(false);
    expect(mocks.declineEnvelope).not.toHaveBeenCalled();
  });

  it('declineAction passes the authorising jti and reports a lost race as a clean error', async () => {
    mocks.declineEnvelope.mockRejectedValue(new mocks.RecipientChangedError('This signing link is no longer valid.'));
    const res = await declineAction({ ok: false }, form({ token: 't', reason: 'no' }));
    expect(mocks.declineEnvelope).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'r1', jti: 'j1' }));
    expect(res).toEqual({ ok: false, error: 'This signing link is no longer valid.' });
  });

  it('declineAction rejects an oversized reason', async () => {
    const res = await declineAction({ ok: false }, form({ token: 't', reason: 'x'.repeat(5000) }));
    expect(res.ok).toBe(false);
    expect(mocks.declineEnvelope).not.toHaveBeenCalled();
  });

  it('addCommentRecipientAction rejects a NUL in the body', async () => {
    const res = await addCommentRecipientAction({ ok: false }, form({ token: 't', body: 'hi\u0000' }));
    expect(res.ok).toBe(false);
    expect(mocks.addComment).not.toHaveBeenCalled();
  });
});

describe('submitSigningAction when the final document cannot be sealed', () => {
  const submit = () => submitSigningAction({ ok: false }, form({ token: 't', fieldValues: '{}', typedSignature: 'Alice' }));

  beforeEach(() => {
    mocks.loadSigningSession.mockResolvedValue({
      ok: true,
      envelope: { id: 'env1', fields: [], items: [{ id: 'i1', documentFileId: 'df1' }] },
      recipient: { id: 'r1', email: 'alice@example.com', name: 'Alice', consentGivenAt: new Date() },
      jti: 'j1',
    });
  });

  it('tells the last signer their signature counts and the sender knows, without a raw error', async () => {
    mocks.completeRecipientSigning.mockResolvedValue({ envelopeStatus: 'IN_PROGRESS', sealFailed: true });
    const res = await submit();
    expect(res.ok).toBe(true);
    expect(res.completed).toBe(false);
    expect(res.error).toBeUndefined();
    expect(res.message).toMatch(/signature has been recorded.*sender has been notified/i);
  });

  it('tells signers the copy will follow when only storing it failed', async () => {
    mocks.completeRecipientSigning.mockResolvedValue({ envelopeStatus: 'COMPLETED', sealFailed: true });
    const res = await submit();
    expect(res).toMatchObject({ ok: true, completed: true });
    expect(res.message).toMatch(/not ready yet.*by email/i);
  });
});

describe('uploadAttachmentAction records only for a link that is still current', () => {
  const staged = () => ({
    relativePath: 'org1/abc.pdf', sizeBytes: 3, sha256: 'ab', mimeType: 'application/pdf', filename: 'a.pdf',
    commit: vi.fn(), discard: vi.fn(),
  });
  const upload = () => uploadAttachmentAction({ ok: false }, form({
    token: 't', fieldId: 'fa', file: new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' }),
  } as unknown as Record<string, string>));

  beforeEach(() => {
    mocks.loadSigningSession.mockResolvedValue({
      ok: true,
      envelope: { id: 'env1', orgId: 'org1', fields: [{ id: 'fa', type: 'ATTACHMENT', recipientId: 'r1', meta: null }] },
      recipient: { id: 'r1', email: 'alice@example.com', name: 'Alice' },
      jti: 'j1',
    });
  });

  it('passes the authorising jti, and discards the staged file when the link changed meanwhile', async () => {
    const file = staged();
    mocks.stageRecipientAttachment.mockResolvedValue(file);
    mocks.attachRecipientFile.mockResolvedValue(false);

    const res = await upload();

    expect(mocks.attachRecipientFile).toHaveBeenCalledWith(expect.objectContaining({
      envelopeId: 'env1', recipientId: 'r1', jti: 'j1', fieldId: 'fa', file,
    }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer valid/i);
    expect(file.discard).toHaveBeenCalled();
  });

  it('reports the attachment when it was recorded', async () => {
    const file = staged();
    mocks.stageRecipientAttachment.mockResolvedValue(file);
    mocks.attachRecipientFile.mockResolvedValue(true);

    const res = await upload();

    expect(res).toMatchObject({ ok: true, fieldId: 'fa', attachment: { filename: 'a.pdf', sha256: 'ab' } });
  });
});

describe('submitSigningAction refuses while a document cannot be shown', () => {
  const submit = () => submitSigningAction({ ok: false }, form({ token: 't', fieldValues: '{}', typedSignature: 'Alice' }));

  beforeEach(() => {
    mocks.loadSigningSession.mockResolvedValue({
      ok: true,
      envelope: { id: 'env1', fields: [], items: [{ id: 'i1', documentFileId: 'df1' }, { id: 'i2', documentFileId: 'df2' }] },
      recipient: { id: 'r1', email: 'alice@example.com', name: 'Alice', consentGivenAt: new Date() },
      jti: 'j1',
    });
  });

  it('records nothing for an envelope with a refused document, and answers with the fixed text', async () => {
    mocks.ensureCanonicalDocument.mockImplementation(async (id: string) => {
      if (id === 'df2') throw new mocks.CanonicalRefusedError('child text from the canonicalizer');
      return { documentFileId: id };
    });
    const res = await submit();
    expect(res).toEqual({ ok: false, error: "This document can't be shown right now. Contact the sender." });
    expect(mocks.ensureCanonicalDocument.mock.calls.map((c) => c[0])).toEqual(['df1', 'df2']);
    // completeRecipientSigning writes the signature row and the recipient.signed event.
    expect(mocks.completeRecipientSigning).not.toHaveBeenCalled();
  });

  it('answers a busy worker with the busy text, recording nothing', async () => {
    const { PdfWorkerError } = await import('@/lib/pdf-worker/runner');
    mocks.ensureCanonicalDocument.mockRejectedValue(new PdfWorkerError('busy'));
    expect(await submit()).toEqual({ ok: false, error: 'DocuRidge is busy preparing this document. Try again shortly.' });
    expect(mocks.completeRecipientSigning).not.toHaveBeenCalled();
  });

  it('answers any other failure with the fixed text, never the error', async () => {
    mocks.ensureCanonicalDocument.mockRejectedValue(new Error('ENOENT: /data/uploads/org1/x.pdf'));
    expect(await submit()).toEqual({ ok: false, error: "This document can't be shown right now. Contact the sender." });
    expect(mocks.completeRecipientSigning).not.toHaveBeenCalled();
  });

  it('signs when every document can be shown', async () => {
    mocks.ensureCanonicalDocument.mockImplementation(async (id: string) => ({ documentFileId: id }));
    mocks.completeRecipientSigning.mockResolvedValue({ envelopeStatus: 'IN_PROGRESS' });
    expect(await submit()).toMatchObject({ ok: true });
    expect(mocks.completeRecipientSigning).toHaveBeenCalledTimes(1);
  });
});
