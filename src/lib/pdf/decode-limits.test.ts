import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  PdfDecodeLimitError,
  loadPdfWithDecodeLimits,
  withPdfDecodeBudget,
} from './decode-limits';
import { appendUprightPage } from './upright-page';
import { sealedContentDigestFromBytes } from './content-digest';
import { buildBombPdf, doubleFlate } from './__fixtures__/bomb-pdf';

const MiB = 1024 * 1024;
const ORIGINAL = {
  stream: process.env.PDF_MAX_DECODED_STREAM_BYTES,
  total: process.env.PDF_MAX_DECODED_TOTAL_BYTES,
};

describe('PDF decode limits', () => {
  beforeEach(() => {
    delete process.env.PDF_MAX_DECODED_STREAM_BYTES;
    delete process.env.PDF_MAX_DECODED_TOTAL_BYTES;
  });

  afterAll(() => {
    for (const [k, v] of [['PDF_MAX_DECODED_STREAM_BYTES', ORIGINAL.stream], ['PDF_MAX_DECODED_TOTAL_BYTES', ORIGINAL.total]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('rejects a nested-FlateDecode /ObjStm bomb at load with the default caps', async () => {
    // 160 MiB decoded from a few hundred bytes: over the 64 MiB per-stream default.
    const bomb = buildBombPdf('objstm', doubleFlate(160 * MiB));
    expect(bomb.length).toBeLessThan(4096);

    const err = await loadPdfWithDecodeLimits(bomb).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('stream');
  });

  it('rejects a /Contents bomb when page contents are decoded (upload check)', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const bomb = buildBombPdf('contents', doubleFlate(8 * MiB));

    // A plain load never touches page contents, which is why this variant
    // used to pass upload and detonate at seal time.
    await expect(loadPdfWithDecodeLimits(bomb)).resolves.toBeInstanceOf(PDFDocument);
    await expect(loadPdfWithDecodeLimits(bomb, { decodePageContents: true })).rejects.toBeInstanceOf(PdfDecodeLimitError);
  });

  it('rejects a /Contents bomb at seal time when the page is embedded', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const bomb = buildBombPdf('contents', doubleFlate(8 * MiB));
    const source = await PDFDocument.load(bomb);
    const out = await PDFDocument.create();

    // appendUprightPage builds the page's Form XObject, decoding /Contents.
    await expect(withPdfDecodeBudget(async () => {
      await appendUprightPage(out, source.getPage(0));
      return out.save();
    })).rejects.toBeInstanceOf(PdfDecodeLimitError);
  });

  it('enforces the per-document total across many streams that are each under the per-stream cap', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(4 * MiB);
    process.env.PDF_MAX_DECODED_TOTAL_BYTES = String(6 * MiB);
    const doc = await PDFDocument.create();
    const streams = [1, 2, 3].map(() => doc.context.flateStream(Buffer.alloc(3 * MiB)));

    const err = await withPdfDecodeBudget(async () => {
      for (const s of streams) decodePDFRawStream(s as unknown as PDFRawStream).decode();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PdfDecodeLimitError);
    expect((err as PdfDecodeLimitError).limit).toBe('total');
  });

  it('surfaces a limit hit even when pdf-lib swallows the error internally', async () => {
    // pdf-lib's parser catches errors from an /ObjStm and carries on with an
    // "invalid object"; the budget must still fail the whole load.
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const bomb = buildBombPdf('objstm', doubleFlate(8 * MiB));
    await expect(loadPdfWithDecodeLimits(bomb)).rejects.toBeInstanceOf(PdfDecodeLimitError);
  });

  it('applies the per-stream cap to pdf-lib decoding outside any budget scope', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const doc = await PDFDocument.create();
    const stream = doc.context.flateStream(Buffer.alloc(2 * MiB));
    expect(() => decodePDFRawStream(stream as unknown as PDFRawStream).decode()).toThrow(PdfDecodeLimitError);
  });

  it('keeps concurrent budgets independent', async () => {
    process.env.PDF_MAX_DECODED_TOTAL_BYTES = String(5 * MiB);
    const doc = await PDFDocument.create();
    const decodeThree = () => withPdfDecodeBudget(async () => {
      for (let i = 0; i < 3; i++) {
        decodePDFRawStream(doc.context.flateStream(Buffer.alloc(1 * MiB)) as unknown as PDFRawStream).decode();
        await new Promise((r) => setTimeout(r, 1));
      }
    });
    // Each scope decodes 3 MiB: fine alone, would trip 5 MiB if they shared a counter.
    await expect(Promise.all([decodeThree(), decodeThree()])).resolves.toBeDefined();
  });

  it('loads an ordinary PDF and decodes its contents within the limits', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 });
    const bytes = await doc.save();
    const loaded = await loadPdfWithDecodeLimits(bytes, { decodePageContents: true });
    expect(loaded.getPageCount()).toBe(1);
  });

  it('bounds the legacy (v1) sealed-content digest, which decodes page contents', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const bomb = buildBombPdf('contents', doubleFlate(8 * MiB));
    await expect(sealedContentDigestFromBytes(bomb, 1)).rejects.toBeInstanceOf(PdfDecodeLimitError);
  });

  it('computes the current (v2) digest without decoding any stream', async () => {
    process.env.PDF_MAX_DECODED_STREAM_BYTES = String(1 * MiB);
    const bomb = buildBombPdf('contents', doubleFlate(8 * MiB));
    await expect(sealedContentDigestFromBytes(bomb, 2)).resolves.toMatchObject({ digestVersion: 2, pageCount: 1 });
  });
});
