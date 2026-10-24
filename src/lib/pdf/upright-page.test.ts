import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { appendUprightPage, appendUprightPages } from './upright-page';
import { flattenPdfFormAppearances } from './form-appearance';
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

async function rasterPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocument({
    data: bytes.slice(), useSystemFonts: false,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
  }).promise;
  try {
    const out: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      out.push(createHash('sha256').update(context.getImageData(0, 0, canvas.width, canvas.height).data).digest('hex'));
    }
    return out;
  } finally { await pdf.destroy(); }
}

/** Rotated + cropped text, a filled form field, plain text, and a blank page. */
async function formBearingSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 600]);
  first.setCropBox(30, 50, 300, 450);
  first.setRotation(degrees(90));
  first.drawText('First page', { x: 60, y: 400, size: 14, font });
  const second = doc.addPage([612, 792]);
  second.drawRectangle({ x: 40, y: 40, width: 200, height: 100, color: rgb(0.2, 0.4, 0.8) });
  const field = doc.getForm().createTextField('name');
  field.setText('Jane Signer');
  field.addToPage(second, { x: 50, y: 600, width: 200, height: 24, textColor: rgb(0, 0, 0) });
  const third = doc.addPage([300, 300]);
  third.drawText('Third page', { x: 20, y: 150, size: 18, font });
  doc.addPage([200, 200]); // blank: no /Contents
  return doc.save();
}

it('renders a multi-page, form-bearing document identically whether pages are embedded one call each or together', async () => {
  const bytes = await formBearingSource();
  const perPage = await PDFDocument.create();
  const one = await PDFDocument.load(bytes);
  await flattenPdfFormAppearances(one);
  for (const page of one.getPages()) await appendUprightPage(perPage, page);
  const together = await PDFDocument.create();
  const all = await PDFDocument.load(bytes);
  await flattenPdfFormAppearances(all);
  const pages = await appendUprightPages(together, all.getPages());
  expect(pages).toHaveLength(4);
  const expected = await rasterPages(await perPage.save());
  expect(await rasterPages(await together.save())).toEqual(expected);
  expect(new Set(expected).size).toBe(4);
});

it('writes one inherited direct /Resources once, not inline in every embedded page', async () => {
  const doc = await PDFDocument.create();
  // A large direct object every page inherits: inline, it would be serialized per page.
  doc.catalog.Pages().set(PDFName.of('Resources'), doc.context.obj({
    ExtGState: { G0: { Type: 'ExtGState', CA: 1 } }, Junk: Array.from({ length: 20000 }, (_, i) => i),
  }));
  for (let i = 0; i < 40; i++) {
    const page = doc.addPage([100, 100]);
    page.node.delete(PDFName.of('Resources'));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('/G0 gs 0 0 10 10 re f')));
  }
  const source = await PDFDocument.load(await doc.save());
  const out = await PDFDocument.create();
  await appendUprightPages(out, source.getPages());
  const size = (await out.save()).length;
  // The 20,000-number array is ~110 KB once; 40 inline copies would be ~4.4 MB.
  expect(size).toBeLessThan(400 * 1024);
});
