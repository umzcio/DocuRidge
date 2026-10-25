import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, PDFName, PDFNumber, rgb } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyPdfEdits } from './edit';
import { flattenPdfFormAppearances } from './form-appearance';
import { appendUprightPage } from './upright-page';

async function raster(bytes: Uint8Array) {
  const doc = await getDocument({
    data: bytes.slice(), useSystemFonts: false,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
  }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const black: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i]! < 100 && pixels[i + 1]! < 100 && pixels[i + 2]! < 100) black.push(i / 4);
    }
    return black;
  } finally { await doc.destroy(); }
}
async function formFixture(options: { flags?: number; matrix?: number[]; bbox?: number[]; scaled?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const field = doc.getForm().createTextField('foo');
  field.setText('VALUE');
  field.addToPage(page, { x: 40, y: 400, width: 100, height: 30, borderWidth: 0, textColor: rgb(0, 0, 0) });
  doc.getForm().updateFieldAppearances();
  const widget = field.acroField.getWidgets()[0]!;
  const appearance = doc.context.register(doc.context.flateStream('0 0 0 rg 5 5 10 10 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: options.bbox ?? [0, 0, 100, 30],
    Matrix: options.matrix ?? [1, 0, 0, 1, 0, 0], Resources: {},
  }));
  widget.dict.set(PDFName.of('AP'), doc.context.obj({ N: appearance }));
  if (options.flags !== undefined) widget.dict.set(PDFName.of('F'), PDFNumber.of(options.flags));
  if (options.scaled) widget.setRectangle({ x: 40, y: 400, width: 300, height: 60 });
  return { doc, field, page, widget };
}

describe.each(['editor', 'sealing'] as const)('form appearance preservation in %s', (path) => {
  async function transform(bytes: Uint8Array) {
    if (path === 'editor') return applyPdfEdits(bytes, [{ sourcePage: 1, rotation: 0 }]);
    const source = await PDFDocument.load(bytes);
    await flattenPdfFormAppearances(source);
    const out = await PDFDocument.create();
    await appendUprightPage(out, source.getPage(0));
    return out.save();
  }
  it.each([2, 32, 34])('does not expose hidden or NoView widget content (flags %i)', async (flags) => {
    const { doc } = await formFixture({ flags });
    const original = await doc.save({ updateFieldAppearances: false });
    expect(await raster(original)).toEqual([]);
    const result = await transform(original);
    expect(await raster(result)).toEqual([]);
  });
  it.each([
    { scaled: true },
    { scaled: true, bbox: [-10, -5, 100, 30] },
    { scaled: true, matrix: [0, 1, -1, 0, 30, 0] },
    { scaled: true, matrix: [2, 0, .5, 1, -20, 15] },
  ])('matches PDF.js pixels when fitting an appearance to its widget rectangle: %j', async (options) => {
    const { doc } = await formFixture(options);
    const original = await doc.save({ updateFieldAppearances: false });
    const before = await raster(original);
    expect(before.length).toBeGreaterThan(0);
    const result = await transform(original);
    expect(await raster(result)).toEqual(before);
  });
  it('draws nothing for a widget with no appearance, as pdf.js does, and keeps the other widgets of the field', async () => {
    const { doc, field, page } = await formFixture();
    field.addToPage(page, { x: 40, y: 200, width: 100, height: 30, borderWidth: 0 });
    const second = field.acroField.getWidgets()[1]!;
    second.dict.delete(PDFName.of('AP'));
    const original = await doc.save({ updateFieldAppearances: false });
    const before = await raster(original);
    const result = await transform(original);
    const pixels = await raster(result);
    // The custom appearance is a 10 x 10 black square at y=185, and pdf.js
    // draws nothing for the second widget, before or after.
    expect(pixels.filter((index) => index < 200 * 400)).toHaveLength(100);
    expect(pixels.some((index) => index > 300 * 400)).toBe(false);
    expect(pixels).toEqual(before);
  });
});
