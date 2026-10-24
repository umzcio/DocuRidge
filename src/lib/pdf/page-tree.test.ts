import { describe, it, expect } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { SealedContentStructureError, pageTreeLeaves } from './page-tree';
import { PdfComplexityError } from './seal-limits';
import { buildSharedNodePageTreePdf } from './__fixtures__/shared-page-tree-pdf';

async function threePages(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage();
  return PDFDocument.load(await doc.save());
}

describe('pageTreeLeaves', () => {
  it('accepts an ordinary document', async () => {
    expect(pageTreeLeaves(await threePages())).toHaveLength(3);
  });

  it('refuses a shared-node page tree in linear time', async () => {
    const doc = await PDFDocument.load(await buildSharedNodePageTreePdf(30));
    const started = performance.now();
    expect(() => pageTreeLeaves(doc)).toThrow(SealedContentStructureError);
    expect(() => pageTreeLeaves(doc)).toThrow(/more than once/);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('refuses an under-reported /Count', async () => {
    const doc = await threePages();
    const root = doc.catalog.lookup(PDFName.of('Pages'), PDFDict);
    root.set(PDFName.of('Count'), PDFNumber.of(1));
    expect(() => pageTreeLeaves(doc)).toThrow(/Count of/);
  });

  it('refuses an untyped kid', async () => {
    const doc = await threePages();
    const leaf = pageTreeLeaves(doc)[0]!;
    leaf.delete(PDFName.of('Type'));
    expect(() => pageTreeLeaves(doc)).toThrow(/neither a \/Type \/Page/);
  });

  it('refuses more pages than maxPages', async () => {
    const doc = await threePages();
    try {
      pageTreeLeaves(doc, { maxPages: 2 });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PdfComplexityError);
      expect((err as PdfComplexityError).limit).toBe('pages');
    }
  });
});
