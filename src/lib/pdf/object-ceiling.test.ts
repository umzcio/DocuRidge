import { deflateSync } from 'node:zlib';
import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from 'vitest';
import { PDFContext, PDFDocument, PDFObjectStreamParser } from 'pdf-lib';
import { assertParseObjectCeiling, countDeclaredObjects } from './object-ceiling';
import { loadPdfWithDecodeLimits, withPdfDecodeBudget } from './decode-limits';
import { PdfComplexityError } from './seal-limits';
import { buildBombPdf } from './__fixtures__/bomb-pdf';

describe('parse object ceiling: pre-parse byte scan (top-level definitions)', () => {
  it('counts top-level definitions only, not object-stream members', () => {
    // buildBombPdf('objstm'): objects 1..5 are top-level definitions; object 5 is an /ObjStm.
    expect(countDeclaredObjects(buildBombPdf('objstm', Buffer.from('x')))).toBe(5);
    const withN = Buffer.from('1 0 obj\n<< /N 7000 /Type /ObjStm /First 4 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(countDeclaredObjects(withN)).toBe(1);
  });

  it('refuses past the ceiling without parsing', () => {
    const load = vi.spyOn(PDFDocument, 'load');
    const buf = Buffer.from('1 0 obj\nnull\nendobj\n'.repeat(1_000_001), 'latin1');
    const started = performance.now();
    try {
      assertParseObjectCeiling(buf);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PdfComplexityError);
      expect((err as PdfComplexityError).limit).toBe('parse_objects');
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
  });

  const wrap = (body: string) =>
    Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n${body}trailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF\n`, 'latin1');

  it('does not under-count definitions glued to endobj', async () => {
    let body = '';
    for (let i = 3; i < 2003; i++) body += `${i} 0 obj null endobj`;
    const bytes = wrap(body);
    const parsed = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    expect(parsed).toBeGreaterThan(1000);
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(parsed);
  });

  it('does not under-count fully glued definitions', async () => {
    let body = '';
    for (let i = 3; i < 2003; i++) body += `${i} 0 objnullendobj`;
    const bytes = wrap(body);
    const parsed = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    expect(parsed).toBeGreaterThan(1000);
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(parsed);
  });

  it('does not under-count comment-separated headers', async () => {
    let body = '';
    for (let i = 3; i < 2003; i++) body += `${i} %c\n0 %c\n objnullendobj`;
    const bytes = wrap(body);
    const parsed = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    expect(parsed).toBeGreaterThan(1000);
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(parsed);
  });

  it('stays close to the real object count for an ordinary multi-page PDF without object streams', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont('Helvetica');
    for (let i = 0; i < 20; i++) doc.addPage().drawText(`page ${i}`, { font });
    const bytes = await doc.save({ useObjectStreams: false });
    const actual = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    const counted = countDeclaredObjects(bytes);
    expect(counted).toBeGreaterThanOrEqual(actual);
    expect(counted).toBeLessThanOrEqual(3 * actual);
  });
});

describe('parse object ceiling: exact count while parsing', () => {
  const ORIGINAL = process.env.PDF_MAX_PARSE_OBJECTS;
  // pdf-lib reports its recovery from the ceiling error with console.warn
  // ("Trying to parse invalid object", "Invalid object ref"); keep it off stderr.
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  const warnedRecovery = () => warn.mock.calls.some(([msg]) => String(msg).startsWith('Trying to parse invalid object'));
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PDF_MAX_PARSE_OBJECTS;
    else process.env.PDF_MAX_PARSE_OBJECTS = ORIGINAL;
    vi.restoreAllMocks();
  });

  const MEMBERS = 300;

  /**
   * A pdf-lib-written PDF whose objects nearly all live in compressed object
   * streams, optionally rewritten into one of the shapes that defeated the
   * earlier byte-scan count of /ObjStm headers.
   */
  async function buildObjStmPdf(variant: 'plain' | 'comment' | 'indirect'): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage();
    for (let i = 0; i < MEMBERS; i++) doc.context.register(doc.context.obj({ I: i }));
    const text = Buffer.from(await doc.save({ useObjectStreams: true })).toString('latin1');
    expect(text).toContain('/Type /ObjStm');
    if (variant === 'plain') return Buffer.from(text, 'latin1');
    if (variant === 'comment') return Buffer.from(text.replaceAll('/Type /ObjStm', '/Type %c\n/ObjStm'), 'latin1');
    // /Type as an indirect reference to a name object defined before the streams;
    // pdf-lib resolves it with dict.lookup and still parses the members.
    const first = text.search(/\d+ 0 obj/);
    return Buffer.from(
      `${text.slice(0, first)}99999 0 obj\n/ObjStm\nendobj\n${text.slice(first).replaceAll('/Type /ObjStm', '/Type 99999 0 R')}`,
      'latin1',
    );
  }

  async function expectParseObjectsRefusal(promise: Promise<unknown>): Promise<void> {
    const err = await promise.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PdfComplexityError);
    expect((err as PdfComplexityError).limit).toBe('parse_objects');
  }

  for (const variant of ['plain', 'comment', 'indirect'] as const) {
    it(`counts object-stream members during the load (${variant} /Type)`, async () => {
      const bytes = await buildObjStmPdf(variant);
      // The byte scan sees only the few top-level definitions, so a refusal
      // below can only come from the parse-time count.
      expect(countDeclaredObjects(bytes)).toBeLessThan(100);

      await expectParseObjectsRefusal(loadPdfWithDecodeLimits(bytes, { maxParseObjects: 100 }));
      // The ceiling error was thrown inside pdf-lib's parser, which caught it
      // and tried to recover; the scope still surfaced it.
      expect(warnedRecovery()).toBe(true);

      warn.mockClear();
      const doc = await loadPdfWithDecodeLimits(bytes, { maxParseObjects: 1000 });
      expect(warn).not.toHaveBeenCalled();
      expect(doc.context.enumerateIndirectObjects().length).toBeGreaterThan(MEMBERS);
    });
  }

  it('reads the ceiling from PDF_MAX_PARSE_OBJECTS', async () => {
    const bytes = await buildObjStmPdf('plain');
    process.env.PDF_MAX_PARSE_OBJECTS = '100';
    await expectParseObjectsRefusal(loadPdfWithDecodeLimits(bytes));
    process.env.PDF_MAX_PARSE_OBJECTS = '1000';
    await expect(loadPdfWithDecodeLimits(bytes)).resolves.toBeInstanceOf(PDFDocument);
  });

  it('stops registering objects once the ceiling is hit, although pdf-lib catches the error', async () => {
    const bytes = await buildObjStmPdf('plain');
    const assign = vi.spyOn(PDFContext.prototype, 'assign');
    await expectParseObjectsRefusal(loadPdfWithDecodeLimits(bytes, { maxParseObjects: 100 }));
    // 100 accepted, the 101st throws inside the object-stream parser; pdf-lib
    // catches that and retries the stream as an invalid object, whose assign
    // throws again and ends the parse. Nothing past that is registered.
    expect(assign.mock.calls.length).toBeLessThanOrEqual(102);
    expect(warnedRecovery()).toBe(true);
  });

  it('refuses an object stream whose /N exceeds the ceiling before reading its offset table', async () => {
    const huge = 16_000_000;
    const body = deflateSync(Buffer.from('0 0 '.repeat(1000), 'latin1'));
    const bytes = Buffer.concat([
      Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
          + `3 0 obj\n<< /Type /ObjStm /N ${huge} /First 4000 /Length ${body.length} /Filter /FlateDecode >>\nstream\n`,
        'latin1',
      ),
      body,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Size 4 /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);
    // parseRawInt is what the unguarded offset-table loop calls once per /N
    // pair; object-stream parsers inherit it, so this spy sees only them.
    const readInt = vi.spyOn(PDFObjectStreamParser.prototype as unknown as { parseRawInt: () => number }, 'parseRawInt');

    const started = performance.now();
    await expectParseObjectsRefusal(loadPdfWithDecodeLimits(bytes, { maxParseObjects: 1000 }));
    expect(performance.now() - started).toBeLessThan(500);
    expect(readInt).not.toHaveBeenCalled();

    // The spy does see the offset table of a stream within the ceiling.
    await loadPdfWithDecodeLimits(await buildObjStmPdf('plain'), { maxParseObjects: 1000 });
    expect(readInt).toHaveBeenCalled();
  });

  it('refuses a top-level-only file over the ceiling before PDFDocument.load', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    for (let i = 0; i < MEMBERS; i++) doc.context.register(doc.context.obj({ I: i }));
    const bytes = await doc.save({ useObjectStreams: false });
    const load = vi.spyOn(PDFDocument, 'load');
    await expectParseObjectsRefusal(loadPdfWithDecodeLimits(bytes, { maxParseObjects: 100 }));
    expect(load).not.toHaveBeenCalled();
  });

  it('does not count objects built outside a load (seal-time building)', async () => {
    process.env.PDF_MAX_PARSE_OBJECTS = '5';
    const source = await loadPdfWithDecodeLimits(await buildObjStmPdf('plain'), { maxParseObjects: 1000 });
    await withPdfDecodeBudget(async () => {
      const out = await PDFDocument.create();
      for (let i = 0; i < 50; i++) out.context.register(out.context.obj({ I: i }));
      for (let i = 0; i < 50; i++) source.context.register(source.context.obj({ I: i }));
      await out.save();
    });
  });
});
