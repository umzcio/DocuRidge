import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
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

const mocks = vi.hoisted(() => ({ decryptPdf: vi.fn() }));
vi.mock('./pdf/decrypt', async (orig) => ({
  ...(await orig<typeof import('./pdf/decrypt')>()),
  decryptPdf: mocks.decryptPdf,
}));
vi.mock('./pdf-worker/runner', async (orig) => {
  const actual = await orig<typeof import('./pdf-worker/runner')>();
  return { ...actual, runPdfJob: vi.fn(actual.runPdfJob) };
});

const { saveUploadedPdf, UploadValidationError } = await import('./storage');
const { runPdfJob, PdfWorkerError } = await import('./pdf-worker/runner');
const { createHash } = await import('node:crypto');

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

describe('saveUploadedPdf worker integration', () => {
  const realRun = vi.mocked(runPdfJob).getMockImplementation()!;
  beforeEach(() => { vi.mocked(runPdfJob).mockClear(); });
  afterEach(() => {
    vi.mocked(runPdfJob).mockReset();
    vi.mocked(runPdfJob).mockImplementation(realRun);
    mocks.decryptPdf.mockReset();
  });

  async function ordinary(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    return Buffer.from(await doc.save());
  }

  it('an encrypted upload is decrypted between two inspections and stored decrypted', async () => {
    const original = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('encrypted-ish')]);
    const decrypted = await ordinary();
    mocks.decryptPdf.mockResolvedValue(decrypted);
    vi.mocked(runPdfJob)
      .mockResolvedValueOnce({ ok: false, code: 'encrypted', message: 'This PDF is encrypted.' })
      .mockResolvedValueOnce({ ok: true, pageCount: 1, sealCost: { pages: 1, objects: 1, bytes: 1 } });
    const stored = await saveUploadedPdf({ orgId: 'org4', buffer: original, declaredMime: 'application/pdf' });
    expect(mocks.decryptPdf).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPdfJob)).toHaveBeenCalledTimes(2);
    expect(stored.sha256).toBe(createHash('sha256').update(decrypted).digest('hex'));
    expect(stored.sizeBytes).toBe(decrypted.length);
  });

  it('a worker timeout is refused as too complex', async () => {
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError('timeout'));
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('pdf_too_complex');
  });

  it('a busy worker gives the busy message', async () => {
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError('busy'));
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('busy');
    expect((err as Error).message).toBe('DocuRidge is busy processing other documents. Try again in a minute.');
  });

  it('an unavailable worker gives the busy message', async () => {
    vi.mocked(runPdfJob).mockRejectedValue(new PdfWorkerError('unavailable'));
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('busy');
  });

  it('decrypted bytes that still report encrypted get the old unreadable text', async () => {
    mocks.decryptPdf.mockResolvedValue(await ordinary());
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'encrypted', message: 'x' });
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('unreadable_pdf');
    expect((err as Error).message).toBe('PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.');
  });

  const okCost = { pages: 1, objects: 5, bytes: 100 };
  it.each([
    ['a missing sealCost', { ok: true, pageCount: 1 }],
    ['a negative cost', { ok: true, pageCount: 1, sealCost: { ...okCost, bytes: -1 } }],
    ['a NaN cost', { ok: true, pageCount: 1, sealCost: { ...okCost, objects: NaN } }],
    ['pageCount 0', { ok: true, pageCount: 0, sealCost: { ...okCost, pages: 0 } }],
    ['pages not matching pageCount', { ok: true, pageCount: 2, sealCost: okCost }],
    ['an over-cap forged cost', { ok: true, pageCount: 1, sealCost: { ...okCost, bytes: 1e12 } }],
    ['an unknown code', { ok: false, code: 'weird', message: 'boo' }],
    ['a non-object', 'ok'],
  ])('refuses %s from the worker as too complex', async (_n, out) => {
    vi.mocked(runPdfJob).mockResolvedValue(out as never);
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('pdf_too_complex');
  });

  it('never shows a forged worker message', async () => {
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'unreadable_pdf', message: 'FORGED' });
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('FORGED');
    expect((err as Error).message).toMatch(/corrupted or unreadable/);
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'unsupported_form', message: 'FORGED '.repeat(100) + 'flattened PDF' });
    const err2 = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err2 as Error).message).not.toContain('FORGED');
  });

  it('shows a fixed unreadable text, not the child\'s, when the inspect job itself fails', async () => {
    vi.mocked(runPdfJob).mockRejectedValue(new Error('TypeError at /app/pdf-worker.cjs:1:2 secret-ish child text'));
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('unreadable_pdf');
    expect((err as Error).message).toBe('PDF file looks corrupted or unreadable. Try re-saving from your PDF tool and uploading again.');
  });

  it('shows "PDF has no pages." for a zero-page upload', async () => {
    const empty = await PDFDocument.create();
    const bytes = Buffer.from(await empty.save({ addDefaultPage: false }));
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: bytes, declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadValidationError);
    expect((err as InstanceType<typeof UploadValidationError>).code).toBe('unreadable_pdf');
    expect((err as Error).message).toBe('PDF has no pages.');
  });

  it('uses the default unreadable text for a refusal reason it does not know', async () => {
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'unreadable_pdf', message: 'x', reason: 'made_up' } as never);
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/corrupted or unreadable/);
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'pdf_too_complex', message: 'x', reason: 'no_pages' } as never);
    const err2 = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err2 as Error).message).toMatch(/too large or complex/);
  });

  it('keeps a short flattened-PDF form message', async () => {
    vi.mocked(runPdfJob).mockResolvedValue({ ok: false, code: 'unsupported_form', message: 'Use a flattened PDF please' });
    const err = await saveUploadedPdf({ orgId: 'org4', buffer: await ordinary(), declaredMime: 'application/pdf' }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('Use a flattened PDF please');
  });
});

// pdf-lib logs "Invalid object ref" for the bomb fixtures' dangling objects; expected noise.
let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy?.mockRestore();
});
