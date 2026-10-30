/**
 * The inline-/OC scan of a layered upload: whether any stream could hold
 * marked content whose /OC properties are an inline dictionary
 * (`/OC << ... >> BDC`), which pdf.js evaluates like any OCMD but the
 * object walk in source-policy.ts cannot see. Run by canonicalize.ts only
 * when the file has /OCProperties and the policy found no hidden layer.
 *
 * Worker-side, and kept apart from source-policy.ts on purpose: it decodes
 * streams (decode-limits.ts, node:async_hooks), while source-policy.ts is
 * also bundled for the browser through form-appearance.ts and edit.ts.
 */

import { PDFArray, PDFName, PDFRawStream, PDFRef, decodePDFRawStream, type PDFDocument, type PDFObject } from 'pdf-lib';
import { PdfDecodeLimitError } from './decode-limits';

/** Filters only images use; pdf-lib decodes none of them. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode']);

const isWhitespace = (c: number) => c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isEol = (c: number) => c === 0x0a || c === 0x0d;
/** ( ) < > [ ] { } / % */
const isDelimiter = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d ||
  c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const hexValue = (c: number) =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

/**
 * True when `bytes` has the name token `/OC` (`#`-escapes decoded) followed
 * by nothing but PDF whitespace and comments up to `<<`, or by `<<` inside
 * such a comment (the old pattern's reading, kept: it may refuse a string
 * that merely reads `/OC <<`, never miss a real one). One forward pass with
 * two flags, so it is linear in the input whatever its whitespace and
 * comments look like:
 * - `afterOc`: an /OC token was followed by whitespace only so far;
 * - `inComment`: such a run has entered a comment, which lasts to the end of
 *   the line and then continues as whitespace.
 */
export function hasInlineOcTag(bytes: Uint8Array): boolean {
  let afterOc = false;
  let inComment = false;
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const c = bytes[i]!;
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      if (afterOc || inComment) return true;
      afterOc = false;
      i += 2;
      continue;
    }
    if (isEol(c)) {
      if (inComment) afterOc = true;
      inComment = false;
      i++;
      continue;
    }
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    if (c === 0x25) {
      if (afterOc) inComment = true;
      afterOc = false;
      i++;
      continue;
    }
    if (c === 0x2f) {
      // A name token: decode it and see whether it is /OC.
      let j = i + 1;
      let name = '';
      while (j < n && !isWhitespace(bytes[j]!) && !isDelimiter(bytes[j]!)) {
        let ch = bytes[j]!;
        if (ch === 0x23 && j + 2 < n && hexValue(bytes[j + 1]!) >= 0 && hexValue(bytes[j + 2]!) >= 0) {
          ch = hexValue(bytes[j + 1]!) * 16 + hexValue(bytes[j + 2]!);
          j += 3;
        } else {
          j++;
        }
        if (name.length <= 2) name += String.fromCharCode(ch);
      }
      afterOc = name === 'OC';
      i = j;
      continue;
    }
    // Any other character ends a whitespace run (a comment ignores it).
    afterOc = false;
    i++;
  }
  return false;
}

/**
 * Whether any stream of the file could carry an inline /OC dictionary: a
 * byte scan of every stream as pdf-lib decodes it, under the caller's decode
 * budget. A stream pdf-lib cannot decode, or one with an /F or /DP key
 * (pdf.js would decode it otherwise), cannot be shown free of one and counts
 * as carrying it; an image stream whose filters are image-only (DCT, JPX,
 * CCITT, JBIG2) is skipped, as pdf.js never reads an image as content.
 */
export function streamsHoldInlineOptionalContent(doc: PDFDocument): boolean {
  const resolve = (value: PDFObject | undefined): PDFObject | undefined =>
    value instanceof PDFRef ? doc.context.lookup(value) : value;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    // `get(key, true)`: a key holding null counts (pdf-lib's `has` says no).
    if (dict.get(PDFName.of('F'), true) !== undefined || dict.get(PDFName.of('DP'), true) !== undefined) return true;
    const filter = resolve(dict.get(PDFName.of('Filter')));
    const filters = filter instanceof PDFArray ? filter.asArray().map(resolve) : filter === undefined ? [] : [filter];
    const imageOnly = filters.some((name) => name instanceof PDFName && IMAGE_FILTERS.has(name.decodeText()));
    if (imageOnly && resolve(dict.get(PDFName.of('Subtype'))) === PDFName.of('Image')) continue;
    let bytes: Uint8Array;
    try {
      bytes = decodePDFRawStream(object).decode();
    } catch (err) {
      if (err instanceof PdfDecodeLimitError) throw err;
      return true;
    }
    if (hasInlineOcTag(bytes)) return true;
  }
  return false;
}
