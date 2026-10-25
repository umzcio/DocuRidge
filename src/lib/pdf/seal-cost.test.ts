import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFStream } from 'pdf-lib';

const mocks = vi.hoisted(() => ({
  envelopeFind: vi.fn(),
  rows: new Map<string, Record<string, unknown> & { id: string }>(),
  uploadsDir: '',
  sealed: vi.fn(),
}));
vi.mock('../prisma', async () => {
  const { fakeDocumentFileTable } = await import('../documents/__fixtures__/stored-documents');
  return { prisma: { envelope: { findUnique: mocks.envelopeFind }, documentFile: fakeDocumentFileTable(mocks.rows) } };
});
vi.mock('../env', () => ({ getEnv: () => ({ UPLOADS_DIR: mocks.uploadsDir }) }));
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
import { SealedContentStructureError } from './page-tree';
import { seedCanonicalDocument, seedLegacyDocument, type Row } from '../documents/__fixtures__/stored-documents';

mocks.uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-seal-cost-'));
afterAll(() => rmSync(mocks.uploadsDir, { recursive: true, force: true }));

function envelopeWith(ids: string[]) {
  return {
    id: 'env', orgId: 'org', title: 'Envelope', sentAt: null, completedAt: null,
    org: { name: 'Org' }, createdBy: { name: 'Sender', email: 'sender@example.com' },
    items: ids.map((id, order) => ({
      id: `item-${order}`, order, title: id, pageCount: 1, documentFileId: id, documentFile: mocks.rows.get(id),
    })),
    recipients: [], fields: [], auditEvents: [],
  };
}

/** Store `bytes` with its canonical copy, as upload does. */
async function store(bytes: Uint8Array): Promise<Row> {
  return (await seedCanonicalDocument(mocks.rows, mocks.uploadsDir, 'doc.pdf', bytes)).row;
}

/** Seal an envelope of the one stored document; the sealed bytes go to `mocks.sealed`. */
async function sealStored(): Promise<unknown> {
  mocks.envelopeFind.mockResolvedValue(envelopeWith(['doc.pdf']));
  return buildSealedEnvelope({ envelopeId: 'env' }).then((build) => { mocks.sealed(build.bytes); }, (e: unknown) => e);
}

async function sealOne(bytes: Uint8Array): Promise<unknown> {
  await store(bytes);
  return sealStored();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  vi.unstubAllEnvs();
});

describe('buildSealedEnvelope form flattening caps', () => {
  // The form is flattened when the canonical copy is made. A stored document
  // that never had one (from before canonical copies) is canonicalized at
  // seal time under the same caps, and a refusal fails the seal as a
  // document to replace.
  it.each([
    ['shared /Kids (2^24 field paths)', () => sharedKidsFormPdf(24)],
    ['500 pages sharing one 50-entry /Annots array', () => sharedAnnotsPdf(500, 50)],
  ] as const)('fails cleanly, in bounded time, on a legacy document with %s', async (_name, build) => {
    const row = seedLegacyDocument(mocks.rows, mocks.uploadsDir, 'doc.pdf', await build());
    const started = Date.now();
    const err = await sealStored();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(err).toBeInstanceOf(SealedContentStructureError);
    expect(row.canonicalRefusal).toBe('pdf_too_complex');
    expect(mocks.sealed).not.toHaveBeenCalled();
  });

  it('still seals an ordinary form-bearing PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField('name');
    field.setText('Jane Signer');
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    expect(await sealOne(await doc.save())).toBeUndefined();
    expect(mocks.sealed).toHaveBeenCalledTimes(1);
  });
});

describe('buildSealedEnvelope copies resources shared between pages once', () => {
  const IMAGE = 256 * 1024;

  async function sealedFrom(bytes: Uint8Array): Promise<Buffer> {
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

  // A canonical copy made under the caps of its day is held to today's caps
  // when it is sealed.
  it('refuses a document over the page cap before copying anything', async () => {
    await store(await sharedImagePdf(60, 1024));
    vi.stubEnv('PDF_MAX_PAGES', '50');
    const copyPages = vi.spyOn(PDFDocument.prototype, 'copyPages');
    const err = await sealStored();
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('pages');
    expect(copyPages).not.toHaveBeenCalled();
    expect(mocks.sealed).not.toHaveBeenCalled();
    copyPages.mockRestore();
  });

  it('refuses a document whose pages reach more stream bytes than the cap', async () => {
    await store(await sharedImagePdf(3, IMAGE));
    vi.stubEnv('PDF_MAX_SEAL_BYTES', String(IMAGE / 2));
    const err = await sealStored();
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('seal_bytes');
  });
});
