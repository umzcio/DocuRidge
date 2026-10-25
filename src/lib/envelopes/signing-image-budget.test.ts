import { beforeEach, describe, expect, it, vi } from 'vitest';
import { solidPng } from '../verify/__fixtures__/sealed-pdf';

/**
 * A signing submission is refused, with nothing committed, when its images
 * together with everything already stored would take the envelope past the
 * seal's image budget (sealing would otherwise fail after the last signer).
 */

const png = (r: number, g: number, b: number, size = 20) => solidPng(r, g, b, size).toString('base64');

const mocks = vi.hoisted(() => ({
  storedSignatures: [] as Array<{ imagePngBase64: string | null }>,
  storedFields: [] as Array<Record<string, unknown>>,
  fieldUpdate: vi.fn(),
  signatureCreate: vi.fn(),
  record: vi.fn(),
  committed: vi.fn(),
  reads: vi.fn(),
}));

const envelopeFields = () => [
  { id: 'sig', envelopeId: 'env1', recipientId: 'r1', type: 'SIGNATURE', required: true, value: null, defaultValue: null, meta: null },
  { id: 'draw', envelopeId: 'env1', recipientId: 'r1', type: 'DRAWING', required: false, value: null, defaultValue: null, meta: null },
  { id: 'other-draw', envelopeId: 'env1', recipientId: 'r2', type: 'DRAWING', required: false, value: null, defaultValue: null, meta: null },
];

vi.mock('../prisma', () => ({
  prisma: {
    recipient: {
      findUnique: async () => ({
        id: 'r1', envelopeId: 'env1', email: 'signer@example.com', name: 'Signer', recipientRole: 'SIGNER',
        envelope: { recipients: [], fields: envelopeFields(), items: [] },
      }),
    },
    fieldAttachment: { findMany: async () => [] },
  },
}));
vi.mock('../audit/envelope', () => {
  const tx = {
    field: { update: mocks.fieldUpdate, findMany: async () => { mocks.reads('field'); return mocks.storedFields; } },
    signature: { create: mocks.signatureCreate, findMany: async () => { mocks.reads('signature'); return mocks.storedSignatures; } },
    recipient: { updateMany: vi.fn(async () => ({ count: 1 })) },
    envelope: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => null), update: vi.fn() },
  };
  return {
    recordEnvelopeEvent: vi.fn(),
    // Like the real one: the transaction commits only if `fn` returns.
    commitWithEnvelopeEvents: async (_envelopeId: string, fn: (t: unknown, record: unknown) => unknown) => {
      await fn(tx, mocks.record);
      mocks.committed();
      throw new Error('stop after the signing transaction');
    },
  };
});
vi.mock('../mail', () => ({ sendMail: vi.fn() }));
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu' }) }));
vi.mock('../pdf/seal', () => ({ buildSealedEnvelope: vi.fn(), persistSealedEnvelope: vi.fn() }));

import { SigningImagesTooLargeError, completeRecipientSigning } from './lifecycle';

const submit = (extra: Record<string, unknown> = {}) => ({
  envelopeId: 'env1',
  recipientId: 'r1',
  jti: 'jti1',
  ipAddress: '203.0.113.9',
  userAgent: 'vitest',
  fieldValues: {} as Record<string, string>,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // 20x20 images are 400 pixels each; the budget allows two distinct ones.
  vi.stubEnv('SEAL_MAX_IMAGE_PIXELS', '1000');
  mocks.storedSignatures = [];
  mocks.storedFields = envelopeFields();
});

function expectNothingWritten(): void {
  expect(mocks.fieldUpdate).not.toHaveBeenCalled();
  expect(mocks.signatureCreate).not.toHaveBeenCalled();
  expect(mocks.record).not.toHaveBeenCalled();
  expect(mocks.committed).not.toHaveBeenCalled();
}

describe('the seal image budget at signing', () => {
  it('refuses a submission whose drawing and signature, with the stored images, exceed the budget', async () => {
    // Another signer already stored a drawing: 400 + 400 + 400 > 1000.
    mocks.storedFields = envelopeFields().map((f) => (f.id === 'other-draw' ? { ...f, value: `data:image/png;base64,${png(0, 0, 255)}` } : f));

    const err = await completeRecipientSigning(submit({
      signatureImagePngBase64: png(255, 0, 0),
      fieldValues: { draw: `data:image/png;base64,${png(0, 255, 0)}` },
    })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SigningImagesTooLargeError);
    expect((err as Error).message).toBe(
      'Your drawings and signature images are too large for this document. Use smaller images or type your signature.',
    );
    expectNothingWritten();
  });

  it('counts stored signature rows and the submitted initials', async () => {
    mocks.storedSignatures = [{ imagePngBase64: png(9, 9, 9) }];

    await expect(completeRecipientSigning(submit({
      signatureImagePngBase64: png(255, 0, 0),
      initialsImagePngBase64: png(0, 255, 0),
    }))).rejects.toBeInstanceOf(SigningImagesTooLargeError);
    expectNothingWritten();
  });

  it('accepts a submission within the budget (an image used twice counts once)', async () => {
    const same = png(255, 0, 0);

    await expect(completeRecipientSigning(submit({
      signatureImagePngBase64: same,
      initialsImagePngBase64: same,
      fieldValues: { draw: `data:image/png;base64,${png(0, 255, 0)}` },
    }))).rejects.toThrow('stop after the signing transaction');

    expect(mocks.signatureCreate).toHaveBeenCalledTimes(2);
    expect(mocks.committed).toHaveBeenCalledTimes(1);
  });

  it('skips the check for a submission without images, which cannot add to the total', async () => {
    vi.stubEnv('SEAL_MAX_IMAGE_PIXELS', '1');

    await expect(completeRecipientSigning(submit({ typedSignature: 'Signer' })))
      .rejects.toThrow('stop after the signing transaction');
    expect(mocks.reads).not.toHaveBeenCalled();
    expect(mocks.committed).toHaveBeenCalledTimes(1);
  });
});
