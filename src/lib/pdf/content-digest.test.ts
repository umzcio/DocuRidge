import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sealedContentDigestFromBytes } from './content-digest';

/** Build a simple one-page PDF with a text string drawn on it. */
async function buildOnePagePdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(text, { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  return doc.save();
}

/** Build a two-page PDF, each page carrying its own distinguishing text. */
async function buildTwoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([612, 792]);
  page1.drawText('page one', { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  const page2 = doc.addPage([612, 792]);
  page2.drawText('page two', { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });
  return doc.save();
}

describe('sealedContentDigestFromBytes', () => {
  it('is stable across a load -> save -> load round trip', async () => {
    const bytes = await buildOnePagePdf('hello');
    const first = await sealedContentDigestFromBytes(bytes);

    const reloaded = await PDFDocument.load(bytes);
    const resaved = await reloaded.save();
    const second = await sealedContentDigestFromBytes(resaved);

    expect(second).toEqual(first);
  });

  it('is stable across attaching a file and re-saving (the seal-flow property)', async () => {
    const bytes = await buildOnePagePdf('hello');
    const before = await sealedContentDigestFromBytes(bytes);

    const doc = await PDFDocument.load(bytes);
    await doc.attach(new TextEncoder().encode('{"k":"v"}'), 'docuridge-manifest.json', {
      mimeType: 'application/json',
    });
    const withAttachment = await doc.save();
    const after = await sealedContentDigestFromBytes(withAttachment);

    expect(after).toEqual(before);
  });

  it('detects a text edit on the affected page', async () => {
    const bytes = await buildOnePagePdf('original text');
    const before = await sealedContentDigestFromBytes(bytes);

    const doc = await PDFDocument.load(bytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.getPages()[0]!;
    page.drawText('tampered text', { x: 50, y: 650, size: 12, font, color: rgb(0, 0, 0) });
    const tamperedBytes = await doc.save();
    const after = await sealedContentDigestFromBytes(tamperedBytes);

    expect(after.pageDigests[0]).not.toBe(before.pageDigests[0]);
  });

  it('detects an added drawing on one page and localizes it to that page', async () => {
    const bytes = await buildTwoPagePdf();
    const before = await sealedContentDigestFromBytes(bytes);

    const doc = await PDFDocument.load(bytes);
    const page2 = doc.getPages()[1]!;
    page2.drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(1, 0, 0) });
    const tamperedBytes = await doc.save();
    const after = await sealedContentDigestFromBytes(tamperedBytes);

    expect(after.pageDigests[1]).not.toBe(before.pageDigests[1]);
    expect(after.pageDigests[0]).toBe(before.pageDigests[0]);
  });

  it('detects a MediaBox (page size) change', async () => {
    const docA = await PDFDocument.create();
    docA.addPage([612, 792]);
    const bytesA = await docA.save();

    const docB = await PDFDocument.create();
    docB.addPage([400, 600]);
    const bytesB = await docB.save();

    const digestA = await sealedContentDigestFromBytes(bytesA);
    const digestB = await sealedContentDigestFromBytes(bytesB);

    expect(digestA.pageDigests[0]).not.toBe(digestB.pageDigests[0]);
  });

  it('covers XObject content — embedding a different source page changes the digest', async () => {
    async function buildOutputWithEmbeddedSource(sourceText: string): Promise<Uint8Array> {
      const source = await PDFDocument.create();
      const font = await source.embedFont(StandardFonts.Helvetica);
      const sourcePage = source.addPage([612, 792]);
      sourcePage.drawText(sourceText, { x: 50, y: 700, size: 12, font, color: rgb(0, 0, 0) });

      // Mirror seal.ts:72-80 — embed the source page as a Form XObject and
      // draw it onto a fresh page in the output document.
      const out = await PDFDocument.create();
      const [embeddedPage] = await out.embedPages([sourcePage]);
      const { width, height } = sourcePage.getSize();
      const page = out.addPage([width, height]);
      page.drawPage(embeddedPage!, { x: 0, y: 0, width, height });
      return out.save();
    }

    const bytesA = await buildOutputWithEmbeddedSource('CONTRACT AMOUNT: $10,000');
    const bytesB = await buildOutputWithEmbeddedSource('CONTRACT AMOUNT: $100,000');

    const digestA = await sealedContentDigestFromBytes(bytesA);
    const digestB = await sealedContentDigestFromBytes(bytesB);

    expect(digestA.pageDigests[0]).not.toBe(digestB.pageDigests[0]);
  });

  it('reports pageCount and pageDigests consistent with the document', async () => {
    const bytes = await buildTwoPagePdf();
    const digest = await sealedContentDigestFromBytes(bytes);
    const doc = await PDFDocument.load(bytes);

    expect(digest.pageCount).toBe(doc.getPages().length);
    expect(digest.pageDigests.length).toBe(digest.pageCount);
    expect(digest.algorithm).toBe('sha256');
  });

  it('digests an empty single-page document without throwing', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const bytes = await doc.save();

    const digest = await sealedContentDigestFromBytes(bytes);

    expect(digest.pageCount).toBe(1);
    expect(digest.pageDigests).toHaveLength(1);
    expect(typeof digest.pageDigests[0]).toBe('string');
  });
});
