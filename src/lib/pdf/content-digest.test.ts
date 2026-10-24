import { describe, it, expect } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from 'pdf-lib';
import { SealedContentStructureError, sealedContentDigestFromBytes } from './content-digest';

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

  it('v3 signs the page tree; v2 only the pages', async () => {
    const bytes = await buildTwoPagePdf();
    const reparented = await (async () => {
      const doc = await PDFDocument.load(bytes);
      const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
      const root = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
      const second = doc.getPage(1);
      const node = doc.context.register(doc.context.obj({ Type: 'Pages', Kids: [second.ref], Count: 1, Parent: rootRef }));
      second.node.set(PDFName.of('Parent'), node);
      root.lookup(PDFName.of('Kids'), PDFArray).set(1, node);
      return doc.save();
    })();
    // Same pages in the same order: v2 cannot tell, v3 can.
    expect((await sealedContentDigestFromBytes(reparented, 2)).pageDigests).toEqual((await sealedContentDigestFromBytes(bytes, 2)).pageDigests);
    const before = await sealedContentDigestFromBytes(bytes, 3);
    const after = await sealedContentDigestFromBytes(reparented, 3);
    expect(after.pageDigests[0]).not.toBe(before.pageDigests[0]);
    expect(after.pageDigests[1]).not.toBe(before.pageDigests[1]);
  });

  it('v3 signs every embedded file except the single manifest attachment', async () => {
    const bytes = await buildOnePagePdf('hello');
    const withFiles = async (names: string[]) => {
      const doc = await PDFDocument.load(bytes);
      for (const name of names) await doc.attach(new TextEncoder().encode(name), name, { mimeType: 'text/plain' });
      return doc.save();
    };
    const sealedV3 = await sealedContentDigestFromBytes(bytes, 3);
    const sealedV2 = await sealedContentDigestFromBytes(bytes, 2);

    const manifestOnly = await withFiles(['docuridge-manifest.json']);
    expect(await sealedContentDigestFromBytes(manifestOnly, 3)).toEqual(sealedV3);

    const extra = await withFiles(['docuridge-manifest.json', 'addendum.pdf']);
    expect((await sealedContentDigestFromBytes(extra, 3)).pageDigests[0]).not.toBe(sealedV3.pageDigests[0]);
    // v2 cannot see it, which is why the verifier also checks attachments structurally.
    expect(await sealedContentDigestFromBytes(extra, 2)).toEqual(sealedV2);

    // Two entries with the manifest's name: neither is excluded.
    const ambiguous = await withFiles(['docuridge-manifest.json', 'docuridge-manifest.json']);
    expect((await sealedContentDigestFromBytes(ambiguous, 3)).pageDigests[0]).not.toBe(sealedV3.pageDigests[0]);
  });

  it('v3 page digests carry the page index', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const digest = await sealedContentDigestFromBytes(await doc.save(), 3);
    // Identical pages: v2 would give equal digests, v3 does not.
    expect(digest.pageDigests[0]).not.toBe(digest.pageDigests[1]);
  });

  it('every version refuses a page tree viewers could read differently', async () => {
    const doc = await PDFDocument.load(await buildTwoPagePdf());
    doc.catalog.lookup(PDFName.of('Pages'), PDFDict).set(PDFName.of('Count'), doc.context.obj(1));
    const bytes = await doc.save();
    for (const version of [1, 2, 3] as const) {
      await expect(sealedContentDigestFromBytes(bytes, version)).rejects.toBeInstanceOf(SealedContentStructureError);
    }
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
