/**
 * Render fidelity of the canonical file: pdf.js must draw the canonical copy
 * as it drew the original upload, or the upload is refused. Each test
 * compares the inked fraction of the affected region between the original
 * and its canonical copy, both rendered by pdf.js on a canvas (what the
 * builder and the signing page show).
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, type PDFRef } from 'pdf-lib';
import { canonicalizeUploadedPdf, type CanonicalizeResult } from './canonicalize';
import { pageInk, rasterPage } from './__fixtures__/raster';

function ok(result: CanonicalizeResult): Extract<CanonicalizeResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a canonical file, got the refusal ${result.key}`);
  return result;
}

/** One 600x800 page with the given content stream and resources. */
async function onePage(build: (doc: PDFDocument) => { content: PDFRef | PDFRef[]; resources?: Record<string, unknown> }): Promise<{ doc: PDFDocument; bytes: () => Promise<Uint8Array> }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const { content, resources } = build(doc);
  page.node.set(PDFName.of('Contents'), Array.isArray(content) ? doc.context.obj(content) : content);
  page.node.set(PDFName.of('Resources'), doc.context.obj((resources ?? {}) as never));
  return { doc, bytes: () => doc.save({ useObjectStreams: false }) };
}

/** Region of the 600x800 page drawn by `100 100 200 200 re`, in page pixels from the top-left. */
const SQUARE = { x: 100, y: 500, width: 200, height: 200 };

describe('content streams with a /Predictor (D)', () => {
  /** PNG "Up" rows of `columns` bytes, each prefixed with filter type 2. */
  function pngUp(data: Buffer, columns: number): Buffer {
    const rows = Math.ceil(data.length / columns);
    const padded = Buffer.alloc(rows * columns, 0x20);
    data.copy(padded);
    const out: number[] = [];
    for (let r = 0; r < rows; r++) {
      out.push(2);
      for (let c = 0; c < columns; c++) {
        const above = r > 0 ? padded[(r - 1) * columns + c]! : 0;
        out.push((padded[r * columns + c]! - above) & 0xff);
      }
    }
    return Buffer.from(out);
  }
  const PAINT = '0 0 0 rg 100 100 400 600 re f';
  const predicted = (doc: PDFDocument) => doc.context.register(doc.context.stream(deflateSync(pngUp(Buffer.from(PAINT), 8)), {
    Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: 8 },
  }));

  it('refuses page content Flate-encoded with PNG predictors (pdf.js draws it, pdf-lib would not)', async () => {
    const original = await (await onePage((doc) => ({ content: predicted(doc) }))).bytes();
    expect(await pageInk(original, { x: 100, y: 100, width: 400, height: 600 })).toBeGreaterThan(0.99);
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'unreadable_pdf' });
  });

  it('checks every stream of a /Contents array and every filter of an array /Filter', async () => {
    const inArray = await (await onePage((doc) => ({
      content: [doc.context.register(doc.context.stream('0 g')), predicted(doc)],
    }))).bytes();
    expect(await canonicalizeUploadedPdf(inArray)).toEqual({ ok: false, key: 'unreadable_pdf' });

    const hex = Buffer.from(deflateSync(pngUp(Buffer.from(PAINT), 8)).toString('hex') + '>');
    const chained = await (await onePage((doc) => ({
      content: doc.context.register(doc.context.stream(hex, {
        Filter: ['ASCIIHexDecode', 'FlateDecode'], DecodeParms: [null, { Predictor: 12, Columns: 8 }],
      } as never)),
    }))).bytes();
    expect(await pageInk(chained, { x: 100, y: 100, width: 400, height: 600 })).toBeGreaterThan(0.99);
    expect(await canonicalizeUploadedPdf(chained)).toEqual({ ok: false, key: 'unreadable_pdf' });
  });

  it('still accepts Flate content without a predictor, or with /Predictor 1', async () => {
    const plain = await (await onePage((doc) => ({
      content: doc.context.register(doc.context.stream(deflateSync(Buffer.from(PAINT)), {
        Filter: 'FlateDecode', DecodeParms: { Predictor: 1 },
      })),
    }))).bytes();
    const { bytes } = ok(await canonicalizeUploadedPdf(plain));
    expect(await pageInk(bytes, { x: 100, y: 100, width: 400, height: 600 })).toBeGreaterThan(0.99);
  });
});

describe('optional content is evaluated as pdf.js does (E)', () => {
  type Ocmd = (group: PDFRef) => Record<string, unknown>;
  /**
   * A Word-style layered page: one group g in /OCProperties, /D /ON [g], and
   * the square drawn inside `/OC /m BDC ... EMC`, where m is `ocmd(g)` (or g
   * itself when `ocmd` is undefined).
   */
  async function layered(options: { ocmd?: Ocmd; group?: Record<string, unknown>; inPattern?: boolean }): Promise<Uint8Array> {
    const { bytes } = await onePage((doc) => {
      const g = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Adobe Fill & Sign'), ...options.group } as never));
      doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        D: { ON: [g], Order: [], RBGroups: [] }, OCGs: [g],
      } as never));
      const marker = options.ocmd ? doc.context.register(doc.context.obj(options.ocmd(g) as never)) : g;
      if (options.inPattern) {
        // A tiling pattern whose cell is half inked inside the marked content.
        const pattern = doc.context.register(doc.context.stream('/OC /m BDC 0 0 0 rg 0 0 10 5 re f EMC', {
          Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10],
          XStep: 10, YStep: 10, Resources: { Properties: { m: marker } },
        } as never));
        return {
          content: doc.context.register(doc.context.stream('/Pattern cs /P0 scn 100 100 200 200 re f')),
          resources: { Pattern: { P0: pattern } },
        };
      }
      return {
        content: doc.context.register(doc.context.stream('/OC /m BDC 0 0 0 rg 100 100 200 200 re f EMC')),
        resources: { Properties: { m: marker } },
      };
    });
    return bytes();
  }

  it('accepts the Fill & Sign shape (an OCMD over one ON group, default /AnyOn) and draws its content', async () => {
    const original = await layered({ ocmd: (g) => ({ Type: 'OCMD', OCGs: g }) });
    const before = await pageInk(original, SQUARE);
    expect(before).toBeGreaterThan(0.99);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    expect(await pageInk(bytes, SQUARE)).toBeCloseTo(before, 3);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(false);
  });

  it.each<[string, Ocmd]>([
    ['/P /AllOn', (g) => ({ Type: 'OCMD', OCGs: [g], P: 'AllOn' })],
    ['/VE [/And g]', (g) => ({ Type: 'OCMD', VE: [PDFName.of('And'), g] })],
  ])('accepts %s over an ON group and draws its content', async (_name, ocmd) => {
    const original = await layered({ ocmd });
    expect(await pageInk(original, SQUARE)).toBeGreaterThan(0.99);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    expect(await pageInk(bytes, SQUARE)).toBeGreaterThan(0.99);
  });

  it.each<[string, Ocmd]>([
    ['/P /AllOff', (g) => ({ Type: 'OCMD', OCGs: [g], P: 'AllOff' })],
    ['/P /AnyOff', (g) => ({ Type: 'OCMD', OCGs: [g], P: 'AnyOff' })],
    ['/VE [/Not g]', (g) => ({ Type: 'OCMD', VE: [PDFName.of('Not'), g] })],
    ['/VE [/Or [/Not g]]', (g) => ({ Type: 'OCMD', VE: [PDFName.of('Or'), [PDFName.of('Not'), g]] })],
    ['/P /AnyOn over an empty /OCGs', () => ({ Type: 'OCMD', OCGs: [] })],
  ])('refuses %s over an ON group, which pdf.js hides', async (_name, ocmd) => {
    const original = await layered({ ocmd });
    expect(await pageInk(original, SQUARE)).toBe(0);
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'hidden_layers' });
  });

  it('refuses a malformed /VE', async () => {
    const original = await layered({ ocmd: (g) => ({ Type: 'OCMD', OCGs: [g], VE: [PDFName.of('Xor'), g] }) });
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'hidden_layers' });
  });

  it('refuses a group whose /Usage /View /ViewState is /OFF, even listed in /D /ON', async () => {
    const original = await layered({ group: { Usage: { View: { ViewState: 'OFF' } } } });
    expect(await pageInk(original, SQUARE)).toBe(0);
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'hidden_layers' });
  });

  it('refuses an /AllOff OCMD inside a tiling pattern cell', async () => {
    const original = await layered({ ocmd: (g) => ({ Type: 'OCMD', OCGs: [g], P: 'AllOff' }), inPattern: true });
    expect(await pageInk(original, SQUARE)).toBe(0);
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'hidden_layers' });
    // The same pattern with a visible OCMD is drawn alike.
    const shown = await layered({ ocmd: (g) => ({ Type: 'OCMD', OCGs: [g], P: 'AllOn' }), inPattern: true });
    const before = await pageInk(shown, SQUARE);
    expect(before).toBeGreaterThan(0.3);
    const { bytes } = ok(await canonicalizeUploadedPdf(shown));
    expect(await pageInk(bytes, SQUARE)).toBeCloseTo(before, 2);
  });
});

describe('reversed page boxes are read as pdf.js reads them (F)', () => {
  it('a /CropBox written top-right first crops to the same area', async () => {
    const source = await onePage((doc) => ({
      // Inside the crop (100..300 x 100..400), and outside it.
      content: doc.context.register(doc.context.stream('0 0 0 rg 150 150 100 200 re f 400 500 100 100 re f')),
    }));
    source.doc.getPage(0).node.set(PDFName.of('CropBox'), source.doc.context.obj([300, 400, 100, 100]));
    const original = await source.bytes();
    const before = await rasterPage(original);
    expect([before.width, before.height]).toEqual([200, 300]);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0);
    expect([page.getWidth(), page.getHeight()]).toEqual([200, 300]);
    const after = await rasterPage(bytes);
    expect([after.width, after.height]).toEqual([200, 300]);
    expect(after.dark).toEqual(before.dark);
  });

  it('a /MediaBox written [612 792 0 0] is accepted at 612x792', async () => {
    const source = await onePage((doc) => ({
      content: doc.context.register(doc.context.stream('0 0 0 rg 50 50 100 100 re f')),
    }));
    source.doc.getPage(0).node.set(PDFName.of('MediaBox'), source.doc.context.obj([612, 792, 0, 0]));
    const original = await source.bytes();
    const before = await rasterPage(original);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    const page = (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0);
    expect([page.getWidth(), page.getHeight()]).toEqual([612, 792]);
    expect((await rasterPage(bytes)).dark).toEqual(before.dark);
  });
});

describe('widgets are drawn only as pdf.js draws them (G)', () => {
  /** A page with one widget (or field) dictionary and an /AcroForm listing it. */
  async function formPage(widget: (doc: PDFDocument) => Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
    const ref = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Widget', P: page.ref, ...widget(doc) } as never));
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [ref], DA: PDFString.of('/Helv 12 Tf 0 g'), ...extra } as never));
    return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
  }
  const black = (doc: PDFDocument) => doc.context.register(doc.context.stream('0 g 0 0 100 50 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50],
  }));
  const blank = (doc: PDFDocument) => doc.context.register(doc.context.stream('', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 50],
  }));
  /** The widget rectangle [100 600 200 650], in page pixels. */
  const RECT = { x: 100, y: 150, width: 100, height: 50 };

  it('drops a filled text field with no /AP (pdf.js draws nothing for it)', async () => {
    const original = await formPage(() => ({
      FT: 'Tx', T: PDFString.of('name'), V: PDFString.of('HELLO WORLD VALUE'), DA: PDFString.of('/Helv 12 Tf 0 g'),
      Rect: [100, 600, 200, 650], F: 4, MK: { BC: [0, 0, 0], BG: [0, 0, 0] },
    }));
    expect(await pageInk(original, RECT)).toBe(0);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    expect(await pageInk(bytes, RECT)).toBe(0);
  });

  it('drops a check box whose /AS /Off has no entry in /AP /N', async () => {
    const original = await formPage((doc) => ({
      FT: 'Btn', T: PDFString.of('agree'), AS: 'Off', Rect: [100, 600, 200, 650], F: 4,
      MK: { BC: [0, 0, 0], BG: [0, 0, 0] }, AP: { N: { Yes: black(doc) } },
    }));
    expect(await pageInk(original, RECT)).toBe(0);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    expect(await pageInk(bytes, RECT)).toBe(0);
  });

  it('refuses a check box pdf.js draws from its value when /AS selects nothing', async () => {
    const original = await formPage((doc) => ({
      FT: 'Btn', T: PDFString.of('agree'), V: 'Yes', Rect: [100, 600, 200, 650], F: 4,
      AP: { N: { Yes: black(doc), Off: blank(doc) } },
    }));
    expect(await pageInk(original, RECT)).toBeGreaterThan(0.9);
    const result = await canonicalizeUploadedPdf(original);
    expect(result).toMatchObject({ ok: false, key: 'unsupported_form' });
    expect(!result.ok && result.message).toMatch(/flattened PDF/);
  });

  it('refuses a radio button pdf.js draws a made-up disc for', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
    const group = doc.context.register(doc.context.obj({ FT: 'Btn', T: PDFString.of('choice'), Ff: 1 << 15, Kids: [] }));
    const kid = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', Parent: group, P: page.ref, Rect: [100, 600, 200, 650], F: 4,
      MK: { BC: [0, 0, 0] }, AP: { N: { Off: blank(doc) } },
    } as never));
    doc.context.lookup(group, PDFDict).set(PDFName.of('Kids'), doc.context.obj([kid]));
    page.node.set(PDFName.of('Annots'), doc.context.obj([kid]));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [group] }));
    const original = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    expect(await pageInk(original, RECT)).toBeGreaterThan(0);
    expect(await canonicalizeUploadedPdf(original)).toMatchObject({ ok: false, key: 'unsupported_form' });
  });

  it.each([-1, 2.5])('draws a widget with an /AP and /F %d (pdf.js reads the flags as 0)', async (flags) => {
    const original = await formPage((doc) => ({
      FT: 'Tx', T: PDFString.of('name'), V: PDFString.of('x'), Rect: [100, 600, 200, 650], F: PDFNumber.of(flags),
      AP: { N: black(doc) },
    }));
    const before = await pageInk(original, RECT);
    expect(before).toBeGreaterThan(0.9);
    const { bytes } = ok(await canonicalizeUploadedPdf(original));
    expect(await pageInk(bytes, RECT)).toBeCloseTo(before, 3);
  });

  it('refuses a Square annotation with an /AP and /F -1 (visible in pdf.js)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('')));
    const square = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [100, 600, 200, 650], F: -1, AP: { N: black(doc) },
    }));
    page.node.set(PDFName.of('Annots'), doc.context.obj([square]));
    const original = await doc.save({ useObjectStreams: false });
    expect(await pageInk(original, RECT)).toBeGreaterThan(0.9);
    expect(await canonicalizeUploadedPdf(original)).toEqual({ ok: false, key: 'visible_annotations' });
  });
});
