import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { assertParseObjectCeiling, countDeclaredObjects } from './object-ceiling';
import { PdfComplexityError } from './seal-limits';
import { buildBombPdf } from './__fixtures__/bomb-pdf';

describe('parse object ceiling', () => {
  it('counts classic and object-stream definitions', () => {
    // buildBombPdf('objstm'): objects 1..5 are classic definitions; object 5 is an /ObjStm with /N 1.
    expect(countDeclaredObjects(buildBombPdf('objstm', Buffer.from('x')))).toBe(5 + 1);
    const withN = Buffer.from('1 0 obj\n<< /N 7000 /Type /ObjStm /First 4 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(countDeclaredObjects(withN)).toBe(1 + 7000);
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

  it('counts an object stream whose /Type uses a name escape by its /N', () => {
    const bytes = Buffer.from('3 0 obj\n<< /Type /Obj#53tm /N 9000 /First 4 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(countDeclaredObjects(bytes)).toBe(1 + 9000);
  });

  it('refuses an object stream with an indirect /N at the default ceiling', () => {
    const bytes = Buffer.from('3 0 obj\n<< /Type /ObjStm /N 5 0 R /First 4 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(() => assertParseObjectCeiling(bytes)).toThrow(PdfComplexityError);
  });

  it('does not under-count fully glued definitions', async () => {
    let body = '';
    for (let i = 3; i < 2003; i++) body += `${i} 0 objnullendobj`;
    const bytes = wrap(body);
    const parsed = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    expect(parsed).toBeGreaterThan(1000);
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(parsed);
  });

  it('does not refuse a PDF whose content stream merely mentions /Type /ObjStm', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('% /Type /ObjStm\nq Q\n')));
    const bytes = await doc.save({ useObjectStreams: false });
    expect(Buffer.from(bytes).toString('latin1')).toContain('/Type /ObjStm');
    expect(() => assertParseObjectCeiling(bytes)).not.toThrow();
  });

  it('does not under-count comment-separated headers', async () => {
    let body = '';
    for (let i = 3; i < 2003; i++) body += `${i} %c\n0 %c\n objnullendobj`;
    const bytes = wrap(body);
    const parsed = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
    expect(parsed).toBeGreaterThan(1000);
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(parsed);
  });

  it('sums a nested /N with the top-level /N of an object stream', () => {
    const bytes = Buffer.from('3 0 obj\n<< /Foo << /N 1 >> /Type /ObjStm /N 5000 /First 4 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(countDeclaredObjects(bytes)).toBeGreaterThanOrEqual(5000);
    const before = Buffer.from('3 0 obj\n<< /Type /ObjStm /Foo << /N 1 >> /N 5000 /Length 0 >>\nstream\n\nendstream\nendobj\n', 'latin1');
    expect(countDeclaredObjects(before)).toBeGreaterThanOrEqual(5000);
  });

  it('stays close to the real object count for an ordinary multi-page PDF', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont('Helvetica');
    for (let i = 0; i < 20; i++) doc.addPage().drawText(`page ${i}`, { font });
    for (const useObjectStreams of [false, true]) {
      const bytes = await doc.save({ useObjectStreams });
      const actual = (await PDFDocument.load(bytes, { updateMetadata: false })).context.enumerateIndirectObjects().length;
      const counted = countDeclaredObjects(bytes);
      expect(counted).toBeGreaterThanOrEqual(actual);
      expect(counted).toBeLessThanOrEqual(3 * actual);
    }
  });
});
