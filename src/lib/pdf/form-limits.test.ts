import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { flattenPdfFormAppearances } from './form-appearance';
import { PdfComplexityError, getPdfSealLimits, type PdfComplexityLimit } from './seal-limits';
import {
  deepFormPdf, generatedTextFormPdf, sharedAnnotsPdf, sharedKidsFormPdf, wideFormPdf,
} from './__fixtures__/hostile-form-pdf';

async function flattenError(bytes: Uint8Array, limits = getPdfSealLimits()): Promise<unknown> {
  const doc = await PDFDocument.load(bytes);
  return flattenPdfFormAppearances(doc, limits).then(() => undefined, (err: unknown) => err);
}

function expectLimit(err: unknown, limit: PdfComplexityLimit) {
  expect(err).toBeInstanceOf(PdfComplexityError);
  expect((err as PdfComplexityError).limit).toBe(limit);
  expect((err as PdfComplexityError).code).toBe('pdf_too_complex');
}

describe('seal-time form flattening is bounded', () => {
  it('refuses /Kids shared between parents (2^24 paths through 25 objects) without walking them', async () => {
    const started = Date.now();
    expectLimit(await flattenError(await sharedKidsFormPdf(24)), 'form_shape');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a field tree nested past the depth cap', async () => {
    expectLimit(await flattenError(await deepFormPdf(40)), 'form_depth');
  });

  it('refuses a /Parent loop instead of ascending forever', async () => {
    const doc = await PDFDocument.load(await wideFormPdf(1));
    const [acroField, ref] = doc.getForm().acroForm.getFields()[0]!;
    acroField.dict.set(PDFName.of('Parent'), ref);
    expectLimit(await flattenPdfFormAppearances(doc).catch((e: unknown) => e), 'form_depth');
  });

  it('refuses more fields or widgets than the caps allow', async () => {
    const bytes = await wideFormPdf(60);
    expectLimit(await flattenError(bytes, { ...getPdfSealLimits(), maxFormFields: 50 }), 'form_fields');
    expectLimit(await flattenError(bytes, { ...getPdfSealLimits(), maxFormWidgets: 50 }), 'form_widgets');
    await expect(flattenError(bytes)).resolves.toBeUndefined();
  });

  it('refuses many pages sharing one huge /Annots array before scanning it per page', async () => {
    // 500 pages x 50 entries = 25,000 annotation slots, over the 20,000 default.
    const bytes = await sharedAnnotsPdf(500, 50);
    expectLimit(await flattenError(bytes), 'annotations');
  });

  it('refuses a missing multiline appearance whose layout would be cubic in a long text', async () => {
    const started = Date.now();
    const text = Array.from({ length: 2500 }, () => 'a').join(' ');
    expectLimit(await flattenError(await generatedTextFormPdf({ text, multiline: true })), 'form_text');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a comb field whose /MaxLen would lay out a billion cells', async () => {
    expectLimit(await flattenError(await generatedTextFormPdf({ text: 'x', combMaxLen: 1e9 })), 'form_text');
  });

  it('refuses generated appearances past the byte cap', async () => {
    const bytes = await generatedTextFormPdf({ text: 'hello world' });
    expectLimit(await flattenError(bytes, { ...getPdfSealLimits(), maxFormGeneratedBytes: 16 }), 'form_generated_bytes');
  });

  it('still generates an ordinary missing appearance', async () => {
    const doc = await PDFDocument.load(await generatedTextFormPdf({ text: 'Jane Signer', multiline: true }));
    await flattenPdfFormAppearances(doc);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });

  it('draws an appearance shared by many widgets through one object, not one copy each', async () => {
    const marker = '% shared-appearance-marker';
    const doc = await PDFDocument.load(await wideFormPdf(40, `${marker}\n0 0 0 rg 0 0 10 10 re f`));
    await flattenPdfFormAppearances(doc);
    const out = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
    expect(out.split(marker).length - 1).toBe(1);
    const page = doc.getPage(0);
    expect(page.node.Annots()?.size() ?? 0).toBe(0);
    const xobjects = page.node.normalizedEntries().XObject;
    const refs = new Set(xobjects.keys().map((key) => xobjects.get(key)));
    expect(xobjects.keys()).toHaveLength(40);
    expect(refs.size).toBe(1);
    expect(doc.context.lookup([...refs][0]!)).toBeInstanceOf(PDFRawStream);
  });
});
