/**
 * Text that pdf-lib's standard fonts can draw. Helvetica, Times and Courier
 * use WinAnsi encoding, whose 218 code points are printable characters only:
 * no C0 or C1 controls, no DEL, nothing beyond Latin-1 but a few typographic
 * marks. `widthOfTextAtSize` and `drawText` throw on any other character, so
 * every string a sealed page or certificate draws goes through here first.
 *
 * Imports nothing at runtime: the PDF worker's seal job uses it.
 */
import type { PDFFont } from 'pdf-lib';

/** Characters drawn as a plain space: tab, the other line and page breaks, and the wide spaces. */
const SPACE_LIKE = /[\t\n\v\f\r\u0085\u2028\u2029\u00a0\u2007\u202f]/g;

const charsets = new WeakMap<PDFFont, Set<number>>();

function charsetOf(font: PDFFont): Set<number> {
  let set = charsets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charsets.set(font, set);
  }
  return set;
}

/**
 * `text` with every character `font` cannot encode replaced: common
 * typographic marks by their ASCII forms, whitespace and line breaks by a
 * space, anything else (controls, DEL, characters outside the font) by "?".
 * The result is single-line; split multi-line text into lines first.
 * Long-term fix: embed a TrueType unicode font.
 */
export function winAnsiSafe(text: string, font: PDFFont): string {
  const charset = charsetOf(font);
  const mapped = text
    .replace(/[\u2010-\u2015]/g, '-') // hyphens, dashes
    .replace(/[\u2018-\u201b]/g, "'")
    .replace(/[\u201c-\u201f]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/[\u2713\u2714]/g, '[x]')
    .replace(SPACE_LIKE, ' ');
  let out = '';
  for (const ch of mapped) out += charset.has(ch.codePointAt(0)!) ? ch : '?';
  return out;
}

/** Split text into the lines a multi-line value holds (LF, CRLF or CR). */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}
