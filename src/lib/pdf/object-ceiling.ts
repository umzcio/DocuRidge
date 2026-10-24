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

const DEFINITION = /(?<![\w])\d+[ \t\r\n\f\0]+\d+[ \t\r\n\f\0]+obj(?![A-Za-z])/g;
const OBJSTM = /\/Type[ \t\r\n\f\0]*\/ObjStm(?![\w#])/g;
const OBJSTM_N = /\/N[ \t\r\n\f\0]+(\d+)/;

/**
 * Count `<int> <int> obj` definitions plus the `/N` of every `/Type /ObjStm`
 * dictionary found in the raw bytes. Over-counts (it also sees text inside
 * streams) but never under-counts a file pdf-lib would parse as declared.
 */
export function countDeclaredObjects(bytes: Uint8Array): number {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let count = 0;
  for (const _ of text.matchAll(DEFINITION)) count++;
  for (const match of text.matchAll(OBJSTM)) {
    const at = match.index ?? 0;
    const start = Math.max(0, text.lastIndexOf('obj', at));
    const streamAt = text.indexOf('stream', at);
    const end = streamAt === -1 ? text.length : streamAt;
    const n = OBJSTM_N.exec(text.slice(start, end));
    if (n) count += Number.parseInt(n[1]!, 10);
  }
  return count;
}

export function assertParseObjectCeiling(bytes: Uint8Array, max: number = getParseObjectCeiling()): void {
  const declared = countDeclaredObjects(bytes);
  if (declared > max) {
    throw new PdfComplexityError('parse_objects', `The PDF declares more than ${max} objects`);
  }
}
