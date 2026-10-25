import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  envelope: null as unknown as Record<string, unknown>,
  updateMany: vi.fn(),
  transaction: vi.fn(),
  commit: vi.fn(),
}));

vi.mock('../prisma', () => ({
  prisma: {
    envelope: {
      findFirst: async () => mocks.envelope,
      updateMany: mocks.updateMany,
    },
    $transaction: mocks.transaction,
  },
}));
vi.mock('../storage', async (importActual) => ({
  ...(await importActual<typeof import('../storage')>()),
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
}));
vi.mock('../audit/envelope', () => ({
  commitWithEnvelopeEvents: mocks.commit,
  recordEnvelopeEvent: vi.fn(),
  publishEnvelopeEvents: vi.fn(),
}));
vi.mock('../pdf/seal', () => ({ buildSealedEnvelope: vi.fn(), persistSealedEnvelope: vi.fn() }));
vi.mock('../mail', () => ({ sendMail: vi.fn() }));
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu' }) }));

import { sendEnvelope } from './lifecycle';
import { instantiateTemplate } from '../templates/service';
import { FieldCapError } from './field-caps';
import { clearSealCostCache } from '../pdf/envelope-seal-check';

const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };

async function pagesPdf(count: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  clearSealCostCache();
  mocks.sources.set('org1/ok.pdf', await pagesPdf(1));
  // A template document stored before the seal caps existed: it never
  // passed the upload check, and now exceeds the page cap.
  mocks.sources.set('org1/legacy.pdf', await pagesPdf(3));
  vi.stubEnv('PDF_MAX_PAGES', '2');
});

function envelopeWith(paths: string[], extra: Record<string, unknown> = {}) {
  return {
    id: 'env1', orgId: 'org1', createdById: 'u1', status: 'DRAFT', type: 'DOCUMENT', title: 'Contract',
    expiresAt: null, routingMode: 'PARALLEL', message: null, meta: null,
    items: paths.map((p, i) => ({ id: `item${i}`, order: i + 1, title: `Doc ${i + 1}`, pageCount: 1, documentFileId: `df${i}`, documentFile: { storagePath: p } })),
    recipients: [{ id: 'r1', email: 'alice@example.com', name: 'Alice', recipientRole: 'SIGNER', signingOrder: 1, tokenJti: null }],
    fields: [{ id: 'f1', recipientId: 'r1', required: true, envelopeItemId: 'item0' }],
    ...extra,
  };
}

describe('send refuses documents sealing could not process', () => {
  it('refuses to send an envelope with a document over a seal cap, before anything changes', async () => {
    mocks.envelope = envelopeWith(['org1/ok.pdf', 'org1/legacy.pdf']);

    await expect(sendEnvelope({ ctx, envelopeId: 'env1' }))
      .rejects.toThrow(/"Doc 2" is too large or complex to seal/);

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to instantiate a template with such a document, before creating the envelope', async () => {
    mocks.envelope = envelopeWith(['org1/legacy.pdf'], { type: 'TEMPLATE', recipients: [] });

    await expect(instantiateTemplate({ ctx, templateId: 'env1', roleMappings: {} }))
      .rejects.toThrow(/"Doc 1" is too large or complex to seal/);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe('send and template use refuse envelopes over the field cap', () => {
  /** 2001 fields over 11 pages of the first document, as a template or API instance could hold them. */
  const manyFields = Array.from({ length: 2001 }, (_, i) => ({
    id: `f${i}`, recipientId: 'r1', required: true, envelopeItemId: 'item0', page: (i % 11) + 1,
  }));

  it('refuses to send an envelope holding 2001 fields, and sends nothing', async () => {
    vi.stubEnv('PDF_MAX_PAGES', '2000');
    mocks.envelope = envelopeWith(['org1/ok.pdf'], { fields: manyFields });

    await expect(sendEnvelope({ ctx, envelopeId: 'env1' })).rejects.toBeInstanceOf(FieldCapError);

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to instantiate a 2001-field template, before creating the envelope', async () => {
    vi.stubEnv('PDF_MAX_PAGES', '2000');
    mocks.envelope = envelopeWith(['org1/ok.pdf'], { type: 'TEMPLATE', recipients: [], fields: manyFields });

    await expect(instantiateTemplate({ ctx, templateId: 'env1', roleMappings: {} }))
      .rejects.toBeInstanceOf(FieldCapError);

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
