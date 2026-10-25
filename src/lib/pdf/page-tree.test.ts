import { describe, it, expect } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { SealedContentStructureError, assertSourcePagesDrawable, pageTreeLeaves } from './page-tree';
import { appendUprightPages } from './upright-page';
import { PdfComplexityError } from './seal-limits';
import { loadPdfWithDecodeLimits } from './decode-limits';
import { buildSharedNodePageTreePdf } from './__fixtures__/shared-page-tree-pdf';
import {
  LENIENT_VARIANTS,
  REFUSED_VARIANTS,
  UNDRAWABLE_VARIANTS,
  pageTreeVariantPdf,
} from './__fixtures__/page-tree-variants-pdf';

async function threePages(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage();
  return PDFDocument.load(await doc.save());
}

/** The page count pdf.js reports, its recovery warnings silenced. */
async function pdfjsPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await getDocument({ data: new Uint8Array(bytes), verbosity: VerbosityLevel.ERRORS }).promise;
  try {
    // numPages is final once every page resolves (pdf.js corrects a wrong root /Count).
    for (let n = 1; n <= pdf.numPages; n++) await pdf.getPage(n);
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
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
    expect(() => pageTreeLeaves(doc, { mode: 'source' })).toThrow(/more than once/);
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
    for (const mode of ['sealed', 'source'] as const) {
      try {
        pageTreeLeaves(doc, { maxPages: 2, mode });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(PdfComplexityError);
        expect((err as PdfComplexityError).limit).toBe('pages');
      }
    }
  });
});

describe('source mode: defects every reader reads alike', () => {
  it.each(LENIENT_VARIANTS)('accepts %s, with the page count pdf.js and pdf-lib report', async (variant) => {
    const bytes = await pageTreeVariantPdf(variant);
    const doc = await PDFDocument.load(bytes);

    const leaves = pageTreeLeaves(doc, { mode: 'source' });

    expect(leaves).toHaveLength(2);
    expect(await pdfjsPageCount(bytes)).toBe(leaves.length);
    expect(doc.getPageCount()).toBe(leaves.length);
    expect(doc.getPages().map((p) => p.node)).toEqual(leaves);
  });

  it.each(LENIENT_VARIANTS)('still refuses %s in sealed mode', async (variant) => {
    const doc = await PDFDocument.load(await pageTreeVariantPdf(variant));
    expect(() => pageTreeLeaves(doc)).toThrow(SealedContentStructureError);
    expect(() => pageTreeLeaves(doc, { mode: 'sealed' })).toThrow(SealedContentStructureError);
  });

  it.each(REFUSED_VARIANTS)('refuses %s in both modes', async (variant) => {
    const doc = await PDFDocument.load(await pageTreeVariantPdf(variant));
    expect(() => pageTreeLeaves(doc, { mode: 'source' })).toThrow(SealedContentStructureError);
    expect(() => pageTreeLeaves(doc, { mode: 'sealed' })).toThrow(SealedContentStructureError);
  });

  it('names the defect for each refused source case', async () => {
    const message = async (variant: (typeof REFUSED_VARIANTS)[number]) => {
      const doc = await PDFDocument.load(await pageTreeVariantPdf(variant));
      try {
        pageTreeLeaves(doc, { mode: 'source' });
      } catch (err) {
        return (err as Error).message;
      }
      return 'accepted';
    };
    expect(await message('root_count_low')).toMatch(/\/Count of .* is 1 but 2 page/);
    expect(await message('intermediate_count_wrong')).toMatch(/\/Count of .* is 1 but 2 page/);
    expect(await message('untyped_kid')).toMatch(/neither a \/Type \/Page/);
    expect(await message('shared_kid')).toMatch(/more than once/);
    expect(await message('direct_kid')).toMatch(/not an indirect reference/);
    expect(await message('parent_cycle')).toMatch(/\/Parent chain .* loops/);
    expect(await message('parent_not_pages')).toMatch(/not a \/Type \/Pages node/);
    expect(await message('too_deep')).toMatch(/nested too deeply|too long/);
  });

  it('loadPdfWithDecodeLimits reads source PDFs in source mode unless told otherwise', async () => {
    const bytes = await pageTreeVariantPdf('missing_parent');
    expect((await loadPdfWithDecodeLimits(bytes)).getPageCount()).toBe(2);
    await expect(loadPdfWithDecodeLimits(bytes, { pageTreeMode: 'sealed' })).rejects.toThrow(SealedContentStructureError);
  });
});

describe('source mode: every page must have the boxes sealing lays it out by', () => {
  it.each(UNDRAWABLE_VARIANTS)('refuses %s when a source is loaded', async (variant) => {
    const bytes = await pageTreeVariantPdf(variant);
    const doc = await PDFDocument.load(bytes);
    expect(() => pageTreeLeaves(doc, { mode: 'source' })).not.toThrow(); // the tree itself is acceptable
    expect(() => assertSourcePagesDrawable(doc)).toThrow(SealedContentStructureError);
    expect(() => assertSourcePagesDrawable(doc)).toThrow(/page \d+ cannot be laid out/);
    await expect(loadPdfWithDecodeLimits(bytes)).rejects.toThrow(SealedContentStructureError);
  });

  it('would otherwise fail only at seal, with a plain error (the regression this guards)', async () => {
    const doc = await PDFDocument.load(await pageTreeVariantPdf('missing_parent_root_mediabox'));
    const err = await appendUprightPages(await PDFDocument.create(), doc.getPages()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SealedContentStructureError);
  });

  it.each(['root_mediabox', 'zero_area_cropbox', 'no_contents_resources_not_dict', 'missing_parent', 'stale_parent', 'dangling_parent'] as const)(
    'accepts %s, whose pages still reach a /MediaBox',
    async (variant) => {
      expect((await loadPdfWithDecodeLimits(await pageTreeVariantPdf(variant))).getPageCount()).toBe(2);
    },
  );

  it('is not applied to sealed loads', async () => {
    // Sealed files are held to the strict walk; their pages are pdf-lib's own.
    const bytes = await pageTreeVariantPdf('no_mediabox');
    expect((await loadPdfWithDecodeLimits(bytes, { pageTreeMode: 'sealed' })).getPageCount()).toBe(2);
  });
});
