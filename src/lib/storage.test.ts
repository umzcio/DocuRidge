import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { buildBombPdf, doubleFlate } from './pdf/__fixtures__/bomb-pdf';
import { sharedImagePdf } from './pdf/__fixtures__/shared-resource-pdf';
import { generatedTextFormPdf, sharedAnnotsPdf, sharedKidsFormPdf, wideFormPdf } from './pdf/__fixtures__/hostile-form-pdf';

const uploadsDir = mkdtempSync(join(tmpdir(), 'docuridge-storage-test-'));

vi.mock('./env', () => ({
  getEnv: () => ({ MAX_UPLOAD_BYTES: 26214400, UPLOADS_DIR: uploadsDir }),
}));

const { saveUploadedPdf, UploadValidationError } = await import('./storage');

const MiB = 1024 * 1024;
const ORIGINAL_STREAM_CAP = process.env.PDF_MAX_DECODED_STREAM_BYTES;

describe('saveUploadedPdf decode limits', () => {
  beforeAll(() => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
  });

  afterAll(() => {
    if (ORIGINAL_STREAM_CAP === undefined) delete process.env.PDF_MAX_DECODED_STREAM_BYTES;
    else process.env.PDF_MAX_DECODED_STREAM_BYTES = ORIGINAL_STREAM_CAP;
    rmSync(uploadsDir, { recursive: true, force: true });
  });

  for (const where of ['objstm', 'contents'] as const) {
    it(`rejects a nested-FlateDecode ${where} bomb as pdf_too_complex and stores nothing`, async () => {
      const bomb = buildBombPdf(where, doubleFlate(8 * MiB));
      const err = await saveUploadedPdf({ orgId: 'org1', buffer: bomb, declaredMime: 'application/pdf' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UploadValidationError);
      expect((err as InstanceType<typeof UploadValidationError>).code).toBe('pdf_too_complex');
      expect(readdirSync(uploadsDir)).toEqual([]);
    });
  }

  it('accepts an ordinary PDF', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const stored = await saveUploadedPdf({
      orgId: 'org1',
      buffer: Buffer.from(await doc.save()),
      declaredMime: 'application/pdf',
    });
    expect(stored.relativePath).toMatch(/^org1\/[0-9a-f]{64}\.pdf$/);
  });
});

describe('saveUploadedPdf seal-time form caps', () => {
  async function uploadError(buffer: Buffer): Promise<unknown> {
    return saveUploadedPdf({ orgId: 'org2', buffer, declaredMime: 'application/pdf' }).catch((e: unknown) => e);
  }

  it.each([
    ['a /Fields graph of shared /Kids', () => sharedKidsFormPdf(24)],
    ['many pages sharing one huge /Annots array', () => sharedAnnotsPdf(500, 50)],
    ['a multiline field whose generated layout is unbounded', () => generatedTextFormPdf({
      text: Array.from({ length: 2500 }, () => 'a').join(' '), multiline: true,
    })],
  ])('refuses %s as pdf_too_complex', async (_name, build) => {
    const err = await uploadError(await build());
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('pdf_too_complex');
  });

  it('refuses a form sealing cannot flatten, with the flatten message', async () => {
    const doc = await PDFDocument.load(await wideFormPdf(1));
    doc.getPage(0).node.delete(PDFName.of('Annots')); // the widget is on no page
    const err = await uploadError(Buffer.from(await doc.save({ updateFieldAppearances: false })));
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('unsupported_form');
    expect((err as Error).message).toMatch(/flattened PDF/);
  });

  it('accepts an ordinary form-bearing PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField('name');
    field.setText('Jane Signer');
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    const stored = await saveUploadedPdf({
      orgId: 'org2', buffer: Buffer.from(await doc.save()), declaredMime: 'application/pdf',
    });
    expect(stored.relativePath).toMatch(/^org2\/[0-9a-f]{64}\.pdf$/);
  });
});

describe('saveUploadedPdf seal-cost caps', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  async function uploadCode(buffer: Buffer): Promise<string | undefined> {
    const err = await saveUploadedPdf({ orgId: 'org3', buffer, declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    if (err === undefined || !(err instanceof Error)) return undefined;
    expect(err).toBeInstanceOf(UploadValidationError);
    return (err as InstanceType<typeof UploadValidationError>).code;
  }

  it('refuses thousands of tiny pages sharing one image over the page cap', async () => {
    expect(await uploadCode(await sharedImagePdf(2500, 64 * 1024))).toBe('pdf_too_complex');
  });

  it('accepts many pages sharing one large image, counting it once as sealing copies it', async () => {
    // 200 pages x 1 MiB would be 200 MiB if counted per page, over the 128 MiB cap.
    expect(await uploadCode(await sharedImagePdf(200, 1024 * 1024))).toBeUndefined();
  });

  it('refuses a document whose pages reach more stream bytes than PDF_MAX_SEAL_BYTES', async () => {
    vi.stubEnv('PDF_MAX_SEAL_BYTES', String(512 * 1024));
    expect(await uploadCode(await sharedImagePdf(3, 1024 * 1024))).toBe('pdf_too_complex');
  });

  it('refuses a document whose pages reach more objects than PDF_MAX_SEAL_OBJECTS', async () => {
    vi.stubEnv('PDF_MAX_SEAL_OBJECTS', '200');
    expect(await uploadCode(await sharedImagePdf(100, 1024))).toBe('pdf_too_complex');
  });
});
