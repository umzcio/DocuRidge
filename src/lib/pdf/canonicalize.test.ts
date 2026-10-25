import { afterEach, describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
  type PDFPage,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ENCRYPTED_PDF_TEXT, encryptedPdf } from './__fixtures__/encrypted-pdf';
import { geometryPdf } from './__fixtures__/geometry-pdf';
import { generatedTextFormPdf } from './__fixtures__/hostile-form-pdf';
import { UNEMBEDDABLE_VARIANTS, pageTreeVariantPdf } from './__fixtures__/page-tree-variants-pdf';
import { needAppearancesForm, opaqueSquareOverText, optionalContentPdf, type PolicyFixture } from './__fixtures__/policy-pdfs';
import { forgedContentStream, pageContentRef, rewriteSingleRevision } from '../verify/__fixtures__/pdf-surgery';
import { checkPdfStructure } from '../verify/pdf-structure';
import { parseCanonicalizeResult } from './canonical-result';
import { canonicalizeUploadedPdf, type CanonicalizeResult } from './canonicalize';
import { assertSealCost } from './seal-limits';
import { runPdfJob } from '../pdf-worker/runner';

const SAVED_ENV = { ...process.env };
function restoreEnv(): void {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
}

function ok(result: CanonicalizeResult): Extract<CanonicalizeResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a canonical file, got the refusal ${result.key}`);
  return result;
}

const fixtureBytes = (fixture: PolicyFixture) => fixture.doc.save({ useObjectStreams: false });

/** `pages` pages, each with a line of Helvetica text. */
async function textPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return doc.save();
}

/** Every stream of `bytes`, decoded, as one latin1 string. */
async function decodedStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = '';
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) text += Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
  }
  return text;
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The decoded content of the Form XObjects a page draws. */
function pageXObjectText(page: PDFPage): string {
  const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
  let text = '';
  for (const [, ref] of xobjects.entries()) {
    const stream = page.doc.context.lookup(ref);
    if (stream instanceof PDFRawStream) text += Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
  }
  return text;
}

/** Indirect objects reachable from the trailer's /Root and /Info, against all the file defines. */
async function reachability(bytes: Uint8Array): Promise<{ reachable: number; defined: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const seen = new Set<string>();
  const pending: PDFObject[] = [doc.context.trailerInfo.Root, doc.context.trailerInfo.Info].filter(Boolean) as PDFObject[];
  while (pending.length) {
    const object = pending.pop()!;
    if (object instanceof PDFRef) {
      if (seen.has(object.tag)) continue;
      seen.add(object.tag);
      const target = doc.context.lookup(object);
      if (target) pending.push(target);
    } else if (object instanceof PDFStream) {
      pending.push(object.dict);
    } else if (object instanceof PDFDict) {
      for (const [, value] of object.entries()) pending.push(value);
    } else if (object instanceof PDFArray) {
      pending.push(...object.asArray());
    }
  }
  return { reachable: seen.size, defined: doc.context.enumerateIndirectObjects().length };
}

const ORPHAN_URI = 'https://marker.example/orphan-uri-5d1e';
const CONTENT_MARKER = 'CONTENT-MARKER-91c2';

/**
 * A page whose uncompressed content stream draws CONTENT_MARKER, with a Link
 * whose URI action is ORPHAN_URI. The canonical file draws the content
 * through a compressed Form XObject and drops the Link, so neither plain
 * byte sequence has any business being in it.
 */
async function linkAndPlainContentPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { Helvetica: font } } as never));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(`BT /Helvetica 12 Tf 20 100 Td (${CONTENT_MARKER}) Tj ET`)));
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 20], Border: [0, 0, 0],
    A: doc.context.obj({ S: 'URI', URI: PDFString.of(ORPHAN_URI) }),
  } as never));
  page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  return doc.save({ useObjectStreams: false });
}

/** Page 1's text, extracted by pdf.js. */
async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocument({
    data: bytes.slice(), useSystemFonts: false,
    standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
  }).promise;
  try {
    const content = await (await doc.getPage(1)).getTextContent();
    return content.items.map((item) => ('str' in item ? item.str : '')).join('');
  } finally {
    await doc.destroy();
  }
}

/** Dark pixels on page 1, rendered by pdf.js. */
async function darkPixels(bytes: Uint8Array): Promise<number> {
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
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 100 && pixels[i + 1]! < 100 && pixels[i + 2]! < 100) dark++;
    return dark;
  } finally {
    await doc.destroy();
  }
}

/** A page with an outline, names, structure tree, metadata, a filled form field, a Link and a dated Info. */
async function catalogExtrasPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Quarterly terms');
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  const page = doc.addPage([300, 200]);
  page.drawText('Body', { x: 20, y: 150, size: 12 });
  const field = doc.getForm().createTextField('name');
  field.setText('Alice');
  field.addToPage(page, { x: 20, y: 20, width: 120, height: 24 });
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Border: [0, 0, 0] }));
  page.node.Annots()!.push(link);
  doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({ Type: 'Outlines', Count: 0 })));
  doc.catalog.set(PDFName.of('Names'), doc.context.obj({ Dests: doc.context.obj({ Names: [] }) } as never));
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(doc.context.obj({ Type: 'StructTreeRoot' })));
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream('<x:xmpmeta/>', { Type: 'Metadata', Subtype: 'XML' })));
  return doc.save({ useObjectStreams: false });
}

/** A page whose only content is an Acrobat-style signature field: /FT /Sig, a /V signature dictionary and a drawn /AP. */
async function acrobatSignedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
  const ap = doc.context.register(doc.context.stream('0 g 0 0 100 50 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50] }));
  const sig = doc.context.register(doc.context.obj({
    Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00'.repeat(64)),
  }));
  const widget = doc.context.register(doc.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: 'Signature1', V: sig, F: 4,
    Rect: [50, 50, 150, 100], AP: { N: ap }, P: page.ref,
  }));
  page.node.set(PDFName.of('Annots'), doc.context.obj([widget]));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [widget], SigFlags: 3 }));
  return doc.save({ useObjectStreams: false });
}

/**
 * One page whose content stream says GENUINE TERMS, rewritten with a second
 * definition of that object (saying FORGED TERMS) ahead of it and the xref
 * pointing at the forged copy: pdf-lib keeps the last definition, viewers
 * follow the xref.
 */
async function duplicateObjectPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { Helvetica: font } } as never));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('BT /Helvetica 24 Tf 50 650 Td (GENUINE TERMS) Tj ET')));
  const bytes = await doc.save({ useObjectStreams: false });
  const loaded = await PDFDocument.load(bytes);
  return rewriteSingleRevision(bytes, {
    before: new Map([[pageContentRef(loaded).objectNumber, forgedContentStream(loaded, 'FORGED TERMS')]]),
  });
}

describe('canonicalizeUploadedPdf', () => {
  it('is deterministic', async () => {
    for (const input of [await catalogExtrasPdf(), await generatedTextFormPdf({ text: 'Alice' }), await textPdf(3)]) {
      const first = ok(await canonicalizeUploadedPdf(input));
      const second = ok(await canonicalizeUploadedPdf(input));
      expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    }
    // The form fixture's field appearance, with its font, really is drawn.
    const form = ok(await canonicalizeUploadedPdf(await catalogExtrasPdf()));
    expect(Buffer.from(form.bytes).toString('latin1')).toContain('/BaseFont /Helvetica');
    expect(await pageText(form.bytes)).toContain('Alice');
  });

  it('output is a pdf-lib fixed point and passes checkPdfStructure', async () => {
    for (const input of [await catalogExtrasPdf(), await textPdf(2), await geometryPdf()]) {
      const { bytes } = ok(await canonicalizeUploadedPdf(input));
      const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
      const again = await reloaded.save({ useObjectStreams: false, updateFieldAppearances: false });
      expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
      await expect(checkPdfStructure(bytes)).resolves.toBeUndefined();
    }
  });

  it('has no annotations, no AcroForm, no OCProperties, no Outlines/Names/StructTreeRoot/Metadata, and Info is exactly /Producer (DocuRidge)', async () => {
    const { bytes } = ok(await canonicalizeUploadedPdf(await catalogExtrasPdf()));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.catalog.keys().map((k) => k.asString()).sort()).toEqual(['/Pages', '/Type']);
    // pdf-lib gives every page it creates an empty /Annots, as in the seal.
    for (const page of doc.getPages()) expect(page.node.Annots()?.size() ?? 0).toBe(0);
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    expect(info.keys().map((k) => k.asString())).toEqual(['/Producer']);
    expect(doc.getProducer()).toBe('DocuRidge');
    expect(Buffer.from(bytes).toString('latin1')).toMatch(/<<\s*\/Producer \(DocuRidge\)\s*>>/);
    expect(doc.context.trailerInfo.ID).toBeUndefined();
  });

  it('page geometry', async () => {
    const { bytes, pageCount } = ok(await canonicalizeUploadedPdf(await geometryPdf()));
    expect(pageCount).toBe(1);
    const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0);
    const box = page.node.lookup(PDFName.of('MediaBox'), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    // The 300x200 crop, turned a quarter, at two units per point.
    expect(box).toEqual([0, 0, 400, 600]);
    expect(page.node.has(PDFName.of('Rotate'))).toBe(false);
    expect(page.node.has(PDFName.of('CropBox'))).toBe(false);
    expect(page.node.has(PDFName.of('UserUnit'))).toBe(false);
  });

  it('under-reported /Count is refused', async () => {
    expect(await canonicalizeUploadedPdf(await pageTreeVariantPdf('root_count_low'))).toEqual({ ok: false, key: 'unreadable_pdf' });
  });

  it('untyped kid is refused', async () => {
    expect(await canonicalizeUploadedPdf(await pageTreeVariantPdf('untyped_kid'))).toEqual({ ok: false, key: 'unreadable_pdf' });
  });

  it('duplicate object definition', async () => {
    const source = await duplicateObjectPdf();
    await expect(checkPdfStructure(source)).rejects.toMatchObject({ code: 'duplicate_object' });
    const { bytes } = ok(await canonicalizeUploadedPdf(source));
    await expect(checkPdfStructure(bytes)).resolves.toBeUndefined();
    // One definition per object number...
    const headers = [...Buffer.from(bytes).toString('latin1').matchAll(/(?:^|\n)(\d+) \d+ obj\b/g)].map((m) => m[1]);
    expect(new Set(headers).size).toBe(headers.length);
    // ...and the content is the copy pdf-lib read, drawn on the page, once;
    // the forged copy is nowhere in the file, encoded or decoded.
    const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0);
    expect(pageXObjectText(page)).toContain('GENUINE TERMS');
    const streams = await decodedStreams(bytes);
    expect(occurrences(streams, 'GENUINE TERMS')).toBe(1);
    expect(streams).not.toContain('FORGED TERMS');
    const forgedBody = forgedContentStream(await PDFDocument.load(source), 'FORGED TERMS');
    const forgedData = forgedBody.subarray(forgedBody.indexOf('stream'));
    expect(Buffer.from(source).includes(forgedData)).toBe(true);
    expect(Buffer.from(bytes).includes(forgedData)).toBe(false);
  });

  it('every indirect object in the canonical file is reachable from the trailer', async () => {
    for (const input of [await generatedTextFormPdf({ text: 'Alice' }), await catalogExtrasPdf(), await linkAndPlainContentPdf()]) {
      const { bytes } = ok(await canonicalizeUploadedPdf(input));
      const { reachable, defined } = await reachability(bytes);
      expect(reachable).toBe(defined);
    }
  });

  it('dropped annotations and the original content stream are not in the file', async () => {
    const { bytes } = ok(await canonicalizeUploadedPdf(await linkAndPlainContentPdf()));
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).not.toContain(ORPHAN_URI);
    expect(raw).not.toContain('/Link');
    expect(raw).not.toContain(CONTENT_MARKER);
    // The text itself is still drawn, through the page's compressed Form XObject.
    const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0);
    expect(pageXObjectText(page)).toContain(CONTENT_MARKER);
  });

  it('refusals map to keys', async () => {
    expect(await canonicalizeUploadedPdf(await fixtureBytes(await needAppearancesForm())))
      .toEqual({ ok: false, key: 'need_appearances' });
    expect(await canonicalizeUploadedPdf(await fixtureBytes(await opaqueSquareOverText())))
      .toEqual({ ok: false, key: 'visible_annotations' });
    expect(await canonicalizeUploadedPdf(await fixtureBytes(await optionalContentPdf('off'))))
      .toEqual({ ok: false, key: 'hidden_layers' });
  });

  it('an all-ON layered document is accepted without OCProperties', async () => {
    const { bytes } = ok(await canonicalizeUploadedPdf(await fixtureBytes(await optionalContentPdf('all_on'))));
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(false);
  });

  it('an Acrobat-signed document is flattened to its appearance', async () => {
    const source = await acrobatSignedPdf();
    expect(await darkPixels(source)).toBeGreaterThan(4000);
    const { bytes } = ok(await canonicalizeUploadedPdf(source));
    // The 100x50 appearance is drawn into the page content...
    expect(await darkPixels(bytes)).toBeGreaterThan(4000);
    // ...and nothing of the field or its signature dictionary is left.
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).not.toContain('/Sig');
    expect(raw).not.toContain('/AcroForm');
    expect(raw).not.toContain('/Widget');
  });

  it.each(['rc4', 'aes'] as const)('an encrypted upload reports encrypted (%s), even with ignoreEncryption', async (cipher) => {
    const source = await encryptedPdf(cipher);
    // A real encrypted file: pdf.js opens it with the empty user password.
    expect(await pageText(source)).toContain(ENCRYPTED_PDF_TEXT);
    expect(await canonicalizeUploadedPdf(source)).toEqual({ ok: false, key: 'encrypted' });
    // The flag only lets pdf-lib parse it; its streams are still ciphertext.
    expect(await canonicalizeUploadedPdf(source, { ignoreEncryption: true })).toEqual({ ok: false, key: 'encrypted' });
  });

  it('refuses a form flatten failure as unsupported_form with its /flattened PDF/ message', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const field = doc.getForm().createTextField('rotated');
    field.addToPage(page, { x: 20, y: 20, width: 100, height: 20 });
    field.acroField.getWidgets()[0]!.dict.set(PDFName.of('F'), PDFNumber.of(4 | 16));
    const result = await canonicalizeUploadedPdf(await doc.save());
    expect(result).toMatchObject({ ok: false, key: 'unsupported_form' });
    expect(result.ok === false && result.message).toMatch(/flattened PDF/);
  });

  // The seal copies canonical pages as they are, so a page it could not have
  // embedded must never get a canonical copy.
  it.each(UNEMBEDDABLE_VARIANTS)('refuses a source pdf-lib cannot embed (%s)', async (variant) => {
    const result = await canonicalizeUploadedPdf(await pageTreeVariantPdf(variant));
    expect(result).toEqual({ ok: false, key: variant === 'annots_not_array' ? 'visible_annotations' : 'unreadable_pdf' });
  });

  it('a PDF with no pages is refused as no_pages', async () => {
    const doc = await PDFDocument.create();
    expect(await canonicalizeUploadedPdf(await doc.save({ addDefaultPage: false }))).toEqual({ ok: false, key: 'no_pages' });
  });

  it('seal cost is measured on the canonical file', async () => {
    const source = await catalogExtrasPdf();
    const result = ok(await canonicalizeUploadedPdf(source));
    const canonicalCost = assertSealCost(await PDFDocument.load(result.bytes, { updateMetadata: false }));
    expect(result.sealCost).toEqual(canonicalCost);
    expect(result.sealCost).not.toEqual(assertSealCost(await PDFDocument.load(source)));
    expect(result.sealCost.pages).toBe(result.pageCount);
  });

  it('Math.random is restored', async () => {
    const original = Math.random;
    ok(await canonicalizeUploadedPdf(await generatedTextFormPdf({ text: 'Alice' })));
    expect(Math.random).toBe(original);
    // Refused after the form is flattened, inside the seeded window.
    expect(await canonicalizeUploadedPdf(await fixtureBytes(await opaqueSquareOverText())))
      .toEqual({ ok: false, key: 'visible_annotations' });
    expect(Math.random).toBe(original);
  });

  it('every result passes parseCanonicalizeResult unchanged', async () => {
    const result = await canonicalizeUploadedPdf(await textPdf(2));
    expect(parseCanonicalizeResult(result)).toEqual(result);
  });
});

describe('the canonicalize job', () => {
  afterEach(restoreEnv);

  it('the canonicalize job runs in a real child', async () => {
    const input = await generatedTextFormPdf({ text: 'Alice' });
    const inline = ok(await canonicalizeUploadedPdf(input));
    process.env.PDF_WORKER_MODE = 'process';
    const output = parseCanonicalizeResult(await runPdfJob('canonicalize', { bytes: input }));
    const child = ok(output);
    expect(child.pageCount).toBe(1);
    // Same bytes as in this process: the seeded names do not depend on the process.
    expect(Buffer.from(child.bytes).equals(Buffer.from(inline.bytes))).toBe(true);
    expect(child.sealCost).toEqual(inline.sealCost);
  }, 30_000);
});
