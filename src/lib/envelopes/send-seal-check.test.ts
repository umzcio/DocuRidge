import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  sources: new Map<string, Buffer>(),
  rows: new Map<string, Record<string, unknown>>(),
  uploadsDir: '',
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
    documentFile: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = mocks.rows.get(where.id);
        return row ? structuredClone(row) : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = mocks.rows.get(where.id as string);
        if (!row || !Object.entries(where).every(([k, v]) => row[k] === v)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      },
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
vi.mock('../env', () => ({ getEnv: () => ({ PUBLIC_URL: 'https://docs.example.edu', UPLOADS_DIR: mocks.uploadsDir }) }));

import { sendEnvelope } from './lifecycle';
import { instantiateTemplate } from '../templates/service';
import { FieldCapError } from './field-caps';
import { EnvelopeNotSealableError } from '../pdf/envelope-seal-check';
import { solidPng } from '../verify/__fixtures__/sealed-pdf';

const ctx = { userId: 'u1', orgId: 'org1', role: 'ADMIN' as const };

async function pagesPdf(count: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.uploadsDir ||= mkdtempSync(join(tmpdir(), 'docuridge-send-seal-test-'));
  mocks.rows.clear();
  mocks.sources.set('org1/ok.pdf', await pagesPdf(1));
  // A template document stored before the seal caps existed: it never
  // passed the upload check, and now exceeds the page cap.
  mocks.sources.set('org1/legacy.pdf', await pagesPdf(3));
  mocks.sources.set('org1/eleven.pdf', await pagesPdf(11));
  vi.stubEnv('PDF_MAX_PAGES', '2');
  // All are stored documents with no canonical copy yet.
  for (const storagePath of ['org1/ok.pdf', 'org1/legacy.pdf', 'org1/eleven.pdf']) {
    mocks.rows.set(`df:${storagePath}`, {
      id: `df:${storagePath}`, orgId: 'org1', storagePath,
      canonicalStoragePath: null, canonicalSha256: null, canonicalVersion: null,
      canonicalPageCount: null, canonicalSealCost: null, canonicalRefusal: null,
    });
  }
});

afterAll(() => {
  rmSync(mocks.uploadsDir, { recursive: true, force: true });
});

function envelopeWith(paths: string[], extra: Record<string, unknown> = {}) {
  return {
    id: 'env1', orgId: 'org1', createdById: 'u1', status: 'DRAFT', type: 'DOCUMENT', title: 'Contract',
    expiresAt: null, routingMode: 'PARALLEL', message: null, meta: null,
    items: paths.map((p, i) => ({ id: `item${i}`, order: i + 1, title: `Doc ${i + 1}`, pageCount: 1, documentFileId: `df:${p}` })),
    recipients: [{ id: 'r1', email: 'alice@example.com', name: 'Alice', recipientRole: 'SIGNER', signingOrder: 1, tokenJti: null, signatures: [] }],
    fields: [{ id: 'f1', recipientId: 'r1', required: true, envelopeItemId: 'item0' }],
    ...extra,
  };
}

describe('send refuses documents sealing could not process', () => {
  it('refuses to send an envelope with a document over a seal cap, before anything changes', async () => {
    mocks.envelope = envelopeWith(['org1/ok.pdf', 'org1/legacy.pdf']);

    await expect(sendEnvelope({ ctx, envelopeId: 'env1' }))
      .rejects.toThrow(/"Doc 2" can't be sent: This PDF is too large or complex/);

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to instantiate a template with such a document, before creating the envelope', async () => {
    mocks.envelope = envelopeWith(['org1/legacy.pdf'], { type: 'TEMPLATE', recipients: [] });

    await expect(instantiateTemplate({ ctx, templateId: 'env1', roleMappings: {} }))
      .rejects.toThrow(/"Doc 1" can't be sent: This PDF is too large or complex/);

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
    mocks.envelope = envelopeWith(['org1/eleven.pdf'], { fields: manyFields });

    const err = await sendEnvelope({ ctx, envelopeId: 'env1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldCapError);
    expect((err as Error).message).not.toMatch(/which has/);

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

describe('send refuses envelopes whose images would exceed the seal image budget', () => {
  const stamp = (id: string, png: Buffer) => ({
    id, recipientId: 'r1', required: false, envelopeItemId: 'item0', page: 1, type: 'STAMP', value: null,
    meta: { stampImageBase64: png.toString('base64') },
  });
  const signature = { id: 'f1', recipientId: 'r1', required: true, envelopeItemId: 'item0', page: 1, type: 'SIGNATURE', value: null, meta: null };

  it('refuses STAMP images that together exceed SEAL_MAX_IMAGE_PIXELS, and sends nothing', async () => {
    vi.stubEnv('SEAL_MAX_IMAGE_PIXELS', '700');
    // Two distinct 20x20 stamps: 800 pixels.
    mocks.envelope = envelopeWith(['org1/ok.pdf'], {
      fields: [signature, stamp('s1', solidPng(255, 0, 0, 20)), stamp('s2', solidPng(0, 255, 0, 20))],
    });

    const err = await sendEnvelope({ ctx, envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnvelopeNotSealableError);
    expect((err as Error).message).toMatch(/images on this envelope are too large to seal together/);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('counts stored signature images with the stamps, and an image used twice once', async () => {
    vi.stubEnv('SEAL_MAX_IMAGE_PIXELS', '700');
    const red = solidPng(255, 0, 0, 20);
    const withStored = (signatures: Array<{ imagePngBase64: string | null }>) => envelopeWith(['org1/ok.pdf'], {
      fields: [signature, stamp('s1', red), stamp('s2', red)],
      recipients: [{ id: 'r1', email: 'alice@example.com', name: 'Alice', recipientRole: 'SIGNER', signingOrder: 1, tokenJti: null, signatures }],
    });

    // The same stamp twice is one 400-pixel image; a stored 20x20 signature makes 800.
    mocks.envelope = withStored([{ imagePngBase64: solidPng(0, 0, 255, 20).toString('base64') }]);
    await expect(sendEnvelope({ ctx, envelopeId: 'env1' })).rejects.toBeInstanceOf(EnvelopeNotSealableError);

    mocks.envelope = withStored([{ imagePngBase64: null }]);
    mocks.commit.mockRejectedValueOnce(new Error('reached the commit'));
    await expect(sendEnvelope({ ctx, envelopeId: 'env1' })).rejects.toThrow('reached the commit');
  });
});

describe('send checks fields against the canonical page count, and records what was sent', () => {
  it('refuses a field on a page the document does not have, though the item row claims it', async () => {
    // A clone or template instance whose item row says 5 pages; the document has 1.
    mocks.envelope = envelopeWith(['org1/ok.pdf'], {
      fields: [{ id: 'f1', recipientId: 'r1', required: true, envelopeItemId: 'item0', page: 3 }],
    });
    (mocks.envelope.items as Array<Record<string, unknown>>)[0]!.pageCount = 5;

    const err = await sendEnvelope({ ctx, envelopeId: 'env1' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FieldCapError);
    expect((err as Error).message).toBe('A field is on page 3 of "Doc 1", which has 1 page(s).');
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('records each document\'s canonical sha256 in the envelope.sent event', async () => {
    mocks.envelope = envelopeWith(['org1/ok.pdf', 'org1/eleven.pdf'], {
      fields: [{ id: 'f1', recipientId: 'r1', required: true, envelopeItemId: 'item1', page: 11 }],
    });
    vi.stubEnv('PDF_MAX_PAGES', '2000');
    const recorded: Array<{ type: string; data: unknown }> = [];
    mocks.commit.mockImplementationOnce(async (_id: string, fn: (tx: unknown, record: unknown) => Promise<void>) => {
      const tx = { envelope: { updateMany: async () => ({ count: 1 }) } };
      await fn(tx, async (event: { type: string; data: unknown }) => { recorded.push(event); });
      throw new Error('stop after the commit');
    });

    await expect(sendEnvelope({ ctx, envelopeId: 'env1' })).rejects.toThrow('stop after the commit');

    const sent = recorded.find((e) => e.type === 'envelope.sent');
    expect(sent?.data).toEqual({
      routingMode: 'PARALLEL',
      recipientCount: 1,
      documents: [
        { itemId: 'item0', canonicalSha256: mocks.rows.get('df:org1/ok.pdf')!.canonicalSha256 },
        { itemId: 'item1', canonicalSha256: mocks.rows.get('df:org1/eleven.pdf')!.canonicalSha256 },
      ],
    });
    expect(mocks.rows.get('df:org1/ok.pdf')!.canonicalSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
