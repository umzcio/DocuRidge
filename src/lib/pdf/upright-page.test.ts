import { it, expect } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { appendUprightPage } from './upright-page';
import { applyPdfEdits, remapFieldsForPages } from './edit';
import { uiToPdf } from './coords';

it.each([0, 90, 180, 270])('keeps a signing stamp aligned when sealing an edited source at %i degrees', async (rotation) => {
  const source = await PDFDocument.create();
  const page = source.addPage([400, 600]);
  page.setCropBox(30, 50, 300, 450);
  page.setRotation(degrees(90));
  page.drawText('Original', { x: 60, y: 400, size: 12 });
  const edits = [{ sourcePage: 1, rotation }];
  const edited = await PDFDocument.load(await applyPdfEdits(await source.save(), edits));
  const field = remapFieldsForPages([{ page: 1, x: .2, y: .3, w: .25, h: .1 }], edits)[0]!;
  // This is the shared source-page normalization and stamping path used in seal.
  const sealed = await PDFDocument.create();
  const sealedPage = await appendUprightPage(sealed, edited.getPage(0));
  const box = uiToPdf(field, sealedPage.getWidth(), sealedPage.getHeight());
  sealedPage.drawText('Signed', { x: box.x, y: box.y, size: 8 });
  const pdf = await getDocument({ data: await sealed.save(), useSystemFonts: true }).promise;
  try {
    const rendered = await pdf.getPage(1);
    const viewport = rendered.getViewport({ scale: 1 });
    const text = await rendered.getTextContent();
    const stamp = text.items.find((item) => 'str' in item && item.str === 'Signed');
    expect(stamp && 'transform' in stamp).toBe(true);
    if (!stamp || !('transform' in stamp)) throw new Error('Missing stamped signature');
    const [x, y] = viewport.convertToViewportPoint(stamp.transform[4]!, stamp.transform[5]!);
    expect(x! / viewport.width).toBeCloseTo(field.x, 7);
    expect(y! / viewport.height).toBeCloseTo(field.y + field.h, 7);
    expect(text.items.some((item) => 'str' in item && item.str === 'Original')).toBe(true);
  } finally { await pdf.destroy(); }
});
