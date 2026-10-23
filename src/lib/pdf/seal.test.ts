import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  sources: new Map<string, Buffer>(),
  sealed: vi.fn(),
  event: vi.fn(),
}));
vi.mock('../prisma', () => ({ prisma: {
  envelope: { findUnique: mocks.envelopeFind },
  documentFile: { create: async () => ({ id: 'sealed-file' }) },
  sealedDocument: { upsert: async () => ({}) },
} }));
vi.mock('../storage', () => ({
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
  saveSealedPdf: async (args: { buffer: Buffer }) => {
    mocks.sealed(args.buffer);
    return { relativePath: 'sealed.pdf', sizeBytes: args.buffer.length, sha256: 'f'.repeat(64) };
  },
}));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: async () => 'sig',
}));
vi.mock('../audit/envelope', async () => ({
  canonicalJson: (await import('../audit/canonical')).canonicalJson,
  recordEnvelopeEvent: mocks.event,
}));

import { sealEnvelope } from './seal';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits } from './decode-limits';

const MiB = 1024 * 1024;
const ORIGINAL = {
  stream: process.env.PDF_MAX_DECODED_STREAM_BYTES,
  total: process.env.PDF_MAX_DECODED_TOTAL_BYTES,
};

/** A PDF whose pages each carry a content stream decoding to `decodedBytes`. */
async function pdfWithHeavyPages(pageCount: number, decodedBytes: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    const content = doc.context.flateStream(Buffer.alloc(decodedBytes, 0x20));
    page.node.set(PDFName.of('Contents'), doc.context.register(content));
  }
  return Buffer.from(await doc.save());
}

function envelopeWith(paths: string[]) {
  return {
    id: 'env', orgId: 'org', title: 'Envelope', sentAt: null, completedAt: null,
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: paths.map((path, order) => ({
      id: `item-${order}`, order, title: path, pageCount: 1,
      documentFile: { storagePath: path, sha256: 'a'.repeat(64) },
    })),
    recipients: [], fields: [], auditEvents: [],
  };
}

describe('sealEnvelope decode budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sources.clear();
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(4 * MiB);
    process.env.PDF_MAX_DECODED_TOTAL_BYTES = String(4 * MiB);
  });

  afterAll(() => {
    for (const [k, v] of [['PDF_MAX_DECODED_STREAM_BYTES', ORIGINAL.stream], ['PDF_MAX_DECODED_TOTAL_BYTES', ORIGINAL.total]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('seals an envelope of documents that each passed the upload decode check', async () => {
    // Each file decodes 3 MiB: inside its own 4 MiB upload budget, but 9 MiB
    // together, which a single envelope-wide budget used to refuse after the
    // last signer had committed.
    const paths = ['a.pdf', 'b.pdf', 'c.pdf'];
    for (const path of paths) {
      const bytes = await pdfWithHeavyPages(1, 3 * MiB);
      await expect(loadPdfWithDecodeLimits(bytes, { decodePageContents: true })).resolves.toBeInstanceOf(PDFDocument);
      mocks.sources.set(path, bytes);
    }
    mocks.envelopeFind.mockResolvedValue(envelopeWith(paths));

    await expect(sealEnvelope({ envelopeId: 'env' })).resolves.toBeUndefined();
    expect(mocks.sealed).toHaveBeenCalledTimes(1);
    const sealed = await PDFDocument.load(mocks.sealed.mock.calls[0]![0] as Buffer);
    expect(sealed.getPageCount()).toBe(paths.length + 1); // + audit page
  });

  it('still refuses a single document whose pages decode past one budget', async () => {
    // Two 3 MiB pages in one file: the upload check refuses it, and so must sealing.
    const bytes = await pdfWithHeavyPages(2, 3 * MiB);
    await expect(loadPdfWithDecodeLimits(bytes, { decodePageContents: true })).rejects.toBeInstanceOf(PdfDecodeLimitError);
    mocks.sources.set('big.pdf', bytes);
    mocks.envelopeFind.mockResolvedValue(envelopeWith(['big.pdf']));

    const err = await sealEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('total');
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('keeps the per-stream cap at seal time', async () => {
    process.env.PDF_MAX_DECODED_TOTAL_BYTES = String(64 * MiB);
    mocks.sources.set('wide.pdf', await pdfWithHeavyPages(1, 5 * MiB));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(['wide.pdf']));

    const err = await sealEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('stream');
  });
});
