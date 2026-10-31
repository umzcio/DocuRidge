import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { splitLines, winAnsiSafe } from './winansi';

describe('winAnsiSafe', () => {
  it.each([StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.TimesRoman, StandardFonts.Courier])(
    'leaves nothing %s cannot encode, for every BMP code point',
    async (name) => {
      const font = await (await PDFDocument.create()).embedFont(name);
      for (let cp = 0; cp <= 0xffff; cp++) {
        if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates: below
        const safe = winAnsiSafe(`a${String.fromCharCode(cp)}b`, font);
        expect(() => font.widthOfTextAtSize(safe, 10), `U+${cp.toString(16)}`).not.toThrow();
      }
      for (const text of ['\ud800', '\udc00x', '\u{1f600}']) {
        expect(() => font.widthOfTextAtSize(winAnsiSafe(text, font), 10)).not.toThrow();
      }
    },
  );

  it('draws tab and the other breaks as a space, and other controls as "?"', async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(winAnsiSafe('a\tb\nc\r\u0085d\u2028e', font)).toBe('a b c  d e');
    expect(winAnsiSafe('a\u0000b\u007fc\u0090d\u009fe', font)).toBe('a?b?c?d?e');
    // Characters the fonts carry are kept; the usual typographic marks become ASCII.
    expect(winAnsiSafe('Zo\u00eb S\u00f8ren \u20ac \u00a9', font)).toBe('Zo\u00eb S\u00f8ren \u20ac \u00a9');
    expect(winAnsiSafe('\u201cquote\u201d \u2014 dash\u2026', font)).toBe('"quote" - dash...');
  });

  it('splits on LF, CRLF and CR', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });
});
