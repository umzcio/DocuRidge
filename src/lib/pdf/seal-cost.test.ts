import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFStream } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  sources: new Map<string, Buffer>(),
  sealed: vi.fn(),
}));
vi.mock('../prisma', () => ({ prisma: {
  envelope: { findUnique: mocks.envelopeFind },
  documentFile: { create: async () => ({ id: 'sealed-file' }) },
  sealedDocument: { upsert: async () => ({}) },
} }));
vi.mock('../storage', () => ({
  readPdfFromStorage: async (path: string) => mocks.sources.get(path)!,
  stageSealedPdf: vi.fn(),
}));
vi.mock('../crypto/org-key', () => ({
  getOrCreateOrgKey: async () => ({ keyId: 'key', fingerprint: 'fp', publicKeyPem: 'pem', algorithm: 'ed25519' }),
  signHex: async () => 'sig',
}));
vi.mock('../audit/envelope', async () => ({
  canonicalJson: (await import('../audit/canonical')).canonicalJson,
  recordEnvelopeEvent: vi.fn(),
}));

import { buildSealedEnvelope } from './seal';
import { PdfComplexityError } from './seal-limits';
import { sharedAnnotsPdf, sharedKidsFormPdf } from './__fixtures__/hostile-form-pdf';
import { sharedImagePdf } from './__fixtures__/shared-resource-pdf';

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

async function sealOne(bytes: Buffer): Promise<unknown> {
  mocks.sources.set('doc.pdf', bytes);
  mocks.envelopeFind.mockResolvedValue(envelopeWith(['doc.pdf']));
  return buildSealedEnvelope({ envelopeId: 'env' }).then((build) => { mocks.sealed(build.bytes); }, (e: unknown) => e);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sources.clear();
  vi.unstubAllEnvs();
});

describe('buildSealedEnvelope form flattening caps', () => {
  it.each([
    ['shared /Kids (2^24 field paths)', () => sharedKidsFormPdf(24), 'form_shape'],
    ['500 pages sharing one 50-entry /Annots array', () => sharedAnnotsPdf(500, 50), 'annotations'],
  ] as const)('fails cleanly, in bounded time, on %s', async (_name, build, limit) => {
    const bytes = await build();
    const started = Date.now();
    const err = await sealOne(bytes);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe(limit);
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('still seals an ordinary form-bearing PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField('name');
    field.setText('Jane Signer');
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    expect(await sealOne(Buffer.from(await doc.save()))).toBeUndefined();
    expect(mocks.sealed).toHaveBeenCalledTimes(1);
  });
});

describe('buildSealedEnvelope copies resources shared between pages once', () => {
  const IMAGE = 256 * 1024;

  async function sealedFrom(bytes: Buffer): Promise<Buffer> {
    expect(await sealOne(bytes)).toBeUndefined();
    return mocks.sealed.mock.calls.at(-1)![0] as Buffer;
  }

  function imageCount(doc: PDFDocument): number {
    return doc.context.enumerateIndirectObjects().filter(([, object]) =>
      object instanceof PDFStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')).length;
  }

  it.each([
    ['per-page /Resources', false],
    ['one inherited direct /Resources', true],
  ])('keeps sealed size and object count flat in page count (%s)', async (_name, inherited) => {
    const small = await sealedFrom(await sharedImagePdf(10, IMAGE, { inherited }));
    const large = await sealedFrom(await sharedImagePdf(80, IMAGE, { inherited }));
    // Per-page copies would add 70 x 256 KiB; one copy adds only page overhead.
    expect(small.length).toBeLessThan(2 * IMAGE);
    expect(large.length).toBeLessThan(2 * IMAGE);
    expect(large.length - small.length).toBeLessThan(IMAGE / 4);
    const sealed = await PDFDocument.load(large);
    expect(sealed.getPageCount()).toBe(81); // + audit page
    expect(imageCount(sealed)).toBe(1);
    const smallObjects = (await PDFDocument.load(small)).context.enumerateIndirectObjects().length;
    // Each extra page adds a fixed handful of objects (page, content, XObject).
    expect(sealed.context.enumerateIndirectObjects().length - smallObjects).toBeLessThanOrEqual(70 * 8);
  });

  it('refuses a document over the page cap before embedding anything', async () => {
    vi.stubEnv('PDF_MAX_PAGES', '50');
    const err = await sealOne(await sharedImagePdf(60, 1024));
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('pages');
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('refuses a document whose pages reach more stream bytes than the cap', async () => {
    vi.stubEnv('PDF_MAX_SEAL_BYTES', String(IMAGE / 2));
    const err = await sealOne(await sharedImagePdf(3, IMAGE));
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('seal_bytes');
  });
});
