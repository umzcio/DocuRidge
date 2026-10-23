import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from 'pdf-lib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyPdfEdits, remapFieldsForPages } from './edit';

async function fixture(rotation = 0, crop = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 600]);
  page.setRotation(degrees(rotation));
  if (crop) page.setCropBox(30, 50, 300, 450);
  page.drawText('FIRST', { x: 60, y: 400, size: 12, font });
  doc.addPage([200, 300]).drawText('SECOND', { x: 20, y: 200, size: 12, font });
  doc.addPage([100, 100]);
  return doc.save();
}
async function inspect(bytes: Uint8Array, pageNumber = 1, delta = 0) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1, rotation: page.rotate + delta });
    const content = await page.getTextContent();
    const text = content.items.filter((i) => 'str' in i).map((i) => ({
      text: i.str, point: viewport.convertToViewportPoint(i.transform[4]!, i.transform[5]!),
    }));
    const ops = await page.getOperatorList();
    return { width: viewport.width, height: viewport.height, rotation: page.rotate, text, ops };
  } finally { await doc.destroy(); }
}

describe('applyPdfEdits', () => {
  it('reorders and deletes real pages while preserving their text and blank pages', async () => {
    const bytes = await applyPdfEdits(await fixture(), [{ sourcePage: 2, rotation: 0 }, { sourcePage: 3, rotation: 0 }]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
    expect((await inspect(bytes)).text.map((t) => t.text)).toEqual(['SECOND']);
    expect((await inspect(bytes, 2)).text).toEqual([]);
  });

  it.each([0, 90, 180, 270])('normalizes intrinsic rotation %i and crops exactly as PDF.js displays it', async (intrinsic) => {
    const original = await fixture(intrinsic, true);
    for (const delta of [0, 90, 180, 270]) {
      const before = await inspect(original, 1, delta);
      const after = await inspect(await applyPdfEdits(original, [{ sourcePage: 1, rotation: delta }]));
      expect(after.rotation).toBe(0);
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      expect(after.text[0]!.text).toBe('FIRST');
      after.text[0]!.point.forEach((v, i) => expect(v).toBeCloseTo(before.text[0]!.point[i]!, 7));
    }
  });

  it('preserves the physical dimensions of a nondefault UserUnit and intersects the crop with the media box', async () => {
    const doc = await PDFDocument.load(await fixture(90));
    doc.getPage(0).setCropBox(-20, 50, 300, 700);
    doc.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    const original = await doc.save();
    const before = await inspect(original);
    const after = await inspect(await applyPdfEdits(original, [{ sourcePage: 1, rotation: 0 }]));
    expect([after.width, after.height]).toEqual([before.width, before.height]);
    after.text[0]!.point.forEach((v, i) => expect(v).toBeCloseTo(before.text[0]!.point[i]!, 7));
  });

  it('bakes text and highlights into content at output page coordinates', async () => {
    const bytes = await applyPdfEdits(await fixture(), [{ sourcePage: 2, rotation: 90 }], [
      { page: 1, kind: 'text', x: .1, y: .1, w: .5, h: .2, text: 'Approved' },
      { page: 1, kind: 'highlight', x: .2, y: .5, w: .3, h: .1 },
    ]);
    const result = await inspect(bytes);
    const annotation = result.text.find((t) => t.text === 'Approved')!;
    expect(annotation).toBeDefined();
    expect(annotation.point[0]).toBeCloseTo(30, 5);
    expect(annotation.point[1]).toBeGreaterThanOrEqual(20);
    expect(annotation.point[1]).toBeLessThanOrEqual(60);
    expect(result.ops.fnArray).toContain(OPS.fill);
    expect(result.ops.fnArray).toContain(OPS.setGState);
    expect(result.ops.argsArray).toContainEqual([1, 0, 0, 1, 60, 80]);
    expect(result.ops.argsArray).toContainEqual([[["ca", .3]]]);
    const paths = result.ops.fnArray.flatMap((op, i) => op === OPS.constructPath ? [result.ops.argsArray[i]] : []);
    expect(paths.some((path) => JSON.stringify(path[2]) === JSON.stringify([0, 0, 90, 20]))).toBe(true);
  });

  it('preserves native form values by flattening widget appearances before page embedding', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const field = doc.getForm().createTextField('name');
    field.setText('Native value');
    field.addToPage(page, { x: 40, y: 400, width: 200, height: 30 });
    const bytes = await applyPdfEdits(await doc.save(), [{ sourcePage: 1, rotation: 90 }]);
    expect((await inspect(bytes)).text.some((t) => t.text === 'Native value')).toBe(true);
  });

  it('rejects existing annotations it cannot preserve instead of silently discarding them', async () => {
    const doc = await PDFDocument.load(await fixture());
    const annotation = doc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [10, 10, 30, 30] });
    doc.getPage(0).node.addAnnot(doc.context.register(annotation));
    await expect(applyPdfEdits(await doc.save(), [{ sourcePage: 1, rotation: 0 }])).rejects.toThrow(/annotation/i);
  });

  it('rejects orphaned form widgets rather than silently discarding their appearance', async () => {
    const doc = await PDFDocument.load(await fixture());
    const widget = doc.context.obj({ Type: 'Annot', Subtype: 'Widget', Rect: [10, 10, 30, 30] });
    doc.getPage(0).node.addAnnot(doc.context.register(widget));
    await expect(applyPdfEdits(await doc.save(), [{ sourcePage: 1, rotation: 0 }])).rejects.toThrow(/form|annotation/i);
  });

  it.each([
    [], [{ sourcePage: 0, rotation: 0 }], [{ sourcePage: 4, rotation: 0 }],
    [{ sourcePage: 1.5, rotation: 0 }], [{ sourcePage: 1, rotation: 45 }],
    [{ sourcePage: 1, rotation: NaN }], [{ sourcePage: 1, rotation: Infinity }],
    [{ sourcePage: 1, rotation: 0 }, { sourcePage: 1, rotation: 90 }],
  ].map((pages) => ({ pages })))('rejects invalid page selections $pages', async ({ pages }) => {
    await expect(applyPdfEdits(await fixture(), pages)).rejects.toThrow();
  });

  it.each([
    { x: -.1 }, { y: NaN }, { w: 0 }, { h: Infinity }, { x: .9, w: .2 },
    { page: 2 }, { page: 1.5 }, { text: '' }, { text: '你好' },
  ])('rejects invalid annotation geometry or unrenderable text %j', async (override) => {
    await expect(applyPdfEdits(await fixture(), [{ sourcePage: 1, rotation: 0 }], [
      { page: 1, kind: 'text', x: .1, y: .1, w: .5, h: .1, text: 'Hello', ...override },
    ])).rejects.toThrow();
  });
});

describe('remapFieldsForPages', () => {
  const field = { id: 'signature', page: 2, x: .1, y: .2, w: .3, h: .4 };
  it.each([
    [0, [.1, .2, .3, .4]], [90, [.4, .1, .4, .3]],
    [180, [.6, .4, .3, .4]], [270, [.2, .6, .4, .3]], [-90, [.2, .6, .4, .3]],
  ])('maps a field through %i degrees clockwise and page reorder', (rotation, expected) => {
    const result = remapFieldsForPages([field], [{ sourcePage: 2, rotation: rotation as number }]);
    expect(result[0]).toMatchObject({ id: 'signature', page: 1 });
    [result[0]!.x, result[0]!.y, result[0]!.w, result[0]!.h].forEach((v, i) => expect(v).toBeCloseTo((expected as number[])[i]!, 7));
    expect(field).toEqual({ id: 'signature', page: 2, x: .1, y: .2, w: .3, h: .4 });
  });
  it('removes fields on deleted pages', () => {
    expect(remapFieldsForPages([field], [{ sourcePage: 1, rotation: 0 }])).toEqual([]);
  });
  it('returns fields to their original geometry after four clockwise turns', () => {
    let fields = [field];
    for (let i = 0; i < 4; i++) fields = remapFieldsForPages(fields, [{ sourcePage: i === 0 ? 2 : 1, rotation: 90 }]);
    for (const key of ['x', 'y', 'w', 'h'] as const) expect(fields[0]![key]).toBeCloseTo(field[key], 7);
  });
  it('rejects invalid field bounds and invalid page edits', () => {
    expect(() => remapFieldsForPages([{ ...field, w: NaN }], [{ sourcePage: 2, rotation: 0 }])).toThrow();
    expect(() => remapFieldsForPages([field], [{ sourcePage: 2, rotation: 12 }])).toThrow();
  });
});
