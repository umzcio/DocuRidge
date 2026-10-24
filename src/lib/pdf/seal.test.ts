import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  sources: new Map<string, Buffer>(),
  sealed: vi.fn(),
  event: vi.fn(),
  write: vi.fn(),
}));
vi.mock('../prisma', () => ({ prisma: {
  envelope: { findUnique: mocks.envelopeFind },
  documentFile: { create: mocks.write },
  sealedDocument: { create: mocks.write, upsert: mocks.write },
} }));
vi.mock('../storage', () => ({
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
  stageSealedPdf: mocks.write,
}));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: async () => 'sig',
  signHexWithKey: async () => 'sig',
}));
vi.mock('../audit/envelope', async () => ({
  canonicalJson: (await import('../audit/canonical')).canonicalJson,
  recordEnvelopeEvent: mocks.event,
  commitWithEnvelopeEvents: mocks.event,
  prepareEnvelopeEvent: (await vi.importActual<typeof import('../audit/envelope')>('../audit/envelope')).prepareEnvelopeEvent,
}));

/** Build the seal and hand its bytes to `mocks.sealed`, as the old store step did. */
async function seal(): Promise<void> {
  const build = await buildSealedEnvelope({ envelopeId: 'env' });
  mocks.sealed(build.bytes);
}

import { buildSealedEnvelope } from './seal';
import { PdfDecodeLimitError, loadPdfWithDecodeLimits } from './decode-limits';
import { PdfComplexityError } from './seal-limits';
import { sealedContentDigestFromBytes } from './content-digest';
import { checkPdfStructure } from '../verify/pdf-structure';

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

describe('buildSealedEnvelope decode budget', () => {
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

    await expect(seal()).resolves.toBeUndefined();
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

    const err = await seal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('total');
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('keeps the per-stream cap at seal time', async () => {
    process.env.PDF_MAX_DECODED_TOTAL_BYTES = String(64 * MiB);
    mocks.sources.set('wide.pdf', await pdfWithHeavyPages(1, 5 * MiB));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(['wide.pdf']));

    const err = await seal().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('stream');
  });
});

describe('buildSealedEnvelope has no side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sources.clear();
  });

  it('returns the sealed bytes and manifest without storing a file, a row or an event', async () => {
    mocks.sources.set('a.pdf', await pdfWithHeavyPages(1, 1024));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(['a.pdf']));
    const completedAt = new Date('2026-10-24T12:00:00Z');

    const build = await buildSealedEnvelope({ envelopeId: 'env', completion: { completedAt, actor: {} } });

    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.event).not.toHaveBeenCalled();
    expect((await PDFDocument.load(build.bytes)).getPageCount()).toBe(2);
    expect(build.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(build.manifest).toMatchObject({ envelope: { completedAt: completedAt.toISOString() } });
    expect(build.recipients).toEqual([]);
    expect(build.completionEvent).toMatchObject({ type: 'envelope.completed', seq: 1, createdAt: completedAt });
  });
});

describe('buildSealedEnvelope envelope-wide limits', () => {
  /** One page whose /Resources reach an indirect array of `elements` numbers (about 7 bytes each). */
  async function manyObjectsPdf(elements: number): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const big = doc.context.register(doc.context.obj(Array.from({ length: elements }, (_, i) => 100000 + i)));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Big: big }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q Q')));
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sources.clear();
    vi.unstubAllEnvs();
  });

  it('seals documents that each fit the decode budget even when their output together does not', async () => {
    // ~1 MiB of objects per document, 5 documents, 3 MiB decode budget: the
    // sealed output must be re-read (to digest it, and later to verify it)
    // without one budget having to cover every document's objects.
    vi.stubEnv('PDF_MAX_DECODED_TOTAL_BYTES', String(3 * MiB));
    const paths = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf'];
    for (const path of paths) mocks.sources.set(path, await manyObjectsPdf(150_000));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(paths));

    const build = await buildSealedEnvelope({ envelopeId: 'env' });

    // The final file reloads, and digests to what the manifest signed, under one budget.
    const digest = await sealedContentDigestFromBytes(build.bytes);
    expect(digest).toEqual((build.manifest as { sealedContent: unknown }).sealedContent);
    await expect(checkPdfStructure(build.bytes)).resolves.toBeUndefined();
  });

  it('refuses an envelope whose documents together exceed the envelope seal-cost total', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_SEAL_OBJECTS', '250000');
    for (const path of ['a.pdf', 'b.pdf']) mocks.sources.set(path, await manyObjectsPdf(150_000));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(['a.pdf', 'b.pdf']));

    const err = await buildSealedEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('envelope_seal_objects');
  });

  it('refuses an envelope with more documents than the item cap', async () => {
    vi.stubEnv('PDF_MAX_ENVELOPE_ITEMS', '2');
    const paths = ['a.pdf', 'b.pdf', 'c.pdf'];
    for (const path of paths) mocks.sources.set(path, await pdfWithHeavyPages(1, 16));
    mocks.envelopeFind.mockResolvedValue(envelopeWith(paths));

    const err = await buildSealedEnvelope({ envelopeId: 'env' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('envelope_items');
  });
});
