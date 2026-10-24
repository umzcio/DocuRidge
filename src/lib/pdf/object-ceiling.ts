/**
 * Pre-parse ceiling on how many objects a PDF declares.
 *
 * `PDFDocument.load` builds one object per definition and per object-stream
 * member before any later limit can run, so a small file declaring millions
 * of tiny objects can exhaust memory inside the parser. This counts the
 * declarations with a byte scan, without parsing, and refuses the file first.
 *
 * Leaf module: reads its cap from `process.env` so it also works in scripts
 * and tests.
 */

import { PdfComplexityError } from './seal-limits';

/** Default ceiling on declared objects (definitions plus object-stream members). */
export const DEFAULT_PDF_MAX_PARSE_OBJECTS = 1_000_000;

export function getParseObjectCeiling(): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.PDF_MAX_PARSE_OBJECTS;
  if (!raw) return DEFAULT_PDF_MAX_PARSE_OBJECTS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PDF_MAX_PARSE_OBJECTS;
}

const OBJ_KEYWORD = /(?<!end)obj/g;
const OBJSTM = /\/Type[ \t\r\n\f\0]*\/ObjStm(?![\w#])/g;
const OBJSTM_N = /\/N(?![\w#])[ \t\r\n\f\0]*(\d+)([ \t\r\n\f\0]+\d+[ \t\r\n\f\0]+R)?/g;

/**
 * A deliberate OVER-estimate of the objects pdf-lib would build for `bytes`.
 * It never matches header shapes, so no separator, comment or glueing can
 * hide an object:
 *   - every occurrence of `obj` that is not the tail of `endobj` counts as one
 *     definition (each real definition contains that keyword; `obj` inside
 *     strings, comments or stream data over-counts, which is acceptable);
 *   - for each `/Type /ObjStm`, the span from the nearest preceding `obj` to
 *     the next `stream` keyword contributes the sum of every direct
 *     `/N <int>` in it, nested dictionaries included. An indirect `/N`
 *     makes the whole count infinite (legitimate writers never emit one);
 *     no `/N` adds 0 (pdf-lib cannot parse such a stream).
 * `#xx` name escapes are decoded first, in either hex case.
 */
export function countDeclaredObjects(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('latin1')
    .replace(/#([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  let count = 0;
  for (const _ of text.matchAll(OBJ_KEYWORD)) count++;
  for (const match of text.matchAll(OBJSTM)) {
    const at = match.index ?? 0;
    const start = Math.max(0, text.lastIndexOf('obj', at));
    const streamAt = text.indexOf('stream', at);
    const span = text.slice(start, streamAt === -1 ? text.length : streamAt);
    for (const n of span.matchAll(OBJSTM_N)) {
      if (n[2]) return Number.POSITIVE_INFINITY;
      count += Number.parseInt(n[1]!, 10);
    }
  }
  return count;
}

export function assertParseObjectCeiling(bytes: Uint8Array, max: number = getParseObjectCeiling()): void {
  const declared = countDeclaredObjects(bytes);
  if (declared > max) {
    throw new PdfComplexityError('parse_objects', `The PDF declares more than ${max} objects`);
  }
}
