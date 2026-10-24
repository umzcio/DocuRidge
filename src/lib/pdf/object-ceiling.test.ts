import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
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
});
