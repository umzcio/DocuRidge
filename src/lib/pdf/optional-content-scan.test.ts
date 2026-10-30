import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { hasInlineOcTag } from './optional-content-scan';
import { canonicalizeUploadedPdf } from './canonicalize';

/** The pattern the scan replaced (quadratic on long whitespace after a comment), kept here as the oracle. */
const OLD_PATTERN = /\/(?:O|#4[Ff])(?:C|#43)(?![^\x00\t\n\f\r ()<>[\]{}/%])(?:[\x00\t\n\f\r ]|%[^\r\n%]*)*<</;
const bytes = (text: string) => Buffer.from(text, 'latin1');

describe('hasInlineOcTag', () => {
  it.each([
    '/OC << /Type /OCMD /OCGs [] >> BDC 0 g EMC',
    '/OC<</Type/OCMD>>BDC',
    '/OC %c\n<</Type/OCMD>> BDC',
    '/OC %a%b\r\n \t<<',
    '/OC % comment << inside it',
    '/OC %one\n%two\n<<',
    '/O#43 <<',
    '/#4fC <<',
    '/#4F#43\n<<',
    '(x) /OC /m BDC 0 g EMC',
    '/OC /m BDC << >>',
    '/OCGs << >>',
    '/OCx <<',
    '/OC x <<',
    '/OC %a\nx <<',
    '/OC (<<)',
    '/OC <',
    '/OC',
    '%/OC <<',
    '(/OC %) /OC << >> BDC',
    '/OC %c /OC <<',
    '//OC <<',
    '/OC\u0000<<',
    '/OC [<<',
    '',
  ])('decides %j as the old pattern did', (text) => {
    expect(hasInlineOcTag(bytes(text))).toBe(OLD_PATTERN.test(text));
  });

  it('scans `/OC %`, a million spaces and `x` linearly, with the old verdict', () => {
    const text = `/OC %${' '.repeat(1_000_000)}x`;
    const started = performance.now();
    expect(hasInlineOcTag(bytes(text))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('stays linear on many /OC tokens inside one long comment, and on whitespace after a comment line', () => {
    const text = `/OC %${'/OC '.repeat(200_000)}\n${' '.repeat(1_000_000)}x`;
    const started = performance.now();
    expect(hasInlineOcTag(bytes(text))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('a layered upload whose content holds `/OC %`, a million spaces and `x` is canonicalized as before', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const g = doc.context.register(doc.context.obj({ Type: 'OCG', Name: 'Layer' }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ D: { ON: [g] }, OCGs: [g] } as never));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(
      `0 0 0 rg 100 100 200 200 re f\n/OC %${' '.repeat(1_000_000)}x\n`,
    )));
    const started = performance.now();
    const result = await canonicalizeUploadedPdf(await doc.save({ useObjectStreams: false }));
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
