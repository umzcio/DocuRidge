import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { buildBombPdf, doubleFlate } from './__fixtures__/bomb-pdf';
import { sharedImagePdf } from './__fixtures__/shared-resource-pdf';
import { generatedTextFormPdf, sharedAnnotsPdf, sharedKidsFormPdf, wideFormPdf } from './__fixtures__/hostile-form-pdf';
import { inspectUploadedPdf } from './inspect-upload';

const MiB = 1024 * 1024;
const ORIGINAL_STREAM_CAP = process.env.PDF_MAX_DECODED_STREAM_BYTES;

async function ordinary(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
  return doc.save();
}

describe('inspectUploadedPdf', () => {
  beforeAll(() => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
  });
  afterAll(() => {
    if (ORIGINAL_STREAM_CAP === undefined) delete process.env.PDF_MAX_DECODED_STREAM_BYTES;
    else process.env.PDF_MAX_DECODED_STREAM_BYTES = ORIGINAL_STREAM_CAP;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('accepts an ordinary PDF with its page count and seal cost', async () => {
    const r = await inspectUploadedPdf(await ordinary());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pageCount).toBe(1);
      expect(r.sealCost).toBeDefined();
    }
  });

  for (const where of ['objstm', 'contents'] as const) {
    it(`refuses a nested-FlateDecode ${where} bomb as pdf_too_complex`, async () => {
      const r = await inspectUploadedPdf(buildBombPdf(where, doubleFlate(8 * MiB)));
      expect(r).toMatchObject({ ok: false, code: 'pdf_too_complex' });
    });
  }

  it('refuses garbage as unreadable_pdf', async () => {
    const r = await inspectUploadedPdf(new TextEncoder().encode('%PDF-1.7\nnot really a pdf'));
    expect(r).toMatchObject({ ok: false, code: 'unreadable_pdf' });
  });

  it.each([
    ['a /Fields graph of shared /Kids', () => sharedKidsFormPdf(24)],
    ['many pages sharing one huge /Annots array', () => sharedAnnotsPdf(500, 50)],
    ['a multiline field whose generated layout is unbounded', () => generatedTextFormPdf({
      text: Array.from({ length: 2500 }, () => 'a').join(' '), multiline: true,
    })],
  ])('refuses %s as pdf_too_complex', async (_n, build) => {
    expect(await inspectUploadedPdf(await build())).toMatchObject({ ok: false, code: 'pdf_too_complex' });
  });

  it('refuses a form sealing cannot flatten, with the flatten message', async () => {
    const doc = await PDFDocument.load(await wideFormPdf(1));
    doc.getPage(0).node.delete(PDFName.of('Annots'));
    const r = await inspectUploadedPdf(await doc.save({ updateFieldAppearances: false }));
    expect(r).toMatchObject({ ok: false, code: 'unsupported_form' });
    if (!r.ok) expect(r.message).toMatch(/flattened PDF/);
  });

  it('accepts an ordinary form-bearing PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const field = doc.getForm().createTextField('name');
    field.setText('Jane Signer');
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
    expect((await inspectUploadedPdf(await doc.save())).ok).toBe(true);
  });

  it('refuses thousands of tiny pages sharing one image over the page cap', async () => {
    expect(await inspectUploadedPdf(await sharedImagePdf(2500, 64 * 1024))).toMatchObject({ ok: false, code: 'pdf_too_complex' });
  });

  it('accepts many pages sharing one large image, counting it once', async () => {
    expect((await inspectUploadedPdf(await sharedImagePdf(200, 1024 * 1024))).ok).toBe(true);
  });

  it('refuses a document over PDF_MAX_SEAL_BYTES', async () => {
    vi.stubEnv('PDF_MAX_SEAL_BYTES', String(512 * 1024));
    expect(await inspectUploadedPdf(await sharedImagePdf(3, 1024 * 1024))).toMatchObject({ ok: false, code: 'pdf_too_complex' });
  });

  it('refuses a document over PDF_MAX_SEAL_OBJECTS', async () => {
    vi.stubEnv('PDF_MAX_SEAL_OBJECTS', '200');
    expect(await inspectUploadedPdf(await sharedImagePdf(100, 1024))).toMatchObject({ ok: false, code: 'pdf_too_complex' });
  });
});
